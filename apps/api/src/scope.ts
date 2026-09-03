/**
 * Record-level scope, applied as a SQL predicate.
 *
 * Never a filter over fetched rows: post-filtering leaks counts, totals and
 * existence. The predicate is composed into the query, and PostgreSQL RLS would
 * enforce the same boundary independently as a backstop.
 */
import type pg from 'pg';
import { grantedScopes, type Module, type Verb } from '@coordinator/permissions';
import type { RequestContext } from '@coordinator/core';

export interface ScopePredicate {
  sql: string;
  params: unknown[];
  empty: boolean;
}

export async function studentScopePredicate(
  pool: pg.Pool,
  ctx: RequestContext,
  module: Module,
  verb: Verb,
): Promise<ScopePredicate> {
  const scopes = grantedScopes(ctx.actor, module, verb);
  if (scopes.length === 0) return { sql: 'false', params: [], empty: true };
  if (scopes.includes('all')) return { sql: 'true', params: [], empty: false };

  const clauses: string[] = [];
  const params: unknown[] = [];

  const add = (sql: string, ...values: unknown[]) => {
    let rendered = sql;
    for (const v of values) {
      params.push(v);
      rendered = rendered.replace('?', `$${params.length}`);
    }
    clauses.push(rendered);
  };

  if (scopes.includes('cohort')) {
    if (ctx.actor.cohortIds.length > 0) {
      add('rm.cohort_id = ANY(?)', ctx.actor.cohortIds);
    } else {
      // A cohort-scoped actor with no cohort assignment sees nothing, rather
      // than everything -- the failure mode has to be closed, not open.
      clauses.push('false');
    }
  }
  if (scopes.includes('team')) {
    // The supervisor's subtree: their own coordinators and the groups they own.
    add(
      `(rm.supervisor_user_id = ? OR rm.coordinator_user_id IN (
          SELECT om.user_id FROM org_membership om
          JOIN team t ON t.id = om.team_id
          WHERE t.manager_user_id = ? AND om.effective_to IS NULL))`,
      ctx.actor.userId,
      ctx.actor.userId,
    );
  }
  if (scopes.includes('coaching_team')) {
    add(
      `(rm.coach_user_id = ? OR rm.coach_user_id IN (
          SELECT om.user_id FROM org_membership om
          JOIN team t ON t.id = om.team_id
          WHERE t.manager_user_id = ? AND om.effective_to IS NULL))`,
      ctx.actor.userId,
      ctx.actor.userId,
    );
  }
  if (scopes.includes('own')) {
    add('(rm.coordinator_user_id = ? OR rm.coach_user_id = ?)', ctx.actor.userId, ctx.actor.userId);
  }

  return { sql: `(${clauses.join(' OR ')})`, params, empty: false };
}
