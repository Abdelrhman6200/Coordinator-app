/**
 * Seeds `role` and `role_permission` from packages/permissions.
 *
 * The point is that this is the ONLY way roles enter the database. The same
 * table that seeds the schema also generates the exhaustive permission tests
 * (docs/11 §4), so the documentation, the runtime behaviour and the test suite
 * cannot drift apart -- there is nowhere for a discrepancy to hide.
 *
 * Idempotent: re-running reconciles the database to the code, removing grants
 * that have been withdrawn rather than leaving them behind. A permission that
 * silently outlives its removal is a security defect.
 */
import type pg from 'pg';
import { SEED_ROLES } from '@coordinator/permissions';

export interface SeedResult {
  rolesUpserted: number;
  permissionsInserted: number;
  permissionsRemoved: number;
}

export async function seedRoles(c: pg.Client | pg.PoolClient): Promise<SeedResult> {
  let permissionsInserted = 0;
  let permissionsRemoved = 0;

  for (const role of SEED_ROLES) {
    const { rows } = await c.query(
      `INSERT INTO role (key, name_i18n, is_system)
       VALUES ($1, $2, true)
       ON CONFLICT (key) DO UPDATE SET name_i18n = EXCLUDED.name_i18n
       RETURNING id`,
      [role.key, JSON.stringify({ en: role.name })],
    );
    const roleId = rows[0].id as string;

    for (const perm of role.permissions) {
      const r = await c.query(
        `INSERT INTO role_permission (role_id, module, verb, scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (role_id, module, verb) DO UPDATE SET scope = EXCLUDED.scope
         WHERE role_permission.scope IS DISTINCT FROM EXCLUDED.scope`,
        [roleId, perm.module, perm.verb, perm.scope],
      );
      permissionsInserted += r.rowCount ?? 0;
    }

    // Withdraw anything no longer granted in code.
    const pairs = role.permissions.map((p) => `${p.module}.${p.verb}`);
    const removed = await c.query(
      `DELETE FROM role_permission
       WHERE role_id = $1 AND (module || '.' || verb) <> ALL($2::text[])`,
      [roleId, pairs],
    );
    permissionsRemoved += removed.rowCount ?? 0;
  }

  return {
    rolesUpserted: SEED_ROLES.length,
    permissionsInserted,
    permissionsRemoved,
  };
}
