/**
 * Authorization: the union of a user's role grants, narrowed by the subtractive
 * separation-of-duties rules. See docs/02-permission-matrix.md §1 and §4.
 *
 * This module answers "may this actor do this?" It does NOT answer "which rows
 * may they see?" -- that is `scope.ts`, which turns a granted scope into a query
 * predicate. Keeping them separate is deliberate: a scope must never be applied
 * by filtering a result set, because a leaked *count* is still a leak.
 */
import {
  ALLOW,
  type Decision,
  type Module,
  type Permission,
  type RoleDefinition,
  type Scope,
  type Verb,
  widerScope,
} from './model.ts';

export interface Actor {
  readonly userId: string;
  /** The real user, when impersonating. Both are recorded on every event. */
  readonly realUserId?: string;
  readonly roles: readonly RoleDefinition[];
  readonly cohortIds: readonly string[];
}

/**
 * The widest scope the actor holds for (module, verb), or undefined if none.
 * Multiple roles union; where two grants tie on breadth but differ in lineage
 * (team vs coaching_team) both are retained by `grantedScopes`.
 */
export function grantedScope(actor: Actor, module: Module, verb: Verb): Scope | undefined {
  let best: Scope | undefined;
  for (const role of actor.roles) {
    for (const perm of role.permissions) {
      if (perm.module !== module || perm.verb !== verb) continue;
      best = best === undefined ? perm.scope : widerScope(best, perm.scope);
    }
  }
  return best;
}

/** Every distinct scope granted for (module, verb) -- lineage preserved. */
export function grantedScopes(actor: Actor, module: Module, verb: Verb): Scope[] {
  const seen = new Set<Scope>();
  for (const role of actor.roles) {
    for (const perm of role.permissions) {
      if (perm.module === module && perm.verb === verb) seen.add(perm.scope);
    }
  }
  return [...seen];
}

export function authorize(actor: Actor, module: Module, verb: Verb): Decision {
  const scopes = grantedScopes(actor, module, verb);
  if (scopes.length > 0) return ALLOW;
  return {
    allowed: false,
    denial: {
      code: 'PERMISSION_DENIED',
      required: { module, verb },
      actorScopes: [],
      reason:
        `You do not have permission to ${verb.replace(/_/g, ' ')} in ${module.replace(/_/g, ' ')}. ` +
        `Ask a System Admin to grant "${module}.${verb}" to one of your roles.`,
    },
  };
}

/**
 * Modules the navigation shell renders: those where the actor holds at least one
 * `view` grant. A user never sees a tab they cannot use (docs/01 §5, AC-27).
 * `my_work` and `notifications` are included via their own view grants, so this
 * needs no special cases.
 */
export function visibleModules(actor: Actor): Module[] {
  const seen = new Set<Module>();
  for (const role of actor.roles) {
    for (const perm of role.permissions) {
      if (perm.verb === 'view' || perm.verb === 'view_logs') seen.add(perm.module);
    }
  }
  return [...seen];
}

/** Flattened grant list, for seeding and for the generated matrix test. */
export function flattenRole(role: RoleDefinition): readonly Permission[] {
  return role.permissions;
}
