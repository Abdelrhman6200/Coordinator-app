/**
 * The single write path (docs/10 §35.3).
 *
 * Every state mutation in the system goes through `execute`. There is no second
 * path, which is what makes "no UI action mutates state without emitting an
 * event" true by construction rather than by discipline:
 *
 *   permission guard -> scope -> separation of duties -> state machine guard
 *   -> BEGIN
 *        state change
 *        event append          (same transaction)
 *        audit row             (same transaction)
 *        outbox row            (same transaction)
 *      COMMIT
 *   -> async handlers (idempotent, keyed on event_id)
 *
 * The transactional outbox rather than a dual write: an event is never published
 * for a transaction that rolled back, and never lost for one that committed.
 */
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from './context.ts';

export interface EventToEmit {
  readonly type: string;
  readonly version?: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly cohortId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly occurredAt?: Date;
  readonly causationId?: string;
}

export interface AuditToWrite {
  readonly module: string;
  readonly recordType: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly permissionUsed: string;
  readonly oldValue?: Record<string, unknown> | null;
  readonly newValue?: Record<string, unknown> | null;
  readonly reason?: string | null;
  readonly relatedObject?: string | null;
}

export interface CommandResult<T> {
  readonly value: T;
  readonly eventIds: readonly string[];
}

/** What a command body may do. It cannot reach the pool directly. */
export interface CommandScope {
  readonly tx: pg.PoolClient;
  readonly ctx: RequestContext;
  /** Append a domain event. Returns its id so later events can cite causation. */
  emit(event: EventToEmit): Promise<string>;
  /** Write an audit row. Every sensitive action must call this. */
  audit(entry: AuditToWrite): Promise<void>;
  /** Record a field-level before/after for the version history. */
  recordChange(
    entityType: string,
    entityId: string,
    field: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void>;
}

export interface Executor {
  execute<T>(ctx: RequestContext, body: (scope: CommandScope) => Promise<T>): Promise<CommandResult<T>>;
}

export function createExecutor(pool: pg.Pool): Executor {
  return {
    async execute<T>(ctx: RequestContext, body: (scope: CommandScope) => Promise<T>) {
      const tx = await pool.connect();
      const eventIds: string[] = [];
      let lastEventId: string | null = null;

      const scope: CommandScope = {
        tx,
        ctx,
        async emit(event) {
          const eventId = randomUUID();
          await tx.query(
            `INSERT INTO events (event_id, event_type, event_version, occurred_at, actor_user_id,
                                 actor_role, effective_actor_user_id, subject_type, subject_id,
                                 cohort_id, payload, correlation_id, causation_id, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
            [
              eventId,
              event.type,
              event.version ?? 1,
              event.occurredAt ?? ctx.now,
              ctx.realUserId === ctx.actor.userId ? ctx.actor.userId : ctx.realUserId,
              ctx.actorRoleKey,
              ctx.realUserId === ctx.actor.userId ? null : ctx.actor.userId,
              event.subjectType,
              event.subjectId,
              event.cohortId ?? null,
              JSON.stringify(event.payload),
              ctx.correlationId,
              event.causationId ?? lastEventId,
              ctx.source,
            ],
          );
          // Published only after COMMIT, by the outbox dispatcher.
          await tx.query(`INSERT INTO event_outbox (event_id) VALUES ($1)`, [eventId]);
          eventIds.push(eventId);
          lastEventId = eventId;
          return eventId;
        },

        async audit(entry) {
          await tx.query(
            `INSERT INTO audit_log (user_id, effective_user_id, role, permission_used, module,
                                    record_type, record_id, action, old_value, new_value, reason,
                                    source, related_object, correlation_id, event_id, ip,
                                    user_agent, session_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              ctx.realUserId,
              ctx.realUserId === ctx.actor.userId ? null : ctx.actor.userId,
              ctx.actorRoleKey,
              entry.permissionUsed,
              entry.module,
              entry.recordType,
              entry.recordId,
              entry.action,
              entry.oldValue ? JSON.stringify(entry.oldValue) : null,
              entry.newValue ? JSON.stringify(entry.newValue) : null,
              entry.reason ?? null,
              ctx.source,
              entry.relatedObject ?? null,
              ctx.correlationId,
              lastEventId,
              ctx.ip ?? null,
              ctx.userAgent ?? null,
              ctx.sessionId ?? null,
            ],
          );
        },

        async recordChange(entityType, entityId, field, oldValue, newValue) {
          await tx.query(
            `INSERT INTO entity_version_history (entity_type, entity_id, field, old_value,
                                                 new_value, changed_by, event_id, correlation_id)
             VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
            [
              entityType,
              entityId,
              field,
              JSON.stringify(oldValue ?? null),
              JSON.stringify(newValue ?? null),
              ctx.realUserId,
              lastEventId,
              ctx.correlationId,
            ],
          );
        },
      };

      try {
        await tx.query('BEGIN');
        const value = await body(scope);
        await tx.query('COMMIT');
        return { value, eventIds };
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        tx.release();
      }
    },
  };
}
