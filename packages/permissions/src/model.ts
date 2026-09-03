/**
 * The permission model. See docs/02-permission-matrix.md.
 *
 * A permission is a tuple (role, module, verb, scope). Roles are data: adding a
 * role is a configuration change, never a code change. Nothing in this package
 * branches on a role name.
 */

export const MODULES = [
  'dashboard',
  'my_work',
  'students',
  'communications',
  'coaching',
  'freelancing',
  'gigs',
  'graduation',
  'risks',
  'escalations',
  'quality',
  'tasks',
  'teams',
  'reports',
  'notifications',
  'audit_logs',
  'admin',
] as const;
export type Module = (typeof MODULES)[number];

export const VERBS = [
  'view',
  'create',
  'edit',
  'delete',
  'assign',
  'reassign',
  'approve',
  'reject',
  'audit',
  'export',
  'configure',
  'view_logs',
  'override_lock',
  'impersonate',
] as const;
export type Verb = (typeof VERBS)[number];

/**
 * Scopes are ordered by breadth. `coaching_team` is deliberately NOT a superset
 * of `team`: they select different subtrees of the org (operations vs coaching),
 * so breadth comparison is only meaningful within a lineage. `rank` exists to
 * pick the widest grant a user holds for one (module, verb); `widen` encodes the
 * actual lineage.
 */
export const SCOPES = ['own', 'team', 'coaching_team', 'cohort', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_RANK: Record<Scope, number> = {
  own: 0,
  team: 1,
  coaching_team: 1,
  cohort: 2,
  all: 3,
};

export function widerScope(a: Scope, b: Scope): Scope {
  if (a === b) return a;
  if (SCOPE_RANK[a] !== SCOPE_RANK[b]) return SCOPE_RANK[a] > SCOPE_RANK[b] ? a : b;
  // Equal rank, different lineage (team vs coaching_team): neither contains the
  // other, so the union is honoured by keeping both grants. Callers use
  // `effectiveScopes`, not this, when lineage matters.
  return a;
}

export interface Permission {
  readonly module: Module;
  readonly verb: Verb;
  readonly scope: Scope;
}

export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

/** A structured denial. The UI renders `reason` verbatim (docs/01 §30). */
export interface Denial {
  readonly code:
    | 'PERMISSION_DENIED'
    | 'SCOPE_DENIED'
    | 'SEPARATION_OF_DUTIES'
    | 'TRANSITION_BLOCKED';
  readonly required: { module: Module; verb: Verb; scope?: Scope };
  readonly actorScopes: readonly Scope[];
  readonly reason: string;
}

export type Decision = { allowed: true } | { allowed: false; denial: Denial };

export const ALLOW: Decision = { allowed: true };
