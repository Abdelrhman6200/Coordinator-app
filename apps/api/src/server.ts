/**
 * The HTTP server.
 *
 * Every request passes through the same gauntlet: resolve session -> load
 * actor -> route permission -> step-up check -> handler. A route cannot skip it,
 * because the dispatcher applies the checks, not the handler.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  DeniedError,
  DomainError,
  ValidationError,
  login,
  logout,
  elevate,
  resolveSession,
  type RequestContext,
} from '@coordinator/core';
import { SEED_ROLES_BY_KEY, type Actor, type RoleDefinition } from '@coordinator/permissions';
import { checkRoutePermission, json, readBody, Router } from './router.ts';
import { routes } from './routes.ts';

export const router = new Router(routes);

export async function loadActor(pool: pg.Pool, userId: string): Promise<Actor> {
  const { rows } = await pool.query(
    `SELECT r.key, array_remove(array_agg(DISTINCT ur.cohort_id), NULL) AS cohorts
     FROM user_role ur JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND ur.effective_to IS NULL
     GROUP BY r.key`,
    [userId],
  );
  const roles: RoleDefinition[] = [];
  const cohortIds = new Set<string>();
  for (const row of rows) {
    const role = SEED_ROLES_BY_KEY.get(row.key);
    if (role) roles.push(role);
    for (const c of row.cohorts ?? []) cohortIds.add(c);
  }
  if (cohortIds.size === 0) {
    // A user with no cohort-scoped grant still needs a cohort for cohort-wide
    // roles; fall back to the active cohorts they can reach.
    const { rows: active } = await pool.query(
      `SELECT id FROM cohort WHERE state = 'active'`,
    );
    for (const c of active) cohortIds.add(c.id);
  }
  return { userId, roles, cohortIds: [...cohortIds] };
}

function errorResponse(err: unknown): { status: number; body: unknown } {
  if (err instanceof DeniedError) {
    return { status: 403, body: { code: err.denial.code, reason: err.denial.reason, required: err.denial.required } };
  }
  if (err instanceof ValidationError) {
    return { status: 422, body: { code: err.code, reason: err.message, violations: err.violations } };
  }
  if (err instanceof DomainError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID_CREDENTIALS' ? 401 : 400;
    return { status, body: { code: err.code, reason: err.message, details: err.details } };
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return { status: 500, body: { code: 'INTERNAL', reason: message } };
}

export function createApp(pool: pg.Pool) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

    try {
      // ---- Public auth endpoints -------------------------------------------
      if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
        const body = await readBody(req);
        const result = await login(pool, String(body.email ?? ''), String(body.password ?? ''), {
          ip: req.socket.remoteAddress ?? undefined,
          userAgent: req.headers['user-agent'],
        });
        return json(res, 200, {
          token: result.token,
          expiresAt: result.expiresAt,
          userId: result.userId,
        });
      }

      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        return json(res, 401, { code: 'UNAUTHENTICATED', reason: 'Sign in to continue.' });
      }
      const session = await resolveSession(pool, token);
      if (!session) {
        return json(res, 401, { code: 'SESSION_INVALID', reason: 'Your session has expired.' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
        await logout(pool, session.sessionId);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/v1/auth/elevate') {
        const body = await readBody(req);
        await elevate(pool, session.sessionId, session.userId, String(body.password ?? ''));
        return json(res, 200, { ok: true });
      }

      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) return json(res, 404, { code: 'NOT_FOUND', reason: 'No such endpoint.' });

      const actor = await loadActor(pool, session.effectiveUserId);
      const primaryRole = actor.roles[0]?.key ?? 'unknown';
      const ctx: RequestContext = {
        actor,
        realUserId: session.userId,
        actorRoleKey: primaryRole,
        correlationId,
        source: 'API',
        ip: req.socket.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'],
        sessionId: session.sessionId,
        elevated: session.elevated,
        now: new Date(),
      };

      const decision = checkRoutePermission(match.route, ctx);
      if (!decision.allowed) {
        // Denials are logged: a pattern of them is a security signal.
        await pool.query(
          `INSERT INTO system_log (level, component, code, message, context, correlation_id)
           VALUES ('warn', 'authz', 'PERMISSION_DENIED', $1, $2::jsonb, $3)`,
          [
            decision.denial.reason,
            JSON.stringify({
              userId: ctx.actor.userId,
              path: url.pathname,
              required: decision.denial.required,
            }),
            correlationId,
          ],
        );
        return json(res, 403, {
          code: decision.denial.code,
          reason: decision.denial.reason,
          required: decision.denial.required,
        });
      }

      if (match.route.elevated && !session.elevated) {
        return json(res, 403, {
          code: 'REAUTH_REQUIRED',
          reason: 'This action requires you to confirm your password again.',
        });
      }

      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await match.route.handle({
        params: match.params,
        query: url.searchParams,
        body,
        ctx,
        pool,
        sessionId: session.sessionId,
        elevated: session.elevated,
      });
      return json(res, result.status ?? 200, result.body);
    } catch (err) {
      const { status, body } = errorResponse(err);
      if (status >= 500) {
        await pool
          .query(
            `INSERT INTO system_log (level, component, code, message, context, correlation_id)
             VALUES ('error','api','UNHANDLED',$1,$2::jsonb,$3)`,
            [
              err instanceof Error ? err.message : 'unknown',
              JSON.stringify({ path: url.pathname, method: req.method }),
              correlationId,
            ],
          )
          .catch(() => {});
      }
      return json(res, status, body);
    }
  };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
  });
  const port = Number(process.env.PORT ?? 4000);
  createServer(createApp(pool)).listen(port, () => {
    console.log(`coordinator api listening on :${port}`);
  });
}
