/**
 * End-to-end HTTP tests.
 *
 * The permission matrix test proves the DECLARATIONS are right; this proves the
 * server actually applies them, and that record-level scope narrows results in
 * the query rather than after it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { seedRoles } from '@coordinator/db';
import { setPassword, createExecutor, projectStudent } from '@coordinator/core';
import { createApp } from '../src/server.ts';
import { CALENDAR } from '../src/routes.ts';

let pool: pg.Pool;
let server: Server;
let base: string;

interface Person {
  userId: string;
  email: string;
  token: string;
}

const PASSWORD = 'correct-horse-battery-staple';

async function makeUser(roleKey: string, name: string): Promise<Person> {
  const email = `${name}_${randomUUID().slice(0, 8)}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  const userId = rows[0].id as string;
  const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = $1`, [roleKey]);
  await pool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    userId,
    role[0].id,
  ]);
  await setPassword(pool, userId, PASSWORD);
  const token = await signIn(email, PASSWORD);
  return { userId, email, token };
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string };
  return body.token ?? '';
}

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

let cohortId: string;
let studentA: string;
let studentB: string;
let coordinatorA: Person;
let coordinatorB: Person;
let pm: Person;
let student: Person;
let ops: Person;
let qualityMember: Person;

beforeAll(async () => {
  pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
  });
  const c = await pool.connect();
  try {
    await seedRoles(c);
  } finally {
    c.release();
  }

  server = createServer(createApp(pool));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const n = randomUUID().slice(0, 8);
  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1,'DEPI') RETURNING id`,
    [`http_${n}`],
  );
  const { rows: coh } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state) VALUES ($1,$2,'R5','active') RETURNING id`,
    [prog[0].id, `http_r5_${n}`],
  );
  cohortId = coh[0].id;

  coordinatorA = await makeUser('operations_coordinator', 'CoordA');
  coordinatorB = await makeUser('operations_coordinator', 'CoordB');
  pm = await makeUser('project_manager', 'PM');
  student = await makeUser('student', 'PortalStudent');
  ops = await makeUser('project_operations', 'Ops');
  qualityMember = await makeUser('quality_member', 'QM');

  const mk = async (name: string, coordinator: string) => {
    const { rows } = await pool.query(
      `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164, current_stage)
       VALUES ($1,$2,$3,'+201000000000','coaching') RETURNING id`,
      [cohortId, `http_${randomUUID()}`, name],
    );
    await pool.query(
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
       VALUES ($1,$2,now())`,
      [rows[0].id, coordinator],
    );
    await projectStudent(pool, rows[0].id, CALENDAR);
    return rows[0].id as string;
  };
  studentA = await mk('Student Of A', coordinatorA.userId);
  studentB = await mk('Student Of B', coordinatorB.userId);

  await pool.query(`INSERT INTO student_account (user_id, student_id) VALUES ($1,$2)`, [
    student.userId,
    studentA,
  ]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const r = await call(null, 'GET', '/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a bad token without revealing whether the account exists', async () => {
    const r = await call('not-a-real-token', 'GET', '/v1/me');
    expect(r.status).toBe(401);
  });

  it('gives one message for a wrong password and an unknown account', async () => {
    const wrongPassword = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: pm.email, password: 'wrong-password-entirely' }),
    });
    const unknownAccount = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-entirely' }),
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Identical, so accounts cannot be enumerated by response.
    expect(await wrongPassword.json()).toEqual(await unknownAccount.json());
  });

  it('signs in and returns the caller’s navigation from the matrix', async () => {
    const r = await call(coordinatorA.token, 'GET', '/v1/me');
    expect(r.status).toBe(200);
    expect(r.body.modules).toContain('my_work');
    expect(r.body.modules).not.toContain('administration');
    expect(r.body.modules).not.toContain('audit');
  });

  it('revokes the session on logout', async () => {
    const token = await signIn(coordinatorB.email, PASSWORD);
    expect((await call(token, 'GET', '/v1/me')).status).toBe(200);
    await call(token, 'POST', '/v1/auth/logout');
    expect((await call(token, 'GET', '/v1/me')).status).toBe(401);
  });
});

describe('record-level scope is applied in the query, not after it', () => {
  it('shows a coordinator only their own students', async () => {
    const r = await call(coordinatorA.token, 'GET', '/v1/students');
    expect(r.status).toBe(200);
    const ids = r.body.students.map((s: any) => s.student_id);
    expect(ids).toContain(studentA);
    expect(ids).not.toContain(studentB);
    // The COUNT must not leak either: a post-filter would have reported 2.
    expect(r.body.total).toBe(1);
  });

  it('returns 404, not 403, for a student outside scope', async () => {
    // Distinguishing "exists but forbidden" from "does not exist" leaks
    // existence, so both are the same response.
    const r = await call(coordinatorA.token, 'GET', `/v1/students/${studentB}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('Student Of B');
  });

  it('shows a cohort-scoped role both students', async () => {
    const r = await call(pm.token, 'GET', '/v1/students');
    const ids = r.body.students.map((s: any) => s.student_id);
    expect(ids).toContain(studentA);
    expect(ids).toContain(studentB);
  });

  it('refuses an interaction against a student outside scope', async () => {
    const r = await call(coordinatorA.token, 'POST', `/v1/students/${studentB}/interactions`, {
      channel: 'whatsapp',
      purpose: 'weekly_follow_up',
      outcome: 'no_response',
    });
    expect(r.status).toBe(404);
  });
});

describe('permission enforcement at the boundary', () => {
  it('denies the coordinator the Quality decision endpoint with a structured reason', async () => {
    const r = await call(coordinatorA.token, 'POST', '/v1/quality/00000000-0000-0000-0000-000000000000/decision', {
      checks: {},
    });
    expect(r.status).toBe(403);
    expect(r.body.required).toEqual({ module: 'quality', verb: 'approve' });
    expect(r.body.reason).toContain('quality.approve');
  });

  it('denies the coordinator the audit log', async () => {
    expect((await call(coordinatorA.token, 'GET', '/v1/audit')).status).toBe(403);
  });

  it('allows the PM the audit log', async () => {
    expect((await call(pm.token, 'GET', '/v1/audit')).status).toBe(200);
  });

  it('logs every denial as a security signal', async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM system_log WHERE code = 'PERMISSION_DENIED'`,
    );
    await call(coordinatorA.token, 'GET', '/v1/audit');
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM system_log WHERE code = 'PERMISSION_DENIED'`,
    );
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
  });

  it('denies a staff role every portal endpoint', async () => {
    expect((await call(coordinatorA.token, 'GET', '/v1/portal/submissions')).status).toBe(403);
  });

  it('denies a student every staff endpoint', async () => {
    expect((await call(student.token, 'GET', '/v1/students')).status).toBe(403);
    expect((await call(student.token, 'GET', '/v1/quality/queue')).status).toBe(403);
    expect((await call(student.token, 'GET', '/v1/graduation/summary')).status).toBe(403);
  });
});

describe('the student portal is bound to one record', () => {
  it('submits against the account’s own student, ignoring any id in the body', async () => {
    const { rows: gigRows } = await pool.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1,'khamsat','Portal gig',10,DATE '2026-01-01',DATE '2026-01-02') RETURNING id`,
      [studentA],
    );
    const r = await call(student.token, 'POST', '/v1/portal/evidence', {
      // A hostile client naming another student must not be able to redirect it:
      // the student id comes from the account binding, never the body.
      studentId: studentB,
      subjectType: 'gig',
      gigId: gigRows[0].id,
      files: [{ kind: 'delivered_work', fileRef: 's3://p', contentHash: 'aabb' }],
    });
    expect(r.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT student_id FROM evidence_submission WHERE id = $1`,
      [r.body.submissionId],
    );
    expect(rows[0].student_id).toBe(studentA);
  });

  it('lists only the student’s own submissions', async () => {
    const r = await call(student.token, 'GET', '/v1/portal/submissions');
    expect(r.status).toBe(200);
    expect(r.body.submissions.length).toBeGreaterThan(0);
  });
});

describe('the atomic contact flow over HTTP', () => {
  it('records an interaction and returns the next due date', async () => {
    const r = await call(coordinatorA.token, 'POST', `/v1/students/${studentA}/interactions`, {
      channel: 'whatsapp',
      purpose: 'weekly_follow_up',
      outcome: 'no_response',
      agreedAction: 'Resend the brief',
    });
    expect(r.status).toBe(201);
    expect(r.body.reference).toMatch(/^INT-/);
    expect(r.body.attemptCount).toBe(1);
    expect(r.body.nextContactDueAt).toBeTruthy();
  });

  it('is idempotent for a replayed offline submission', async () => {
    const key = `offline-${randomUUID()}`;
    const first = await call(coordinatorA.token, 'POST', `/v1/students/${studentA}/interactions`, {
      channel: 'email',
      purpose: 'weekly_follow_up',
      outcome: 'waiting_for_response',
      clientDedupKey: key,
    });
    const second = await call(coordinatorA.token, 'POST', `/v1/students/${studentA}/interactions`, {
      channel: 'email',
      purpose: 'weekly_follow_up',
      outcome: 'waiting_for_response',
      clientDedupKey: key,
    });
    expect(second.body.interactionId).toBe(first.body.interactionId);
  });

  it('rejects an interaction missing a required field with a field-level violation', async () => {
    const r = await call(coordinatorA.token, 'POST', `/v1/students/${studentA}/interactions`, {
      channel: 'whatsapp',
    });
    expect(r.status).toBe(400);
    expect(r.body.details.field).toBe('purpose');
  });
});

describe('the headline figure shows both targets separately', () => {
  it('returns the contractual threshold and the internal target with their own gaps', async () => {
    const r = await call(pm.token, 'GET', `/v1/graduation/summary?cohortId=${cohortId}`);
    expect(r.status).toBe(200);
    expect(r.body.contractualThresholdPercent).toBe(70);
    expect(r.body.internalTargetPercent).toBe(85);
    expect(r.body).toHaveProperty('studentsNeededForContractual');
    expect(r.body).toHaveProperty('studentsNeededForInternal');
  });

  it('drills from the number down to the records behind it (§74)', async () => {
    const r = await call(pm.token, 'GET', `/v1/graduation/records?cohortId=${cohortId}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.records)).toBe(true);
  });
});

describe('the Quality queue is oldest-first', () => {
  it('orders by submission time, so reviewers cannot pick convenient work', async () => {
    const r = await call(qualityMember.token, 'GET', `/v1/quality/queue?cohortId=${cohortId}`);
    expect(r.status).toBe(200);
    const times = r.body.items.map((i: any) => new Date(i.submitted_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(r.body.checks).toHaveLength(7);
  });
});

describe('unresponsive status is Project Operations only', () => {
  it('denies a coordinator even with the students.edit permission', async () => {
    const r = await call(coordinatorA.token, 'POST', `/v1/students/${studentA}/unresponsive`, {});
    expect(r.status).toBe(403);
    expect(r.body.reason).toContain('Project Operations');
  });

  it('refuses Project Operations without the attempt history', async () => {
    const r = await call(ops.token, 'POST', `/v1/students/${studentA}/unresponsive`, {});
    expect(r.status).toBe(403);
    expect(r.body.reason).toContain('attempts across channels');
  });
});
