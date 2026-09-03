/**
 * The route table. Every entry declares the permission it requires.
 *
 * Record-level scope is applied as a query PREDICATE inside each handler, never
 * as a filter over a fetched result set: a leaked count is still a leak.
 */
import { randomUUID } from 'node:crypto';
import {
  ALL_CHECKS_PASS,
  assignCoordinator,
  createExecutor,
  decideQuality,
  duplicateSignals,
  graduationSummary,
  inbox,
  markRead,
  qualityQueue,
  recordInteraction,
  recordWithdrawal,
  reviewStage,
  setUnresponsive,
  submitEvidence,
  workQueue,
  completeTask,
  DomainError,
  NotFoundError,
} from '@coordinator/core';
import {
  ACCEPTED_GIG_SOURCES,
  GRADUATION_TARGETS,
  QUALITY_CHECKS,
  REJECTION_CODES,
  type QualityCheck,
  type RejectionCode,
  type WorkingCalendar,
} from '@coordinator/rules';
import { defineRoute, type Route } from './router.ts';
import { studentScopePredicate } from './scope.ts';

/** Cohort calendar. Holidays remain unset pending register item 19. */
export const CALENDAR: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(),
};

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new DomainError('FIELD_REQUIRED', `"${key}" is required.`, { field: key });
  }
  return v;
}

export const routes: Route[] = [
  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/me',
    requires: { module: 'home', verb: 'view' },
    summary: 'The signed-in user, their roles, and the modules their navigation shows',
    async handle(req) {
      const { rows } = await req.pool.query(
        `SELECT u.id, u.full_name, u.email, u.locale,
                array_agg(r.key) FILTER (WHERE r.key IS NOT NULL) AS roles
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.id AND ur.effective_to IS NULL
         LEFT JOIN role r ON r.id = ur.role_id
         WHERE u.id = $1 GROUP BY u.id`,
        [req.ctx.actor.userId],
      );
      const { visibleModules } = await import('@coordinator/permissions');
      return {
        body: {
          user: rows[0] ?? null,
          modules: visibleModules(req.ctx.actor).sort(),
        },
      };
    },
  }),

  // -------------------------------------------------------------------------
  // My Work
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/my-work',
    requires: { module: 'my_work', verb: 'view' },
    summary: "The user's queue, overdue and urgent first",
    async handle(req) {
      return { body: { tasks: await workQueue(req.pool, req.ctx.actor.userId) } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/my-work/:id/complete',
    requires: { module: 'my_work', verb: 'edit' },
    summary: 'Complete a task',
    async handle(req) {
      const exec = createExecutor(req.pool);
      // Ownership is checked in SQL, so completing someone else's task is not
      // possible even with the permission.
      const { rows } = await req.pool.query(
        `SELECT 1 FROM task WHERE id = $1 AND owner_user_id = $2`,
        [req.params.id, req.ctx.actor.userId],
      );
      if (!rows[0]) throw new NotFoundError('Task');
      await exec.execute(req.ctx, (scope) =>
        completeTask(scope, req.params.id!, req.body.notes as string | undefined),
      );
      return { body: { ok: true } };
    },
  }),

  // -------------------------------------------------------------------------
  // Students
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/students',
    requires: { module: 'students', verb: 'view' },
    summary: 'Student list, scoped by the actor’s record-level access',
    async handle(req) {
      const predicate = await studentScopePredicate(req.pool, req.ctx, 'students', 'view');
      if (predicate.empty) return { body: { students: [], total: 0 } };
      const { rows } = await req.pool.query(
        `SELECT rm.student_id, rm.full_name, rm.stage, rm.risk_level, rm.sla_state,
                rm.graduation_status, rm.last_contact_at, rm.next_contact_due_at,
                rm.accepted_gig_count, rm.open_evidence_count, g.code AS group_code
         FROM rm_student_current rm
         LEFT JOIN cohort_group g ON g.id = rm.cohort_group_id
         WHERE ${predicate.sql}
         ORDER BY rm.full_name
         LIMIT 200`,
        predicate.params,
      );
      return { body: { students: rows, total: rows.length } };
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/students/:id',
    requires: { module: 'students', verb: 'view' },
    summary: 'One student record',
    async handle(req) {
      const predicate = await studentScopePredicate(req.pool, req.ctx, 'students', 'view');
      if (predicate.empty) throw new NotFoundError('Student');
      const { rows } = await req.pool.query(
        `SELECT rm.*, g.code AS group_code, g.current_session_number, g.planned_session_count
         FROM rm_student_current rm
         LEFT JOIN cohort_group g ON g.id = rm.cohort_group_id
         WHERE rm.student_id = $${predicate.params.length + 1} AND ${predicate.sql}`,
        [...predicate.params, req.params.id],
      );
      if (!rows[0]) throw new NotFoundError('Student');
      const { rows: timeline } = await req.pool.query(
        `SELECT event_type, occurred_at, actor_role, payload FROM events
         WHERE subject_id = $1 ORDER BY seq DESC LIMIT 50`,
        [req.params.id],
      );
      const { rows: gradRow } = await req.pool.query(
        `SELECT status, matched_route_key, gap_explanation_i18n, rule_version, in_denominator
         FROM graduation_progress WHERE student_id = $1`,
        [req.params.id],
      );
      return { body: { student: rows[0], timeline, graduation: gradRow[0] ?? null } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/students/:id/assign',
    requires: { module: 'students', verb: 'assign' },
    summary: 'Assign or reassign the responsible coordinator',
    async handle(req) {
      const exec = createExecutor(req.pool);
      await exec.execute(req.ctx, (scope) =>
        assignCoordinator(scope, {
          studentId: req.params.id!,
          coordinatorUserId: (req.body.coordinatorUserId as string | null) ?? null,
          reasonCode: req.body.reasonCode as string | undefined,
        }),
      );
      return { body: { ok: true } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/students/:id/unresponsive',
    requires: { module: 'students', verb: 'edit' },
    summary: 'Mark a student Unresponsive (Project Operations only, history required)',
    async handle(req) {
      const exec = createExecutor(req.pool);
      // Confirmed §15: only Project Operations sets this status.
      const maySet = req.ctx.actor.roles.some((r) => r.key === 'project_operations');
      await exec.execute(req.ctx, (scope) =>
        setUnresponsive(scope, {
          studentId: req.params.id!,
          actorMaySetUnresponsive: maySet,
          overrideReason: req.body.overrideReason as string | undefined,
        }),
      );
      return { body: { ok: true } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/students/:id/withdrawal',
    requires: { module: 'students', verb: 'edit' },
    summary: 'Record a Ministry withdrawal decision',
    async handle(req) {
      const exec = createExecutor(req.pool);
      await exec.execute(req.ctx, (scope) =>
        recordWithdrawal(scope, {
          studentId: req.params.id!,
          withdrawnOn: new Date(str(req.body, 'withdrawnOn')),
          reason: str(req.body, 'reason'),
          ministryReference: str(req.body, 'ministryReference'),
          sourceDocument: req.body.sourceDocument as string | undefined,
        }),
      );
      return { body: { ok: true } };
    },
  }),

  // -------------------------------------------------------------------------
  // Communications
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'POST',
    path: '/v1/students/:id/interactions',
    requires: { module: 'communications', verb: 'create' },
    summary: 'Record one contact: the atomic chain in §13',
    async handle(req) {
      const predicate = await studentScopePredicate(req.pool, req.ctx, 'communications', 'create');
      if (predicate.empty) throw new NotFoundError('Student');
      const { rows } = await req.pool.query(
        `SELECT 1 FROM rm_student_current rm
         WHERE rm.student_id = $${predicate.params.length + 1} AND ${predicate.sql}`,
        [...predicate.params, req.params.id],
      );
      if (!rows[0]) throw new NotFoundError('Student');

      const exec = createExecutor(req.pool);
      const { value } = await exec.execute(req.ctx, (scope) =>
        recordInteraction(scope, {
          studentId: req.params.id!,
          channel: str(req.body, 'channel') as 'whatsapp',
          purpose: str(req.body, 'purpose'),
          outcome: str(req.body, 'outcome') as 'responded',
          graduationPosition: req.body.graduationPosition as string | undefined,
          blockingFactor: req.body.blockingFactor as string | undefined,
          agreedAction: req.body.agreedAction as string | undefined,
          actionDeadline: req.body.actionDeadline
            ? new Date(req.body.actionDeadline as string)
            : undefined,
          escalationRequired: req.body.escalationRequired === true,
          notes: req.body.notes as string | undefined,
          clientDedupKey: req.body.clientDedupKey as string | undefined,
          calendar: CALENDAR,
        }),
      );
      return { status: 201, body: value };
    },
  }),

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'POST',
    path: '/v1/portal/evidence',
    requires: { module: 'portal', verb: 'create' },
    summary: 'A student submits their own evidence (§10)',
    async handle(req) {
      // The student id comes from the ACCOUNT BINDING, never from the request
      // body: a student must not be able to submit against another record.
      const { rows } = await req.pool.query(
        `SELECT student_id FROM student_account WHERE user_id = $1`,
        [req.ctx.actor.userId],
      );
      if (!rows[0]) throw new NotFoundError('Student record for this account');

      const files = Array.isArray(req.body.files) ? (req.body.files as Array<Record<string, unknown>>) : [];
      const exec = createExecutor(req.pool);
      const { value } = await exec.execute(req.ctx, (scope) =>
        submitEvidence(scope, {
          studentId: rows[0].student_id,
          subjectType: (req.body.subjectType as 'gig') ?? 'gig',
          gigId: req.body.gigId as string | undefined,
          serviceId: req.body.serviceId as string | undefined,
          files: files.map((f) => ({
            kind: String(f.kind ?? 'other'),
            fileRef: String(f.fileRef ?? ''),
            contentHash: Buffer.from(String(f.contentHash ?? ''), 'hex'),
            fileName: f.fileName as string | undefined,
            sizeBytes: f.sizeBytes as number | undefined,
          })),
          calendar: CALENDAR,
        }),
      );
      return { status: 201, body: value };
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/portal/submissions',
    requires: { module: 'portal', verb: 'view' },
    summary: 'A student’s own submissions and their state',
    async handle(req) {
      const { rows } = await req.pool.query(
        `SELECT es.id, es.reference, es.subject_type, es.current_stage, es.is_open,
                es.rejection_count, es.submitted_at, es.accepted_at
         FROM evidence_submission es
         JOIN student_account sa ON sa.student_id = es.student_id
         WHERE sa.user_id = $1
         ORDER BY es.submitted_at DESC`,
        [req.ctx.actor.userId],
      );
      return { body: { submissions: rows } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/evidence/:id/review',
    requires: { module: 'evidence', verb: 'edit' },
    summary: 'Coach review or coordinator L1 screening',
    async handle(req) {
      const exec = createExecutor(req.pool);
      await exec.execute(req.ctx, (scope) =>
        reviewStage(scope, {
          submissionId: req.params.id!,
          stage: str(req.body, 'stage') as 'coach' | 'l1',
          decision: str(req.body, 'decision') as 'passed' | 'returned',
          notes: req.body.notes as string | undefined,
          calendar: CALENDAR,
        }),
      );
      return { body: { ok: true } };
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/evidence/:id/duplicates',
    requires: { module: 'evidence', verb: 'view' },
    summary: 'Duplicate signals for the Quality screen; flags only, never a decision',
    async handle(req) {
      return { body: { flags: await duplicateSignals(req.pool, req.params.id!) } };
    },
  }),

  // -------------------------------------------------------------------------
  // Quality
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/quality/queue',
    requires: { module: 'quality', verb: 'view' },
    summary: 'The Quality queue, oldest first (§32)',
    async handle(req) {
      const cohortId = req.query.get('cohortId') ?? req.ctx.actor.cohortIds[0];
      if (!cohortId) throw new DomainError('COHORT_REQUIRED', 'A cohort must be specified.');
      return {
        body: {
          items: await qualityQueue(req.pool, cohortId),
          checks: QUALITY_CHECKS,
          rejectionCodes: REJECTION_CODES,
        },
      };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/quality/:id/decision',
    requires: { module: 'quality', verb: 'approve' },
    summary: 'Record a binary Quality decision: seven checks, all must pass',
    async handle(req) {
      const raw = (req.body.checks ?? {}) as Record<string, unknown>;
      const checks = Object.fromEntries(
        QUALITY_CHECKS.map((c) => [c, raw[c] === true]),
      ) as Record<QualityCheck, boolean>;
      const isLead = req.ctx.actor.roles.some((r) => r.key === 'quality_lead');
      const exec = createExecutor(req.pool);
      const { value } = await exec.execute(req.ctx, (scope) =>
        decideQuality(scope, {
          submissionId: req.params.id!,
          level: (req.body.level as 'l2' | 'l3') ?? 'l2',
          checks,
          rejectionCodes: Array.isArray(req.body.rejectionCodes)
            ? (req.body.rejectionCodes as RejectionCode[])
            : [],
          comments: req.body.comments as string | undefined,
          disputed: req.body.disputed === true,
          actorIsQualityLead: isLead,
          calendar: CALENDAR,
        }),
      );
      return { body: value };
    },
  }),

  // -------------------------------------------------------------------------
  // Graduation
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/graduation/summary',
    requires: { module: 'graduation', verb: 'view' },
    summary: 'The headline figure, with both targets shown separately (§41)',
    async handle(req) {
      const cohortId = req.query.get('cohortId') ?? req.ctx.actor.cohortIds[0];
      if (!cohortId) throw new DomainError('COHORT_REQUIRED', 'A cohort must be specified.');
      const summary = await graduationSummary(req.pool, cohortId);
      return { body: { ...summary, targets: GRADUATION_TARGETS } };
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/graduation/records',
    requires: { module: 'graduation', verb: 'view' },
    summary: 'The drill-down behind the graduation rate (§74)',
    async handle(req) {
      const cohortId = req.query.get('cohortId') ?? req.ctx.actor.cohortIds[0];
      const status = req.query.get('status');
      const { rows } = await req.pool.query(
        `SELECT gp.student_id, s.full_name, gp.status, gp.matched_route_key,
                gp.gap_explanation_i18n, gp.rule_version, gp.in_denominator, gp.effective_at
         FROM graduation_progress gp JOIN student s ON s.id = gp.student_id
         WHERE gp.cohort_id = $1 AND ($2::text IS NULL OR gp.status = $2)
         ORDER BY s.full_name LIMIT 500`,
        [cohortId, status],
      );
      return { body: { records: rows } };
    },
  }),

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/notifications',
    requires: { module: 'notifications', verb: 'view' },
    summary: 'In-app notification inbox',
    async handle(req) {
      return { body: { notifications: await inbox(req.pool, req.ctx.actor.userId) } };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/notifications/:id/read',
    requires: { module: 'notifications', verb: 'edit' },
    summary: 'Mark a notification read',
    async handle(req) {
      await markRead(req.pool, req.ctx.actor.userId, req.params.id!);
      return { body: { ok: true } };
    },
  }),

  // -------------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/reference',
    requires: { module: 'home', verb: 'view' },
    summary: 'Confirmed configuration the UI renders from',
    async handle() {
      return {
        body: {
          gigSources: ACCEPTED_GIG_SOURCES,
          qualityChecks: QUALITY_CHECKS,
          rejectionCodes: REJECTION_CODES,
          targets: GRADUATION_TARGETS,
        },
      };
    },
  }),

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    path: '/v1/audit',
    requires: { module: 'audit', verb: 'view_logs' },
    summary: 'The audit trail, filterable by record',
    async handle(req) {
      const recordId = req.query.get('recordId');
      const { rows } = await req.pool.query(
        `SELECT occurred_at, user_id, role, permission_used, module, record_type, record_id,
                action, old_value, new_value, reason, correlation_id
         FROM audit_log
         WHERE ($1::uuid IS NULL OR record_id = $1)
         ORDER BY occurred_at DESC LIMIT 200`,
        [recordId],
      );
      return { body: { entries: rows } };
    },
  }),
];

export const routeIndex = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
export { randomUUID };
