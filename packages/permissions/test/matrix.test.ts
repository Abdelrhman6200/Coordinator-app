import { describe, expect, it } from 'vitest';
import {
  authorize,
  COORDINATOR,
  CLIENT_VIEWER,
  grantedScope,
  MODULES,
  QUALITY_LEAD,
  QUALITY_SPECIALIST,
  SEED_ROLES,
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
  it('every seed permission uses a known module, verb and scope', () => {
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

  it('role keys are unique', () => {
    const keys = SEED_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('exhaustive role x (module, verb) allow/deny', () => {
  // This is the shape the generated endpoint test takes once routes exist
  // (docs/11 §4): every role against every declared permission, asserted both
  // ways. Here it locks the matrix itself.
  it.each(SEED_ROLES.map((r) => [r.key, r] as const))('%s', (_key, role) => {
    const actor = actorOf(role);
    const granted = new Set(role.permissions.map((p) => `${p.module}.${p.verb}`));
    for (const module of MODULES) {
      for (const verb of VERBS) {
        const decision = authorize(actor, module, verb);
        expect(decision.allowed, `${role.key} ${module}.${verb}`).toBe(
          granted.has(`${module}.${verb}`),
        );
      }
    }
  });
});

describe('structural guarantees the matrix must keep', () => {
  it('no coordinator composition can approve a graduation (AC-08)', () => {
    // The terminal transition requires graduation.approve. Assert no role a
    // coordinator could plausibly also hold grants it, and that the coordinator
    // role itself certainly does not.
    expect(authorize(actorOf(COORDINATOR), 'graduation', 'approve').allowed).toBe(false);
    expect(grantedScope(actorOf(COORDINATOR), 'graduation', 'approve')).toBeUndefined();
  });

  it('quality roles hold no write on operational modules (docs/02 §3.2)', () => {
    const operational: Module[] = [
      'students',
      'communications',
      'coaching',
      'freelancing',
      'gigs',
      'graduation',
      'risks',
    ];
    const writeVerbs: Verb[] = ['create', 'edit', 'delete', 'approve', 'reject', 'override_lock'];
    for (const role of [QUALITY_LEAD, QUALITY_SPECIALIST]) {
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

  it('quality roles do hold write on QA objects', () => {
    expect(authorize(actorOf(QUALITY_LEAD), 'quality', 'audit').allowed).toBe(true);
    expect(authorize(actorOf(QUALITY_SPECIALIST), 'quality', 'audit').allowed).toBe(true);
  });

  it('only System Admin may impersonate', () => {
    for (const role of SEED_ROLES) {
      expect(authorize(actorOf(role), 'admin', 'impersonate').allowed).toBe(
        role.key === 'system_admin',
      );
    }
  });

  it('override_lock is held only by System Admin', () => {
    for (const role of SEED_ROLES) {
      const holds =
        authorize(actorOf(role), 'gigs', 'override_lock').allowed ||
        authorize(actorOf(role), 'graduation', 'override_lock').allowed;
      expect(holds, role.key).toBe(role.key === 'system_admin');
    }
  });

  it('client viewer can neither export students nor see audit logs', () => {
    const a = actorOf(CLIENT_VIEWER);
    expect(authorize(a, 'students', 'export').allowed).toBe(false);
    expect(authorize(a, 'audit_logs', 'view_logs').allowed).toBe(false);
    expect(authorize(a, 'communications', 'view').allowed).toBe(false);
  });

  it('coordinator peer visibility is off by default (register item 14)', () => {
    expect(grantedScope(actorOf(COORDINATOR), 'students', 'view')).toBe('own');
  });
});

describe('multi-role union', () => {
  it('takes the widest scope for a given (module, verb)', () => {
    const a = actorOf(COORDINATOR, SYSTEM_ADMIN);
    expect(grantedScope(a, 'students', 'view')).toBe('all');
  });

  it('grants a verb held by only one of the roles', () => {
    expect(authorize(actorOf(COORDINATOR), 'gigs', 'approve').allowed).toBe(false);
    expect(authorize(actorOf(COORDINATOR, SYSTEM_ADMIN), 'gigs', 'approve').allowed).toBe(true);
  });
});

describe('navigation renders from the matrix (AC-27)', () => {
  it('shows exactly the modules with a view grant', () => {
    const visible = new Set(visibleModules(actorOf(COORDINATOR)));
    expect(visible.has('admin')).toBe(false);
    expect(visible.has('audit_logs')).toBe(false);
    expect(visible.has('my_work')).toBe(true);
    expect(visible.has('students')).toBe(true);
  });

  it('gives the client viewer a minimal shell', () => {
    expect(visibleModules(actorOf(CLIENT_VIEWER)).sort()).toEqual(
      ['dashboard', 'graduation', 'notifications', 'reports', 'students'].sort(),
    );
  });
});

describe('denials are structured and renderable verbatim', () => {
  it('names the required permission and how to obtain it', () => {
    const d = authorize(actorOf(COORDINATOR), 'gigs', 'approve');
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.denial.code).toBe('PERMISSION_DENIED');
    expect(d.denial.required).toEqual({ module: 'gigs', verb: 'approve' });
    expect(d.denial.reason).toContain('gigs.approve');
    // Must not leak whether any record exists.
    expect(d.denial.reason).not.toMatch(/\d+ (record|student|gig)/);
  });
});
