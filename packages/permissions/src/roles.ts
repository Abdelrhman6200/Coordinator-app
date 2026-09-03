/**
 * The seed role set, transcribed from docs/02-permission-matrix.md.
 *
 * This table is the single source of truth: it seeds `role_permission` in the
 * database AND generates the exhaustive role x endpoint test (docs/11 §4), so
 * documentation and behaviour cannot drift.
 *
 * Roles here are *seed data*, not code. An operator may add, edit or remove
 * roles at runtime through Admin; nothing in the system branches on these keys.
 */
import type { Module, Permission, RoleDefinition, Scope, Verb } from './model.ts';

/** Terse builder: p('students', 'view create edit', 'cohort') */
function p(module: Module, verbs: string, scope: Scope): Permission[] {
  return verbs.split(/\s+/).map((v) => ({ module, verb: v as Verb, scope }));
}

export const SYSTEM_ADMIN: RoleDefinition = {
  key: 'system_admin',
  name: 'System Admin',
  permissions: [
    ...p('dashboard', 'view', 'all'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view create edit delete assign reassign export', 'all'),
    ...p('communications', 'view create edit', 'all'),
    ...p('coaching', 'view create edit assign', 'all'),
    ...p('freelancing', 'view create edit', 'all'),
    ...p('gigs', 'view create edit approve reject override_lock', 'all'),
    ...p('graduation', 'view create approve reject override_lock', 'all'),
    ...p('risks', 'view create edit', 'all'),
    ...p('escalations', 'view create edit approve', 'all'),
    ...p('quality', 'view create edit audit configure', 'all'),
    ...p('tasks', 'view create edit assign', 'all'),
    ...p('teams', 'view create edit assign reassign', 'all'),
    ...p('reports', 'view export configure', 'all'),
    ...p('notifications', 'view edit configure', 'all'),
    ...p('audit_logs', 'view_logs export', 'all'),
    ...p('admin', 'view configure impersonate', 'all'),
  ],
};

export const PROJECT_MANAGER: RoleDefinition = {
  key: 'project_manager',
  name: 'Project Manager',
  permissions: [
    ...p('dashboard', 'view', 'all'),
    ...p('my_work', 'view', 'own'),
    ...p('students', 'view export', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('coaching', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('gigs', 'view', 'cohort'),
    ...p('graduation', 'view approve reject', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view approve', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('tasks', 'view', 'cohort'),
    ...p('teams', 'view', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit_logs', 'view_logs', 'cohort'),
    ...p('admin', 'view', 'cohort'),
  ],
};

export const OPS_ASSOCIATE: RoleDefinition = {
  key: 'ops_associate',
  name: 'Project Operations Associate',
  permissions: [
    ...p('dashboard', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view create edit assign reassign export', 'cohort'),
    ...p('communications', 'view create', 'cohort'),
    ...p('coaching', 'view edit', 'cohort'),
    ...p('freelancing', 'view create edit', 'cohort'),
    ...p('gigs', 'view create edit approve reject', 'cohort'),
    ...p('graduation', 'view create', 'cohort'),
    ...p('risks', 'view create edit', 'cohort'),
    ...p('escalations', 'view create edit approve', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('tasks', 'view create assign', 'cohort'),
    ...p('teams', 'view assign reassign', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit_logs', 'view_logs', 'cohort'),
    ...p('admin', 'view', 'cohort'),
  ],
};

export const TEAM_LEADER: RoleDefinition = {
  key: 'team_leader',
  name: 'Team Leader',
  permissions: [
    ...p('dashboard', 'view', 'team'),
    ...p('my_work', 'view edit', 'team'),
    ...p('students', 'view edit assign reassign', 'team'),
    ...p('communications', 'view create edit', 'team'),
    ...p('coaching', 'view', 'team'),
    ...p('freelancing', 'view edit', 'team'),
    ...p('gigs', 'view create edit', 'team'),
    ...p('graduation', 'view create', 'team'),
    ...p('risks', 'view create edit', 'team'),
    ...p('escalations', 'view create edit approve', 'team'),
    ...p('quality', 'view', 'team'),
    ...p('tasks', 'view create assign', 'team'),
    ...p('teams', 'view assign', 'team'),
    ...p('reports', 'view export', 'team'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit_logs', 'view_logs', 'team'),
  ],
};

export const COORDINATOR: RoleDefinition = {
  key: 'coordinator',
  name: 'Operations Coordinator',
  permissions: [
    ...p('dashboard', 'view', 'own'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view edit', 'own'),
    ...p('communications', 'view create edit', 'own'),
    ...p('coaching', 'view', 'own'),
    ...p('freelancing', 'view create edit', 'own'),
    ...p('gigs', 'view create edit', 'own'),
    ...p('graduation', 'view create', 'own'),
    ...p('risks', 'view create edit', 'own'),
    ...p('escalations', 'view create', 'own'),
    ...p('quality', 'view', 'own'),
    ...p('tasks', 'view create edit', 'own'),
    ...p('teams', 'view', 'own'),
    ...p('reports', 'view', 'own'),
    ...p('notifications', 'view edit', 'own'),
  ],
};

function coachingManager(type: 't1' | 't2'): RoleDefinition {
  return {
    key: `coaching_manager_${type}`,
    name: `Coaching Manager Type ${type === 't1' ? 1 : 2}`,
    permissions: [
      ...p('dashboard', 'view', 'coaching_team'),
      ...p('my_work', 'view edit', 'coaching_team'),
      ...p('students', 'view', 'coaching_team'),
      ...p('communications', 'view', 'coaching_team'),
      ...p('coaching', 'view create edit assign', 'coaching_team'),
      ...p('freelancing', 'view', 'coaching_team'),
      ...p('gigs', 'view', 'coaching_team'),
      ...p('graduation', 'view', 'coaching_team'),
      ...p('risks', 'view create', 'coaching_team'),
      ...p('escalations', 'view create edit approve', 'coaching_team'),
      ...p('quality', 'view', 'coaching_team'),
      ...p('tasks', 'view create assign', 'coaching_team'),
      ...p('teams', 'view assign', 'coaching_team'),
      ...p('reports', 'view export', 'coaching_team'),
      ...p('notifications', 'view edit', 'own'),
      ...p('audit_logs', 'view_logs', 'coaching_team'),
    ],
  };
}

function coach(type: 't1' | 't2'): RoleDefinition {
  return {
    key: `coach_${type}`,
    name: `Coach Type ${type === 't1' ? 1 : 2}`,
    permissions: [
      ...p('dashboard', 'view', 'own'),
      ...p('my_work', 'view edit', 'own'),
      // Coaching projection of the student record; enforced by the projection,
      // not by hiding fields in the UI. See docs/02 §3.2.
      ...p('students', 'view', 'own'),
      ...p('communications', 'view', 'own'),
      ...p('coaching', 'view create edit', 'own'),
      ...p('freelancing', 'view create', 'own'),
      ...p('gigs', 'view', 'own'),
      ...p('graduation', 'view', 'own'),
      ...p('risks', 'view create', 'own'),
      ...p('escalations', 'view create', 'own'),
      ...p('quality', 'view', 'own'),
      ...p('tasks', 'view create edit', 'own'),
      ...p('teams', 'view', 'own'),
      ...p('reports', 'view', 'own'),
      ...p('notifications', 'view edit', 'own'),
    ],
  };
}

export const QUALITY_LEAD: RoleDefinition = {
  key: 'quality_lead',
  name: 'Quality Lead',
  permissions: [
    ...p('dashboard', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    // Broad read for auditability; NO write on operational modules. The absence
    // of create/edit here is the whole point (docs/02 §3.2).
    ...p('students', 'view', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('coaching', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('gigs', 'view', 'cohort'),
    ...p('graduation', 'view', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view create', 'cohort'),
    ...p('quality', 'view create edit audit configure export', 'cohort'),
    ...p('tasks', 'view create', 'own'),
    ...p('teams', 'view', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit_logs', 'view_logs export', 'cohort'),
    ...p('admin', 'view configure', 'cohort'),
  ],
};

export const QUALITY_SPECIALIST: RoleDefinition = {
  key: 'quality_specialist',
  name: 'Quality Specialist',
  permissions: [
    ...p('dashboard', 'view', 'cohort'),
    ...p('my_work', 'view edit', 'own'),
    ...p('students', 'view', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('coaching', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('gigs', 'view', 'cohort'),
    ...p('graduation', 'view', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view create', 'cohort'),
    ...p('quality', 'view create edit audit', 'own'),
    ...p('tasks', 'view create', 'own'),
    ...p('teams', 'view', 'cohort'),
    ...p('reports', 'view', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
    ...p('audit_logs', 'view_logs', 'cohort'),
  ],
};

export const REPORTING_USER: RoleDefinition = {
  key: 'reporting_user',
  name: 'Reporting/Data User',
  permissions: [
    ...p('dashboard', 'view', 'cohort'),
    ...p('students', 'view export', 'cohort'),
    ...p('communications', 'view', 'cohort'),
    ...p('coaching', 'view', 'cohort'),
    ...p('freelancing', 'view', 'cohort'),
    ...p('gigs', 'view', 'cohort'),
    ...p('graduation', 'view', 'cohort'),
    ...p('risks', 'view', 'cohort'),
    ...p('escalations', 'view', 'cohort'),
    ...p('quality', 'view', 'cohort'),
    ...p('teams', 'view', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
  ],
};

export const CLIENT_VIEWER: RoleDefinition = {
  key: 'client_viewer',
  name: 'Client/Read-Only Viewer',
  permissions: [
    // Aggregates and approved reports only. PII masking is applied in the query
    // layer by role (docs/10 §38), not by omitting columns in the UI.
    ...p('dashboard', 'view', 'cohort'),
    ...p('students', 'view', 'cohort'),
    ...p('graduation', 'view', 'cohort'),
    ...p('reports', 'view export', 'cohort'),
    ...p('notifications', 'view edit', 'own'),
  ],
};

export const SEED_ROLES: readonly RoleDefinition[] = [
  SYSTEM_ADMIN,
  PROJECT_MANAGER,
  OPS_ASSOCIATE,
  TEAM_LEADER,
  COORDINATOR,
  coachingManager('t1'),
  coachingManager('t2'),
  coach('t1'),
  coach('t2'),
  QUALITY_LEAD,
  QUALITY_SPECIALIST,
  REPORTING_USER,
  CLIENT_VIEWER,
];

export const SEED_ROLES_BY_KEY: ReadonlyMap<string, RoleDefinition> = new Map(
  SEED_ROLES.map((r) => [r.key, r]),
);
