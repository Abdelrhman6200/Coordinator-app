/**
 * The confirmed DEPI Round 5 role set (requirements §3, §5).
 *
 * This table is the single source of truth: it seeds `role_permission` AND
 * generates the exhaustive role x endpoint test, so documentation and behaviour
 * cannot drift.
 *
 * Roles are seed DATA. Nothing in the codebase branches on a role key -- an
 * operator may add, rename or remove roles through Administration for a future
 * round without a code change.
 */
import type { Module, Permission, RoleDefinition, Scope, Verb } from './model.ts';

function p(module: Module, verbs: string, scope: Scope): Permission[] {
  return verbs.split(/\s+/).map((v) => ({ module, verb: v as Verb, scope }));
}

/**
 * Project Manager -- full management visibility and high-level approval.
 * Deliberately NOT an administrator: §5 requires administrative technical
 * access to remain separate from business authority, so the PM cannot
 * `configure` or `impersonate`.
 */
export const PROJECT_MANAGER: RoleDefinition = {
  key: 'project_manager',
  name: 'Project Manager',
  permissions: [
    ...p('home', 'view', 'all'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view export', 'cohort'),
    ...p('groups', 'view export', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('sessions', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('services', 'view', 'cohort'),
    ...p('evidence', 'view', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('graduation', 'view export', 'cohort'),
    ...p('risks', 'view create edit', 'cohort'),
    ...p('escalations', 'view create edit approve', 'cohort'),
    ...p('team', 'view', 'cohort'),
    ...p('performance', 'view create approve', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs export', 'cohort'),
  ],
};

/** Project Operations -- cross-operations authority, including pathway designation. */
export const PROJECT_OPERATIONS: RoleDefinition = {
  key: 'project_operations',
  name: 'Project Operations',
  permissions: [
    ...p('home', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view create edit assign reassign export', 'cohort'),
    ...p('groups', 'view create edit assign reassign approve export', 'cohort'),
    ...p('communications', 'view create', 'cohort'),
    ...p('sessions', 'view edit', 'cohort'),
    ...p('freelancing', 'view create edit', 'cohort'),
    ...p('services', 'view create edit assign', 'cohort'),
    ...p('evidence', 'view', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('graduation', 'view export', 'cohort'),
    ...p('risks', 'view create edit', 'cohort'),
    ...p('escalations', 'view create edit approve', 'cohort'),
    ...p('team', 'view assign reassign', 'cohort'),
    ...p('performance', 'view', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs', 'cohort'),
    ...p('administration', 'view', 'cohort'),
  ],
};

/** Team Supervisor -- all coordinators and students in their team subtree. */
export const TEAM_SUPERVISOR: RoleDefinition = {
  key: 'team_supervisor',
  name: 'Team Supervisor',
  permissions: [
    ...p('home', 'view', 'team'),
    ...p('my_work', 'view edit', 'team'),
    ...p('students', 'view edit reassign', 'team'),
    ...p('groups', 'view edit reassign', 'team'),
    ...p('communications', 'view create edit', 'team'),
    ...p('sessions', 'view', 'team'),
    ...p('freelancing', 'view edit', 'team'),
    ...p('services', 'view', 'team'),
    ...p('evidence', 'view', 'team'),
    ...p('quality', 'view', 'team'),
    ...p('graduation', 'view', 'team'),
    ...p('risks', 'view create edit', 'team'),
    ...p('escalations', 'view create edit approve', 'team'),
    ...p('team', 'view assign', 'team'),
    ...p('performance', 'view create', 'team'),
    ...p('reports', 'view export', 'team'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs', 'team'),
  ],
};

/**
 * Operations Coordinator -- frontline student ownership plus L1 evidence
 * screening. Explicitly cannot Quality-approve, edit a Quality decision, or
 * graduate a student.
 */
export const OPERATIONS_COORDINATOR: RoleDefinition = {
  key: 'operations_coordinator',
  name: 'Operations Coordinator',
  permissions: [
    ...p('home', 'view', 'own'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view edit', 'own'),
    ...p('groups', 'view', 'own'),
    ...p('communications', 'view create edit', 'own'),
    ...p('sessions', 'view', 'own'),
    ...p('freelancing', 'view create edit', 'own'),
    ...p('services', 'view', 'own'),
    // L1 screening: may review and return, never accept on Quality's behalf.
    ...p('evidence', 'view create edit reject', 'own'),
    ...p('quality', 'view', 'own'),
    ...p('graduation', 'view', 'own'),
    ...p('risks', 'view create edit', 'own'),
    ...p('escalations', 'view create', 'own'),
    ...p('team', 'view', 'own'),
    ...p('performance', 'view', 'own'),
    ...p('reports', 'view', 'own'),
    ...p('notifications', 'view edit', 'own'),
  ],
};

/** Coach Operations -- coach capacity, standby pool, session coverage. */
export const COACH_OPERATIONS: RoleDefinition = {
  key: 'coach_operations',
  name: 'Coach Operations',
  permissions: [
    ...p('home', 'view', 'coaching_team'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view', 'coaching_team'),
    ...p('groups', 'view', 'coaching_team'),
    ...p('communications', 'view', 'coaching_team'),
    ...p('sessions', 'view create edit assign reassign', 'coaching_team'),
    ...p('freelancing', 'view', 'coaching_team'),
    ...p('services', 'view', 'coaching_team'),
    ...p('evidence', 'view', 'coaching_team'),
    ...p('quality', 'view', 'coaching_team'),
    ...p('graduation', 'view', 'coaching_team'),
    ...p('risks', 'view create', 'coaching_team'),
    ...p('escalations', 'view create edit approve', 'coaching_team'),
    ...p('team', 'view assign reassign', 'coaching_team'),
    ...p('performance', 'view create', 'coaching_team'),
    ...p('reports', 'view export', 'coaching_team'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs', 'coaching_team'),
  ],
};

/**
 * Coaches. Both types deliver sessions and review evidence within 24h; the
 * Support Coach additionally owns the internal-service pipeline through to
 * acceptance, which is the only difference in the grant set.
 */
function coachRole(
  key: 'outcome_coach' | 'support_coach',
  name: string,
  extra: Permission[],
): RoleDefinition {
  return {
    key,
    name,
    permissions: [
      ...p('home', 'view', 'own'),
      ...p('my_work', 'view edit', 'own'),
      ...p('students', 'view', 'own'),
      ...p('groups', 'view', 'own'),
      ...p('communications', 'view', 'own'),
      ...p('sessions', 'view create edit', 'own'),
      ...p('freelancing', 'view create edit', 'own'),
      // Coach review stage: approve onward to L1, or return. Never the Quality
      // decision itself.
      ...p('evidence', 'view edit reject', 'own'),
      ...p('quality', 'view', 'own'),
      ...p('graduation', 'view', 'own'),
      ...p('risks', 'view create', 'own'),
      ...p('escalations', 'view create', 'own'),
      ...p('team', 'view', 'own'),
      ...p('performance', 'view', 'own'),
      ...p('reports', 'view', 'own'),
      ...p('notifications', 'view edit', 'own'),
      ...extra,
    ],
  };
}

export const OUTCOME_COACH = coachRole('outcome_coach', 'Outcome Coach', [
  ...p('services', 'view', 'own'),
]);

export const SUPPORT_COACH = coachRole('support_coach', 'Support Coach', [
  ...p('services', 'view create edit assign', 'own'),
]);

/**
 * Quality Member -- the L2 queue. Broad read for auditability; write confined to
 * Quality objects. Explicitly cannot edit operational records or rewrite
 * evidence.
 */
export const QUALITY_MEMBER: RoleDefinition = {
  key: 'quality_member',
  name: 'Quality Member',
  permissions: [
    ...p('home', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view', 'cohort'),
    ...p('groups', 'view', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('sessions', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('services', 'view', 'cohort'),
    ...p('evidence', 'view', 'cohort'),
    ...p('quality', 'view create edit audit approve reject', 'own'),
    ...p('graduation', 'view', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view create', 'cohort'),
    ...p('team', 'view', 'cohort'),
    ...p('performance', 'view', 'own'),
    ...p('reports', 'view', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs', 'cohort'),
  ],
};

/**
 * Quality Lead -- independent QA authority, owns complaints, resolves L3.
 * Independence is enforced here: no operational role holds any write on
 * `quality`, and the Lead holds no write on operational modules.
 */
export const QUALITY_LEAD: RoleDefinition = {
  key: 'quality_lead',
  name: 'Quality Lead',
  permissions: [
    ...p('home', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view', 'cohort'),
    ...p('groups', 'view', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('sessions', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('services', 'view', 'cohort'),
    ...p('evidence', 'view export', 'cohort'),
    ...p('quality', 'view create edit audit approve reject configure export override_lock', 'cohort'),
    ...p('graduation', 'view export', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    // Owns complaints, which live in escalations with independent routing.
    ...p('escalations', 'view create edit approve', 'cohort'),
    ...p('team', 'view', 'cohort'),
    ...p('performance', 'view create', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs export', 'cohort'),
    ...p('administration', 'view configure', 'cohort'),
  ],
};

/**
 * Operations Systems Specialist -- data accuracy, dashboards, the consolidated
 * report. Read across operations with controlled configuration on reporting
 * only; no operational write, so the person who reports the numbers cannot
 * change the records behind them.
 */
export const OPERATIONS_SYSTEMS: RoleDefinition = {
  key: 'operations_systems_specialist',
  name: 'Operations Systems Specialist',
  permissions: [
    ...p('home', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view export', 'cohort'),
    ...p('groups', 'view export', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('sessions', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('services', 'view', 'cohort'),
    ...p('evidence', 'view', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('graduation', 'view export', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view', 'cohort'),
    ...p('team', 'view', 'cohort'),
    ...p('performance', 'view', 'cohort'),
    ...p('reports', 'view export configure', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit', 'view_logs export', 'cohort'),
    ...p('administration', 'view', 'cohort'),
  ],
};

/**
 * Student -- the portal, and nothing else (§10).
 *
 * A student holds grants on `portal` alone. Every operational module is absent
 * from the grant set rather than merely hidden, so a routing mistake or a
 * crafted request cannot reach staff data. Students submit evidence; they
 * cannot accept it, alter a locked gig value, or graduate themselves.
 */
export const STUDENT: RoleDefinition = {
  key: 'student',
  name: 'Student',
  permissions: [...p('portal', 'view create edit', 'own')],
};

/**
 * System Admin -- technical administration, held separately from business
 * authority (§5). Note it holds no `approve` on graduation: graduation is
 * computed, never granted by a person (§40).
 */
export const SYSTEM_ADMIN: RoleDefinition = {
  key: 'system_admin',
  name: 'System Admin',
  permissions: [
    ...p('home', 'view', 'all'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view create edit delete assign reassign export', 'all'),
    ...p('groups', 'view create edit assign reassign export', 'all'),
    ...p('communications', 'view', 'all'),
    ...p('sessions', 'view create edit assign', 'all'),
    ...p('freelancing', 'view edit', 'all'),
    ...p('services', 'view edit', 'all'),
    ...p('evidence', 'view', 'all'),
    // Read-only on Quality: no user outside Quality may edit a Quality decision,
    // and "outside Quality" includes the administrator.
    ...p('quality', 'view', 'all'),
    ...p('graduation', 'view override_lock', 'all'),
    ...p('risks', 'view edit', 'all'),
    ...p('escalations', 'view edit', 'all'),
    ...p('team', 'view create edit assign reassign', 'all'),
    ...p('performance', 'view', 'all'),
    ...p('reports', 'view export configure', 'all'),
    ...p('notifications', 'view edit configure', 'all'),
    ...p('audit', 'view_logs export', 'all'),
    ...p('administration', 'view configure impersonate', 'all'),
  ],
};

export const SEED_ROLES: readonly RoleDefinition[] = [
  PROJECT_MANAGER,
  PROJECT_OPERATIONS,
  TEAM_SUPERVISOR,
  OPERATIONS_COORDINATOR,
  COACH_OPERATIONS,
  OUTCOME_COACH,
  SUPPORT_COACH,
  QUALITY_MEMBER,
  QUALITY_LEAD,
  OPERATIONS_SYSTEMS,
  STUDENT,
  SYSTEM_ADMIN,
];

export const SEED_ROLES_BY_KEY: ReadonlyMap<string, RoleDefinition> = new Map(
  SEED_ROLES.map((r) => [r.key, r]),
);

/** Roles that operate on student records -- used by portal-isolation checks. */
export const OPERATIONAL_MODULES: readonly Module[] = [
  'students',
  'groups',
  'communications',
  'sessions',
  'freelancing',
  'services',
  'evidence',
  'risks',
  'escalations',
  'team',
  'performance',
  'audit',
  'administration',
];
