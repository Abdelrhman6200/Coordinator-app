/**
 * Authentication (increment 1).
 *
 * scrypt rather than a bare hash: password storage must be slow by design. The
 * parameters travel with the hash, so they can be raised later without
 * invalidating existing credentials.
 *
 * Session tokens are stored only as a hash: a database leak must not yield
 * usable sessions.
 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type pg from 'pg';
import { DomainError } from './errors.ts';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time: a timing difference here leaks the hash a byte at a time.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface LoginResult {
  token: string;
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_HOURS = 12;

export async function login(
  pool: pg.Pool,
  email: string,
  password: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<LoginResult> {
  const { rows } = await pool.query(
    `SELECT u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until
     FROM app_user u LEFT JOIN user_credential c ON c.user_id = u.id
     WHERE u.email = $1`,
    [email],
  );
  const user = rows[0];

  // One message for every failure mode: distinguishing "no such account" from
  // "wrong password" enumerates users.
  const invalid = new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect.');

  if (!user || !user.password_hash) {
    // Still spend the time, so a missing account is not detectably faster.
    await hashPassword(password);
    throw invalid;
  }
  if (user.status !== 'active') {
    await hashPassword(password);
    throw new DomainError('ACCOUNT_INACTIVE', 'This account is not active.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new DomainError(
      'ACCOUNT_LOCKED',
      'Too many failed attempts. Try again later or ask an administrator to unlock the account.',
    );
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const attempts = (user.failed_attempts ?? 0) + 1;
    await pool.query(
      `UPDATE user_credential SET failed_attempts = $2,
         locked_until = CASE WHEN $2 >= $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END
       WHERE user_id = $1`,
      [user.id, attempts, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES],
    );
    await pool.query(
      `INSERT INTO system_log (level, component, code, message, context)
       VALUES ('warn', 'auth', 'LOGIN_FAILED', 'failed login', $1::jsonb)`,
      [JSON.stringify({ userId: user.id, attempts, ip: meta.ip ?? null })],
    );
    throw invalid;
  }

  await pool.query(
    `UPDATE user_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
    [user.id],
  );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  const { rows: created } = await pool.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [user.id, hashToken(token), expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );

  await pool.query(
    `INSERT INTO audit_log (user_id, module, record_type, record_id, action, permission_used,
                            source, correlation_id, ip, user_agent)
     VALUES ($1, 'administration', 'session', $2, 'login', 'none', 'API', $3, $4, $5)`,
    [user.id, created[0].id, randomUUID(), meta.ip ?? null, meta.userAgent ?? null],
  );

  return { token, sessionId: created[0].id, userId: user.id, expiresAt };
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  effectiveUserId: string;
  elevated: boolean;
}

export async function resolveSession(pool: pg.Pool, token: string): Promise<SessionInfo | null> {
  const { rows } = await pool.query(
    `SELECT id, user_id, impersonating_user_id, elevated_until
     FROM user_session
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const s = rows[0];
  if (!s) return null;
  await pool.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [s.id]);
  return {
    sessionId: s.id,
    userId: s.user_id,
    effectiveUserId: s.impersonating_user_id ?? s.user_id,
    elevated: s.elevated_until !== null && new Date(s.elevated_until) > new Date(),
  };
}

/** Step-up re-authentication for elevated actions (override_lock, impersonate). */
export async function elevate(
  pool: pg.Pool,
  sessionId: string,
  userId: string,
  password: string,
  minutes = 10,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT password_hash FROM user_credential WHERE user_id = $1`,
    [userId],
  );
  if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) {
    throw new DomainError('REAUTH_FAILED', 'Password confirmation failed.');
  }
  await pool.query(
    `UPDATE user_session SET elevated_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
    [sessionId, minutes],
  );
}

export async function logout(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(`UPDATE user_session SET revoked_at = now() WHERE id = $1`, [sessionId]);
}

export async function setPassword(pool: pg.Pool, userId: string, password: string): Promise<void> {
  if (password.length < 12) {
    throw new DomainError('WEAK_PASSWORD', 'Password must be at least 12 characters.');
  }
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO user_credential (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_changed_at = now(),
           failed_attempts = 0, locked_until = NULL, must_change = false`,
    [userId, hash],
  );
}
