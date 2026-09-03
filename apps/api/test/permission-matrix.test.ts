/**
 * The exhaustive role x endpoint permission test (docs/11 §4).
 *
 * GENERATED from the same two tables that seed the database: the route table
 * (which declares what each endpoint requires) and the role table (which
 * declares what each role holds). Drift between documentation, runtime and test
 * is therefore not possible -- there is nowhere for a discrepancy to live.
 *
 * Every role is asserted against every endpoint, both ways: allowed where the
 * matrix says so, denied where it does not.
 */
import { describe, expect, it } from 'vitest';
import {
  authorize,
  MODULES,
  SEED_ROLES,
  VERBS,
  type Actor,
  type RoleDefinition,
} from '@coordinator/permissions';
import { checkRoutePermission, Router } from '../src/router.ts';
import { routes } from '../src/routes.ts';

const router = new Router(routes);

function actorOf(role: RoleDefinition): Actor {
  return { userId: 'u1', roles: [role], cohortIds: ['c1'] };
}

function ctxOf(role: RoleDefinition) {
  return {
    actor: actorOf(role),
    realUserId: 'u1',
    actorRoleKey: role.key,
    correlationId: 'c',
    source: 'API' as const,
    elevated: false,
    now: new Date(),
  };
}

describe('every endpoint declares a valid permission', () => {
  it('names a known module and verb', () => {
    for (const route of routes) {
      expect(MODULES, `${route.path} module`).toContain(route.requires.module);
      expect(VERBS, `${route.path} verb`).toContain(route.requires.verb);
    }
  });

  it('has no duplicate method+path', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries a human summary, so the route table doubles as documentation', () => {
    for (const route of routes) {
      expect(route.summary.length, route.path).toBeGreaterThan(10);
    }
  });
});

describe('exhaustive: every role x every endpoint', () => {
  const cases = SEED_ROLES.flatMap((role) =>
    routes.map((route) => ({ role, route })),
  );

  it.each(cases.map((c) => [`${c.role.key} -> ${c.route.method} ${c.route.path}`, c] as const))(
    '%s',
    (_label, { role, route }) => {
      const decision = checkRoutePermission(route, ctxOf(role));
      const expected = authorize(actorOf(role), route.requires.module, route.requires.verb).allowed;
      expect(decision.allowed).toBe(expected);
    },
  );
});

describe('structural guarantees at the HTTP boundary', () => {
  it('exposes no endpoint that writes graduation (§40)', () => {
    const writeVerbs = new Set(['create', 'edit', 'delete', 'approve', 'reject']);
    const offenders = routes.filter(
      (r) => r.requires.module === 'graduation' && writeVerbs.has(r.requires.verb),
    );
    expect(offenders.map((r) => r.path)).toEqual([]);
  });

  it('lets no non-Quality role reach a Quality write endpoint (§59)', () => {
    const qualityWrites = routes.filter(
      (r) =>
        r.requires.module === 'quality' &&
        ['create', 'edit', 'approve', 'reject', 'audit', 'configure'].includes(r.requires.verb),
    );
    expect(qualityWrites.length).toBeGreaterThan(0);
    for (const route of qualityWrites) {
      for (const role of SEED_ROLES) {
        const allowed = checkRoutePermission(route, ctxOf(role)).allowed;
        const isQuality = role.key === 'quality_lead' || role.key === 'quality_member';
        expect(allowed, `${role.key} -> ${route.path}`).toBe(isQuality);
      }
    }
  });

  it('confines the student to portal endpoints', () => {
    const student = SEED_ROLES.find((r) => r.key === 'student')!;
    for (const route of routes) {
      const allowed = checkRoutePermission(route, ctxOf(student)).allowed;
      expect(allowed, route.path).toBe(route.requires.module === 'portal');
    }
  });

  it('keeps every staff role out of the portal', () => {
    const portalRoutes = routes.filter((r) => r.requires.module === 'portal');
    expect(portalRoutes.length).toBeGreaterThan(0);
    for (const route of portalRoutes) {
      for (const role of SEED_ROLES) {
        if (role.key === 'student') continue;
        expect(checkRoutePermission(route, ctxOf(role)).allowed, `${role.key} ${route.path}`).toBe(
          false,
        );
      }
    }
  });

  it('lets only the coordinator, ops and admin roles assign a student', () => {
    const route = routes.find((r) => r.path === '/v1/students/:id/assign')!;
    const allowed = SEED_ROLES.filter((r) => checkRoutePermission(route, ctxOf(r)).allowed).map(
      (r) => r.key,
    );
    expect(allowed.sort()).toEqual(['project_operations', 'system_admin'].sort());
  });

  it('denies the coordinator the Quality decision endpoint', () => {
    const route = routes.find((r) => r.path === '/v1/quality/:id/decision')!;
    const coordinator = SEED_ROLES.find((r) => r.key === 'operations_coordinator')!;
    const decision = checkRoutePermission(route, ctxOf(coordinator));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denial.reason).toContain('quality.approve');
      // The denial must not hint at what exists behind it.
      expect(decision.denial.reason).not.toMatch(/\d+ (item|submission|record)/);
    }
  });
});

describe('route matching', () => {
  it('matches parameterised paths and extracts params', () => {
    const m = router.match('GET', '/v1/students/abc-123');
    expect(m?.route.path).toBe('/v1/students/:id');
    expect(m?.params.id).toBe('abc-123');
  });

  it('does not match a different method on the same path', () => {
    expect(router.match('DELETE', '/v1/students/abc-123')).toBeNull();
  });

  it('does not match a longer path', () => {
    expect(router.match('GET', '/v1/students/abc-123/secret')).toBeNull();
  });
});
