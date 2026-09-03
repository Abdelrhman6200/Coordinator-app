/**
 * Brute-force protection.
 *
 * These exist because the lockout was silently inert: the UPDATE that increments
 * the failed-attempt counter failed on a type-deduction error, so the counter
 * never moved and the account never locked. A 500 in the response was the only
 * symptom, and it would have been easy to read as noise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { login, setPassword, elevate, resolveSession, DomainError } from '@coordinator/core';

let pool: pg.Pool;
let userId: string;
let email: string;
const PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
  });
  email = `lockout_${randomUUID().slice(0, 8)}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'Lockout Test') RETURNING id`,
    [email],
  );
  userId = rows[0].id;
  await setPassword(pool, userId, PASSWORD);
});

afterAll(async () => {
  await pool.end();
});

async function attemptWrongPassword(): Promise<string> {
  try {
    await login(pool, email, 'definitely-the-wrong-password');
    return 'unexpectedly succeeded';
  } catch (err) {
    return (err as DomainError).code;
  }
}

describe('failed login attempts', () => {
  it('increments the counter on every wrong password', async () => {
    for (let i = 1; i <= 3; i++) {
      expect(await attemptWrongPassword()).toBe('INVALID_CREDENTIALS');
      const { rows } = await pool.query(
        `SELECT failed_attempts FROM user_credential WHERE user_id = $1`,
        [userId],
      );
      // The assertion the original bug would have failed: the counter moves.
      expect(rows[0].failed_attempts, `after attempt ${i}`).toBe(i);
    }
  });

  it('does not lock the account before the threshold', async () => {
    const { rows } = await pool.query(
      `SELECT locked_until FROM user_credential WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].locked_until).toBeNull();
  });

  it('locks the account at the threshold', async () => {
    await attemptWrongPassword();
    await attemptWrongPassword();
    const { rows } = await pool.query(
      `SELECT failed_attempts, locked_until FROM user_credential WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].failed_attempts).toBe(5);
    expect(rows[0].locked_until).not.toBeNull();
    expect(new Date(rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses the CORRECT password while locked', async () => {
    // The point of a lockout: knowing the password is not enough during the
    // cool-down, or an attacker who guesses on the last attempt still wins.
    try {
      await login(pool, email, PASSWORD);
      throw new Error('login succeeded while locked');
    } catch (err) {
      expect((err as DomainError).code).toBe('ACCOUNT_LOCKED');
    }
  });

  it('clears the counter on a successful login once the lock expires', async () => {
    await pool.query(
      `UPDATE user_credential SET locked_until = now() - interval '1 minute' WHERE user_id = $1`,
      [userId],
    );
    const result = await login(pool, email, PASSWORD);
    expect(result.token).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT failed_attempts, locked_until FROM user_credential WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].failed_attempts).toBe(0);
    expect(rows[0].locked_until).toBeNull();
  });

  it('records each failure in the system log for alerting', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM system_log
       WHERE code = 'LOGIN_FAILED' AND context->>'userId' = $1`,
      [userId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });
});

describe('step-up re-authentication', () => {
  it('elevates a session for a bounded window and refuses a wrong password', async () => {
    const { token, sessionId } = await login(pool, email, PASSWORD);

    const before = await resolveSession(pool, token);
    expect(before?.elevated).toBe(false);

    await expect(elevate(pool, sessionId, userId, 'not-the-password')).rejects.toThrow();

    await elevate(pool, sessionId, userId, PASSWORD, 10);
    const after = await resolveSession(pool, token);
    expect(after?.elevated).toBe(true);

    // The elevation expires; it is not a permanent upgrade.
    await pool.query(
      `UPDATE user_session SET elevated_until = now() - interval '1 minute' WHERE id = $1`,
      [sessionId],
    );
    const expired = await resolveSession(pool, token);
    expect(expired?.elevated).toBe(false);
  });
});

describe('session tokens', () => {
  it('stores only the hash, never the token', async () => {
    const { token, sessionId } = await login(pool, email, PASSWORD);
    const { rows } = await pool.query(
      `SELECT token_hash FROM user_session WHERE id = $1`,
      [sessionId],
    );
    const stored = (rows[0].token_hash as Buffer).toString('utf8');
    // A database leak must not yield usable sessions.
    expect(stored).not.toContain(token);
    expect((rows[0].token_hash as Buffer).length).toBe(32);
  });

  it('rejects an expired session', async () => {
    const { token, sessionId } = await login(pool, email, PASSWORD);
    // The whole session is aged, not just its expiry: the schema enforces
    // expires_at > created_at, so an "expired" row must be one that was created
    // in the past -- which is exactly what a real expired session looks like.
    await pool.query(
      `UPDATE user_session
       SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour'
       WHERE id = $1`,
      [sessionId],
    );
    expect(await resolveSession(pool, token)).toBeNull();
  });
});
