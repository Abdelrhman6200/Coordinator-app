import { describe, expect, it } from 'vitest';
import {
  authorize,
  grantedScope,
  MODULES,
  OPERATIONAL_MODULES,
  OPERATIONS_COORDINATOR,
  OPERATIONS_SYSTEMS,
  PROJECT_MANAGER,
  PROJECT_OPERATIONS,
  QUALITY_LEAD,
  QUALITY_MEMBER,
  SEED_ROLES,
  STUDENT,
  SYSTEM_ADMIN,
  type Actor,
  type Module,
  type RoleDefinition,
  type Verb,
  VERBS,
  visibleModules,
} from '../src/index.ts';

function actorOf(...roles: RoleDefinition[]): Actor {
  return { userId: 'u1', roles, cohortIds: ['c1'] };
}

describe('matrix integrity', () => {
  it('every seed permission uses a known module and verb', () => {
    for (const role of SEED_ROLES) {
      for (const perm of role.permissions) {
        expect(MODULES, `${role.key}.${perm.module}`).toContain(perm.module);
        expect(VERBS, `${role.key}.${perm.verb}`).toContain(perm.verb);
      }
    }
  });

  it('has no duplicate (module, verb) grants within a role', () => {
    for (const role of SEED_ROLES) {
      const seen = new Set<string>();
      for (const perm of role.permissions) {
        const key = `${perm.module}.${perm.verb}`;
        expect(seen.has(key), `${role.key} duplicates ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('covers all twelve confirmed DEPI Round 5 roles', () => {
    expect(SEED_ROLES.map((r) => r.key).sort()).toEqual(
      [
        'coach_operations',
        'operations_coordinator',
        'operations_systems_specialist',
        'outcome_coach',
        'project_manager',
        'project_operations',
        'quality_lead',
        'quality_member',
        'student',
        'support_coach',
        'system_admin',
        'team_supervisor',
      ].sort(),
    );
  });
});

describe('exhaustive role x (module, verb) allow/deny', () => {
  it.each(SEED_ROLES.map((r) => [r.key, r] as const))('%s', (_key, role) => {
    const actor = actorOf(role);
    const granted = new Set(role.permissions.map((p) => `${p.module}.${p.verb}`));
    for (const module of MODULES) {
      for (const verb of VERBS) {
        expect(authorize(actor, module, verb).allowed, `${role.key} ${module}.${verb}`).toBe(
          granted.has(`${module}.${verb}`),
        );
      }
    }
  });
});

describe('graduation is computed, never granted (§40)', () => {
  it('gives no role any write verb on graduation', () => {
    const writeVerbs: Verb[] = ['create', 'edit', 'delete', 'approve', 'reject'];
    for (const role of SEED_ROLES) {
      for (const verb of writeVerbs) {
        expect(
          authorize(actorOf(role), 'graduation', verb).allowed,
          `${role.key} must not hold graduation.${verb}`,
        ).toBe(false);
      }
    }
  });

  it('reserves the graduation lock override to the System Admin alone', () => {
    for (const role of SEED_ROLES) {
      expect(authorize(actorOf(role), 'graduation', 'override_lock').allowed, role.key).toBe(
        role.key === 'system_admin',
      );
    }
  });
});

describe('Quality independence (§5, §36, §59)', () => {
  it('gives no non-Quality role any write on the quality module', () => {
    const writeVerbs: Verb[] = [
      'create',
      'edit',
      'delete',
      'approve',
      'reject',
      'audit',
      'configure',
      'override_lock',
    ];
    for (const role of SEED_ROLES) {
      if (role.key === 'quality_lead' || role.key === 'quality_member') continue;
      for (const verb of writeVerbs) {
        expect(
          authorize(actorOf(role), 'quality', verb).allowed,
          `${role.key} must not hold quality.${verb}`,
        ).toBe(false);
      }
    }
  });

  it('denies even the System Admin any write on Quality decisions', () => {
    expect(authorize(actorOf(SYSTEM_ADMIN), 'quality', 'edit').allowed).toBe(false);
    expect(authorize(actorOf(SYSTEM_ADMIN), 'quality', 'view').allowed).toBe(true);
  });

  it('gives Quality roles no write on operational records', () => {
    const writeVerbs: Verb[] = ['create', 'edit', 'delete', 'assign', 'reassign', 'approve'];
    const operational: Module[] = [
      'students',
      'groups',
      'communications',
      'sessions',
      'freelancing',
      'services',
    ];
    for (const role of [QUALITY_LEAD, QUALITY_MEMBER]) {
      for (const module of operational) {
        for (const verb of writeVerbs) {
          expect(
            authorize(actorOf(role), module, verb).allowed,
            `${role.key} must not hold ${module}.${verb}`,
          ).toBe(false);
        }
      }
    }
  });

  it('reserves L3 authority and Quality configuration to the Quality Lead', () => {
    expect(authorize(actorOf(QUALITY_LEAD), 'quality', 'configure').allowed).toBe(true);
    expect(authorize(actorOf(QUALITY_MEMBER), 'quality', 'configure').allowed).toBe(false);
    expect(authorize(actorOf(QUALITY_MEMBER), 'quality', 'override_lock').allowed).toBe(false);
  });
});

describe('the coordinator boundary (§5)', () => {
  const coord = actorOf(OPERATIONS_COORDINATOR);

  it('permits L1 screening: review and return, never accept', () => {
    expect(authorize(coord, 'evidence', 'edit').allowed).toBe(true);
    expect(authorize(coord, 'evidence', 'reject').allowed).toBe(true);
    expect(authorize(coord, 'evidence', 'approve').allowed).toBe(false);
  });

  it('denies Quality approval, graduation and configuration', () => {
    expect(authorize(coord, 'quality', 'approve').allowed).toBe(false);
    expect(authorize(coord, 'graduation', 'edit').allowed).toBe(false);
    expect(authorize(coord, 'administration', 'configure').allowed).toBe(false);
  });

  it('confines the coordinator to their own assignments', () => {
    expect(grantedScope(coord, 'students', 'view')).toBe('own');
    expect(grantedScope(coord, 'groups', 'view')).toBe('own');
  });
});

describe('the student portal is isolated (§10)', () => {
  const student = actorOf(STUDENT);

  it('grants nothing outside the portal', () => {
    for (const module of MODULES) {
      for (const verb of VERBS) {
        expect(authorize(student, module, verb).allowed, `${module}.${verb}`).toBe(
          module === 'portal' && ['view', 'create', 'edit'].includes(verb),
        );
      }
    }
  });

  it('holds no grant on any operational module at all', () => {
    // Absent from the grant set, not merely hidden: a routing mistake cannot
    // reach staff data.
    for (const module of OPERATIONAL_MODULES) {
      for (const verb of VERBS) {
        expect(authorize(student, module, verb).allowed).toBe(false);
      }
    }
  });

  it('shows the student only the portal in navigation', () => {
    expect(visibleModules(student)).toEqual(['portal']);
  });

  it('gives no staff role access to the portal surface', () => {
    for (const role of SEED_ROLES) {
      if (role.key === 'student') continue;
      expect(authorize(actorOf(role), 'portal', 'view').allowed, role.key).toBe(false);
    }
  });
});

describe('administrative access is separate from business authority (§5)', () => {
  it('denies the Project Manager configuration and impersonation', () => {
    expect(authorize(actorOf(PROJECT_MANAGER), 'administration', 'configure').allowed).toBe(false);
    expect(authorize(actorOf(PROJECT_MANAGER), 'administration', 'impersonate').allowed).toBe(false);
  });

  it('reserves impersonation to the System Admin', () => {
    for (const role of SEED_ROLES) {
      expect(authorize(actorOf(role), 'administration', 'impersonate').allowed, role.key).toBe(
        role.key === 'system_admin',
      );
    }
  });

  it('gives Operations Systems reporting configuration but no operational write', () => {
    const os = actorOf(OPERATIONS_SYSTEMS);
    expect(authorize(os, 'reports', 'configure').allowed).toBe(true);
    // The person who reports the numbers must not be able to change the records
    // behind them.
    expect(authorize(os, 'students', 'edit').allowed).toBe(false);
    expect(authorize(os, 'evidence', 'edit').allowed).toBe(false);
  });

  it('reserves pathway designation and group approval to Project Operations', () => {
    expect(authorize(actorOf(PROJECT_OPERATIONS), 'groups', 'approve').allowed).toBe(true);
    expect(authorize(actorOf(OPERATIONS_COORDINATOR), 'groups', 'approve').allowed).toBe(false);
    expect(authorize(actorOf(PROJECT_MANAGER), 'groups', 'approve').allowed).toBe(false);
  });
});

describe('coaching roles', () => {
  it('gives only the Support Coach write on the service pipeline', () => {
    const outcome = SEED_ROLES.find((r) => r.key === 'outcome_coach')!;
    const support = SEED_ROLES.find((r) => r.key === 'support_coach')!;
    expect(authorize(actorOf(support), 'services', 'edit').allowed).toBe(true);
    expect(authorize(actorOf(outcome), 'services', 'edit').allowed).toBe(false);
    expect(authorize(actorOf(outcome), 'services', 'view').allowed).toBe(true);
  });

  it('lets Coach Operations assign and replace coaches', () => {
    const co = actorOf(SEED_ROLES.find((r) => r.key === 'coach_operations')!);
    expect(authorize(co, 'sessions', 'assign').allowed).toBe(true);
    expect(authorize(co, 'team', 'reassign').allowed).toBe(true);
  });
});

describe('navigation renders from the matrix', () => {
  it('gives the coordinator no administration or audit tab', () => {
    const visible = new Set(visibleModules(actorOf(OPERATIONS_COORDINATOR)));
    expect(visible.has('administration')).toBe(false);
    expect(visible.has('audit')).toBe(false);
    expect(visible.has('my_work')).toBe(true);
    expect(visible.has('groups')).toBe(true);
  });
});

describe('denials are structured and leak nothing', () => {
  it('names the required permission without revealing record existence', () => {
    const d = authorize(actorOf(OPERATIONS_COORDINATOR), 'quality', 'approve');
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.denial.reason).toContain('quality.approve');
    expect(d.denial.reason).not.toMatch(/\d+ (record|student|submission)/);
  });
});
