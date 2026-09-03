/**
 * A minimal router whose defining feature is that a route CANNOT exist without
 * declaring the permission it requires.
 *
 * `defineRoute` takes `(module, verb)` as a required field, and the route table
 * is exported so the exhaustive role x endpoint test can be generated from it.
 * An endpoint added without a declaration does not compile; an endpoint whose
 * declaration names an unknown module or verb fails the test.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import {
  authorize,
  MODULES,
  VERBS,
  type Module,
  type Verb,
} from '@coordinator/permissions';
import type { RequestContext } from '@coordinator/core';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteRequest {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
  readonly ctx: RequestContext;
  readonly pool: pg.Pool;
  readonly sessionId: string;
  readonly elevated: boolean;
}

export interface RouteResponse {
  status?: number;
  body: unknown;
}

export interface Route {
  readonly method: Method;
  /** Path pattern with `:name` segments, e.g. `/v1/students/:id`. */
  readonly path: string;
  /** The permission this endpoint requires. Not optional -- that is the point. */
  readonly requires: { module: Module; verb: Verb };
  /** True for routes reachable before authentication (login only). */
  readonly public?: boolean;
  /** True when the action needs a fresh step-up re-authentication. */
  readonly elevated?: boolean;
  readonly summary: string;
  handle(req: RouteRequest): Promise<RouteResponse>;
}

export function defineRoute(route: Route): Route {
  if (!route.public) {
    if (!MODULES.includes(route.requires.module)) {
      throw new Error(`route ${route.path} declares unknown module ${route.requires.module}`);
    }
    if (!VERBS.includes(route.requires.verb)) {
      throw new Error(`route ${route.path} declares unknown verb ${route.requires.verb}`);
    }
  }
  return route;
}

interface Compiled {
  route: Route;
  segments: string[];
}

export class Router {
  private readonly compiled: Compiled[] = [];

  constructor(routes: readonly Route[]) {
    for (const route of routes) {
      this.compiled.push({ route, segments: route.path.split('/').filter(Boolean) });
    }
  }

  get routes(): readonly Route[] {
    return this.compiled.map((c) => c.route);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const { route, segments } of this.compiled) {
      if (route.method !== method) continue;
      if (segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!;
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]!);
        else if (s !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

/** The permission check every non-public route passes through. */
export function checkRoutePermission(route: Route, ctx: RequestContext) {
  if (route.public) return { allowed: true as const };
  return authorize(ctx.actor, route.requires.module, route.requires.verb);
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The API is not a browser surface; these are cheap and prevent a class of
    // accidents if a response is ever rendered.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new Error('request body is not valid JSON');
  }
}
