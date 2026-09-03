/**
 * Scheduled jobs.
 *
 * Handlers alone are not enough: the signals that matter most here are
 * ABSENCES -- no contact for seven days, an SLA elapsed, a session unconfirmed
 * tomorrow. Nothing emits an event when something fails to happen, so a system
 * built on handlers alone silently fails to notice students going quiet, which
 * is precisely what this platform exists to prevent.
 *
 * Every job is idempotent: re-running it produces no duplicate task, event or
 * notification.
 */
import type pg from 'pg';
import {
  CONTACT_POLICY,
  EVIDENCE_SLA_HOURS,
  QUALITY_QUEUE_THRESHOLDS,
  SESSION_POLICY,
  type WorkingCalendar,
} from '@coordinator/rules';
import { createExecutor } from './write-path.ts';
import { systemContext } from './context.ts';
import { randomUUID } from 'node:crypto';
import { createTask } from './services/tasks.ts';
import { evaluateStudentRisk } from './services/risk.ts';
import { projectStudent } from './services/projection.ts';
import { notify } from './services/notifications.ts';

export interface JobResult {
  job: string;
  examined: number;
  acted: number;
}

/**
 * Weekly contact sweep (§14). A student with no contact logged within seven days
 * is flagged; the task dedup key means a student already flagged is not flagged
 * again on the next run.
 */
export async function contactSlaSweep(
  pool: pg.Pool,
  cohortId: string,
  calendar: WorkingCalendar,
  now = new Date(),
): Promise<JobResult> {
  const executor = createExecutor(pool);
  const cutoff = new Date(now.getTime() - CONTACT_POLICY.cadenceDays * 86_400_000);

  const { rows } = await pool.query(
    `SELECT s.id, s.cohort_id, sa.coordinator_user_id
     FROM student s
     LEFT JOIN student_assignment sa ON sa.student_id = s.id AND sa.effective_to IS NULL
     WHERE s.cohort_id = $1
       AND NOT (s.current_statuses @> '["withdrawn"]'::jsonb)
       AND (s.last_contact_at IS NULL OR s.last_contact_at < $2)`,
    [cohortId, cutoff],
  );

  let acted = 0;
  for (const r of rows) {
    if (!r.coordinator_user_id) continue; // unowned: an ownership exception, not an SLA breach
    const ctx = systemContext(randomUUID(), now);
    await executor.execute(ctx, async (scope) => {
      const eventId = await scope.emit({
        type: 'CONTACT_SLA_BREACHED',
        subjectType: 'student',
        subjectId: r.id,
        cohortId: r.cohort_id,
        payload: { cadenceDays: CONTACT_POLICY.cadenceDays, ownerAtBreach: r.coordinator_user_id },
      });
      await createTask(scope, {
        studentId: r.id,
        cohortId: r.cohort_id,
        taskType: 'contact_overdue',
        ownerResolver: { kind: 'user', userId: r.coordinator_user_id },
        dueAt: now,
        source: 'sla',
        dedupKey: `${r.id}:contact_overdue`,
        originatingEventId: eventId,
        priority: 20,
      });
      await evaluateStudentRisk(scope, r.id, calendar);
    });
    acted++;
  }
  return { job: 'contact_sla_sweep', examined: rows.length, acted };
}

/**
 * Evidence SLA sweep (§31). Each stage has its own window; a breach names the
 * stage and the owner at the time, and escalates to the Quality Lead where the
 * queue is the bottleneck.
 */
export async function evidenceSlaSweep(
  pool: pg.Pool,
  cohortId: string,
  now = new Date(),
): Promise<JobResult> {
  const executor = createExecutor(pool);
  const { rows } = await pool.query(
    `SELECT es.id, es.current_stage, es.submitted_at, s.cohort_id, s.id AS student_id,
            EXTRACT(EPOCH FROM (now() - es.submitted_at)) / 3600 AS age_hours
     FROM evidence_submission es JOIN student s ON s.id = es.student_id
     WHERE s.cohort_id = $1 AND es.is_open AND es.current_stage IN ('coach','l1','l2','l3')`,
    [cohortId],
  );

  const limits: Record<string, number> = {
    coach: EVIDENCE_SLA_HOURS.coachReview,
    l1: EVIDENCE_SLA_HOURS.coachReview + EVIDENCE_SLA_HOURS.coordinatorL1,
    l2: EVIDENCE_SLA_HOURS.coachReview + EVIDENCE_SLA_HOURS.coordinatorL1 + EVIDENCE_SLA_HOURS.qualityL2,
    l3: 168,
  };

  let acted = 0;
  for (const r of rows) {
    const limit = limits[r.current_stage as string];
    if (limit === undefined || Number(r.age_hours) <= limit) continue;
    const ctx = systemContext(randomUUID(), now);
    await executor.execute(ctx, async (scope) => {
      await scope.emit({
        type: 'EVIDENCE_SLA_BREACHED',
        subjectType: 'evidence_submission',
        subjectId: r.id,
        cohortId: r.cohort_id,
        payload: { stage: r.current_stage, ageHours: Math.round(Number(r.age_hours)), limitHours: limit },
      });
    });
    acted++;
  }
  return { job: 'evidence_sla_sweep', examined: rows.length, acted };
}

/**
 * Quality queue thresholds (§37): the Quality Lead reviews above 1,000; above
 * 1,400 the PM is escalated immediately. Both are configuration.
 */
export async function qualityQueueWatch(
  pool: pg.Pool,
  cohortId: string,
  now = new Date(),
): Promise<JobResult & { queueSize: number }> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            max(EXTRACT(EPOCH FROM (now() - es.submitted_at)) / 3600) AS oldest_hours
     FROM evidence_submission es JOIN student s ON s.id = es.student_id
     WHERE s.cohort_id = $1 AND es.is_open AND es.current_stage IN ('l2','l3')`,
    [cohortId],
  );
  const size: number = rows[0].n;
  let acted = 0;

  if (size >= QUALITY_QUEUE_THRESHOLDS.pmEscalationQueueSize) {
    acted += await notify(pool, {
      roleKey: 'project_manager',
      triggerKey: 'quality_queue_pm_escalation',
      title: `Quality queue exceeded ${QUALITY_QUEUE_THRESHOLDS.pmEscalationQueueSize}`,
      body: `The queue is at ${size} items. Immediate escalation per §37.`,
      // One notification per threshold crossing per day: an alert that repeats
      // every sweep trains people to ignore it.
      rateLimitKey: `quality_queue_pm:${now.toISOString().slice(0, 10)}`,
    });
  } else if (size >= QUALITY_QUEUE_THRESHOLDS.leadReviewQueueSize) {
    acted += await notify(pool, {
      roleKey: 'quality_lead',
      triggerKey: 'quality_queue_lead_review',
      title: `Quality queue exceeded ${QUALITY_QUEUE_THRESHOLDS.leadReviewQueueSize}`,
      body: `The queue is at ${size} items; oldest ${Math.round(rows[0].oldest_hours ?? 0)}h.`,
      rateLimitKey: `quality_queue_lead:${now.toISOString().slice(0, 10)}`,
    });
  }

  return { job: 'quality_queue_watch', examined: size, acted, queueSize: size };
}

/** Coach confirmation, 24h before the session (§18). */
export async function sessionConfirmationSweep(
  pool: pg.Pool,
  cohortId: string,
  now = new Date(),
): Promise<JobResult> {
  const executor = createExecutor(pool);
  const horizon = new Date(now.getTime() + SESSION_POLICY.coachConfirmationLeadHours * 3_600_000);
  const { rows } = await pool.query(
    `SELECT ses.id, ses.coach_user_id, ses.scheduled_date, g.code AS group_code, g.cohort_id
     FROM session ses JOIN cohort_group g ON g.id = ses.cohort_group_id
     WHERE g.cohort_id = $1 AND ses.status = 'scheduled'
       AND ses.scheduled_date <= $2::date AND ses.scheduled_date >= $3::date
       AND (ses.coach_confirmed IS NULL OR ses.coach_confirmed = 'not_confirmed')`,
    [cohortId, horizon, now],
  );

  let acted = 0;
  for (const r of rows) {
    const ctx = systemContext(randomUUID(), now);
    await executor.execute(ctx, async (scope) => {
      const eventId = await scope.emit({
        type: 'SESSION_CONFIRMATION_REQUIRED',
        subjectType: 'session',
        subjectId: r.id,
        cohortId: r.cohort_id,
        payload: { groupCode: r.group_code, scheduledDate: r.scheduled_date },
      });
      if (r.coach_user_id) {
        await createTask(scope, {
          cohortId: r.cohort_id,
          taskType: 'confirm_session',
          ownerResolver: { kind: 'user', userId: r.coach_user_id },
          dueAt: now,
          source: 'workflow',
          dedupKey: `${r.id}:confirm`,
          originatingEventId: eventId,
          priority: 20,
        });
      }
    });
    acted++;
  }
  return { job: 'session_confirmation_sweep', examined: rows.length, acted };
}

/** Marks overdue tasks. Idempotent: the status transition is naturally so. */
export async function taskOverdueSweep(pool: pg.Pool, now = new Date()): Promise<JobResult> {
  const { rowCount } = await pool.query(
    `UPDATE task SET status = 'overdue'
     WHERE status = 'open' AND due_at IS NOT NULL AND due_at < $1`,
    [now],
  );
  return { job: 'task_overdue_sweep', examined: rowCount ?? 0, acted: rowCount ?? 0 };
}

/** Nightly risk re-evaluation, for time-based rules with no triggering event. */
export async function riskSweep(
  pool: pg.Pool,
  cohortId: string,
  calendar: WorkingCalendar,
  now = new Date(),
): Promise<JobResult> {
  const executor = createExecutor(pool);
  const { rows } = await pool.query(
    `SELECT id FROM student WHERE cohort_id = $1
       AND NOT (current_statuses @> '["withdrawn"]'::jsonb)`,
    [cohortId],
  );
  let acted = 0;
  for (const r of rows) {
    const ctx = systemContext(randomUUID(), now);
    const result = await executor.execute(ctx, (scope) => evaluateStudentRisk(scope, r.id, calendar));
    if (result.value.changed) acted++;
    await projectStudent(pool, r.id, calendar, now);
  }
  return { job: 'risk_sweep', examined: rows.length, acted };
}

/**
 * Invariant 5: every student has an open next action, or an explicit
 * NO_ACTION_REQUIRED. Violations surface as data-quality exceptions rather than
 * write failures -- blocking a write because a downstream task has not been
 * created yet would make the system fragile exactly when it matters most.
 */
export async function invariantSweep(pool: pg.Pool, cohortId: string): Promise<JobResult> {
  const { rows } = await pool.query(
    `SELECT s.id, s.full_name FROM student s
     WHERE s.cohort_id = $1
       AND NOT (s.current_statuses @> '["withdrawn"]'::jsonb)
       AND s.graduation_status <> 'graduated'
       AND NOT EXISTS (
         SELECT 1 FROM task t
         WHERE t.student_id = s.id AND t.status IN ('open','in_progress','overdue'))`,
    [cohortId],
  );
  for (const r of rows) {
    await pool.query(
      `INSERT INTO system_log (level, component, code, message, context)
       VALUES ('warn', 'invariants', 'NO_OPEN_ACTION',
               'student has no open next action', $1::jsonb)`,
      [JSON.stringify({ studentId: r.id, studentName: r.full_name })],
    );
  }
  return { job: 'invariant_sweep', examined: rows.length, acted: rows.length };
}

/** A Critical risk with no intervention plan is a control-tower exception (§22). */
export async function interventionGapSweep(pool: pg.Pool, cohortId: string): Promise<JobResult> {
  const { rows } = await pool.query(
    `SELECT rr.id, rr.student_id FROM risk_record rr
     JOIN student s ON s.id = rr.student_id
     WHERE s.cohort_id = $1 AND rr.closed_at IS NULL AND rr.level = 'red'
       AND NOT EXISTS (SELECT 1 FROM intervention i
                       WHERE i.risk_record_id = rr.id AND i.closed_at IS NULL)`,
    [cohortId],
  );
  for (const r of rows) {
    await pool.query(
      `INSERT INTO system_log (level, component, code, message, context)
       VALUES ('warn', 'invariants', 'CRITICAL_WITHOUT_INTERVENTION',
               'critical risk has no open intervention plan', $1::jsonb)`,
      [JSON.stringify({ studentId: r.student_id, riskRecordId: r.id })],
    );
  }
  return { job: 'intervention_gap_sweep', examined: rows.length, acted: rows.length };
}

export async function runAllSweeps(
  pool: pg.Pool,
  cohortId: string,
  calendar: WorkingCalendar,
  now = new Date(),
): Promise<JobResult[]> {
  return [
    await contactSlaSweep(pool, cohortId, calendar, now),
    await evidenceSlaSweep(pool, cohortId, now),
    await qualityQueueWatch(pool, cohortId, now),
    await sessionConfirmationSweep(pool, cohortId, now),
    await taskOverdueSweep(pool, now),
    await riskSweep(pool, cohortId, calendar, now),
    await invariantSweep(pool, cohortId),
    await interventionGapSweep(pool, cohortId),
  ];
}
