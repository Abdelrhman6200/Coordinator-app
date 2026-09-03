/**
 * Proves the "one source of truth" claim for the permission matrix (docs/02 §5):
 * what the database enforces is exactly what packages/permissions declares, and
 * a withdrawn grant really disappears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SEED_ROLES } from '@coordinator/permissions';
import { seedRoles } from '../src/seed-roles.ts';
import { client } from './helpers.ts';

let c: pg.Client;

beforeAll(async () => {
  c = client();
  await c.connect();
  await seedRoles(c);
});

afterAll(async () => {
  await c.end();
});

describe('seeding is faithful to the declared matrix', () => {
  it('creates every declared role', async () => {
    const { rows } = await c.query('SELECT key FROM role ORDER BY key');
    const seeded = rows.map((r) => r.key).sort();
    for (const role of SEED_ROLES) expect(seeded).toContain(role.key);
  });

  it('stores exactly the declared grants, with the declared scopes', async () => {
    for (const role of SEED_ROLES) {
      const { rows } = await c.query(
        `SELECT rp.module, rp.verb, rp.scope
         FROM role_permission rp JOIN role r ON r.id = rp.role_id
         WHERE r.key = $1`,
        [role.key],
      );
      const inDb = new Map(rows.map((r) => [`${r.module}.${r.verb}`, r.scope]));
      const inCode = new Map(
        role.permissions.map((p) => [`${p.module}.${p.verb}`, p.scope]),
      );
      expect(inDb.size, `${role.key} grant count`).toBe(inCode.size);
      for (const [key, scope] of inCode) {
        expect(inDb.get(key), `${role.key} ${key}`).toBe(scope);
      }
    }
  });
});

describe('seeding is idempotent and reconciling', () => {
  it('changes nothing on a second run', async () => {
    const before = await c.query('SELECT count(*)::int AS n FROM role_permission');
    const result = await seedRoles(c);
    const after = await c.query('SELECT count(*)::int AS n FROM role_permission');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(result.permissionsRemoved).toBe(0);
    expect(result.permissionsInserted).toBe(0);
  });

  it('withdraws a grant that no longer exists in code', async () => {
    // A permission that outlives its removal from the matrix is a security
    // defect, so the seed must actively remove it, not merely stop adding it.
    const { rows } = await c.query(`SELECT id FROM role WHERE key = 'operations_coordinator'`);
    await c.query(
      `INSERT INTO role_permission (role_id, module, verb, scope)
       VALUES ($1, 'graduation', 'approve', 'all')`,
      [rows[0].id],
    );

    const result = await seedRoles(c);
    expect(result.permissionsRemoved).toBeGreaterThanOrEqual(1);

    const check = await c.query(
      `SELECT 1 FROM role_permission
       WHERE role_id = $1 AND module = 'graduation' AND verb = 'approve'`,
      [rows[0].id],
    );
    expect(check.rowCount).toBe(0);
  });

  it('corrects a scope that has been widened out of band', async () => {
    const { rows } = await c.query(`SELECT id FROM role WHERE key = 'operations_coordinator'`);
    await c.query(
      `UPDATE role_permission SET scope = 'all'
       WHERE role_id = $1 AND module = 'students' AND verb = 'view'`,
      [rows[0].id],
    );
    await seedRoles(c);
    const check = await c.query(
      `SELECT scope FROM role_permission
       WHERE role_id = $1 AND module = 'students' AND verb = 'view'`,
      [rows[0].id],
    );
    expect(check.rows[0].scope).toBe('own');
  });
});

describe('structural guarantees survive the round trip to the database', () => {
  it('no role in the database can write graduation at all (§40)', async () => {
    // Graduation is computed from Quality-accepted evidence. There is no role
    // that may grant it, so the grant set must be empty -- not merely narrow.
    const { rows } = await c.query(
      `SELECT r.key, rp.verb FROM role_permission rp JOIN role r ON r.id = rp.role_id
       WHERE rp.module = 'graduation'
         AND rp.verb IN ('create','edit','delete','approve','reject')`,
    );
    expect(rows).toEqual([]);
  });

  it('lets no role outside Quality write a Quality decision (§59)', async () => {
    const { rows } = await c.query(
      `SELECT r.key FROM role_permission rp JOIN role r ON r.id = rp.role_id
       WHERE rp.module = 'quality'
         AND rp.verb IN ('create','edit','delete','approve','reject','audit','configure',
                         'override_lock')`,
    );
    expect([...new Set(rows.map((r) => r.key))].sort()).toEqual(['quality_lead', 'quality_member']);
  });

  it('confines the student to the portal', async () => {
    const { rows } = await c.query(
      `SELECT DISTINCT rp.module FROM role_permission rp JOIN role r ON r.id = rp.role_id
       WHERE r.key = 'student'`,
    );
    expect(rows.map((r) => r.module)).toEqual(['portal']);
  });

  it('no quality role holds a write verb on an operational module', async () => {
    const { rows } = await c.query(
      `SELECT r.key, rp.module, rp.verb
       FROM role_permission rp JOIN role r ON r.id = rp.role_id
       WHERE r.key IN ('quality_lead', 'quality_specialist')
         AND rp.module IN ('students','communications','coaching','freelancing','gigs',
                           'graduation','risks')
         AND rp.verb IN ('create','edit','delete','approve','reject','override_lock')`,
    );
    expect(rows).toEqual([]);
  });

  it('only System Admin may impersonate', async () => {
    const { rows } = await c.query(
      `SELECT r.key FROM role_permission rp JOIN role r ON r.id = rp.role_id
       WHERE rp.verb = 'impersonate'`,
    );
    expect(rows.map((r) => r.key)).toEqual(['system_admin']);
  });

  it('deletes a system role withdrawn from the matrix', async () => {
    // A withdrawn role must stop granting anything; leaving it behind is the
    // same defect as leaving a withdrawn permission behind.
    const legacyKey = `legacy_role_${Date.now()}`;
    const inserted = await c.query(
      `INSERT INTO role (key, name_i18n, is_system) VALUES ($1, '{}'::jsonb, true)
       RETURNING id`,
      [legacyKey],
    );
    await c.query(
      `INSERT INTO role_permission (role_id, module, verb, scope)
       VALUES ($1, 'students', 'delete', 'all')`,
      [inserted.rows[0].id],
    );

    const result = await seedRoles(c);
    expect(result.rolesRemoved).toContain(legacyKey);
    const check = await c.query(`SELECT 1 FROM role WHERE key = $1`, [legacyKey]);
    expect(check.rowCount).toBe(0);
  });

  it('disarms rather than deletes a withdrawn role still assigned to someone', async () => {
    // Deleting it would destroy the assignment history; stripping its grants
    // makes it inert while it can still explain what a past actor held.
    const retiredKey = `retired_role_${Date.now()}`;
    const role = await c.query(
      `INSERT INTO role (key, name_i18n, is_system) VALUES ($1, '{}'::jsonb, true)
       RETURNING id`,
      [retiredKey],
    );
    await c.query(
      `INSERT INTO role_permission (role_id, module, verb, scope)
       VALUES ($1, 'students', 'delete', 'all')`,
      [role.rows[0].id],
    );
    const user = await c.query(
      `INSERT INTO app_user (email, full_name) VALUES ($1, 'Retired') RETURNING id`,
      [`retired_${Date.now()}@example.test`],
    );
    await c.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
      user.rows[0].id,
      role.rows[0].id,
    ]);

    const result = await seedRoles(c);
    expect(result.rolesDisarmed).toContain(retiredKey);
    const kept = await c.query(`SELECT 1 FROM role WHERE key = $1`, [retiredKey]);
    expect(kept.rowCount).toBe(1);
    const grants = await c.query(`SELECT 1 FROM role_permission WHERE role_id = $1`, [
      role.rows[0].id,
    ]);
    expect(grants.rowCount).toBe(0);
  });
});
