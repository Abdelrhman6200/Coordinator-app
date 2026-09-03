/**
 * Imports a DEPI operations workbook into a cohort.
 *
 *   node --experimental-strip-types scripts/import-workbook.ts <file.xlsx> [--commit]
 *
 * Dry run by default (§66: never silently import). Prints the validation preview
 * and the data-quality findings; `--commit` writes.
 *
 * The gig sheet is read BY POSITION, not by header name, because the export's
 * header row is misaligned with its own data -- see packages/core/services/
 * workbook.ts. The shape guard stops the run if the export moves again.
 */
import ExcelJS from 'exceljs';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { seedRoles } from '../packages/db/src/index.ts';
import {
  assertGigSheetShape,
  createExecutor,
  detectRound,
  identityKey,
  normalisePhone,
  parseGigRow,
  parseGroupCode,
  priceColumnLooksSane,
  projectStudent,
  recomputeGraduation,
  graduationSummary,
  type ParsedGig,
  type RequestContext,
} from '../packages/core/src/index.ts';
import { SEED_ROLES_BY_KEY } from '../packages/permissions/src/index.ts';
import type { WorkingCalendar } from '../packages/rules/src/index.ts';

const CALENDAR: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(),
};

const file = process.argv[2];
const commit = process.argv.includes('--commit');
if (!file) {
  console.error('usage: import-workbook.ts <file.xlsx> [--commit]');
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
});

interface RosterRow {
  name: string;
  nationalId: string | null;
  phone: string | null;
  email: string | null;
  groupCode: string | null;
  status: string | null;
  type: string;
  provider: string | null;
}

function cellValues(row: ExcelJS.Row, width: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 1; i <= width; i++) {
    const v = row.getCell(i).value;
    // ExcelJS wraps formula cells and rich text; take the resolved value.
    if (v && typeof v === 'object' && 'result' in v) out.push((v as { result: unknown }).result);
    else if (v && typeof v === 'object' && 'richText' in v) {
      out.push((v as { richText: { text: string }[] }).richText.map((t) => t.text).join(''));
    } else if (v && typeof v === 'object' && 'text' in v) out.push((v as { text: unknown }).text);
    else out.push(v);
  }
  return out;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return !s || s === '#NAME?' || s === '#N/A' ? null : s;
}

async function main() {
  console.log(`Reading ${file}\n`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file!);

  // ---- Roster (S = students, G = graduates) --------------------------------
  const roster: RosterRow[] = [];
  for (const [sheetName, type] of [['S', 'STUDENT'], ['G', 'GRADUATE']] as const) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const v = cellValues(row, 8);
      const name = str(v[1]);
      if (!name) return;
      roster.push({
        name,
        nationalId: str(v[2]),
        phone: str(v[3]),
        email: str(v[4])?.toLowerCase() ?? null,
        groupCode: str(v[5]),
        status: str(v[6]),
        type,
        provider: str(v[0]),
      });
    });
  }

  // ---- Gigs ---------------------------------------------------------------
  const gigSheet = wb.getWorksheet('GigsDataFromPortal');
  if (!gigSheet) throw new Error('GigsDataFromPortal sheet not found');
  const header = cellValues(gigSheet.getRow(1), 34).map((v) => (v === null ? '' : String(v)));
  assertGigSheetShape(header);

  const gigs: ParsedGig[] = [];
  gigSheet.eachRow((row, n) => {
    if (n === 1) return;
    const v = cellValues(row, 34);
    if (v.every((x) => x === null || x === undefined)) return;
    gigs.push(parseGigRow(v, n));
  });

  // ---- Group -> coordinator / coach ---------------------------------------
  const groupOwners = new Map<string, { coordinator: string | null; coach: string | null }>();
  const coachSheet = wb.getWorksheet('CoachesData');
  coachSheet?.eachRow((row, n) => {
    if (n === 1) return;
    const v = cellValues(row, 4);
    const code = str(v[0]);
    if (!code) return;
    groupOwners.set(code, { coordinator: str(v[1]), coach: str(v[2]) });
  });

  // ---- Findings -----------------------------------------------------------
  const codes = roster.map((r) => r.groupCode).filter((c): c is string => !!c);
  const round = detectRound(codes);
  const rosterEmails = new Set(roster.map((r) => r.email).filter((e): e is string => !!e));
  const gigEmails = new Set(gigs.map((g) => g.studentEmail).filter((e): e is string => !!e));
  const orphanGigs = [...gigEmails].filter((e) => !rosterEmails.has(e));
  // Guard against a systematic epoch shift: it is invisible in a spot check and
  // silently changes who graduates.
  const sanity = priceColumnLooksSane(gigs.map((g) => g.price));
  if (!sanity.ok) {
    throw new Error(
      `Refusing to continue: the recovered price column does not look like money. ` +
        `${sanity.reason}.`,
    );
  }
  const missingPrice = gigs.filter((g) => g.price === null);
  const zeroPrice = gigs.filter((g) => g.price === 0);
  const accepted = gigs.filter((g) => g.qualityAccepted);

  console.log('=== WHAT THIS WORKBOOK CONTAINS ===');
  console.log(`  roster rows          ${roster.length} (${roster.filter((r) => r.type === 'STUDENT').length} students, ${roster.filter((r) => r.type === 'GRADUATE').length} graduates)`);
  console.log(`  distinct group codes ${new Set(codes).size}`);
  console.log(`  round (from codes)   ${round ?? 'MIXED / unknown'}`);
  console.log(`  gig rows             ${gigs.length}`);
  console.log(`  gigs Quality-accepted ${accepted.length}`);
  console.log(`  group->owner rows    ${groupOwners.size}`);

  console.log('\n=== DATA-QUALITY FINDINGS ===');
  const findings: string[] = [];
  if (round !== null && round !== 5) {
    findings.push(
      `This is ROUND ${round} data. The platform's confirmed requirements describe Round 5 ` +
        `(2,948 students / 131 groups); this workbook has ${new Set(codes).size} groups.`,
    );
  }
  findings.push(
    `Gig prices are stored DATE-FORMATTED in the export; every value was recovered from its ` +
      `Excel serial (modal value $${sanity.modal}). Read by header name and taken at face ` +
      `value, every gig in this file is unusable.`,
  );
  if (missingPrice.length) findings.push(`${missingPrice.length} gig(s) have no price at all.`);
  if (zeroPrice.length) findings.push(`${zeroPrice.length} gig(s) are priced $0.`);
  findings.push(
    `The Account Manager / Team Leader / Coordinator columns in the gig sheet are #NAME? on all ` +
      `${gigs.length} rows -- the formulas did not survive the export, so gig-level ownership is ` +
      `unusable and is taken from CoachesData by group code instead.`,
  );
  if (orphanGigs.length) {
    findings.push(`${orphanGigs.length} gig email(s) do not appear on the roster at all.`);
  }
  const noStatus = roster.filter((r) => !r.status).length;
  if (noStatus) findings.push(`${noStatus} roster row(s) carry no status.`);
  const login = wb.getWorksheet('Dashboard Login');
  if (login) {
    findings.push(
      `The "Dashboard Login" sheet holds ${login.rowCount - 1} staff accounts with PLAINTEXT ` +
        `passwords, most of which look like phone numbers. These are NOT imported as ` +
        `credentials. Treat them as compromised and reset them.`,
    );
  }
  findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  console.log('\n=== WHAT THE CONFIRMED RULE SAYS ABOUT THIS DATA ===');
  const byStudent = new Map<string, number[]>();
  for (const g of accepted) {
    if (!g.studentEmail) continue;
    const list = byStudent.get(g.studentEmail) ?? [];
    list.push(g.price ?? 0);
    byStudent.set(g.studentEmail, list);
  }
  let routeA = 0;
  let routeB = 0;
  let meets = 0;
  for (const values of byStudent.values()) {
    const a = values.filter((p) => p >= 5).length >= 3 && values.reduce((s, p) => s + p, 0) >= 15;
    const b = values.some((p) => p >= 300);
    if (a) routeA++;
    if (b) routeB++;
    if (a || b) meets++;
  }
  console.log(`  students with an accepted gig  ${byStudent.size}`);
  console.log(`  meet Route A (3 x >=$5, >=$15) ${routeA}`);
  console.log(`  meet Route B (1 x >=$300)      ${routeB}`);
  console.log(`  meet either                    ${meets}`);
  console.log(`  over the full roster           ${meets}/${roster.length} = ${((meets / roster.length) * 100).toFixed(1)}%`);

  if (!commit) {
    console.log('\nDRY RUN. Nothing was written. Re-run with --commit to import.');
    await pool.end();
    return;
  }

  // ---- Commit -------------------------------------------------------------
  console.log('\n=== IMPORTING ===');
  const client = await pool.connect();
  try {
    await seedRoles(client);
  } finally {
    client.release();
  }

  const { rows: sysUser } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1,'Workbook Import') RETURNING id`,
    [`import_${randomUUID().slice(0, 8)}@system.local`],
  );
  const actorId = sysUser[0].id as string;
  const { rows: adminRole } = await pool.query(`SELECT id FROM role WHERE key = 'system_admin'`);
  await pool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)`, [
    actorId,
    adminRole[0].id,
  ]);

  const ctx: RequestContext = {
    actor: {
      userId: actorId,
      roles: [SEED_ROLES_BY_KEY.get('system_admin')!],
      cohortIds: [],
    },
    realUserId: actorId,
    actorRoleKey: 'system_admin',
    correlationId: randomUUID(),
    source: 'IMPORT',
    elevated: false,
    now: new Date(),
  };
  const exec = createExecutor(pool);

  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1,'DEPI') RETURNING id`,
    [`depi_r${round ?? 'x'}_${randomUUID().slice(0, 6)}`],
  );
  const cohortCode = `R${round ?? 'X'}-IMPORT-${new Date().toISOString().slice(0, 10)}`;
  const { rows: coh } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state, timezone)
     VALUES ($1,$2,$3,'active','Africa/Cairo') RETURNING id`,
    [prog[0].id, cohortCode, `DEPI Round ${round ?? '?'} (imported)`],
  );
  const cohortId = coh[0].id as string;
  console.log(`  cohort ${cohortCode}`);

  // Providers and tracks, from what the data actually contains.
  const providerIds = new Map<string, string>();
  for (const code of new Set(roster.map((r) => r.provider).filter((p): p is string => !!p))) {
    const { rows } = await pool.query(
      `INSERT INTO provider (cohort_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [cohortId, code],
    );
    providerIds.set(code, rows[0].id);
  }
  const trackIds = new Map<string, string>();
  for (const code of new Set(codes.map((c) => parseGroupCode(c).track).filter((t): t is string => !!t))) {
    const { rows } = await pool.query(
      `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1,$2,$3::jsonb) RETURNING id`,
      [cohortId, code, JSON.stringify({ en: code })],
    );
    trackIds.set(code, rows[0].id);
  }
  console.log(`  ${providerIds.size} providers, ${trackIds.size} tracks`);

  // Staff, from CoachesData. Names only -- no credentials are imported.
  const staffIds = new Map<string, string>();
  async function staff(name: string, roleKey: string): Promise<string> {
    const existing = staffIds.get(name);
    if (existing) return existing;
    const { rows } = await pool.query(
      `INSERT INTO app_user (email, full_name, status) VALUES ($1,$2,'active') RETURNING id`,
      [`${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomUUID().slice(0, 6)}@imported.local`, name],
    );
    const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = $1`, [roleKey]);
    await pool.query(`INSERT INTO user_role (user_id, role_id, cohort_id) VALUES ($1,$2,$3)`, [
      rows[0].id,
      role[0].id,
      cohortId,
    ]);
    staffIds.set(name, rows[0].id);
    return rows[0].id;
  }

  const groupIds = new Map<string, string>();
  for (const code of new Set(codes)) {
    const parsed = parseGroupCode(code);
    const owners = groupOwners.get(code);
    const coordinatorId = owners?.coordinator ? await staff(owners.coordinator, 'operations_coordinator') : null;
    const coachId = owners?.coach ? await staff(owners.coach, 'outcome_coach') : null;
    const { rows } = await pool.query(
      `INSERT INTO cohort_group (cohort_id, code, track_id, coordinator_user_id, coach_user_id,
                                 planned_session_count, current_session_number)
       VALUES ($1,$2,$3,$4,$5,8,8) RETURNING id`,
      [cohortId, code, parsed.track ? trackIds.get(parsed.track) : null, coordinatorId, coachId],
    );
    groupIds.set(code, rows[0].id);
  }
  console.log(`  ${groupIds.size} groups, ${staffIds.size} staff (names only, NO credentials)`);

  // Students.
  const studentByEmail = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  for (const r of roster) {
    const key = identityKey({
      externalStudentId: r.nationalId ?? undefined,
      fullName: r.name,
      phone: r.phone ?? undefined,
      email: r.email ?? undefined,
    });
    const { rows } = await pool.query(
      `INSERT INTO student (cohort_id, cohort_group_id, external_student_id, identity_key,
                            full_name, phone_e164, email, track_id, provider_id, pathway,
                            current_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'outcome','coaching')
       ON CONFLICT (cohort_id, identity_key) DO NOTHING RETURNING id`,
      [
        cohortId,
        r.groupCode ? (groupIds.get(r.groupCode) ?? null) : null,
        r.nationalId,
        key,
        r.name,
        r.phone ? normalisePhone(r.phone) : null,
        r.email,
        r.groupCode ? (trackIds.get(parseGroupCode(r.groupCode).track ?? '') ?? null) : null,
        r.provider ? (providerIds.get(r.provider) ?? null) : null,
      ],
    );
    if (rows.length === 0) {
      skipped++;
      continue;
    }
    if (r.email) studentByEmail.set(r.email, rows[0].id);
    const coordinator = r.groupCode ? groupOwners.get(r.groupCode)?.coordinator : null;
    if (coordinator && staffIds.has(coordinator)) {
      await pool.query(
        `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
         VALUES ($1,$2,now())`,
        [rows[0].id, staffIds.get(coordinator)],
      );
    }
    imported++;
  }
  console.log(`  ${imported} students imported, ${skipped} duplicates skipped`);

  // Gigs. Acceptance carries over from the auditor's decision.
  let gigCount = 0;
  let gigSkipped = 0;
  for (const g of gigs) {
    const studentId = g.studentEmail ? studentByEmail.get(g.studentEmail) : undefined;
    if (!studentId || g.price === null) {
      gigSkipped++;
      continue;
    }
    const day = g.createdOn ? g.createdOn.toISOString().slice(0, 10) : null;
    await pool.query(
      `INSERT INTO gig (student_id, source, client_identifier, title, description, value_amount,
                        currency, value_toward_graduation, delivered_on, paid_on,
                        quality_accepted, locked_at)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11)`,
      [
        studentId,
        g.platform ?? 'unknown',
        g.url,
        g.title ?? 'Imported gig',
        g.category,
        g.price,
        g.qualityAccepted ? g.price : null,
        // A gig only counts when delivered AND paid; the export records neither
        // date, so acceptance stands in for both and is dated from creation.
        g.qualityAccepted ? day : null,
        g.qualityAccepted ? day : null,
        g.qualityAccepted,
        g.qualityAccepted ? new Date() : null,
      ],
    );
    gigCount++;
  }
  console.log(`  ${gigCount} gigs imported, ${gigSkipped} skipped (no matching student or price)`);

  // Compute graduation through the one calculation service, and project.
  console.log('  computing graduation...');
  let done = 0;
  for (const studentId of studentByEmail.values()) {
    await exec.execute(ctx, (scope) => recomputeGraduation(scope, studentId));
    await projectStudent(pool, studentId, CALENDAR);
    if (++done % 500 === 0) console.log(`    ${done}...`);
  }
  // Students with no gig still need a record and a place in the denominator.
  const { rows: rest } = await pool.query(
    `SELECT id FROM student WHERE cohort_id = $1 AND id NOT IN (
       SELECT student_id FROM graduation_progress WHERE cohort_id = $1)`,
    [cohortId],
  );
  for (const r of rest) {
    await exec.execute(ctx, (scope) => recomputeGraduation(scope, r.id));
    await projectStudent(pool, r.id, CALENDAR);
  }

  const summary = await graduationSummary(pool, cohortId);
  console.log('\n=== THE SYSTEM\'S OWN NUMBERS ===');
  console.log(`  denominator                 ${summary.denominator}`);
  console.log(`  graduated                   ${summary.graduated}`);
  console.log(`  rate                        ${summary.ratePercent.toFixed(1)}%`);
  console.log(`  contractual threshold       ${summary.contractualThresholdPercent}%  ` +
    `(gap ${summary.gapToContractual.toFixed(1)}pp, ${summary.studentsNeededForContractual} students)`);
  console.log(`  internal target             ${summary.internalTargetPercent}%  ` +
    `(gap ${summary.gapToInternal.toFixed(1)}pp, ${summary.studentsNeededForInternal} students)`);
  console.log(`\n  cohort code: ${cohortCode}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nIMPORT FAILED:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
