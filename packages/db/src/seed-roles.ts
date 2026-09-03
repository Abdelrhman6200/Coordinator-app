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
  /** System roles withdrawn from the matrix and deleted. */
  rolesRemoved: string[];
  /** Withdrawn roles still assigned to a user: stripped of grants, kept for audit. */
  rolesDisarmed: string[];
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

  // A role withdrawn from the matrix must stop granting anything. Leaving it
  // behind is the same defect as leaving a withdrawn permission behind: the
  // grant silently outlives its removal.
  //
  // Where the role is still assigned to a user, deleting it would destroy the
  // assignment history, so it is stripped of every grant and kept instead --
  // inert, but still explaining what a past actor held.
  const declared = SEED_ROLES.map((r) => r.key);
  const { rows: stale } = await c.query(
    `SELECT r.id, r.key, EXISTS (SELECT 1 FROM user_role ur WHERE ur.role_id = r.id) AS in_use
     FROM role r
     WHERE r.is_system = true AND r.key <> ALL($1::text[])`,
    [declared],
  );

  const rolesRemoved: string[] = [];
  const rolesDisarmed: string[] = [];
  for (const row of stale) {
    const stripped = await c.query('DELETE FROM role_permission WHERE role_id = $1', [row.id]);
    permissionsRemoved += stripped.rowCount ?? 0;
    if (row.in_use) {
      rolesDisarmed.push(row.key);
    } else {
      await c.query('DELETE FROM role WHERE id = $1', [row.id]);
      rolesRemoved.push(row.key);
    }
  }

  return {
    rolesUpserted: SEED_ROLES.length,
    permissionsInserted,
    permissionsRemoved,
    rolesRemoved,
    rolesDisarmed,
  };
}
