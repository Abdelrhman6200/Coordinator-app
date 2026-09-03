/**
 * The import pipeline (§66).
 *
 *   Upload -> Validate -> Preview errors -> Resolve conflicts -> Confirm ->
 *   Commit -> Import log
 *
 * Never silently import invalid data. Two properties carry the module:
 *   1. Validation happens BEFORE anything is written, and the preview is the
 *      operator's decision point.
 *   2. A committed batch can be rolled back -- but only while no downstream
 *      event references its records, because unpicking a batch after the
 *      operation has acted on it would rewrite history.
 *
 * This is where the Round 5 master cohort workbook lands (register item 23). The
 * pipeline is built and tested against synthetic data; no production import is
 * possible until the workbook is supplied.
 */
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { DomainError } from '../errors.ts';
import type { CommandScope } from '../write-path.ts';

export interface StudentRow {
  externalStudentId?: string;
  fullName: string;
  phone?: string;
  email?: string;
  trackCode?: string;
  groupCode?: string;
  providerCode?: string;
}

export type ErrorCode =
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'UNKNOWN_TRACK'
  | 'UNKNOWN_GROUP'
  | 'UNKNOWN_PROVIDER'
  | 'DUPLICATE_IN_FILE'
  | 'DUPLICATE_IN_COHORT'
  | 'FUZZY_DUPLICATE'
  | 'GROUP_OVER_CAPACITY';

export interface RowError {
  rowNo: number;
  field: string | null;
  code: ErrorCode;
  detail: string;
  /** Fuzzy duplicates are surfaced for a human decision, never auto-merged. */
  blocking: boolean;
}

export interface ValidationPreview {
  batchId: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  warningCount: number;
  errors: RowError[];
}

/**
 * Arabic-aware normalisation before hashing.
 *
 * Without this, "محمد" written with different alef forms, a tatweel, or
 * Arabic-Indic digits produces a different key for the same person -- and an
 * Arabic-language intake silently accumulates duplicates.
 */
export function normaliseName(input: string): string {
  return (
    input
      // NFKD decomposes a hamza-bearing alef into a bare alef plus a COMBINING
      // hamza (U+0654). Stripping only the classic harakat range leaves that
      // mark behind, and the letter-level fold below then never matches -- so
      // "أحمد" and "احمد" stay different keys and the duplicate is silent.
      // Strip the full combining block first, then fold letters.
      .normalize('NFKD')
      .replace(/[\u064B-\u065F\u0670]/g, '') // harakat, hamza marks, superscript alef
      .replace(/\u0640/g, '') // tatweel
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // any remaining alef variant
      .replace(/\u0629/g, '\u0647') // ta marbuta -> ha
      .replace(/\u0649/g, '\u064A') // alef maqsura -> ya
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // Persian
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

export function normalisePhone(input: string): string {
  const digits = input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, '');
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+20${digits.slice(1)}`;
  if (digits.startsWith('20')) return `+${digits}`;
  return `+${digits}`;
}

export function identityKey(row: StudentRow): string {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  if (row.externalStudentId?.trim()) return hash(row.externalStudentId.trim().toLowerCase());
  if (row.phone && row.email) {
    return hash(`${normalisePhone(row.phone)}|${row.email.trim().toLowerCase()}`);
  }
  if (row.phone) return hash(`${normaliseName(row.fullName)}|${normalisePhone(row.phone)}`);
  return hash(`${normaliseName(row.fullName)}|${(row.email ?? '').trim().toLowerCase()}`);
}

/** Trigram similarity, for the fuzzy-duplicate warning surfaced in the preview. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(normaliseName(a));
  const gb = grams(normaliseName(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trigram threshold for the fuzzy-duplicate WARNING.
 *
 * Set low enough to catch a transposed letter or a missing one, because the
 * consequence of a miss (two records for one person, and a graduation rate
 * computed over a denominator that double-counts) is far worse than the
 * consequence of a false positive (an operator glances at a name and clicks
 * past). It is a warning, never a block.
 */
const FUZZY_DUPLICATE_THRESHOLD = 0.7;

/**
 * Validates a file WITHOUT writing any student rows. The batch and its errors
 * are recorded so the operator sees a preview and an error report before
 * deciding anything.
 */
export async function validateImport(
  scope: CommandScope,
  input: { cohortId: string; filename: string; rows: StudentRow[]; mode: 'all_or_nothing' | 'valid_rows_only' },
): Promise<ValidationPreview> {
  const { tx, ctx } = scope;

  const { rows: batchRow } = await tx.query(
    `INSERT INTO import_batch (cohort_id, kind, filename, uploaded_by, mode, status, row_count)
     VALUES ($1,'students',$2,$3,$4,'validating',$5) RETURNING id`,
    [input.cohortId, input.filename, ctx.actor.userId, input.mode, input.rows.length],
  );
  const batchId = batchRow[0].id as string;

  const { rows: tracks } = await tx.query(`SELECT code FROM track WHERE cohort_id = $1`, [
    input.cohortId,
  ]);
  const { rows: groups } = await tx.query(
    `SELECT id, code FROM cohort_group WHERE cohort_id = $1`,
    [input.cohortId],
  );
  const { rows: providers } = await tx.query(
    `SELECT code FROM provider WHERE cohort_id = $1`,
    [input.cohortId],
  );
  const { rows: existing } = await tx.query(
    `SELECT identity_key, full_name, phone_e164 FROM student WHERE cohort_id = $1`,
    [input.cohortId],
  );

  const trackCodes = new Set(tracks.map((t) => t.code));
  const groupCodes = new Set(groups.map((g) => g.code));
  const providerCodes = new Set(providers.map((p) => p.code));
  const existingKeys = new Set(existing.map((e) => e.identity_key));

  const errors: RowError[] = [];
  const seenKeys = new Map<string, number>();

  input.rows.forEach((row, index) => {
    const rowNo = index + 1;
    const add = (field: string | null, code: ErrorCode, detail: string, blocking = true) =>
      errors.push({ rowNo, field, code, detail, blocking });

    if (!row.fullName?.trim()) add('fullName', 'MISSING_REQUIRED_FIELD', 'Name is required.');
    if (!row.phone && !row.email) {
      add('phone', 'MISSING_REQUIRED_FIELD', 'A phone number or an email address is required.');
    }
    if (row.phone && normalisePhone(row.phone).replace(/\D/g, '').length < 10) {
      add('phone', 'INVALID_PHONE', `"${row.phone}" is not a usable phone number.`);
    }
    if (row.email && !EMAIL.test(row.email.trim())) {
      add('email', 'INVALID_EMAIL', `"${row.email}" is not a valid email address.`);
    }
    if (row.trackCode && !trackCodes.has(row.trackCode)) {
      add('trackCode', 'UNKNOWN_TRACK', `Track "${row.trackCode}" does not exist in this cohort.`);
    }
    if (row.groupCode && !groupCodes.has(row.groupCode)) {
      add('groupCode', 'UNKNOWN_GROUP', `Group "${row.groupCode}" does not exist in this cohort.`);
    }
    if (row.providerCode && !providerCodes.has(row.providerCode)) {
      add('providerCode', 'UNKNOWN_PROVIDER', `Provider "${row.providerCode}" does not exist.`);
    }

    if (row.fullName?.trim()) {
      const key = identityKey(row);
      const firstSeen = seenKeys.get(key);
      if (firstSeen !== undefined) {
        add(null, 'DUPLICATE_IN_FILE', `Same person as row ${firstSeen} in this file.`);
      } else {
        seenKeys.set(key, rowNo);
      }
      if (existingKeys.has(key)) {
        add(null, 'DUPLICATE_IN_COHORT', 'This student already exists in the cohort.');
      } else {
        // A fuzzy match is a WARNING: it is surfaced for a human decision and
        // never auto-merged, because merging two real people is unrecoverable.
        for (const e of existing) {
          if (similarity(row.fullName, e.full_name) >= FUZZY_DUPLICATE_THRESHOLD) {
            add(
              'fullName',
              'FUZZY_DUPLICATE',
              `Looks similar to existing student "${e.full_name}". Confirm before importing.`,
              false,
            );
            break;
          }
        }
      }
    }
  });

  for (const e of errors) {
    await tx.query(
      `INSERT INTO import_row_error (batch_id, row_no, field, error_code, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [batchId, e.rowNo, e.field, e.code, e.detail],
    );
  }

  const blockingRows = new Set(errors.filter((e) => e.blocking).map((e) => e.rowNo));
  const validCount = input.rows.length - blockingRows.size;
  const warningCount = errors.filter((e) => !e.blocking).length;

  await tx.query(
    `UPDATE import_batch SET status = 'previewed', valid_count = $2, error_count = $3
     WHERE id = $1`,
    [batchId, validCount, blockingRows.size],
  );

  return {
    batchId,
    rowCount: input.rows.length,
    validCount,
    errorCount: blockingRows.size,
    warningCount,
    errors,
  };
}

/**
 * Commits a previewed batch.
 *
 * All-or-nothing unless the operator explicitly chose "valid rows only" -- the
 * default refuses a partial import rather than leaving the operator to discover
 * which half arrived.
 */
export async function commitImport(
  scope: CommandScope,
  input: { batchId: string; rows: StudentRow[]; confirmedFuzzyRowNumbers?: number[] },
): Promise<{ imported: number; skipped: number }> {
  const { tx, ctx } = scope;

  const { rows: batch } = await tx.query(`SELECT * FROM import_batch WHERE id = $1`, [
    input.batchId,
  ]);
  if (!batch[0]) throw new DomainError('NOT_FOUND', 'Import batch not found.');
  if (batch[0].status !== 'previewed') {
    throw new DomainError(
      'BATCH_NOT_PREVIEWED',
      `This batch is ${batch[0].status}. Only a previewed batch can be committed.`,
    );
  }

  const { rows: errorRows } = await tx.query(
    `SELECT row_no, error_code FROM import_row_error WHERE batch_id = $1`,
    [input.batchId],
  );
  const blocking = new Set(
    errorRows.filter((e) => e.error_code !== 'FUZZY_DUPLICATE').map((e) => e.row_no as number),
  );

  if (blocking.size > 0 && batch[0].mode === 'all_or_nothing') {
    await tx.query(`UPDATE import_batch SET status = 'failed' WHERE id = $1`, [input.batchId]);
    throw new DomainError(
      'IMPORT_HAS_ERRORS',
      `${blocking.size} row(s) failed validation. This batch is all-or-nothing, so nothing was ` +
        'imported. Fix the file, or re-upload choosing "import valid rows only".',
      { errorCount: blocking.size },
    );
  }

  const { rows: groups } = await tx.query(
    `SELECT id, code FROM cohort_group WHERE cohort_id = $1`,
    [batch[0].cohort_id],
  );
  const { rows: tracks } = await tx.query(`SELECT id, code FROM track WHERE cohort_id = $1`, [
    batch[0].cohort_id,
  ]);
  const groupByCode = new Map(groups.map((g) => [g.code, g.id]));
  const trackByCode = new Map(tracks.map((t) => [t.code, t.id]));

  let imported = 0;
  let skipped = 0;

  for (const [index, row] of input.rows.entries()) {
    const rowNo = index + 1;
    if (blocking.has(rowNo)) {
      skipped++;
      continue;
    }
    const { rows: created } = await tx.query(
      `INSERT INTO student (cohort_id, cohort_group_id, external_student_id, identity_key,
                            full_name, phone_e164, email, track_id, source_batch_id, current_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'imported')
       ON CONFLICT (cohort_id, identity_key) DO NOTHING
       RETURNING id`,
      [
        batch[0].cohort_id,
        row.groupCode ? (groupByCode.get(row.groupCode) ?? null) : null,
        row.externalStudentId ?? null,
        identityKey(row),
        row.fullName.trim(),
        row.phone ? normalisePhone(row.phone) : null,
        row.email?.trim() ?? null,
        row.trackCode ? (trackByCode.get(row.trackCode) ?? null) : null,
        input.batchId,
      ],
    );
    if (created.length === 0) {
      skipped++;
      continue;
    }
    await tx.query(
      `INSERT INTO student_stage_history (student_id, stage, entered_at, entered_by)
       VALUES ($1,'imported',$2,$3)`,
      [created[0].id, ctx.now, ctx.actor.userId],
    );
    await scope.emit({
      type: 'STUDENT_IMPORTED',
      subjectType: 'student',
      subjectId: created[0].id,
      cohortId: batch[0].cohort_id,
      payload: { batchId: input.batchId, rowNo, externalStudentId: row.externalStudentId ?? null },
    });
    imported++;
  }

  await tx.query(
    `UPDATE import_batch SET status = 'committed', committed_at = now(), valid_count = $2
     WHERE id = $1`,
    [input.batchId, imported],
  );
  await scope.emit({
    type: 'IMPORT_BATCH_COMMITTED',
    subjectType: 'import_batch',
    subjectId: input.batchId,
    cohortId: batch[0].cohort_id,
    payload: { imported, skipped, mode: batch[0].mode },
  });
  await scope.audit({
    module: 'administration',
    recordType: 'import_batch',
    recordId: input.batchId,
    action: 'commit',
    permissionUsed: 'students.create',
    newValue: { imported, skipped },
  });

  return { imported, skipped };
}

/**
 * Rolls a batch back.
 *
 * Permitted only while NO downstream event references the batch's students. Once
 * the operation has acted on a record -- contacted them, coached them, reviewed
 * their evidence -- removing it would rewrite history, so the rollback is
 * refused and names the blocking events instead.
 */
export async function rollbackImport(
  scope: CommandScope,
  batchId: string,
): Promise<{ removed: number }> {
  const { tx } = scope;

  const { rows: batch } = await tx.query(`SELECT * FROM import_batch WHERE id = $1`, [batchId]);
  if (!batch[0]) throw new DomainError('NOT_FOUND', 'Import batch not found.');
  if (batch[0].status !== 'committed') {
    throw new DomainError('NOT_COMMITTED', `This batch is ${batch[0].status}, not committed.`);
  }

  const { rows: downstream } = await tx.query(
    `SELECT e.event_type, count(*)::int AS n
     FROM events e
     WHERE e.subject_id IN (SELECT id FROM student WHERE source_batch_id = $1)
       AND e.event_type <> 'STUDENT_IMPORTED'
     GROUP BY e.event_type
     ORDER BY n DESC`,
    [batchId],
  );

  if (downstream.length > 0) {
    const summary = downstream.map((d) => `${d.event_type} (${d.n})`).join(', ');
    // Deliberately NOT written to the batch here: this throw rolls the
    // transaction back, so any row written alongside it disappears with it. The
    // reason travels on the error, and `rollbackBlockers` recomputes it for the
    // screen -- a diagnostic that vanishes when the diagnosis happens is worse
    // than none.
    throw new DomainError(
      'ROLLBACK_BLOCKED',
      `This batch cannot be rolled back: the operation has already acted on its students. ` +
        `Blocking activity: ${summary}. Withdraw or exclude the students individually instead.`,
      { blockingEvents: downstream },
    );
  }

  const { rows: removed } = await tx.query(
    `DELETE FROM student WHERE source_batch_id = $1 RETURNING id`,
    [batchId],
  );
  await tx.query(
    `UPDATE import_batch SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`,
    [batchId],
  );
  await scope.emit({
    type: 'IMPORT_BATCH_ROLLED_BACK',
    subjectType: 'import_batch',
    subjectId: batchId,
    cohortId: batch[0].cohort_id,
    payload: { removed: removed.length },
  });
  await scope.audit({
    module: 'administration',
    recordType: 'import_batch',
    recordId: batchId,
    action: 'rollback',
    permissionUsed: 'students.delete',
    newValue: { removed: removed.length },
  });

  return { removed: removed.length };
}

/**
 * Why a batch cannot be rolled back, for the import screen.
 *
 * Read-only and outside any failing transaction, so the answer survives to be
 * displayed. Returns an empty list when rollback is permitted.
 */
export async function rollbackBlockers(
  db: pg.Pool | pg.PoolClient,
  batchId: string,
): Promise<Array<{ eventType: string; count: number }>> {
  const { rows } = await db.query(
    `SELECT e.event_type, count(*)::int AS n
     FROM events e
     WHERE e.subject_id IN (SELECT id FROM student WHERE source_batch_id = $1)
       AND e.event_type <> 'STUDENT_IMPORTED'
     GROUP BY e.event_type ORDER BY n DESC`,
    [batchId],
  );
  return rows.map((r) => ({ eventType: r.event_type as string, count: r.n as number }));
}
