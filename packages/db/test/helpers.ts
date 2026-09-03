import pg from 'pg';

export const URL =
  process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator';

export function client(): pg.Client {
  return new pg.Client({ connectionString: URL });
}

/** Runs `fn` on a fresh connection and always closes it. */
export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = client();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Asserts the statement is refused, returning the error for inspection. */
export async function expectRefused(c: pg.Client, sql: string, params: unknown[] = []) {
  try {
    await c.query(sql, params);
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error(`expected the database to refuse: ${sql.slice(0, 120)}`);
}

export interface Fixture {
  programId: string;
  cohortId: string;
  userA: string;
  userB: string;
  studentId: string;
}

let counter = 0;

/** A minimal, isolated fixture. Each call uses fresh codes so tests do not collide. */
export async function seed(c: pg.Client): Promise<Fixture> {
  const n = `${Date.now()}_${counter++}`;
  const program = await c.query(
    `INSERT INTO program (code, name) VALUES ($1, 'Test') RETURNING id`,
    [`prog_${n}`],
  );
  const programId = program.rows[0].id;
  const cohort = await c.query(
    `INSERT INTO cohort (program_id, code, name, state) VALUES ($1, $2, 'Cohort', 'active')
     RETURNING id`,
    [programId, `coh_${n}`],
  );
  const cohortId = cohort.rows[0].id;
  const users = await c.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'A'), ($2, 'B') RETURNING id`,
    [`a_${n}@example.test`, `b_${n}@example.test`],
  );
  const student = await c.query(
    `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164)
     VALUES ($1, $2, 'Student', '+201000000000') RETURNING id`,
    [cohortId, `idk_${n}`],
  );
  return {
    programId,
    cohortId,
    userA: users.rows[0].id,
    userB: users.rows[1].id,
    studentId: student.rows[0].id,
  };
}

export async function insertEvent(
  c: pg.Client,
  f: Fixture,
  overrides: Partial<{ type: string; subjectId: string; occurredAt: string }> = {},
): Promise<string> {
  const r = await c.query(
    `INSERT INTO events (event_type, occurred_at, subject_type, subject_id, cohort_id,
                         correlation_id, source, payload)
     VALUES ($1, $2, 'student', $3, $4, gen_random_uuid(), 'UI', '{"a":1}'::jsonb)
     RETURNING event_id`,
    [
      overrides.type ?? 'INTERACTION_RECORDED',
      overrides.occurredAt ?? new Date().toISOString(),
      overrides.subjectId ?? f.studentId,
      f.cohortId,
    ],
  );
  return r.rows[0].event_id;
}
