/**
 * Event handlers and the outbox dispatcher.
 *
 * Every handler is idempotent, keyed on `event_id` via `handler_offsets` written
 * inside the handler's own transaction. Replaying an event is therefore a no-op,
 * which is what makes DLQ replay safe and what the replay-twice test asserts.
 */
import type pg from 'pg';

export interface DomainEvent {
  readonly eventId: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly cohortId: string | null;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface EventHandler {
  readonly key: string;
  /** Event types this handler reacts to. */
  readonly handles: readonly string[];
  handle(event: DomainEvent, tx: pg.PoolClient): Promise<void>;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  skipped: number;
}

function toDomainEvent(row: Record<string, unknown>): DomainEvent {
  return {
    eventId: row.event_id as string,
    type: row.event_type as string,
    version: row.event_version as number,
    occurredAt: row.occurred_at as Date,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    subjectType: row.subject_type as string,
    subjectId: row.subject_id as string,
    cohortId: (row.cohort_id as string | null) ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    correlationId: row.correlation_id as string,
  };
}

/**
 * Runs one handler against one event, exactly once.
 *
 * The offset row is written in the SAME transaction as the handler's effects, so
 * "the handler ran" and "the handler's effects exist" cannot disagree. A
 * duplicate offset (unique violation) means another worker already processed it.
 */
export async function runHandler(
  pool: pg.Pool,
  handler: EventHandler,
  event: DomainEvent,
): Promise<'ran' | 'already_processed'> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const claim = await tx.query(
      `INSERT INTO handler_offsets (handler_key, event_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [handler.key, event.eventId],
    );
    if (claim.rowCount === 0) {
      await tx.query('ROLLBACK');
      return 'already_processed';
    }
    await handler.handle(event, tx);
    await tx.query('COMMIT');
    return 'ran';
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * Drains the outbox. Only committed rows are visible, so an event is never
 * published for a rolled-back transaction.
 *
 * A handler failure leaves the outbox row undispatched with the error recorded
 * and a backoff applied; after `maxAttempts` it is dead-lettered for an operator
 * to inspect and replay, which is safe because handlers are idempotent.
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  handlers: readonly EventHandler[],
  options: { batchSize?: number; maxAttempts?: number; now?: Date } = {},
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? 100;
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? new Date();

  const { rows } = await pool.query(
    `SELECT e.*, o.attempts
     FROM event_outbox o JOIN events e ON e.event_id = o.event_id
     WHERE o.dispatched_at IS NULL AND o.available_at <= $1
     ORDER BY e.seq
     LIMIT $2`,
    [now, batchSize],
  );

  const result: DispatchResult = { dispatched: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    const event = toDomainEvent(row);
    const interested = handlers.filter((h) => h.handles.includes(event.type));
    if (interested.length === 0) {
      await pool.query(`UPDATE event_outbox SET dispatched_at = $2 WHERE event_id = $1`, [
        event.eventId,
        now,
      ]);
      result.skipped++;
      continue;
    }

    let failure: Error | null = null;
    for (const handler of interested) {
      try {
        await runHandler(pool, handler, event);
      } catch (err) {
        failure = err as Error;
        break;
      }
    }

    if (failure) {
      const attempts = ((row.attempts as number) ?? 0) + 1;
      // Exponential backoff, capped. Beyond maxAttempts the row stays pending
      // with its error, which is what the DLQ console lists.
      const backoffSeconds = Math.min(2 ** attempts, 300);
      await pool.query(
        `UPDATE event_outbox
         SET attempts = $2, last_error = $3, available_at = $4
         WHERE event_id = $1`,
        [
          event.eventId,
          attempts,
          failure.message.slice(0, 2000),
          attempts >= maxAttempts ? new Date(8640000000000000) : new Date(now.getTime() + backoffSeconds * 1000),
        ],
      );
      await pool.query(
        `INSERT INTO system_log (level, component, code, message, context, correlation_id)
         VALUES ('error', 'outbox', 'HANDLER_FAILED', $1, $2::jsonb, $3)`,
        [
          failure.message.slice(0, 2000),
          JSON.stringify({ eventId: event.eventId, eventType: event.type, attempts }),
          event.correlationId,
        ],
      );
      result.failed++;
    } else {
      await pool.query(`UPDATE event_outbox SET dispatched_at = $2 WHERE event_id = $1`, [
        event.eventId,
        now,
      ]);
      result.dispatched++;
    }
  }

  return result;
}

/** Dead-lettered events, for the operator console (§78). */
export async function deadLetters(pool: pg.Pool, maxAttempts = 5) {
  const { rows } = await pool.query(
    `SELECT o.event_id, o.attempts, o.last_error, e.event_type, e.occurred_at
     FROM event_outbox o JOIN events e ON e.event_id = o.event_id
     WHERE o.dispatched_at IS NULL AND o.attempts >= $1
     ORDER BY e.seq`,
    [maxAttempts],
  );
  return rows;
}

/** Re-arms a dead-lettered event for another attempt. Safe: handlers are idempotent. */
export async function replayDeadLetter(pool: pg.Pool, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE event_outbox SET attempts = 0, available_at = now(), last_error = NULL
     WHERE event_id = $1 AND dispatched_at IS NULL`,
    [eventId],
  );
}
