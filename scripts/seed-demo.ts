/**
 * The seeded demo cohort (§release readiness, docs/11 §15).
 *
 * Mirrors production configuration with synthetic people, so staff can practise
 * destructive actions -- rejecting evidence, marking a student unresponsive,
 * rolling back an import -- without touching a real record. Reset by re-running.
 *
 *   node --experimental-strip-types scripts/seed-demo.ts
 *
 * Every account uses the same demo password, which is printed at the end. This
 * is a training fixture and refuses to run against a database that already holds
 * a non-demo cohort with students, so it cannot be pointed at production by
 * accident.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedRoles } from '../packages/db/src/index.ts';
import {
  createExecutor,
  setPassword,
  projectStudent,
  submitEvidence,
  reviewStage,
  decideQuality,
  recordInteraction,
  ALL_CHECKS_PASS,
} from '../packages/core/src/index.ts';
import type { RequestContext } from '../packages/core/src/index.ts';
import { SEED_ROLES_BY_KEY } from '../packages/permissions/src/index.ts';
import type { WorkingCalendar } from '../packages/rules/src/index.ts';

const DEMO_PASSWORD = 'demo-cohort-practice-2026';

/**
 * Each run creates a NEW demo cohort rather than erasing the previous one.
 *
 * That is not laziness: a Quality decision is immutable and append-only, so once
 * training has produced one, the cohort's students cannot be deleted -- the
 * database refuses, correctly. Accounts are therefore suffixed per run so two
 * demo cohorts can coexist, and an old one is retired by closing it, exactly as
 * a real cohort is.
 */
const CALENDAR: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(),
};

const FIRST = ['Ahmed', 'Mona', 'Youssef', 'Salma', 'Omar', 'Nour', 'Khaled', 'Hana', 'Tarek', 'Dina'];
const LAST = ['Hassan', 'Farouk', 'Ibrahim', 'Mansour', 'Zaki', 'Adel', 'Nabil', 'Shafik'];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
});

function ctxFor(userId: string, roleKey: string): RequestContext {
  const role = SEED_ROLES_BY_KEY.get(roleKey);
  return {
    actor: { userId, roles: role ? [role] : [], cohortIds: [] },
    realUserId: userId,
    actorRoleKey: roleKey,
    correlationId: randomUUID(),
    source: 'IMPORT',
    elevated: false,
    now: new Date(),
  };
}

async function main() {
  // Refuse to run where real data lives.
  const { rows: real } = await pool.query(
    `SELECT count(*)::int AS n FROM student s JOIN cohort c ON c.id = s.cohort_id
     WHERE c.code NOT LIKE 'DEMO-%'`,
  );
  if (real[0].n > 0 && process.env.SEED_DEMO_FORCE !== '1') {
    console.error(
      `Refusing to seed: this database already holds ${real[0].n} student(s) outside a demo ` +
        `cohort. Set SEED_DEMO_FORCE=1 only if you are certain this is not production. ` +
        `Each run creates a NEW demo cohort; it never deletes an existing one.`,
    );
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await seedRoles(client);
  } finally {
    client.release();
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const code = `DEMO-${stamp}-${randomUUID().slice(0, 4)}`;

  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1,'DEPI Demo') RETURNING id`,
    [`demo_${randomUUID().slice(0, 8)}`],
  );
  const { rows: coh } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state, timezone, start_date, end_date)
     VALUES ($1,$2,'Round 5 (demo)','active','Africa/Cairo',
             CURRENT_DATE - 30, CURRENT_DATE + 60)
     RETURNING id`,
    [prog[0].id, code],
  );
  const cohortId = coh[0].id as string;

  const tracks: Record<string, string> = {};
  for (const t of ['data', 'web', 'design']) {
    const { rows } = await pool.query(
      `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1,$2,$3::jsonb) RETURNING id`,
      [cohortId, t, JSON.stringify({ en: t, ar: t })],
    );
    tracks[t] = rows[0].id;
  }
  for (const p of ['YAT', 'HRV', 'EUI']) {
    await pool.query(`INSERT INTO provider (cohort_id, code, name) VALUES ($1,$2,$2)`, [
      cohortId,
      p,
    ]);
  }

  const suffix = code.toLowerCase();

  async function user(roleKey: string, name: string): Promise<string> {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@demo.local`;
    const { rows } = await pool.query(
      `INSERT INTO app_user (email, full_name) VALUES ($1,$2) RETURNING id`,
      [email, name],
    );
    const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = $1`, [roleKey]);
    await pool.query(`INSERT INTO user_role (user_id, role_id, cohort_id) VALUES ($1,$2,$3)`, [
      rows[0].id,
      role[0].id,
      cohortId,
    ]);
    await setPassword(pool, rows[0].id, DEMO_PASSWORD);
    return rows[0].id;
  }

  const pm = await user('project_manager', `PM ${code}`);
  const ops = await user('project_operations', `Ops ${code}`);
  const supervisor = await user('team_supervisor', `Supervisor ${code}`);
  const qualityLead = await user('quality_lead', `Quality Lead ${code}`);
  const qualityMember = await user('quality_member', `Quality Member ${code}`);
  const coordinators = [
    await user('operations_coordinator', `Coordinator A ${code}`),
    await user('operations_coordinator', `Coordinator B ${code}`),
  ];
  const coaches = [
    await user('outcome_coach', `Outcome Coach ${code}`),
    await user('support_coach', `Support Coach ${code}`),
  ];
  for (const coach of coaches) {
    for (const trackId of Object.values(tracks)) {
      await pool.query(
        `INSERT INTO coach_specialisation (coach_user_id, track_id) VALUES ($1,$2)`,
        [coach, trackId],
      );
    }
  }

  const exec = createExecutor(pool);
  const trackKeys = Object.keys(tracks);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    const trackKey = trackKeys[g % trackKeys.length]!;
    const { rows } = await pool.query(
      `INSERT INTO cohort_group (cohort_id, code, track_id, pathway, planned_session_count,
                                 current_session_number, coordinator_user_id, supervisor_user_id,
                                 coach_user_id)
       VALUES ($1,$2,$3,$4,8,$5,$6,$7,$8) RETURNING id`,
      [
        cohortId,
        `G-${String(g + 1).padStart(2, '0')}`,
        tracks[trackKey],
        g === 3 ? 'support' : 'outcome',
        // Groups sit at DIFFERENT session positions: the cohort is rolling, and
        // a demo where every group is in lockstep teaches the wrong model.
        [2, 4, 6, 3][g],
        coordinators[g % coordinators.length],
        supervisor,
        coaches[g === 3 ? 1 : 0],
      ],
    );
    groups.push(rows[0].id);
  }

  const studentIds: string[] = [];
  let n = 0;
  for (const [gi, groupId] of groups.entries()) {
    for (let i = 0; i < 6; i++) {
      const name = `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]}`;
      n++;
      const { rows } = await pool.query(
        `INSERT INTO student (cohort_id, cohort_group_id, identity_key, full_name, phone_e164,
                              email, track_id, pathway, current_stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'coaching') RETURNING id`,
        [
          cohortId,
          groupId,
          randomUUID(),
          name,
          `+2010${String(10000000 + n).slice(0, 8)}`,
          `student${n}.record.${suffix}@demo.local`,
          tracks[trackKeys[gi % trackKeys.length]!],
          gi === 3 ? 'support' : 'outcome',
        ],
      );
      const studentId = rows[0].id as string;
      studentIds.push(studentId);

      // Every demo student gets a portal account: students submit their own
      // evidence (§10), so a demo without portal logins cannot exercise the
      // pipeline the way it actually runs.
      const { rows: portalUser } = await pool.query(
        `INSERT INTO app_user (email, full_name) VALUES ($1,$2) RETURNING id`,
        [`student${n}.${suffix}@demo.local`, name],
      );
      const { rows: studentRole } = await pool.query(`SELECT id FROM role WHERE key = 'student'`);
      await pool.query(`INSERT INTO user_role (user_id, role_id, cohort_id) VALUES ($1,$2,$3)`, [
        portalUser[0].id,
        studentRole[0].id,
        cohortId,
      ]);
      await pool.query(`INSERT INTO student_account (user_id, student_id) VALUES ($1,$2)`, [
        portalUser[0].id,
        studentId,
      ]);
      await setPassword(pool, portalUser[0].id, DEMO_PASSWORD);

      await pool.query(
        `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
         VALUES ($1,$2,now() - interval '20 days')`,
        [studentId, coordinators[gi % coordinators.length]],
      );
      await pool.query(
        `INSERT INTO student_coach_assignment (student_id, coach_user_id, coaching_type,
                                               effective_from)
         VALUES ($1,$2,'t1',now() - interval '20 days')`,
        [studentId, coaches[gi === 3 ? 1 : 0]],
      );

      // A spread of realistic states, so every exception queue has something in
      // it and staff can practise on a queue that is not empty.
      if (i > 0) {
        await exec.execute(ctxFor(coordinators[gi % coordinators.length]!, 'operations_coordinator'), (scope) =>
          recordInteraction(scope, {
            studentId,
            channel: i % 2 === 0 ? 'whatsapp' : 'phone',
            purpose: 'weekly_follow_up',
            outcome: i % 3 === 0 ? 'no_response' : 'responded',
            agreedAction: 'Complete the profile',
            calendar: CALENDAR,
          }),
        );
      }

      // One student per group carries an accepted gig; one carries a rejection
      // sitting open in the correction loop.
      if (i === 1 || i === 2) {
        const { rows: gig } = await pool.query(
          `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
           VALUES ($1,'khamsat',$2,$3,CURRENT_DATE - 10, CURRENT_DATE - 8) RETURNING id`,
          [studentId, `Demo gig ${n}`, 10],
        );
        const { value: sub } = await exec.execute(ctxFor(portalUser[0].id, 'student'), (scope) =>
          submitEvidence(scope, {
            studentId,
            subjectType: 'gig',
            gigId: gig[0].id,
            files: [
              { kind: 'completed_order_page', fileRef: `demo://order/${n}`, contentHash: Buffer.from(randomUUID()) },
              { kind: 'earnings_or_balance_proof', fileRef: `demo://pay/${n}`, contentHash: Buffer.from(randomUUID()) },
            ],
            calendar: CALENDAR,
          }),
        );
        await exec.execute(ctxFor(coaches[0]!, 'outcome_coach'), (scope) =>
          reviewStage(scope, { submissionId: sub.submissionId, stage: 'coach', decision: 'passed', calendar: CALENDAR }),
        );
        await exec.execute(ctxFor(coordinators[gi % coordinators.length]!, 'operations_coordinator'), (scope) =>
          reviewStage(scope, { submissionId: sub.submissionId, stage: 'l1', decision: 'passed', calendar: CALENDAR }),
        );
        if (i === 1) {
          await exec.execute(ctxFor(qualityMember, 'quality_member'), (scope) =>
            decideQuality(scope, {
              submissionId: sub.submissionId,
              level: 'l2',
              checks: ALL_CHECKS_PASS,
              rejectionCodes: [],
              calendar: CALENDAR,
            }),
          );
        }
        // i === 2 is deliberately LEFT in the Quality queue, so the queue is not
        // empty on the first day of training.
      }

      await projectStudent(pool, studentId, CALENDAR);
    }
  }

  // Sessions across the coming days, some unconfirmed so the coverage exception
  // queue has content.
  for (const [gi, groupId] of groups.entries()) {
    for (let s = 1; s <= 3; s++) {
      await pool.query(
        `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                              scheduled_date, slot_key, coach_confirmed)
         VALUES ($1,$2,$3,$4, CURRENT_DATE + ($5::int), 'slot_17_20', $6)
         ON CONFLICT DO NOTHING`,
        [
          groupId,
          tracks[trackKeys[gi % trackKeys.length]!],
          coaches[gi === 3 ? 1 : 0],
          s,
          // Spread across days: a coach cannot hold two groups on one day.
          gi * 3 + s,
          s === 1 ? 'confirmed' : null,
        ],
      );
    }
  }

  console.log(`
Demo cohort seeded.

  Cohort code   ${code}
  Students      ${studentIds.length} across ${groups.length} groups at different session positions
  Password      ${DEMO_PASSWORD}

  Sign in as (password above):
    pm.${suffix}@demo.local              Project Manager
    ops.${suffix}@demo.local             Project Operations
    supervisor.${suffix}@demo.local      Team Supervisor
    coordinator.a.${suffix}@demo.local   Operations Coordinator
    outcome.coach.${suffix}@demo.local   Outcome Coach
    quality.member.${suffix}@demo.local  Quality Member
    quality.lead.${suffix}@demo.local    Quality Lead

  Every demo student also has a portal account:
    student1.${suffix}@demo.local ... student${studentIds.length}.${suffix}@demo.local

  The Quality queue is deliberately non-empty and one submission sits in the
  correction loop, so every screen has something to practise on.
`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
