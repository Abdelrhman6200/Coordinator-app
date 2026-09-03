/**
 * Student operations: allocation, contact, and the unresponsive flow.
 *
 * The contact path is the one the requirements care most about (§13): a single
 * recorded interaction must update last contact, the weekly KPI, the attempt
 * counter, the timeline, the next action, the task, the SLA, the risk rules and
 * the audit trail -- atomically, so no user ever updates two modules by hand for
 * one real-world action.
 */
import {
  addWorkingMinutes,
  CONTACT_POLICY,
  recordAttempt,
  windowKey,
  type WorkingCalendar,
} from '@coordinator/rules';
import { checkUnresponsiveStatus } from '@coordinator/permissions';
import { DeniedError, DomainError, NotFoundError, ValidationError } from '../errors.ts';
import type { CommandScope } from '../write-path.ts';
import { cancelTasksByDedupPrefix, createTask, reassignTasks } from './tasks.ts';
import { evaluateStudentRisk } from './risk.ts';

export async function assignCoordinator(
  scope: CommandScope,
  input: { studentId: string; coordinatorUserId: string | null; reasonCode?: string | undefined },
): Promise<void> {
  const { tx, ctx } = scope;
  const { rows: prior } = await tx.query(
    `SELECT id, coordinator_user_id FROM student_assignment
     WHERE student_id = $1 AND effective_to IS NULL`,
    [input.studentId],
  );
  const previous = prior[0]?.coordinator_user_id ?? null;
  if (previous === input.coordinatorUserId) return;

  if (prior[0]) {
    await tx.query(`UPDATE student_assignment SET effective_to = $2 WHERE id = $1`, [
      prior[0].id,
      ctx.now,
    ]);
  }
  // A null coordinator is an explicit UNASSIGNED row, never an absent row: that
  // is what gives an unowned student an age clock on the control tower.
  await tx.query(
    `INSERT INTO student_assignment (student_id, coordinator_user_id, reason_code,
                                     effective_from, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.studentId, input.coordinatorUserId, input.reasonCode ?? null, ctx.now, ctx.actor.userId],
  );

  const { rows: s } = await tx.query(`SELECT cohort_id FROM student WHERE id = $1`, [
    input.studentId,
  ]);

  const eventId = await scope.emit({
    type: previous === null ? 'STUDENT_ASSIGNED' : 'STUDENT_REASSIGNED',
    subjectType: 'student',
    subjectId: input.studentId,
    cohortId: s[0]?.cohort_id,
    payload: { from: previous, to: input.coordinatorUserId, reasonCode: input.reasonCode ?? null },
  });

  if (input.coordinatorUserId) {
    // Open tasks and escalations follow the student; handover must not drop work.
    await reassignTasks(scope, input.studentId, input.coordinatorUserId);
    await tx.query(
      `UPDATE escalation SET owner_user_id = $2
       WHERE student_id = $1 AND status NOT IN ('closed') AND owner_user_id = $3`,
      [input.studentId, input.coordinatorUserId, previous],
    );
    await createTask(scope, {
      studentId: input.studentId,
      cohortId: s[0]?.cohort_id,
      taskType: 'first_contact',
      ownerResolver: { kind: 'user', userId: input.coordinatorUserId },
      dueAt: new Date(ctx.now.getTime() + CONTACT_POLICY.cadenceDays * 86_400_000),
      source: 'workflow',
      dedupKey: `${input.studentId}:first_contact`,
      originatingEventId: eventId,
      priority: 50,
    });
  }

  await scope.recordChange('student', input.studentId, 'coordinator_user_id', previous, input.coordinatorUserId);
  await scope.audit({
    module: 'students',
    recordType: 'student',
    recordId: input.studentId,
    action: previous === null ? 'assign' : 'reassign',
    permissionUsed: previous === null ? 'students.assign' : 'students.reassign',
    oldValue: { coordinatorUserId: previous },
    newValue: { coordinatorUserId: input.coordinatorUserId },
    reason: input.reasonCode ?? null,
  });
}

export type ContactOutcome =
  | 'responded'
  | 'no_response'
  | 'waiting_for_response'
  | 'callback_required'
  | 'issue_identified'
  | 'student_needs_support'
  | 'incorrect_contact_data';

export interface RecordInteractionInput {
  studentId: string;
  channel: 'whatsapp' | 'phone' | 'email' | 'sms' | 'other';
  purpose: string;
  outcome: ContactOutcome;
  graduationPosition?: string | undefined;
  blockingFactor?: string | undefined;
  agreedAction?: string | undefined;
  actionDeadline?: Date | undefined;
  escalationRequired?: boolean | undefined;
  notes?: string | undefined;
  clientDedupKey?: string | undefined;
  calendar: WorkingCalendar;
}

const SUCCESSFUL_OUTCOMES: ReadonlySet<string> = new Set(['responded', 'issue_identified', 'student_needs_support']);

export interface InteractionResult {
  interactionId: string;
  reference: string;
  attemptCounted: boolean;
  attemptCount: number;
  reachedUnresponsiveThreshold: boolean;
  nextContactDueAt: Date;
}

/**
 * One real-world contact, one atomic record.
 *
 * Everything downstream happens inside the caller's transaction: attempt
 * counting, last-contact fields, the next follow-up task, risk re-evaluation and
 * the audit trail. If any of it fails, none of it happened.
 */
export async function recordInteraction(
  scope: CommandScope,
  input: RecordInteractionInput,
): Promise<InteractionResult> {
  const { tx, ctx } = scope;

  const violations: Array<{ field: string; rule: string; message: string }> = [];
  if (!input.purpose) violations.push({ field: 'purpose', rule: 'required', message: 'Select a purpose.' });
  if (!input.outcome) violations.push({ field: 'outcome', rule: 'required', message: 'Record an outcome.' });
  if (violations.length) throw new ValidationError('Interaction is incomplete.', violations);

  const { rows: student } = await tx.query(
    `SELECT cohort_id, consent_message_storage FROM student WHERE id = $1`,
    [input.studentId],
  );
  if (!student[0]) throw new NotFoundError('Student');

  // Idempotency for the offline outbox: the same client key must not produce a
  // second interaction when a queued submission is retried.
  if (input.clientDedupKey) {
    const { rows: existing } = await tx.query(
      `SELECT id, reference FROM interaction WHERE client_dedup_key = $1`,
      [input.clientDedupKey],
    );
    if (existing[0]) {
      const { rows: attempts } = await tx.query(
        `SELECT count(*)::int AS n FROM contact_attempt WHERE student_id = $1`,
        [input.studentId],
      );
      return {
        interactionId: existing[0].id,
        reference: existing[0].reference,
        attemptCounted: false,
        attemptCount: attempts[0].n,
        reachedUnresponsiveThreshold: false,
        nextContactDueAt: new Date(ctx.now.getTime() + CONTACT_POLICY.cadenceDays * 86_400_000),
      };
    }
  }

  const { rows: created } = await tx.query(
    `INSERT INTO interaction (student_id, staff_user_id, occurred_at, channel, purpose, outcome,
                              graduation_position, blocking_factor, agreed_action, action_deadline,
                              escalation_required, notes, client_dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.studentId,
      ctx.actor.userId,
      ctx.now,
      input.channel,
      input.purpose,
      input.outcome,
      input.graduationPosition ?? null,
      input.blockingFactor ?? null,
      input.agreedAction ?? null,
      input.actionDeadline ?? null,
      input.escalationRequired === true,
      input.notes ?? null,
      input.clientDedupKey ?? null,
    ],
  );
  const interactionId = created[0].id as string;
  const reference = `INT-${interactionId.slice(0, 8).toUpperCase()}`;
  await tx.query(`UPDATE interaction SET reference = $2 WHERE id = $1`, [interactionId, reference]);

  // Attempt counting is per channel: five WhatsApp messages in a morning are one
  // channel's worth of effort, not five attempts to reach a person.
  const policy = {
    dedupWindowHours: 24,
    unresponsiveAttempts: CONTACT_POLICY.unresponsiveAttempts,
    unresponsiveThreshold: CONTACT_POLICY.unresponsiveAttempts,
    cooldownHours: 48,
    configVersionId: 'depi-r5-contact-v1',
  };
  const key = windowKey(ctx.now, policy);
  const { rows: seen } = await tx.query(
    `SELECT window_key FROM contact_attempt WHERE student_id = $1 AND channel = $2`,
    [input.studentId, input.channel],
  );
  const attempt = recordAttempt(ctx.now, new Set(seen.map((r) => r.window_key)), policy);

  const successful = SUCCESSFUL_OUTCOMES.has(input.outcome);
  let attemptCounted = false;
  if (!successful && attempt.outcome === 'counted') {
    const { rows: total } = await tx.query(
      `SELECT count(*)::int AS n FROM contact_attempt WHERE student_id = $1`,
      [input.studentId],
    );
    await tx.query(
      `INSERT INTO contact_attempt (student_id, interaction_id, attempt_no, channel, window_key)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [input.studentId, interactionId, total[0].n + 1, input.channel, key],
    );
    attemptCounted = true;
  }

  const { rows: attemptTotals } = await tx.query(
    `SELECT count(*)::int AS n, count(DISTINCT channel)::int AS channels
     FROM contact_attempt WHERE student_id = $1`,
    [input.studentId],
  );
  const attemptCount: number = attemptTotals[0].n;
  const distinctChannels: number = attemptTotals[0].channels;

  const nextContactDueAt = addWorkingMinutes(
    ctx.now,
    CONTACT_POLICY.cadenceDays * 24 * 60,
    input.calendar,
  );

  await tx.query(
    `UPDATE student
     SET last_contact_at = $2,
         last_successful_contact_at = CASE WHEN $3 THEN $2 ELSE last_successful_contact_at END,
         next_action_at = $4,
         updated_at = now()
     WHERE id = $1`,
    [input.studentId, ctx.now, successful, input.actionDeadline ?? nextContactDueAt],
  );

  const eventId = await scope.emit({
    type: successful ? 'STUDENT_REPLIED' : input.channel === 'phone' ? 'CALL_LOGGED' : 'MESSAGE_SENT',
    subjectType: 'student',
    subjectId: input.studentId,
    cohortId: student[0].cohort_id,
    payload: {
      interactionId,
      reference,
      channel: input.channel,
      purpose: input.purpose,
      outcome: input.outcome,
      attemptCounted,
      attemptCount,
    },
  });
  await scope.emit({
    type: 'INTERACTION_RECORDED',
    subjectType: 'student',
    subjectId: input.studentId,
    cohortId: student[0].cohort_id,
    payload: { interactionId, outcome: input.outcome },
    causationId: eventId,
  });

  // The follow-up task is created here, so nothing depends on the coordinator
  // remembering to schedule it.
  await createTask(scope, {
    studentId: input.studentId,
    cohortId: student[0].cohort_id,
    taskType: 'weekly_contact',
    ownerResolver: { kind: 'student_coordinator', studentId: input.studentId },
    dueAt: input.actionDeadline ?? nextContactDueAt,
    source: 'sla',
    dedupKey: `${input.studentId}:weekly_contact`,
    originatingEventId: eventId,
    priority: 60,
  });
  await cancelTasksByDedupPrefix(scope, `${input.studentId}:first_contact`, 'contact_made');

  if (successful) {
    // The reason for chasing has disappeared, so the chase task must too --
    // otherwise the queue accumulates work nobody needs to do.
    await cancelTasksByDedupPrefix(scope, `${input.studentId}:unresponsive`, 'student_replied');
  }

  await evaluateStudentRisk(scope, input.studentId, input.calendar);

  await scope.audit({
    module: 'communications',
    recordType: 'interaction',
    recordId: interactionId,
    action: 'record',
    permissionUsed: 'communications.create',
    newValue: { channel: input.channel, outcome: input.outcome, reference },
  });

  const reachedThreshold =
    !successful &&
    attemptCount >= CONTACT_POLICY.unresponsiveAttempts &&
    distinctChannels >= CONTACT_POLICY.minimumDistinctChannels;

  if (reachedThreshold) {
    await createTask(scope, {
      studentId: input.studentId,
      cohortId: student[0].cohort_id,
      taskType: 'supervisor_intervention',
      ownerResolver: { kind: 'student_supervisor', studentId: input.studentId },
      dueAt: new Date(ctx.now.getTime() + CONTACT_POLICY.supervisorInterventionHours * 3_600_000),
      source: 'workflow',
      dedupKey: `${input.studentId}:unresponsive_escalation`,
      originatingEventId: eventId,
      priority: 20,
    });
  }

  return {
    interactionId,
    reference,
    attemptCounted,
    attemptCount,
    reachedUnresponsiveThreshold: reachedThreshold,
    nextContactDueAt,
  };
}

/**
 * Setting a student Unresponsive (§15).
 *
 * Project Operations only, and only with the attempt history behind it: five
 * attempts across channels over two weeks, or an explicit recorded override.
 * The student REMAINS in the denominator -- only a Ministry withdrawal changes
 * that.
 */
export async function setUnresponsive(
  scope: CommandScope,
  input: {
    studentId: string;
    actorMaySetUnresponsive: boolean;
    overrideReason?: string | undefined;
  },
): Promise<void> {
  const { tx, ctx } = scope;
  const { rows } = await tx.query(
    `SELECT count(*)::int AS attempts,
            EXTRACT(DAY FROM (now() - min(occurred_at)))::int AS days
     FROM contact_attempt WHERE student_id = $1`,
    [input.studentId],
  );

  const check = checkUnresponsiveStatus({
    attemptCount: rows[0].attempts,
    requiredAttempts: CONTACT_POLICY.unresponsiveAttempts,
    daysSinceFirstAttempt: rows[0].days ?? 0,
    requiredDays: CONTACT_POLICY.unresponsivePeriodDays,
    actorMaySetUnresponsive: input.actorMaySetUnresponsive,
    overrideReason: input.overrideReason ?? null,
  });
  if (!check.allowed) throw new DeniedError(check.denial);

  await tx.query(
    `UPDATE student
     SET current_statuses = (current_statuses - 'unresponsive') || '["unresponsive"]'::jsonb,
         unresponsive_set_at = $2, unresponsive_set_by = $3, unresponsive_override_reason = $4
     WHERE id = $1`,
    [input.studentId, ctx.now, ctx.actor.userId, input.overrideReason ?? null],
  );

  await scope.emit({
    type: 'STUDENT_MARKED_UNRESPONSIVE',
    subjectType: 'student',
    subjectId: input.studentId,
    payload: {
      attempts: rows[0].attempts,
      daysSinceFirstAttempt: rows[0].days ?? 0,
      override: input.overrideReason ?? null,
      // Recorded explicitly because it is the fact people most often assume
      // wrongly: an unresponsive student is still counted.
      remainsInDenominator: CONTACT_POLICY.unresponsiveRemainsInDenominator,
    },
  });

  await scope.audit({
    module: 'students',
    recordType: 'student',
    recordId: input.studentId,
    action: 'mark_unresponsive',
    permissionUsed: 'students.edit',
    newValue: { attempts: rows[0].attempts },
    reason: input.overrideReason ?? 'attempt history satisfied',
  });
}

/** Ministry withdrawal (§43). The project records; it does not decide. */
export async function recordWithdrawal(
  scope: CommandScope,
  input: {
    studentId: string;
    withdrawnOn: Date;
    reason: string;
    ministryReference: string;
    sourceDocument?: string | undefined;
  },
): Promise<void> {
  const { tx, ctx } = scope;
  if (!input.ministryReference.trim()) {
    throw new DomainError(
      'MINISTRY_REFERENCE_REQUIRED',
      'A withdrawal must carry the Ministry reference. Only the Ministry decides withdrawal; ' +
        'the project records the decision.',
    );
  }
  const { rows } = await tx.query(`SELECT current_stage FROM student WHERE id = $1`, [
    input.studentId,
  ]);
  if (!rows[0]) throw new NotFoundError('Student');

  await tx.query(
    `INSERT INTO withdrawal (student_id, withdrawn_on, reason, ministry_reference,
                             source_document, previous_status, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.studentId,
      input.withdrawnOn,
      input.reason,
      input.ministryReference,
      input.sourceDocument ?? null,
      rows[0].current_stage,
      ctx.actor.userId,
    ],
  );
  // The student record is never deleted.
  await tx.query(
    `UPDATE student SET current_statuses = current_statuses || '["withdrawn"]'::jsonb WHERE id = $1`,
    [input.studentId],
  );

  await scope.emit({
    type: 'STUDENT_WITHDRAWN',
    subjectType: 'student',
    subjectId: input.studentId,
    payload: { ministryReference: input.ministryReference, previousStatus: rows[0].current_stage },
  });
  await scope.audit({
    module: 'students',
    recordType: 'student',
    recordId: input.studentId,
    action: 'withdraw',
    permissionUsed: 'students.edit',
    newValue: { ministryReference: input.ministryReference },
    reason: input.reason,
  });
}
