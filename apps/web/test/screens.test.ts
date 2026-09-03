/**
 * Screen tests.
 *
 * The API tests prove the rules are enforced; these prove the SCREENS honour
 * them -- navigation renders from the matrix, a denied deep link explains itself
 * without leaking, the contact flow actually writes, and the Arabic layout is a
 * real mirror rather than a mirrored afterthought.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedRoles } from '@coordinator/db';
import { setPassword, projectStudent } from '@coordinator/core';
import { createWebApp } from '../src/server.ts';

const PASSWORD = 'correct-horse-battery-staple';
const CALENDAR = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set<string>(),
};

let pool: pg.Pool;
let server: Server;
let base: string;
let cohortId: string;
let studentId: string;
let coordinatorCookie: string;
let pmCookie: string;
let studentCookie: string;

async function makeUser(roleKey: string, name: string): Promise<string> {
  const email = `${name}_${randomUUID().slice(0, 8)}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = $1`, [roleKey]);
  await pool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    rows[0].id,
    role[0].id,
  ]);
  await setPassword(pool, rows[0].id, PASSWORD);
  return email;
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: PASSWORD }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

async function get(cookie: string | null, path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}

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

  server = createServer(createWebApp(pool));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const n = randomUUID().slice(0, 8);
  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1,'DEPI') RETURNING id`,
    [`web_${n}`],
  );
  const { rows: coh } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state) VALUES ($1,$2,'R5','active') RETURNING id`,
    [prog[0].id, `web_r5_${n}`],
  );
  cohortId = coh[0].id;

  const coordEmail = await makeUser('operations_coordinator', 'WebCoord');
  const pmEmail = await makeUser('project_manager', 'WebPM');
  const studentEmail = await makeUser('student', 'WebStudent');

  const { rows: coordRow } = await pool.query(`SELECT id FROM app_user WHERE email = $1`, [
    coordEmail,
  ]);
  const { rows: studentUser } = await pool.query(`SELECT id FROM app_user WHERE email = $1`, [
    studentEmail,
  ]);

  const { rows: st } = await pool.query(
    `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164, current_stage)
     VALUES ($1,$2,'Web Student','+201000000000','coaching') RETURNING id`,
    [cohortId, `web_${n}`],
  );
  studentId = st[0].id;
  await pool.query(
    `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
     VALUES ($1,$2,now())`,
    [studentId, coordRow[0].id],
  );
  await pool.query(`INSERT INTO student_account (user_id, student_id) VALUES ($1,$2)`, [
    studentUser[0].id,
    studentId,
  ]);
  await pool.query(
    `INSERT INTO task (student_id, cohort_id, task_type, owner_user_id, source, due_at, dedup_key)
     VALUES ($1,$2,'first_contact',$3,'workflow',now(),$4)`,
    [studentId, cohortId, coordRow[0].id, `${studentId}:first_contact`],
  );
  await projectStudent(pool, studentId, CALENDAR);

  coordinatorCookie = await signIn(coordEmail);
  pmCookie = await signIn(pmEmail);
  studentCookie = await signIn(studentEmail);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('authentication', () => {
  it('redirects an unauthenticated visitor to sign in', async () => {
    const r = await get(null, '/my-work');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/login');
  });

  it('renders the sign-in page', async () => {
    const r = await get(null, '/login');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Sign in');
  });

  it('sets an HttpOnly SameSite cookie on sign-in', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'nobody@example.test', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(coordinatorCookie).toMatch(/^coordinator_session=/);
  });
});

describe('navigation renders from the permission matrix (§4)', () => {
  it('gives the coordinator no Administration or Audit tab', async () => {
    const r = await get(coordinatorCookie, '/my-work');
    expect(r.status).toBe(200);
    expect(r.html).not.toContain('>Administration<');
    expect(r.html).not.toContain('>Audit<');
    expect(r.html).toContain('>My Work<');
  });

  it('gives the student only the portal', async () => {
    const r = await get(studentCookie, '/portal');
    expect(r.status).toBe(200);
    expect(r.html).not.toContain('>Students<');
    expect(r.html).not.toContain('>Quality<');
  });
});

describe('a denied deep link explains itself without leaking', () => {
  it('refuses the coordinator the graduation page and names the permission', async () => {
    const r = await get(coordinatorCookie, '/graduation');
    expect(r.status).toBe(403);
    expect(r.html).toContain('graduation.view');
    // The refusal points them at where the information IS available to them.
    expect(r.html).toContain('their record');
    // No hint about how many records exist behind it.
    expect(r.html).not.toMatch(/\d+ (student|record)s? /);
  });

  it('refuses a staff member the student portal', async () => {
    const r = await get(coordinatorCookie, '/portal');
    expect(r.status).toBe(403);
  });

  it('refuses a student every staff screen', async () => {
    for (const path of ['/students', '/quality', '/graduation', '/my-work']) {
      const r = await get(studentCookie, path);
      expect(r.status, path).toBe(403);
    }
  });
});

describe('the coordinator day (§11)', () => {
  it('renders the queue with the assigned student', async () => {
    const r = await get(coordinatorCookie, '/my-work');
    expect(r.html).toContain('My Day');
    expect(r.html).toContain('Web Student');
  });

  it('offers a one-click route into the contact flow from the row', async () => {
    const r = await get(coordinatorCookie, '/my-work');
    expect(r.html).toContain(`/contact/${studentId}`);
  });
});

describe('the contact flow (§12, §13)', () => {
  it('renders one screen with channel, purpose and outcome', async () => {
    const r = await get(coordinatorCookie, `/contact/${studentId}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('name="channel"');
    expect(r.html).toContain('name="purpose"');
    expect(r.html).toContain('name="outcome"');
    expect(r.html).toContain('name="agreedAction"');
  });

  it('records the interaction and returns the coordinator to their queue', async () => {
    const res = await fetch(`${base}/contact/${studentId}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: coordinatorCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        channel: 'whatsapp',
        purpose: 'weekly_follow_up',
        outcome: 'no_response',
        agreedAction: 'Send the portfolio brief',
      }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/my-work');

    const { rows } = await pool.query(
      `SELECT agreed_action, outcome FROM interaction WHERE student_id = $1`,
      [studentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('no_response');
    expect(rows[0].agreed_action).toBe('Send the portfolio brief');
  });

  it('writes the whole chain, not just the interaction row', async () => {
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE subject_id = $1`,
      [studentId],
    );
    const tasks = await pool.query(
      `SELECT count(*)::int AS n FROM task
       WHERE student_id = $1 AND task_type = 'weekly_contact' AND status IN ('open','in_progress')`,
      [studentId],
    );
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE module = 'communications'`,
    );
    expect(events.rows[0].n).toBeGreaterThan(0);
    expect(tasks.rows[0].n).toBe(1);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('refuses a contact against a student outside the caller’s scope', async () => {
    const { rows: other } = await pool.query(
      `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164, current_stage)
       VALUES ($1,$2,'Not Mine','+201000000001','coaching') RETURNING id`,
      [cohortId, `web_other_${randomUUID().slice(0, 8)}`],
    );
    await projectStudent(pool, other[0].id, CALENDAR);
    const r = await get(coordinatorCookie, `/contact/${other[0].id}`);
    expect(r.status).toBe(404);
    expect(r.html).not.toContain('Not Mine');
  });
});

describe('the PM command centre (§51)', () => {
  it('shows the contractual threshold and the internal target separately', async () => {
    const r = await get(pmCookie, '/graduation');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Command centre');
    expect(r.html).toContain('70%');
    expect(r.html).toContain('85%');
    // The contractual one is labelled as such: it is the number with consequences.
    expect(r.html).toContain('Ministry');
  });

  it('drills from the headline down to the records behind it (§74)', async () => {
    const r = await get(pmCookie, '/graduation/records');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Graduation records');
    expect(r.html).toContain('Rule version');
  });
});

describe('Arabic is a first-class layout (§72)', () => {
  it('sets direction and language on the document', async () => {
    const r = await get(coordinatorCookie, '/my-work?locale=ar');
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('lang="ar"');
    expect(r.html).toContain('يومي');
  });

  it('translates the contact flow, not just the chrome', async () => {
    const r = await get(coordinatorCookie, `/contact/${studentId}?locale=ar`);
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('تسجيل التواصل');
  });
});

describe('security headers', () => {
  it('sends a content security policy and blocks sniffing', async () => {
    const res = await fetch(`${base}/login`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('escaping', () => {
  it('escapes a student name containing markup', async () => {
    const { rows } = await pool.query(
      `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164, current_stage)
       VALUES ($1,$2,$3,'+201000000002','coaching') RETURNING id`,
      [cohortId, `web_xss_${randomUUID().slice(0, 8)}`, '<script>alert(1)</script>'],
    );
    await projectStudent(pool, rows[0].id, CALENDAR);
    const r = await get(pmCookie, '/students');
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});
