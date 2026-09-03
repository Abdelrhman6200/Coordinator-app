/**
 * The four-stage evidence pipeline (§31): student -> coach (24h) ->
 * coordinator L1 (24h) -> Quality L2 (48h) -> Quality Lead L3.
 *
 * Two properties carry the module:
 *   1. A rejection NEVER closes the item. It returns to a correction loop and
 *      stays open until accepted (§25, §36).
 *   2. Each stage is decided by a different person (SoD-1), and the Quality
 *      decision is immutable once written (§59).
 */
import type pg from 'pg';
import {
  checkEvidenceReview,
  checkL3Resolution,
  type EvidenceStage,
} from '@coordinator/permissions';
import {
  addWorkingMinutes,
  detectDuplicates,
  EVIDENCE_SLA_HOURS,
  QUALITY_CHECKS,
  reviewEvidence,
  type KnownEvidenceIndex,
  type QualityCheck,
  type RejectionCode,
  type WorkingCalendar,
} from '@coordinator/rules';
import { DeniedError, DomainError, NotFoundError } from '../errors.ts';
import type { CommandScope } from '../write-path.ts';
import { recomputeGraduation } from './graduation.ts';
import { createTask } from './tasks.ts';

/** SLA due time in working hours, so an overnight or weekend gap does not breach. */
function dueAfterHours(from: Date, hours: number, calendar: WorkingCalendar): Date {
  return addWorkingMinutes(from, hours * 60, calendar);
}

export interface SubmitEvidenceInput {
  studentId: string;
  subjectType: 'gig' | 'service' | 'entrepreneurship';
  gigId?: string | undefined;
  serviceId?: string | undefined;
  files: Array<{
    kind: string;
    fileRef: string;
    contentHash: Buffer;
    fileName?: string | undefined;
    sizeBytes?: number | undefined;
  }>;
  calendar: WorkingCalendar;
}

/**
 * The student submits (§10). Staff may submit on a student's behalf during the
 * day-zero census import, which is why the submitter is taken from the context
 * rather than assumed to be the student.
 */
export async function submitEvidence(
  scope: CommandScope,
  input: SubmitEvidenceInput,
): Promise<{ submissionId: string; reference: string }> {
  const { tx, ctx } = scope;

  if (input.files.length === 0) {
    throw new DomainError(
      'EVIDENCE_EMPTY',
      'At least one evidence file is required to submit.',
    );
  }

  const { rows: student } = await tx.query(
    `SELECT cohort_id, cohort_group_id FROM student WHERE id = $1`,
    [input.studentId],
  );
  if (!student[0]) throw new NotFoundError('Student');

  const { rows } = await tx.query(
    `INSERT INTO evidence_submission (student_id, submitted_by, subject_type, gig_id, service_id,
                                      current_stage, is_open)
     VALUES ($1, $2, $3, $4, $5, 'coach', true)
     RETURNING id`,
    [
      input.studentId,
      ctx.actor.userId,
      input.subjectType,
      input.gigId ?? null,
      input.serviceId ?? null,
    ],
  );
  const submissionId = rows[0].id as string;
  const reference = `EV-${submissionId.slice(0, 8).toUpperCase()}`;
  await tx.query(`UPDATE evidence_submission SET reference = $2 WHERE id = $1`, [
    submissionId,
    reference,
  ]);

  for (const f of input.files) {
    await tx.query(
      `INSERT INTO evidence_file (submission_id, kind, file_ref, content_hash, file_name,
                                  size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        submissionId,
        f.kind,
        f.fileRef,
        f.contentHash,
        f.fileName ?? null,
        f.sizeBytes ?? null,
        ctx.actor.userId,
      ],
    );
  }

  // The coach review clock starts now, in working hours.
  const dueAt = dueAfterHours(ctx.now, EVIDENCE_SLA_HOURS.coachReview, input.calendar);
  await tx.query(
    `INSERT INTO evidence_review (submission_id, stage, reviewer_id, received_at, due_at)
     SELECT $1, 'coach', sca.coach_user_id, $2, $3
     FROM student_coach_assignment sca
     WHERE sca.student_id = $4 AND sca.effective_to IS NULL AND sca.coach_user_id IS NOT NULL
     LIMIT 1`,
    [submissionId, ctx.now, dueAt, input.studentId],
  );

  const eventId = await scope.emit({
    type: 'EVIDENCE_SUBMITTED',
    subjectType: 'evidence_submission',
    subjectId: submissionId,
    cohortId: student[0].cohort_id,
    payload: {
      studentId: input.studentId,
      subjectType: input.subjectType,
      fileCount: input.files.length,
      reference,
    },
  });

  await createTask(scope, {
    studentId: input.studentId,
    cohortId: student[0].cohort_id,
    taskType: 'review_evidence_coach',
    ownerResolver: { kind: 'student_coach', studentId: input.studentId },
    dueAt,
    source: 'workflow',
    dedupKey: `${submissionId}:coach_review`,
    originatingEventId: eventId,
    priority: 40,
  });

  await scope.audit({
    module: 'evidence',
    recordType: 'evidence_submission',
    recordId: submissionId,
    action: 'submit',
    permissionUsed: 'evidence.create',
    newValue: { reference, subjectType: input.subjectType },
  });

  return { submissionId, reference };
}

async function loadSubmission(tx: pg.PoolClient, submissionId: string) {
  const { rows } = await tx.query(
    `SELECT es.*, s.cohort_id
     FROM evidence_submission es JOIN student s ON s.id = es.student_id
     WHERE es.id = $1`,
    [submissionId],
  );
  if (!rows[0]) throw new NotFoundError('Evidence submission');
  return rows[0];
}

async function priorReviewers(
  tx: pg.PoolClient,
  submissionId: string,
): Promise<Partial<Record<EvidenceStage, string>>> {
  const out: Partial<Record<EvidenceStage, string>> = {};
  const { rows: reviews } = await tx.query(
    `SELECT stage, reviewer_id FROM evidence_review
     WHERE submission_id = $1 AND completed_at IS NOT NULL`,
    [submissionId],
  );
  for (const r of reviews) out[r.stage as EvidenceStage] = r.reviewer_id;
  const { rows: qd } = await tx.query(
    `SELECT level, reviewer_id FROM quality_decision WHERE submission_id = $1`,
    [submissionId],
  );
  for (const r of qd) out[r.level as EvidenceStage] = r.reviewer_id;
  return out;
}

/**
 * Coach review or coordinator L1 screening.
 *
 * `returned` sends the item back to the student for correction. It does NOT
 * close it: `is_open` stays true throughout (§36).
 */
export async function reviewStage(
  scope: CommandScope,
  input: {
    submissionId: string;
    stage: 'coach' | 'l1';
    decision: 'passed' | 'returned';
    notes?: string | undefined;
    calendar: WorkingCalendar;
  },
): Promise<void> {
  const { tx, ctx } = scope;
  const sub = await loadSubmission(tx, input.submissionId);

  if (sub.current_stage !== input.stage) {
    throw new DomainError(
      'WRONG_STAGE',
      `This submission is at ${sub.current_stage}, not ${input.stage}.`,
    );
  }

  const sod = checkEvidenceReview({
    actorUserId: ctx.actor.userId,
    submittedByUserId: sub.submitted_by,
    stage: input.stage,
    priorReviewers: await priorReviewers(tx, input.submissionId),
  });
  if (!sod.allowed) throw new DeniedError(sod.denial);

  await tx.query(
    `INSERT INTO evidence_review (submission_id, stage, reviewer_id, received_at, due_at,
                                  completed_at, decision, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.submissionId,
      input.stage,
      ctx.actor.userId,
      sub.submitted_at,
      dueAfterHours(
        sub.submitted_at,
        input.stage === 'coach' ? EVIDENCE_SLA_HOURS.coachReview : EVIDENCE_SLA_HOURS.coordinatorL1,
        input.calendar,
      ),
      ctx.now,
      input.decision,
      input.notes ?? null,
    ],
  );

  if (input.decision === 'returned') {
    // Back to the student. The item stays open; that is the whole point.
    await tx.query(
      `UPDATE evidence_submission SET current_stage = 'coach', rejection_count = rejection_count + 1
       WHERE id = $1`,
      [input.submissionId],
    );
    const eventId = await scope.emit({
      type: 'EVIDENCE_RETURNED',
      subjectType: 'evidence_submission',
      subjectId: input.submissionId,
      cohortId: sub.cohort_id,
      payload: { stage: input.stage, notes: input.notes ?? null },
    });
    await createTask(scope, {
      studentId: sub.student_id,
      cohortId: sub.cohort_id,
      taskType: 'correct_evidence',
      ownerResolver: { kind: 'student_coordinator', studentId: sub.student_id },
      dueAt: dueAfterHours(ctx.now, 48, input.calendar),
      source: 'workflow',
      dedupKey: `${input.submissionId}:correction`,
      originatingEventId: eventId,
      priority: 30,
    });
  } else {
    const nextStage = input.stage === 'coach' ? 'l1' : 'l2';
    await tx.query(`UPDATE evidence_submission SET current_stage = $2 WHERE id = $1`, [
      input.submissionId,
      nextStage,
    ]);
    const eventId = await scope.emit({
      type: input.stage === 'coach' ? 'EVIDENCE_COACH_APPROVED' : 'EVIDENCE_L1_PASSED',
      subjectType: 'evidence_submission',
      subjectId: input.submissionId,
      cohortId: sub.cohort_id,
      payload: { stage: input.stage, nextStage },
    });
    const dueAt = dueAfterHours(
      ctx.now,
      nextStage === 'l1' ? EVIDENCE_SLA_HOURS.coordinatorL1 : EVIDENCE_SLA_HOURS.qualityL2,
      input.calendar,
    );
    await createTask(scope, {
      studentId: sub.student_id,
      cohortId: sub.cohort_id,
      taskType: nextStage === 'l1' ? 'screen_evidence_l1' : 'review_evidence_quality',
      ownerResolver:
        nextStage === 'l1'
          ? { kind: 'student_coordinator', studentId: sub.student_id }
          : { kind: 'quality_pool' },
      dueAt,
      source: nextStage === 'l1' ? 'workflow' : 'qa',
      dedupKey: `${input.submissionId}:${nextStage}`,
      originatingEventId: eventId,
      priority: 40,
    });
  }

  await scope.audit({
    module: 'evidence',
    recordType: 'evidence_submission',
    recordId: input.submissionId,
    action: `${input.stage}_${input.decision}`,
    permissionUsed: input.decision === 'returned' ? 'evidence.reject' : 'evidence.edit',
    newValue: { decision: input.decision, notes: input.notes ?? null },
  });
}

export interface QualityReviewInput {
  submissionId: string;
  level: 'l2' | 'l3';
  checks: Record<QualityCheck, boolean>;
  rejectionCodes: RejectionCode[];
  comments?: string | undefined;
  disputed?: boolean | undefined;
  actorIsQualityLead?: boolean | undefined;
  calendar: WorkingCalendar;
}

/**
 * The Quality decision (§33-§36). Binary: all seven checks must pass.
 *
 * The decision row is immutable once written, so this is the only place a
 * Quality outcome comes into being -- a changed mind is a new decision at a
 * higher level, never an edit.
 */
export async function decideQuality(
  scope: CommandScope,
  input: QualityReviewInput,
): Promise<{ outcome: 'accepted' | 'rejected' | 'escalated'; explanation: string }> {
  const { tx, ctx } = scope;
  const sub = await loadSubmission(tx, input.submissionId);

  const prior = await priorReviewers(tx, input.submissionId);

  if (input.level === 'l3') {
    const l3 = checkL3Resolution({
      actorUserId: ctx.actor.userId,
      actorIsQualityLead: input.actorIsQualityLead === true,
      l2ReviewerUserId: prior.l2 ?? null,
    });
    if (!l3.allowed) throw new DeniedError(l3.denial);
  } else {
    const sod = checkEvidenceReview({
      actorUserId: ctx.actor.userId,
      submittedByUserId: sub.submitted_by,
      stage: 'l2',
      priorReviewers: prior,
    });
    if (!sod.allowed) throw new DeniedError(sod.denial);
  }

  const decision = reviewEvidence({
    checks: input.checks,
    rejectionCodes: input.rejectionCodes,
    reviewerComments: input.comments,
    priorRejectionCount: sub.rejection_count,
    disputed: input.disputed === true,
  });

  await tx.query(
    `INSERT INTO quality_decision (submission_id, level, reviewer_id, received_at, due_at,
                                   outcome, checks, rejection_codes, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [
      input.submissionId,
      input.level,
      ctx.actor.userId,
      sub.submitted_at,
      dueAfterHours(sub.submitted_at, EVIDENCE_SLA_HOURS.qualityL2, input.calendar),
      decision.outcome,
      JSON.stringify(input.checks),
      input.rejectionCodes,
      input.comments ?? null,
    ],
  );

  if (decision.outcome === 'accepted') {
    await tx.query(
      `UPDATE evidence_submission
       SET current_stage = 'accepted', accepted_at = now(), is_open = false WHERE id = $1`,
      [input.submissionId],
    );
    if (sub.gig_id) {
      // Acceptance is what makes a gig count (§30) and locks its evidence (§59).
      await tx.query(
        `UPDATE gig SET quality_accepted = true, locked_at = now(),
                        value_toward_graduation = value_amount
         WHERE id = $1`,
        [sub.gig_id],
      );
    }
    if (sub.service_id) {
      await tx.query(
        `UPDATE service SET state = 'accepted', accepted_at = now() WHERE id = $1`,
        [sub.service_id],
      );
    }
    await scope.emit({
      type: 'EVIDENCE_ACCEPTED',
      subjectType: 'evidence_submission',
      subjectId: input.submissionId,
      cohortId: sub.cohort_id,
      payload: { level: input.level, gigId: sub.gig_id, serviceId: sub.service_id },
    });
    // The one calculation service. Recomputed here so acceptance and the
    // graduation number can never disagree.
    await recomputeGraduation(scope, sub.student_id);
  } else {
    // Rejected or escalated: the item REMAINS OPEN and returns for correction.
    const nextStage = decision.outcome === 'escalated' ? 'l3' : 'coach';
    await tx.query(
      `UPDATE evidence_submission
       SET current_stage = $2, rejection_count = rejection_count + 1, is_open = true
       WHERE id = $1`,
      [input.submissionId, nextStage],
    );
    if (sub.service_id && decision.outcome === 'rejected') {
      await tx.query(
        `UPDATE service SET state = 'rejected', rejection_code = $2, rejected_at = now()
         WHERE id = $1`,
        [sub.service_id, input.rejectionCodes[0] ?? 'R01'],
      );
    }
    const eventId = await scope.emit({
      type: decision.outcome === 'escalated' ? 'EVIDENCE_ESCALATED' : 'EVIDENCE_REJECTED',
      subjectType: 'evidence_submission',
      subjectId: input.submissionId,
      cohortId: sub.cohort_id,
      payload: {
        level: input.level,
        rejectionCodes: input.rejectionCodes,
        failedChecks: decision.failedChecks,
        escalationReason: decision.escalationReason,
      },
    });
    await createTask(scope, {
      studentId: sub.student_id,
      cohortId: sub.cohort_id,
      taskType: decision.outcome === 'escalated' ? 'resolve_evidence_l3' : 'correct_evidence',
      ownerResolver:
        decision.outcome === 'escalated'
          ? { kind: 'quality_lead' }
          : { kind: 'student_coordinator', studentId: sub.student_id },
      dueAt: dueAfterHours(ctx.now, 48, input.calendar),
      source: 'qa',
      dedupKey: `${input.submissionId}:${decision.outcome}`,
      originatingEventId: eventId,
      priority: decision.outcome === 'escalated' ? 10 : 30,
    });
  }

  await scope.audit({
    module: 'quality',
    recordType: 'quality_decision',
    recordId: input.submissionId,
    action: `${input.level}_${decision.outcome}`,
    permissionUsed: decision.outcome === 'accepted' ? 'quality.approve' : 'quality.reject',
    newValue: {
      outcome: decision.outcome,
      rejectionCodes: input.rejectionCodes,
      failedChecks: decision.failedChecks,
    },
    reason: decision.explanation,
  });

  return { outcome: decision.outcome, explanation: decision.explanation };
}

/**
 * Duplicate signals for the Quality screen (§35). Flags only -- the reviewer
 * decides, because an automatic rejection on a hash collision would make the
 * seventh check a machine's opinion.
 */
export async function duplicateSignals(
  db: pg.Pool | pg.PoolClient,
  submissionId: string,
): Promise<ReturnType<typeof detectDuplicates>> {
  const { rows: sub } = await db.query(
    `SELECT student_id FROM evidence_submission WHERE id = $1`,
    [submissionId],
  );
  if (!sub[0]) throw new NotFoundError('Evidence submission');

  const { rows: mine } = await db.query(
    `SELECT content_hash, file_name, size_bytes FROM evidence_file WHERE submission_id = $1`,
    [submissionId],
  );
  const { rows: others } = await db.query(
    `SELECT ef.content_hash, ef.file_name, ef.size_bytes, ef.submission_id, es.student_id
     FROM evidence_file ef JOIN evidence_submission es ON es.id = ef.submission_id
     WHERE ef.submission_id <> $1`,
    [submissionId],
  );

  const index: KnownEvidenceIndex = {
    byHash: new Map(
      others.map((o) => [
        (o.content_hash as Buffer).toString('hex'),
        { submissionId: o.submission_id as string, studentId: o.student_id as string },
      ]),
    ),
    byUrl: new Map(),
    byOrderId: new Map(),
    byFingerprint: new Map(
      others
        .filter((o) => o.file_name && o.size_bytes)
        .map((o) => [
          `${o.file_name}:${o.size_bytes}`,
          { submissionId: o.submission_id as string, studentId: o.student_id as string },
        ]),
    ),
  };

  return detectDuplicates(
    {
      fileHashes: mine.map((m) => (m.content_hash as Buffer).toString('hex')),
      urls: [],
      clientOrderId: null,
      fileFingerprints: mine
        .filter((m) => m.file_name && m.size_bytes)
        .map((m) => `${m.file_name}:${m.size_bytes}`),
    },
    sub[0].student_id,
    index,
  );
}

/** The Quality queue: OLDEST FIRST (§32). Reviewers do not choose convenient work. */
export async function qualityQueue(
  db: pg.Pool | pg.PoolClient,
  cohortId: string,
  limit = 50,
) {
  const { rows } = await db.query(
    `SELECT es.id, es.reference, es.student_id, s.full_name, es.subject_type,
            es.current_stage, es.submitted_at, es.rejection_count,
            EXTRACT(EPOCH FROM (now() - es.submitted_at)) / 3600 AS age_hours
     FROM evidence_submission es
     JOIN student s ON s.id = es.student_id
     WHERE es.is_open AND es.current_stage IN ('l2','l3') AND s.cohort_id = $1
     ORDER BY es.submitted_at ASC
     LIMIT $2`,
    [cohortId, limit],
  );
  return rows;
}

export const ALL_CHECKS_PASS: Record<QualityCheck, boolean> = Object.fromEntries(
  QUALITY_CHECKS.map((c) => [c, true]),
) as Record<QualityCheck, boolean>;
