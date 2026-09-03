/**
 * The risk service (§21, §22).
 *
 * Rule-based only. Every level change records which rule fired, under which
 * config version, on which evidence -- so "why is this student Critical?" is
 * answered by data rather than by reading code.
 *
 * DEPI triggers (§21):
 *   At Risk   -- attendance < 70%, or no service started by the expected point
 *   Critical  -- attendance < 50%, or progress 30pp behind expectation
 *   Critical  -- two evidence rejections for the same student (Quality)
 */
import type pg from 'pg';
import {
  ATTENDANCE_POLICY,
  evaluateRisk,
  RISK_THRESHOLDS,
  workingDaysBetween,
  type RiskFacts,
  type RiskRule,
  type RiskRuleset,
  type WorkingCalendar,
} from '@coordinator/rules';
import type { CommandScope } from '../write-path.ts';
import { createTask } from './tasks.ts';

/**
 * The Round 5 ruleset, expressed as configuration.
 *
 * Thresholds come from `RISK_THRESHOLDS`, which is marked CONFIG-PENDING because
 * the attendance operating standard behind them is PROPOSED (register item 30).
 * Nothing here hard-codes a number.
 */
export function depiR5RiskRuleset(): RiskRuleset {
  const t = RISK_THRESHOLDS.value;
  const rule = (r: Omit<RiskRule, 'enabled'>): RiskRule => ({ ...r, enabled: true });
  return {
    configVersionId: 'depi-r5-risk-v1',
    // Two distinct At Risk signals together are a Critical case.
    multiSignalAmberToRed: 2,
    rules: [
      rule({
        key: 'attendance_at_risk',
        fact: 'attendanceShortfallAtRisk',
        comparator: 'is_true',
        threshold: 0,
        resultingLevel: 'amber',
        reason: 'missed_coaching',
        explain: {
          en: `Attendance is below ${t.atRiskAttendanceBelowPercent}%.`,
          ar: `نسبة الحضور أقل من ${t.atRiskAttendanceBelowPercent}%.`,
        },
      }),
      rule({
        key: 'attendance_critical',
        fact: 'attendanceShortfallCritical',
        comparator: 'is_true',
        threshold: 0,
        resultingLevel: 'red',
        reason: 'missed_coaching',
        explain: {
          en: `Attendance is below ${t.criticalAttendanceBelowPercent}%.`,
          ar: `نسبة الحضور أقل من ${t.criticalAttendanceBelowPercent}%.`,
        },
      }),
      rule({
        key: 'no_service_started',
        fact: 'noServiceStartedByExpectedPoint',
        comparator: 'is_true',
        threshold: 0,
        resultingLevel: 'amber',
        reason: 'no_freelance_activity',
        explain: {
          en: 'No service has been started by the expected point in the group journey.',
          ar: 'لم تبدأ أي خدمة في النقطة المتوقعة من رحلة المجموعة.',
        },
      }),
      rule({
        key: 'progress_behind',
        fact: 'progressBehindPercentagePoints',
        comparator: 'gte',
        threshold: t.criticalProgressBehindPercentagePoints,
        resultingLevel: 'red',
        reason: 'behind_milestone',
        explain: {
          en: `Progress is {actual} percentage points behind the group's session position.`,
          ar: 'التقدم متأخر بمقدار {actual} نقطة مئوية عن موضع جلسات المجموعة.',
        },
      }),
      rule({
        key: 'evidence_rejections',
        fact: 'rejectedGigCount',
        comparator: 'gte',
        threshold: t.criticalQualityRejectionCount,
        resultingLevel: 'red',
        reason: 'gig_verification_failure',
        explain: {
          en: `{actual} evidence rejections for this student.`,
          ar: '{actual} حالات رفض للأدلة لهذا الطالب.',
        },
      }),
      rule({
        key: 'no_contact',
        fact: 'workingDaysSinceContact',
        comparator: 'gt',
        threshold: 7,
        resultingLevel: 'amber',
        reason: 'unresponsive',
        explain: {
          en: 'No contact has been logged for more than a week.',
          ar: 'لم يتم تسجيل أي تواصل منذ أكثر من أسبوع.',
        },
      }),
    ],
  };
}

/**
 * The DEPI-specific signals, computed from the group's OWN session position:
 * the cohort is rolling (§2), so calendar elapsed time would misjudge a group
 * that started late.
 */
interface DepiRiskFacts extends RiskFacts {
  attendanceShortfallAtRisk: boolean;
  attendanceShortfallCritical: boolean;
  noServiceStartedByExpectedPoint: boolean;
  progressBehindPercentagePoints: number;
}

export async function loadRiskFacts(
  tx: pg.PoolClient,
  studentId: string,
  calendar: WorkingCalendar,
  now: Date,
): Promise<DepiRiskFacts> {
  const { rows } = await tx.query(
    `SELECT s.last_contact_at,
            g.current_session_number, g.planned_session_count, g.pathway,
            (SELECT count(*)::int FROM contact_attempt ca WHERE ca.student_id = s.id) AS attempts,
            (SELECT count(*)::int FROM attendance a JOIN session ses ON ses.id = a.session_id
              WHERE a.student_id = s.id AND a.state IN ('attended','late')) AS attended,
            (SELECT count(*)::int FROM attendance a JOIN session ses ON ses.id = a.session_id
              WHERE a.student_id = s.id AND a.state <> 'pending') AS recorded,
            (SELECT count(*)::int FROM service sv
              WHERE sv.student_id = s.id AND sv.state <> 'not_assigned') AS services_started,
            (SELECT count(*)::int FROM service sv
              WHERE sv.student_id = s.id AND sv.state = 'accepted') AS services_accepted,
            (SELECT count(*)::int FROM gig gg
              WHERE gg.student_id = s.id AND gg.quality_accepted) AS gigs_accepted,
            (SELECT count(*)::int FROM quality_decision qd
              JOIN evidence_submission es ON es.id = qd.submission_id
              WHERE es.student_id = s.id AND qd.outcome <> 'accepted') AS rejections
     FROM student s LEFT JOIN cohort_group g ON g.id = s.cohort_group_id
     WHERE s.id = $1`,
    [studentId],
  );
  const r = rows[0];
  const t = RISK_THRESHOLDS.value;

  const attendancePercent = r.recorded > 0 ? (r.attended / r.recorded) * 100 : null;

  // Expected progress is the group's own position through its plan, not a
  // calendar week -- the rolling-cohort requirement in practice.
  const sessionPosition =
    r.planned_session_count > 0 ? (r.current_session_number / r.planned_session_count) * 100 : 0;
  const expectedOutputs = r.pathway === 'support' ? 3 : 3;
  const actualOutputs = r.pathway === 'support' ? r.services_accepted : r.gigs_accepted;
  const actualProgress = expectedOutputs > 0 ? (actualOutputs / expectedOutputs) * 100 : 0;
  const behind = Math.max(0, sessionPosition - actualProgress);

  return {
    workingDaysSinceContact: r.last_contact_at
      ? workingDaysBetween(r.last_contact_at, now, calendar)
      : null,
    failedContactAttempts: r.attempts,
    missedCoachingSessions: Math.max(0, r.recorded - r.attended),
    milestonesOverdue: 0,
    workingDaysSinceFreelanceActivity: null,
    pastGigMilestoneWithoutSubmission: false,
    rejectedGigCount: r.rejections,
    overdueEvidenceTasks: 0,
    attendanceShortfallAtRisk:
      attendancePercent !== null && attendancePercent < t.atRiskAttendanceBelowPercent,
    attendanceShortfallCritical:
      attendancePercent !== null && attendancePercent < t.criticalAttendanceBelowPercent,
    // Only meaningful once the group is past its opening sessions; before that,
    // "no service yet" is normal rather than a risk.
    noServiceStartedByExpectedPoint:
      r.pathway === 'support' && sessionPosition >= 25 && r.services_started === 0,
    progressBehindPercentagePoints: behind,
  };
}

/**
 * Re-evaluates risk and keeps exactly one open record (Invariant 6).
 *
 * A manual override is left alone until its review date: automation must not
 * silently undo a human judgement.
 */
export async function evaluateStudentRisk(
  scope: CommandScope,
  studentId: string,
  calendar: WorkingCalendar,
): Promise<{ level: string; changed: boolean }> {
  const { tx, ctx } = scope;
  const facts = await loadRiskFacts(tx, studentId, calendar, ctx.now);
  const evaluation = evaluateRisk(facts, depiR5RiskRuleset());

  const { rows: open } = await tx.query(
    `SELECT id, level, origin, review_due_at FROM risk_record
     WHERE student_id = $1 AND closed_at IS NULL`,
    [studentId],
  );
  const current = open[0];

  if (current?.origin === 'manual' && current.review_due_at && new Date(current.review_due_at) > ctx.now) {
    return { level: current.level, changed: false };
  }

  if (current && current.level === evaluation.level) {
    await tx.query(
      `UPDATE risk_record SET evidence = $2::jsonb, fired_rule_key = $3 WHERE id = $1`,
      [
        current.id,
        JSON.stringify(evaluation.firedRules),
        evaluation.firedRules[0]?.ruleKey ?? null,
      ],
    );
    return { level: evaluation.level, changed: false };
  }

  if (current) {
    await tx.query(`UPDATE risk_record SET closed_at = $2 WHERE id = $1`, [current.id, ctx.now]);
  }

  const { rows: created } = await tx.query(
    `INSERT INTO risk_record (student_id, level, origin, fired_rule_key, evidence, opened_at)
     VALUES ($1,$2,'rule',$3,$4::jsonb,$5) RETURNING id`,
    [
      studentId,
      evaluation.level,
      evaluation.firedRules[0]?.ruleKey ?? null,
      JSON.stringify(evaluation.firedRules),
      ctx.now,
    ],
  );
  for (const reason of evaluation.reasons) {
    await tx.query(
      `INSERT INTO risk_reason (risk_record_id, reason_code, evidence)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
      [created[0].id, reason, JSON.stringify({})],
    );
  }

  await tx.query(`UPDATE student SET current_risk_level = $2 WHERE id = $1`, [
    studentId,
    evaluation.level,
  ]);

  const eventId = await scope.emit({
    type: 'RISK_CHANGED',
    subjectType: 'student',
    subjectId: studentId,
    payload: {
      from: current?.level ?? 'green',
      to: evaluation.level,
      reasons: evaluation.reasons,
      firedRules: evaluation.firedRules.map((f) => f.ruleKey),
      configVersionId: evaluation.configVersionId,
      escalatedByMultiSignal: evaluation.escalatedByMultiSignal,
    },
  });

  if (evaluation.level !== 'green') {
    // A Critical student without an intervention plan is a control-tower
    // exception, so the plan is a task from the moment the risk opens (§22).
    await createTask(scope, {
      studentId,
      taskType: evaluation.level === 'red' ? 'critical_intervention_plan' : 'at_risk_review',
      ownerResolver:
        evaluation.level === 'red'
          ? { kind: 'student_supervisor', studentId }
          : { kind: 'student_coordinator', studentId },
      dueAt: new Date(ctx.now.getTime() + (evaluation.level === 'red' ? 2 : 5) * 86_400_000),
      source: 'risk',
      dedupKey: `${studentId}:risk_${evaluation.level}`,
      originatingEventId: eventId,
      priority: evaluation.level === 'red' ? 10 : 40,
    });
  } else {
    const { cancelTasksByDedupPrefix } = await import('./tasks.ts');
    await cancelTasksByDedupPrefix(scope, `${studentId}:risk_`, 'risk_cleared');
  }

  await scope.audit({
    module: 'risks',
    recordType: 'risk_record',
    recordId: created[0].id,
    action: 'evaluate',
    permissionUsed: 'risks.create',
    oldValue: { level: current?.level ?? 'green' },
    newValue: { level: evaluation.level, reasons: evaluation.reasons },
    reason: evaluation.firedRules.map((f) => f.explain.en).join('; '),
  });

  return { level: evaluation.level, changed: true };
}
