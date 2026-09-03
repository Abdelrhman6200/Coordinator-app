/**
 * The request context every command carries.
 *
 * `actorUserId` is the real person; `effectiveUserId` differs only while
 * impersonating, and BOTH are recorded on every event and audit row -- an
 * impersonated action must never look like the impersonated user acted alone.
 */
import type { Actor } from '@coordinator/permissions';

export interface RequestContext {
  readonly actor: Actor;
  /** The real user behind an impersonated session, when different. */
  readonly realUserId: string;
  readonly actorRoleKey: string;
  readonly correlationId: string;
  readonly source: 'UI' | 'API' | 'IMPORT' | 'SYSTEM_JOB';
  readonly ip?: string;
  readonly userAgent?: string;
  readonly sessionId?: string;
  /** True while a step-up re-authentication is still valid. */
  readonly elevated: boolean;
  readonly now: Date;
}

export function systemContext(correlationId: string, now = new Date()): RequestContext {
  return {
    actor: { userId: '00000000-0000-0000-0000-000000000000', roles: [], cohortIds: [] },
    realUserId: '00000000-0000-0000-0000-000000000000',
    actorRoleKey: 'system',
    correlationId,
    source: 'SYSTEM_JOB',
    elevated: false,
    now,
  };
}
