/**
 * The registered event handlers.
 *
 * Each is idempotent by `event_id` (the offset row is written in the handler's
 * own transaction), and each is additionally idempotent by construction:
 * projections are set-to-value, tasks are dedup-keyed, notifications are
 * rate-limit-keyed. Belt and braces, because replay must be safe for the DLQ
 * console to be usable.
 */
import type pg from 'pg';
import type { WorkingCalendar } from '@coordinator/rules';
import type { EventHandler } from './handlers.ts';
import { projectStudent } from './services/projection.ts';
import { notify } from './services/notifications.ts';

export function buildHandlers(calendar: WorkingCalendar): EventHandler[] {
  const projectSubjectStudent: EventHandler = {
    key: 'project_student',
    handles: [
      'STUDENT_ASSIGNED',
      'STUDENT_REASSIGNED',
      'MESSAGE_SENT',
      'CALL_LOGGED',
      'STUDENT_REPLIED',
      'INTERACTION_RECORDED',
      'RISK_CHANGED',
      'GRADUATION_COMPUTED',
      'GRADUATION_REVERSED',
      'STUDENT_WITHDRAWN',
      'STUDENT_MARKED_UNRESPONSIVE',
      'CONTACT_SLA_BREACHED',
    ],
    async handle(event, tx: pg.PoolClient) {
      if (event.subjectType !== 'student') return;
      await projectStudent(tx, event.subjectId, calendar, event.occurredAt);
    },
  };

  const projectEvidenceStudent: EventHandler = {
    key: 'project_evidence_student',
    handles: [
      'EVIDENCE_SUBMITTED',
      'EVIDENCE_ACCEPTED',
      'EVIDENCE_REJECTED',
      'EVIDENCE_RETURNED',
      'EVIDENCE_ESCALATED',
    ],
    async handle(event, tx) {
      const { rows } = await tx.query(
        `SELECT student_id FROM evidence_submission WHERE id = $1`,
        [event.subjectId],
      );
      if (rows[0]) await projectStudent(tx, rows[0].student_id, calendar, event.occurredAt);
    },
  };

  const notifyRisk: EventHandler = {
    key: 'notify_risk',
    handles: ['RISK_CHANGED'],
    async handle(event, tx) {
      const to = event.payload.to as string;
      if (to === 'green') return;
      const { rows } = await tx.query(
        `SELECT sa.coordinator_user_id, s.full_name
         FROM student s
         LEFT JOIN student_assignment sa ON sa.student_id = s.id AND sa.effective_to IS NULL
         WHERE s.id = $1`,
        [event.subjectId],
      );
      if (!rows[0]?.coordinator_user_id) return;
      await notify(tx, {
        userId: rows[0].coordinator_user_id,
        triggerKey: to === 'red' ? 'student_critical' : 'student_at_risk',
        title: `${rows[0].full_name} is now ${to === 'red' ? 'Critical' : 'At Risk'}`,
        body: `Reasons: ${(event.payload.reasons as string[] | undefined)?.join(', ') ?? 'see risk record'}`,
        subjectType: 'student',
        subjectId: event.subjectId,
        // Keyed on the event: a replay reaches the person once.
        rateLimitKey: `risk:${event.eventId}`,
      });
    },
  };

  const notifyEvidenceForReview: EventHandler = {
    key: 'notify_evidence_review',
    handles: ['EVIDENCE_SUBMITTED', 'EVIDENCE_ESCALATED'],
    async handle(event, tx) {
      const escalated = event.type === 'EVIDENCE_ESCALATED';
      await notify(tx, {
        roleKey: escalated ? 'quality_lead' : 'quality_member',
        triggerKey: escalated ? 'evidence_escalated' : 'evidence_submitted',
        title: escalated ? 'Evidence escalated to Level 3' : 'New evidence submitted',
        subjectType: 'evidence_submission',
        subjectId: event.subjectId,
        rateLimitKey: `evidence:${event.eventId}`,
      });
    },
  };

  return [projectSubjectStudent, projectEvidenceStudent, notifyRisk, notifyEvidenceForReview];
}
