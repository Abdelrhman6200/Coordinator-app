/**
 * Scope resolution: turns a granted scope into a *predicate*, never a filter
 * applied to an already-fetched result set (docs/02 §2).
 *
 * The distinction matters: post-filtering leaks counts, pagination totals and
 * existence. The predicate produced here is composed into the query, and
 * PostgreSQL RLS independently enforces the same boundary as a backstop.
 *
 * Scope resolves against the EFFECTIVE-DATED org and assignment tables at
 * `asOf`, so a historical query resolves against the hierarchy as it was, not
 * as it is (AC-18).
 */
import type { Module, Scope, Verb } from './model.ts';
import type { Actor } from './authorize.ts';
import { grantedScopes } from './authorize.ts';

/**
 * A resolved, declarative predicate over students. The db package renders it to
 * SQL; keeping it declarative keeps this package pure and testable.
 */
export type StudentPredicate =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'cohorts'; cohortIds: readonly string[] }
  | { kind: 'assignedToUsers'; userIds: readonly string[]; asOf: Date }
  | { kind: 'coachedByUsers'; userIds: readonly string[]; asOf: Date }
  | { kind: 'union'; of: readonly StudentPredicate[] };

export interface OrgResolver {
  /** Users in the actor's operations team subtree at `asOf`, including the actor. */
  operationsSubtree(userId: string, asOf: Date): Promise<readonly string[]>;
  /** Coaches reporting to the actor at `asOf`, including the actor. */
  coachingSubtree(userId: string, asOf: Date): Promise<readonly string[]>;
}

export async function studentPredicateFor(
  actor: Actor,
  module: Module,
  verb: Verb,
  org: OrgResolver,
  asOf: Date,
): Promise<StudentPredicate> {
  const scopes = grantedScopes(actor, module, verb);
  if (scopes.length === 0) return { kind: 'none' };
  if (scopes.includes('all')) return { kind: 'all' };

  const parts: StudentPredicate[] = [];
  for (const scope of scopes) {
    parts.push(await resolveOne(actor, scope, org, asOf));
  }
  return parts.length === 1 ? parts[0]! : { kind: 'union', of: parts };
}

async function resolveOne(
  actor: Actor,
  scope: Scope,
  org: OrgResolver,
  asOf: Date,
): Promise<StudentPredicate> {
  switch (scope) {
    case 'all':
      return { kind: 'all' };
    case 'cohort':
      return { kind: 'cohorts', cohortIds: actor.cohortIds };
    case 'team': {
      const userIds = await org.operationsSubtree(actor.userId, asOf);
      return { kind: 'assignedToUsers', userIds, asOf };
    }
    case 'coaching_team': {
      const userIds = await org.coachingSubtree(actor.userId, asOf);
      return { kind: 'coachedByUsers', userIds, asOf };
    }
    case 'own':
      // A coordinator's own students are those assigned to them; a coach's own
      // students are those they coach. A user holding both grants gets the union,
      // which `studentPredicateFor` assembles.
      return {
        kind: 'union',
        of: [
          { kind: 'assignedToUsers', userIds: [actor.userId], asOf },
          { kind: 'coachedByUsers', userIds: [actor.userId], asOf },
        ],
      };
  }
}

/** True when the predicate can match nothing -- used to short-circuit queries. */
export function isEmpty(p: StudentPredicate): boolean {
  switch (p.kind) {
    case 'none':
      return true;
    case 'all':
      return false;
    case 'cohorts':
      return p.cohortIds.length === 0;
    case 'assignedToUsers':
    case 'coachedByUsers':
      return p.userIds.length === 0;
    case 'union':
      return p.of.every(isEmpty);
  }
}
