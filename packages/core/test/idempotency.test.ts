/**
 * Idempotency and replay (Phase E).
 *
 * The claim: replaying EVERY event type twice produces no duplicate task, no
 * duplicate notification, no double-counted KPI and no second audit entry. This
 * is what makes the dead-letter replay console safe to hand an operator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { seedRoles } from '@coordinator/db';
import { createExecutor, type Executor } from '../src/write-path.ts';
import { buildHandlers } from '../src/handlers-registry.ts';
import { deadLetters, dispatchOutbox, replayDeadLetter, runHandler } from '../src/handlers.ts';
import { recordInteraction } from '../src/services/students.ts';
import { ALL_CHECKS_PASS, decideQuality, reviewStage, submitEvidence } from '../src/services/evidence.ts';
import { buildWorld, CALENDAR, ctxFor, makePool, type World } from './fixture.ts';

let pool: pg.Pool;
let exec: Executor;
let w: World;

beforeAll(async () => {
  pool = makePool();
  const c = await pool.connect();
  try {
    await seedRoles(c);
  } finally {
    c.release();
  }
  exec = createExecutor(pool);
  w = await buildWorld(pool);
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].n);
}

describe('the outbox publishes only committed work', () => {
  it('does not publish an event from a rolled-back transaction', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const marker = randomUUID();
    await expect(
      exec.execute(ctx, async (scope) => {
        await scope.emit({
          type: 'TEST_ROLLED_BACK',
          subjectType: 'student',
          subjectId: w.studentId,
          payload: { marker },
        });
        throw new Error('deliberate failure after emit');
      }),
    ).rejects.toThrow('deliberate failure');

    // Neither the event nor its outbox row survives. A dual write would have
    // published this.
    expect(
      await count(`SELECT count(*)::int AS n FROM events WHERE event_type = 'TEST_ROLLED_BACK'`, []),
    ).toBe(0);
  });

  it('publishes an event from a committed transaction exactly once', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { eventIds } = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'whatsapp',
        purpose: 'weekly_follow_up',
        outcome: 'no_response',
        calendar: CALENDAR,
      }),
    );
    expect(eventIds.length).toBeGreaterThan(0);

    const handlers = buildHandlers(CALENDAR);
    await dispatchOutbox(pool, handlers, { batchSize: 500 });

    // Asserted on THESE events rather than on the drain being empty: sibling
    // test files share the database, so "nothing left anywhere" is not a
    // property this test owns.
    const { rows } = await pool.query(
      `SELECT event_id, dispatched_at FROM event_outbox WHERE event_id = ANY($1)`,
      [eventIds],
    );
    expect(rows).toHaveLength(eventIds.length);
    for (const r of rows) expect(r.dispatched_at).not.toBeNull();

    // Draining again does not re-dispatch them.
    await dispatchOutbox(pool, handlers, { batchSize: 500 });
    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS n FROM event_outbox
       WHERE event_id = ANY($1) AND dispatched_at IS NULL`,
      [eventIds],
    );
    expect(after[0].n).toBe(0);
  });
});

describe('replaying every event twice changes nothing', () => {
  it('produces no duplicate tasks, notifications or read-model rows', async () => {
    // Build a realistic history first.
    const gigRow = await pool.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1,'khamsat','Replay',10,DATE '2026-01-05',DATE '2026-01-06') RETURNING id`,
      [w.studentId],
    );
    const { value: sub } = await exec.execute(ctxFor(w.studentUserId, 'student'), (scope) =>
      submitEvidence(scope, {
        studentId: w.studentId,
        subjectType: 'gig',
        gigId: gigRow.rows[0].id,
        files: [{ kind: 'delivered_work', fileRef: 's3://r', contentHash: Buffer.from(randomUUID()) }],
        calendar: CALENDAR,
      }),
    );
    await exec.execute(ctxFor(w.coachId, 'outcome_coach'), (scope) =>
      reviewStage(scope, { submissionId: sub.submissionId, stage: 'coach', decision: 'passed', calendar: CALENDAR }),
    );
    await exec.execute(ctxFor(w.coordinatorId, 'operations_coordinator'), (scope) =>
      reviewStage(scope, { submissionId: sub.submissionId, stage: 'l1', decision: 'passed', calendar: CALENDAR }),
    );
    await exec.execute(ctxFor(w.qualityMemberId, 'quality_member'), (scope) =>
      decideQuality(scope, {
        submissionId: sub.submissionId,
        level: 'l2',
        checks: ALL_CHECKS_PASS,
        rejectionCodes: [],
        calendar: CALENDAR,
      }),
    );

    const handlers = buildHandlers(CALENDAR);
    // Drain fully: vitest runs test files in parallel against the same database,
    // so a single pass may leave a sibling file's freshly-committed events
    // pending.
    for (let i = 0; i < 10; i++) {
      const r = await dispatchOutbox(pool, handlers, { batchSize: 500 });
      if (r.dispatched + r.skipped + r.failed === 0) break;
    }

    const before = {
      tasks: await count(`SELECT count(*)::int AS n FROM task WHERE student_id = $1`, [w.studentId]),
      notifications: await count(
        `SELECT count(*)::int AS n FROM notification WHERE user_id IN ($1,$2,$3,$4,$5)`,
        [w.coordinatorId, w.coachId, w.qualityMemberId, w.qualityLeadId, w.supervisorId],
      ),
      audits: await count(
        `SELECT count(*)::int AS n FROM audit_log WHERE user_id IN ($1,$2,$3,$4,$5)`,
        [w.coordinatorId, w.coachId, w.qualityMemberId, w.qualityLeadId, w.studentUserId],
      ),
      readModel: await count(
        `SELECT accepted_gig_count::int AS n FROM rm_student_current WHERE student_id = $1`,
        [w.studentId],
      ),
      graduation: await count(
        `SELECT count(*)::int AS n FROM graduation_progress WHERE student_id = $1`,
        [w.studentId],
      ),
    };

    // Replay EVERY event belonging to THIS world against EVERY interested
    // handler, twice. Scoped to the world because sibling test files share the
    // database and may be mid-flight.
    const { rows: allEvents } = await pool.query(
      `SELECT * FROM events
       WHERE cohort_id = $1
          OR subject_id IN (SELECT id FROM student WHERE cohort_id = $1)
          OR subject_id IN (SELECT es.id FROM evidence_submission es
                            JOIN student s ON s.id = es.student_id WHERE s.cohort_id = $1)
       ORDER BY seq`,
      [w.cohortId],
    );
    expect(allEvents.length).toBeGreaterThan(0);
    for (const pass of [1, 2]) {
      for (const row of allEvents) {
        const event = {
          eventId: row.event_id as string,
          type: row.event_type as string,
          version: row.event_version as number,
          occurredAt: row.occurred_at as Date,
          actorUserId: row.actor_user_id as string | null,
          subjectType: row.subject_type as string,
          subjectId: row.subject_id as string,
          cohortId: row.cohort_id as string | null,
          payload: (row.payload ?? {}) as Record<string, unknown>,
          correlationId: row.correlation_id as string,
        };
        for (const h of handlers) {
          if (!h.handles.includes(event.type)) continue;
          const outcome = await runHandler(pool, h, event);
          // Everything has already been processed by the live dispatch, so every
          // replay is a no-op -- on both passes.
          expect(outcome, `pass ${pass} ${h.key} ${event.type}`).toBe('already_processed');
        }
      }
    }

    expect(await count(`SELECT count(*)::int AS n FROM task WHERE student_id = $1`, [w.studentId]))
      .toBe(before.tasks);
    // Counts are scoped to this world for the same reason.
    expect(
      await count(
        `SELECT count(*)::int AS n FROM notification WHERE user_id IN ($1,$2,$3,$4,$5)`,
        [w.coordinatorId, w.coachId, w.qualityMemberId, w.qualityLeadId, w.supervisorId],
      ),
    ).toBe(before.notifications);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM audit_log WHERE user_id IN ($1,$2,$3,$4,$5)`,
        [w.coordinatorId, w.coachId, w.qualityMemberId, w.qualityLeadId, w.studentUserId],
      ),
    ).toBe(before.audits);
    expect(
      await count(`SELECT accepted_gig_count::int AS n FROM rm_student_current WHERE student_id = $1`, [
        w.studentId,
      ]),
    ).toBe(before.readModel);
    expect(
      await count(`SELECT count(*)::int AS n FROM graduation_progress WHERE student_id = $1`, [
        w.studentId,
      ]),
    ).toBe(before.graduation);
  });

  it('keeps read-model projection safe under forced re-application', async () => {
    // Even bypassing the offset table -- the projection is set-to-value, so a
    // handler bug that ran it twice would still be harmless.
    const before = await pool.query(
      `SELECT accepted_gig_count, contact_attempts FROM rm_student_current WHERE student_id = $1`,
      [w.studentId],
    );
    const { projectStudent } = await import('../src/services/projection.ts');
    await projectStudent(pool, w.studentId, CALENDAR);
    await projectStudent(pool, w.studentId, CALENDAR);
    const after = await pool.query(
      `SELECT accepted_gig_count, contact_attempts FROM rm_student_current WHERE student_id = $1`,
      [w.studentId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('the dead-letter queue', () => {
  it('records the failure, backs off, and replays safely', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { eventIds } = await exec.execute(ctx, async (scope) => {
      await scope.emit({
        type: 'DLQ_PROBE',
        subjectType: 'student',
        subjectId: w.studentId,
        payload: {},
      });
      return null;
    });

    let attempts = 0;
    const flaky = {
      key: 'flaky_probe',
      handles: ['DLQ_PROBE'],
      async handle() {
        attempts++;
        if (attempts <= 2) throw new Error('transient downstream failure');
      },
    };

    const now = new Date();
    const first = await dispatchOutbox(pool, [flaky], { now });
    expect(first.failed).toBe(1);

    const { rows: outbox } = await pool.query(
      `SELECT attempts, last_error FROM event_outbox WHERE event_id = $1`,
      [eventIds[0]],
    );
    expect(outbox[0].attempts).toBe(1);
    expect(outbox[0].last_error).toContain('transient downstream failure');

    // The system log carries it too, which is where the operator console reads.
    const logged = await count(
      `SELECT count(*)::int AS n FROM system_log WHERE code = 'HANDLER_FAILED'`,
      [],
    );
    expect(logged).toBeGreaterThan(0);

    // Past the backoff, the second attempt fails, the third succeeds.
    await dispatchOutbox(pool, [flaky], { now: new Date(now.getTime() + 60_000) });
    const third = await dispatchOutbox(pool, [flaky], { now: new Date(now.getTime() + 600_000) });
    expect(third.dispatched).toBe(1);
    expect(attempts).toBe(3);
  });

  it('lists dead letters and re-arms them on request', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { eventIds } = await exec.execute(ctx, async (scope) => {
      await scope.emit({
        type: 'DLQ_PERMANENT',
        subjectType: 'student',
        subjectId: w.studentId,
        payload: {},
      });
      return null;
    });

    const alwaysFails = {
      key: 'always_fails',
      handles: ['DLQ_PERMANENT'],
      async handle() {
        throw new Error('permanent failure');
      },
    };

    let now = new Date();
    for (let i = 0; i < 5; i++) {
      await dispatchOutbox(pool, [alwaysFails], { now });
      now = new Date(now.getTime() + 3_600_000);
    }

    const dead = await deadLetters(pool);
    expect(dead.some((d) => d.event_id === eventIds[0])).toBe(true);

    await replayDeadLetter(pool, eventIds[0]!);
    const { rows } = await pool.query(
      `SELECT attempts, last_error FROM event_outbox WHERE event_id = $1`,
      [eventIds[0]],
    );
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].last_error).toBeNull();
  });
});
