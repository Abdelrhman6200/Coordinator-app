/**
 * Import pipeline tests (§66).
 *
 * These matter more than most: this is where the Round 5 master cohort workbook
 * lands, and a silent duplicate or a half-applied batch at intake poisons every
 * number downstream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { seedRoles } from '@coordinator/db';
import { createExecutor, type Executor } from '../src/write-path.ts';
import {
  commitImport,
  identityKey,
  normaliseName,
  normalisePhone,
  rollbackBlockers,
  rollbackImport,
  similarity,
  validateImport,
  type StudentRow,
} from '../src/services/import.ts';
import { recordInteraction } from '../src/services/students.ts';
import { CALENDAR, ctxFor, makePool } from './fixture.ts';

let pool: pg.Pool;
let exec: Executor;
let cohortId: string;
let opsId: string;

beforeAll(async () => {
  pool = makePool();
  const c = await pool.connect();
  try {
    await seedRoles(c);
  } finally {
    c.release();
  }
  exec = createExecutor(pool);

  const n = randomUUID().slice(0, 8);
  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1,'DEPI') RETURNING id`,
    [`imp_${n}`],
  );
  const { rows: coh } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state) VALUES ($1,$2,'R5','active') RETURNING id`,
    [prog[0].id, `imp_r5_${n}`],
  );
  cohortId = coh[0].id;
  await pool.query(
    `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1,'data','{"en":"Data"}'::jsonb)`,
    [cohortId],
  );
  await pool.query(
    `INSERT INTO cohort_group (cohort_id, code) VALUES ($1,'G-01')`,
    [cohortId],
  );
  const { rows: user } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1,'Ops') RETURNING id`,
    [`ops_${n}@example.test`],
  );
  opsId = user[0].id;
  const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = 'project_operations'`);
  await pool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)`, [
    opsId,
    role[0].id,
  ]);
});

afterAll(async () => {
  await pool.end();
});

const ctx = () => ctxFor(opsId, 'project_operations');

function row(over: Partial<StudentRow> = {}): StudentRow {
  return {
    externalStudentId: `EXT-${randomUUID().slice(0, 8)}`,
    fullName: 'Ahmed Hassan',
    phone: '01001234567',
    email: `a_${randomUUID().slice(0, 6)}@example.test`,
    trackCode: 'data',
    groupCode: 'G-01',
    ...over,
  };
}

describe('Arabic-aware normalisation', () => {
  it('folds alef variants, ta marbuta and tatweel to one form', () => {
    // Without this an Arabic intake accumulates duplicates that look identical
    // on screen.
    expect(normaliseName('أحمد')).toBe(normaliseName('احمد'));
    expect(normaliseName('إبراهيم')).toBe(normaliseName('ابراهيم'));
    expect(normaliseName('فاطمة')).toBe(normaliseName('فاطمه'));
    expect(normaliseName('محـــمد')).toBe(normaliseName('محمد'));
  });

  it('strips diacritics', () => {
    expect(normaliseName('مُحَمَّد')).toBe(normaliseName('محمد'));
  });

  it('converts Arabic-Indic digits', () => {
    expect(normaliseName('طالب ٢٠٢٦')).toBe('طالب 2026');
  });

  it('normalises Egyptian phone formats to E.164', () => {
    expect(normalisePhone('01001234567')).toBe('+201001234567');
    expect(normalisePhone('+20 100 123 4567')).toBe('+201001234567');
    expect(normalisePhone('0020-100-1234567')).toBe('+201001234567');
    expect(normalisePhone('٠١٠٠١٢٣٤٥٦٧')).toBe('+201001234567');
  });

  it('gives the same identity key for the same person written differently', () => {
    const a = identityKey({ fullName: 'أحمد حسن', phone: '01001234567' });
    const b = identityKey({ fullName: 'احمد حسن', phone: '+20 100 123 4567' });
    expect(a).toBe(b);
  });

  it('gives different keys for different people', () => {
    expect(identityKey({ fullName: 'Ahmed', phone: '01001234567' })).not.toBe(
      identityKey({ fullName: 'Ahmed', phone: '01001234568' }),
    );
  });
});

describe('similarity', () => {
  it('scores a near match high and an unrelated name low', () => {
    expect(similarity('Ahmed Hassan', 'Ahmad Hassan')).toBeGreaterThan(0.5);
    expect(similarity('Ahmed Hassan', 'Mona Farouk')).toBeLessThan(0.2);
  });
});

describe('validation happens before anything is written', () => {
  it('reports errors and writes no students', async () => {
    const rows = [
      row(),
      row({ fullName: '', phone: '01001234500' }),
      row({ phone: undefined, email: undefined }),
      row({ trackCode: 'nonexistent' }),
      row({ email: 'not-an-email' }),
    ];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, {
        cohortId,
        filename: 'r5.xlsx',
        rows,
        mode: 'all_or_nothing',
      }),
    );

    expect(preview.rowCount).toBe(5);
    expect(preview.errorCount).toBe(4);
    expect(preview.validCount).toBe(1);
    expect(preview.errors.map((e) => e.code)).toContain('MISSING_REQUIRED_FIELD');
    expect(preview.errors.map((e) => e.code)).toContain('UNKNOWN_TRACK');
    expect(preview.errors.map((e) => e.code)).toContain('INVALID_EMAIL');

    const { rows: students } = await pool.query(
      `SELECT count(*)::int AS n FROM student WHERE cohort_id = $1`,
      [cohortId],
    );
    expect(students[0].n).toBe(0);
  });

  it('detects a duplicate within the file itself', async () => {
    const dup = row();
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, {
        cohortId,
        filename: 'dup.xlsx',
        rows: [dup, { ...dup }],
        mode: 'all_or_nothing',
      }),
    );
    const codes = preview.errors.map((e) => e.code);
    expect(codes).toContain('DUPLICATE_IN_FILE');
  });

  it('records the error report against the batch for the operator', async () => {
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, {
        cohortId,
        filename: 'e.xlsx',
        rows: [row({ fullName: '' })],
        mode: 'all_or_nothing',
      }),
    );
    const { rows } = await pool.query(
      `SELECT error_code, detail FROM import_row_error WHERE batch_id = $1`,
      [preview.batchId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].detail).toBeTruthy();
  });
});

describe('all-or-nothing is the default', () => {
  it('refuses to commit a batch with any blocking error, importing nothing', async () => {
    const rows = [row(), row({ fullName: '' })];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, { cohortId, filename: 'x.xlsx', rows, mode: 'all_or_nothing' }),
    );
    await expect(
      exec.execute(ctx(), (scope) => commitImport(scope, { batchId: preview.batchId, rows })),
    ).rejects.toThrow(/all-or-nothing/);

    const { rows: students } = await pool.query(
      `SELECT count(*)::int AS n FROM student WHERE source_batch_id = $1`,
      [preview.batchId],
    );
    expect(students[0].n).toBe(0);
  });

  it('imports the valid rows when the operator explicitly chooses to', async () => {
    const rows = [row(), row({ fullName: '' }), row()];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, { cohortId, filename: 'v.xlsx', rows, mode: 'valid_rows_only' }),
    );
    const { value: result } = await exec.execute(ctx(), (scope) =>
      commitImport(scope, { batchId: preview.batchId, rows }),
    );
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
  });
});

describe('a clean import', () => {
  let batchId: string;
  let rows: StudentRow[];

  it('commits every row and stamps the batch on each record', async () => {
    rows = [row({ fullName: 'Clean One' }), row({ fullName: 'Clean Two' })];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, { cohortId, filename: 'clean.xlsx', rows, mode: 'all_or_nothing' }),
    );
    expect(preview.errorCount).toBe(0);

    batchId = preview.batchId;
    const { value: result } = await exec.execute(ctx(), (scope) =>
      commitImport(scope, { batchId, rows }),
    );
    expect(result.imported).toBe(2);

    const { rows: students } = await pool.query(
      `SELECT full_name, current_stage FROM student WHERE source_batch_id = $1 ORDER BY full_name`,
      [batchId],
    );
    expect(students.map((s) => s.full_name)).toEqual(['Clean One', 'Clean Two']);
    expect(students[0].current_stage).toBe('imported');
  });

  it('emits an event per student and one for the batch', async () => {
    const { rows: perStudent } = await pool.query(
      `SELECT count(*)::int AS n FROM events
       WHERE event_type = 'STUDENT_IMPORTED' AND payload->>'batchId' = $1`,
      [batchId],
    );
    const { rows: batchEvent } = await pool.query(
      `SELECT count(*)::int AS n FROM events
       WHERE event_type = 'IMPORT_BATCH_COMMITTED' AND subject_id = $1`,
      [batchId],
    );
    expect(perStudent[0].n).toBe(2);
    expect(batchEvent[0].n).toBe(1);
  });

  it('opens a stage history row so dwell time is measurable from the start', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM student_stage_history sh
       JOIN student s ON s.id = sh.student_id WHERE s.source_batch_id = $1`,
      [batchId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('warns about a fuzzy duplicate on a later import without blocking it', async () => {
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, {
        cohortId,
        filename: 'fuzzy.xlsx',
        rows: [row({ fullName: 'Clean Onee' })],
        mode: 'all_or_nothing',
      }),
    );
    const fuzzy = preview.errors.filter((e) => e.code === 'FUZZY_DUPLICATE');
    expect(fuzzy.length).toBe(1);
    // Surfaced for a human decision, never auto-merged: merging two real people
    // is unrecoverable.
    expect(fuzzy[0]!.blocking).toBe(false);
    expect(preview.errorCount).toBe(0);
    expect(preview.warningCount).toBe(1);
  });

  it('rolls back while no downstream event references its students', async () => {
    const fresh = [row({ fullName: 'Rollback Me' })];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, { cohortId, filename: 'rb.xlsx', rows: fresh, mode: 'all_or_nothing' }),
    );
    await exec.execute(ctx(), (scope) =>
      commitImport(scope, { batchId: preview.batchId, rows: fresh }),
    );
    const { value: result } = await exec.execute(ctx(), (scope) =>
      rollbackImport(scope, preview.batchId),
    );
    expect(result.removed).toBe(1);

    const { rows: gone } = await pool.query(
      `SELECT count(*)::int AS n FROM student WHERE source_batch_id = $1`,
      [preview.batchId],
    );
    expect(gone[0].n).toBe(0);
  });

  it('refuses rollback once the operation has acted on a student', async () => {
    const fresh = [row({ fullName: 'Contacted Already' })];
    const { value: preview } = await exec.execute(ctx(), (scope) =>
      validateImport(scope, { cohortId, filename: 'ct.xlsx', rows: fresh, mode: 'all_or_nothing' }),
    );
    await exec.execute(ctx(), (scope) =>
      commitImport(scope, { batchId: preview.batchId, rows: fresh }),
    );
    const { rows: student } = await pool.query(
      `SELECT id FROM student WHERE source_batch_id = $1`,
      [preview.batchId],
    );
    await pool.query(
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
       VALUES ($1,$2,now())`,
      [student[0].id, opsId],
    );
    await exec.execute(ctx(), (scope) =>
      recordInteraction(scope, {
        studentId: student[0].id,
        channel: 'whatsapp',
        purpose: 'onboarding',
        outcome: 'responded',
        calendar: CALENDAR,
      }),
    );

    await expect(
      exec.execute(ctx(), (scope) => rollbackImport(scope, preview.batchId)),
    ).rejects.toThrow(/cannot be rolled back/);

    // And it says WHY, naming the activity rather than just refusing. The
    // reason is recomputed outside the failed transaction, since anything
    // written inside it would have rolled back with the refusal.
    const blockers = await rollbackBlockers(pool, preview.batchId);
    expect(blockers.map((b) => b.eventType)).toContain('INTERACTION_RECORDED');
  });

  it('refuses to commit a batch twice', async () => {
    await expect(
      exec.execute(ctx(), (scope) => commitImport(scope, { batchId, rows })),
    ).rejects.toThrow(/previewed/);
  });
});
