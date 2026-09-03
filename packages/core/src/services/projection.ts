/**
 * Read-model projection (§69, §72).
 *
 * Dashboards read from `rm_student_current`, never by aggregating OLTP. The
 * projection is computed as SET-TO-VALUE rather than incremented, so applying it
 * twice is harmless by construction -- which is what lets the replay tests hold
 * without special-casing.
 */
import type pg from 'pg';
import { evaluateSla, type SlaRuleset, type WorkingCalendar } from '@coordinator/rules';

export const DEPI_SLA_RULESET: SlaRuleset = {
  configVersionId: 'depi-r5-sla-v1',
  rules: new Map(),
  // Confirmed §14: every student contacted at least once every 7 days, whatever
  // their stage. Risk-specific tightening is configuration, not code.
  fallback: {
    contactIntervalWorkingDays: 5, // 7 calendar days ~ 5 working days
    approachingWorkingDays: 1,
    firstContactWorkingDays: 2,
  },
};

export async function projectStudent(
  db: pg.Pool | pg.PoolClient,
  studentId: string,
  calendar: WorkingCalendar,
  now = new Date(),
): Promise<void> {
  const { rows } = await db.query(
    `SELECT s.id, s.cohort_id, s.cohort_group_id, s.full_name, s.current_stage, s.pathway,
            s.current_risk_level, s.graduation_status, s.last_contact_at,
            s.last_successful_contact_at,
            sa.coordinator_user_id, sca.coach_user_id,
            g.supervisor_user_id,
            (SELECT min(effective_from) FROM student_assignment x
              WHERE x.student_id = s.id AND x.coordinator_user_id IS NOT NULL) AS assigned_at,
            (SELECT count(*)::int FROM contact_attempt ca WHERE ca.student_id = s.id) AS attempts,
            (SELECT count(*)::int FROM evidence_submission es
              WHERE es.student_id = s.id AND es.is_open) AS open_evidence,
            (SELECT count(*)::int FROM gig gg
              WHERE gg.student_id = s.id AND gg.quality_accepted) AS accepted_gigs,
            (SELECT coalesce(sum(gg.value_amount), 0) FROM gig gg
              WHERE gg.student_id = s.id AND gg.quality_accepted) AS accepted_value,
            (SELECT count(*)::int FROM service sv
              WHERE sv.student_id = s.id AND sv.state = 'accepted') AS accepted_services,
            (SELECT count(*)::int FROM escalation e
              WHERE e.student_id = s.id AND e.status NOT IN ('closed')) AS open_escalations,
            (SELECT count(*)::int FROM attendance a
              WHERE a.student_id = s.id AND a.state IN ('attended','late')) AS attended,
            (SELECT count(*)::int FROM attendance a
              WHERE a.student_id = s.id AND a.state <> 'pending') AS recorded,
            COALESCE((SELECT gp.in_denominator FROM graduation_progress gp
                      WHERE gp.student_id = s.id), true) AS in_denominator
     FROM student s
     LEFT JOIN student_assignment sa
       ON sa.student_id = s.id AND sa.effective_to IS NULL
     LEFT JOIN student_coach_assignment sca
       ON sca.student_id = s.id AND sca.effective_to IS NULL
     LEFT JOIN cohort_group g ON g.id = s.cohort_group_id
     WHERE s.id = $1`,
    [studentId],
  );
  const r = rows[0];
  if (!r) return;

  const sla = evaluateSla(
    {
      stage: r.current_stage,
      riskLevel: r.current_risk_level,
      track: null,
      lastContactAt: r.last_contact_at,
      assignedAt: r.assigned_at,
      now,
    },
    DEPI_SLA_RULESET,
    calendar,
  );

  await db.query(
    `INSERT INTO rm_student_current (
       student_id, cohort_id, cohort_group_id, coordinator_user_id, supervisor_user_id,
       coach_user_id, full_name, stage, pathway, risk_level, graduation_status,
       last_contact_at, last_successful_contact_at, next_contact_due_at, sla_state,
       contact_attempts, open_evidence_count, accepted_gig_count, accepted_gig_value,
       accepted_service_count, attendance_percent, open_escalations, in_denominator, refreshed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now())
     ON CONFLICT (student_id) DO UPDATE SET
       cohort_id = EXCLUDED.cohort_id, cohort_group_id = EXCLUDED.cohort_group_id,
       coordinator_user_id = EXCLUDED.coordinator_user_id,
       supervisor_user_id = EXCLUDED.supervisor_user_id,
       coach_user_id = EXCLUDED.coach_user_id, full_name = EXCLUDED.full_name,
       stage = EXCLUDED.stage, pathway = EXCLUDED.pathway, risk_level = EXCLUDED.risk_level,
       graduation_status = EXCLUDED.graduation_status,
       last_contact_at = EXCLUDED.last_contact_at,
       last_successful_contact_at = EXCLUDED.last_successful_contact_at,
       next_contact_due_at = EXCLUDED.next_contact_due_at, sla_state = EXCLUDED.sla_state,
       contact_attempts = EXCLUDED.contact_attempts,
       open_evidence_count = EXCLUDED.open_evidence_count,
       accepted_gig_count = EXCLUDED.accepted_gig_count,
       accepted_gig_value = EXCLUDED.accepted_gig_value,
       accepted_service_count = EXCLUDED.accepted_service_count,
       attendance_percent = EXCLUDED.attendance_percent,
       open_escalations = EXCLUDED.open_escalations,
       in_denominator = EXCLUDED.in_denominator,
       refreshed_at = now()`,
    [
      r.id, r.cohort_id, r.cohort_group_id, r.coordinator_user_id, r.supervisor_user_id,
      r.coach_user_id, r.full_name, r.current_stage, r.pathway, r.current_risk_level,
      r.graduation_status, r.last_contact_at, r.last_successful_contact_at,
      sla.nextContactDueAt, sla.state, r.attempts, r.open_evidence, r.accepted_gigs,
      r.accepted_value, r.accepted_services,
      r.recorded > 0 ? (r.attended / r.recorded) * 100 : null,
      r.open_escalations, r.in_denominator,
    ],
  );
}

/** Full rebuild, used by the nightly reconciliation and after a bulk import. */
export async function projectCohort(
  db: pg.Pool,
  cohortId: string,
  calendar: WorkingCalendar,
  now = new Date(),
): Promise<number> {
  const { rows } = await db.query(`SELECT id FROM student WHERE cohort_id = $1`, [cohortId]);
  for (const r of rows) await projectStudent(db, r.id, calendar, now);
  return rows.length;
}
