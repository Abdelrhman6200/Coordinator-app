/**
 * Reports (§60, §61).
 *
 * Generated from system data with no manual assembly, and from the SAME
 * calculation layer the dashboards use (§69). A report that recomputed
 * "graduated" its own way would reintroduce exactly the conflicting-figures
 * problem the requirement exists to prevent.
 *
 * Every report is snapshotted: `report_snapshot` is append-only, so a figure
 * quoted in a Monday meeting can be reproduced exactly, filters and all.
 */
import type pg from 'pg';
import { QUALITY_QUEUE_THRESHOLDS } from '@coordinator/rules';
import { graduationSummary } from './graduation.ts';

export interface DailyOperationsReport {
  generatedAt: string;
  cohortId: string;
  sessions: { today: number; tomorrow: number; unconfirmed: number };
  quality: { queueSize: number; oldestHours: number; overSlaCount: number; threshold: string };
  services: Record<string, number>;
  openRejections: number;
  escalations: { openedToday: number; closedToday: number; pastSla: number };
  studentsWithoutUpdate7d: number;
}

export async function dailyOperationsReport(
  db: pg.Pool,
  cohortId: string,
  now = new Date(),
): Promise<DailyOperationsReport> {
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);

  const { rows: sessions } = await db.query(
    `SELECT
       count(*) FILTER (WHERE ses.scheduled_date = $2::date)::int AS today,
       count(*) FILTER (WHERE ses.scheduled_date = $3::date)::int AS tomorrow,
       count(*) FILTER (WHERE ses.scheduled_date BETWEEN $2::date AND $3::date
                          AND coalesce(ses.coach_confirmed,'not_confirmed') <> 'confirmed')::int
         AS unconfirmed
     FROM session ses JOIN cohort_group g ON g.id = ses.cohort_group_id
     WHERE g.cohort_id = $1 AND ses.status = 'scheduled'`,
    [cohortId, today, tomorrow],
  );

  const { rows: quality } = await db.query(
    `SELECT count(*)::int AS queue,
            coalesce(max(EXTRACT(EPOCH FROM (now() - es.submitted_at)) / 3600), 0) AS oldest,
            count(*) FILTER (WHERE es.submitted_at < now() - interval '48 hours')::int AS over_sla
     FROM evidence_submission es JOIN student s ON s.id = es.student_id
     WHERE s.cohort_id = $1 AND es.is_open AND es.current_stage IN ('l2','l3')`,
    [cohortId],
  );
  const queueSize: number = quality[0].queue;

  const { rows: services } = await db.query(
    `SELECT sv.state, count(*)::int AS n
     FROM service sv JOIN student s ON s.id = sv.student_id
     WHERE s.cohort_id = $1 GROUP BY sv.state`,
    [cohortId],
  );

  const { rows: rejections } = await db.query(
    `SELECT count(*)::int AS n FROM service sv JOIN student s ON s.id = sv.student_id
     WHERE s.cohort_id = $1 AND sv.state IN ('rejected','correction')`,
    [cohortId],
  );

  const { rows: esc } = await db.query(
    `SELECT
       count(*) FILTER (WHERE e.raised_at::date = $2::date)::int AS opened,
       count(*) FILTER (WHERE e.closed_at::date = $2::date)::int AS closed,
       count(*) FILTER (WHERE e.status NOT IN ('closed')
                          AND e.sla_due_at IS NOT NULL AND e.sla_due_at < now())::int AS past_sla
     FROM escalation e WHERE e.cohort_id = $1`,
    [cohortId, today],
  );

  const { rows: stale } = await db.query(
    `SELECT count(*)::int AS n FROM rm_student_current rm
     WHERE rm.cohort_id = $1
       AND (rm.last_contact_at IS NULL OR rm.last_contact_at < now() - interval '7 days')`,
    [cohortId],
  );

  return {
    generatedAt: now.toISOString(),
    cohortId,
    sessions: {
      today: sessions[0].today,
      tomorrow: sessions[0].tomorrow,
      unconfirmed: sessions[0].unconfirmed,
    },
    quality: {
      queueSize,
      oldestHours: Math.round(Number(quality[0].oldest)),
      overSlaCount: quality[0].over_sla,
      threshold:
        queueSize >= QUALITY_QUEUE_THRESHOLDS.pmEscalationQueueSize
          ? 'pm_escalation'
          : queueSize >= QUALITY_QUEUE_THRESHOLDS.leadReviewQueueSize
            ? 'lead_review'
            : 'normal',
    },
    services: Object.fromEntries(services.map((s) => [s.state, s.n])),
    openRejections: rejections[0].n,
    escalations: {
      openedToday: esc[0].opened,
      closedToday: esc[0].closed,
      pastSla: esc[0].past_sla,
    },
    studentsWithoutUpdate7d: stale[0].n,
  };
}

export interface WeeklyConsolidatedReport {
  generatedAt: string;
  cohortId: string;
  headline: Awaited<ReturnType<typeof graduationSummary>>;
  groups: { onTrack: number; delayed: number; critical: number };
  services: Record<string, number>;
  quality: {
    reviews: number;
    accepted: number;
    rejected: number;
    rejectionRatePercent: number;
    byCode: Record<string, number>;
  };
  coaching: { planned: number; delivered: number; attendancePercent: number | null };
  risk: { green: number; amber: number; red: number };
}

export async function weeklyConsolidatedReport(
  db: pg.Pool,
  cohortId: string,
  now = new Date(),
): Promise<WeeklyConsolidatedReport> {
  // The SAME calculation service the dashboard calls. One definition of
  // "graduated", so the report and the screen cannot disagree.
  const headline = await graduationSummary(db, cohortId);

  const { rows: groups } = await db.query(
    `SELECT risk_classification, count(*)::int AS n FROM cohort_group
     WHERE cohort_id = $1 GROUP BY risk_classification`,
    [cohortId],
  );
  const byClass = Object.fromEntries(groups.map((g) => [g.risk_classification, g.n]));

  const { rows: services } = await db.query(
    `SELECT sv.state, count(*)::int AS n FROM service sv JOIN student s ON s.id = sv.student_id
     WHERE s.cohort_id = $1 GROUP BY sv.state`,
    [cohortId],
  );

  const { rows: decisions } = await db.query(
    `SELECT qd.outcome, count(*)::int AS n
     FROM quality_decision qd
     JOIN evidence_submission es ON es.id = qd.submission_id
     JOIN student s ON s.id = es.student_id
     WHERE s.cohort_id = $1 AND qd.decided_at > $2
     GROUP BY qd.outcome`,
    [cohortId, new Date(now.getTime() - 7 * 86_400_000)],
  );
  const accepted = decisions.find((d) => d.outcome === 'accepted')?.n ?? 0;
  const rejected = decisions
    .filter((d) => d.outcome !== 'accepted')
    .reduce((sum, d) => sum + d.n, 0);
  const reviews = accepted + rejected;

  const { rows: codes } = await db.query(
    `SELECT code, count(*)::int AS n FROM (
       SELECT unnest(qd.rejection_codes) AS code
       FROM quality_decision qd
       JOIN evidence_submission es ON es.id = qd.submission_id
       JOIN student s ON s.id = es.student_id
       WHERE s.cohort_id = $1
     ) x GROUP BY code ORDER BY n DESC`,
    [cohortId],
  );

  const { rows: coaching } = await db.query(
    `SELECT
       count(*)::int AS planned,
       count(*) FILTER (WHERE ses.status = 'delivered')::int AS delivered
     FROM session ses JOIN cohort_group g ON g.id = ses.cohort_group_id
     WHERE g.cohort_id = $1`,
    [cohortId],
  );
  const { rows: attendance } = await db.query(
    `SELECT
       count(*) FILTER (WHERE a.state IN ('attended','late'))::int AS present,
       count(*) FILTER (WHERE a.state <> 'pending')::int AS recorded
     FROM attendance a JOIN student s ON s.id = a.student_id WHERE s.cohort_id = $1`,
    [cohortId],
  );

  const { rows: risk } = await db.query(
    `SELECT risk_level, count(*)::int AS n FROM rm_student_current
     WHERE cohort_id = $1 GROUP BY risk_level`,
    [cohortId],
  );
  const byRisk = Object.fromEntries(risk.map((r) => [r.risk_level, r.n]));

  return {
    generatedAt: now.toISOString(),
    cohortId,
    headline,
    groups: {
      onTrack: byClass.on_track ?? 0,
      delayed: byClass.delayed ?? 0,
      critical: byClass.critical ?? 0,
    },
    services: Object.fromEntries(services.map((s) => [s.state, s.n])),
    quality: {
      reviews,
      accepted,
      rejected,
      rejectionRatePercent: reviews === 0 ? 0 : (rejected / reviews) * 100,
      byCode: Object.fromEntries(codes.map((c) => [c.code, c.n])),
    },
    coaching: {
      planned: coaching[0].planned,
      delivered: coaching[0].delivered,
      attendancePercent:
        attendance[0].recorded > 0
          ? (attendance[0].present / attendance[0].recorded) * 100
          : null,
    },
    risk: { green: byRisk.green ?? 0, amber: byRisk.amber ?? 0, red: byRisk.red ?? 0 },
  };
}

/**
 * Snapshots a report so a figure quoted in a meeting can be reproduced exactly.
 * `report_snapshot` is append-only: a past report is never silently restated.
 */
export async function snapshotReport(
  db: pg.Pool,
  input: {
    reportKey: string;
    cohortId: string;
    generatedBy?: string | null;
    filters?: Record<string, unknown>;
    metricVersion?: string;
    payload: unknown;
  },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO report_snapshot (report_key, cohort_id, generated_by, filters, metric_version,
                                  payload)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb) RETURNING id`,
    [
      input.reportKey,
      input.cohortId,
      input.generatedBy ?? null,
      JSON.stringify(input.filters ?? {}),
      input.metricVersion ?? 'depi-r5-metrics-v1',
      JSON.stringify(input.payload),
    ],
  );
  return rows[0].id;
}

/**
 * Reconciliation (§69): recompute the headline from the RAW EVENT LOG and
 * compare it to the read model.
 *
 * This is the mechanical guarantee behind "every number traces to records". A
 * divergence means a projection has drifted, and it is an alert rather than a
 * rounding note.
 */
export async function reconcileGraduation(
  db: pg.Pool,
  cohortId: string,
): Promise<{
  fromReadModel: number;
  fromEvents: number;
  matches: boolean;
  divergentStudentIds: string[];
}> {
  const summary = await graduationSummary(db, cohortId);

  // Rebuilt from events alone: a student is a graduate if their most recent
  // graduation event is a computation rather than a reversal.
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (e.subject_id) e.subject_id, e.event_type
       FROM events e
       WHERE e.cohort_id = $1
         AND e.event_type IN ('GRADUATION_COMPUTED','GRADUATION_REVERSED')
       ORDER BY e.subject_id, e.seq DESC
     )
     SELECT l.subject_id
     FROM latest l
     JOIN graduation_progress gp ON gp.student_id = l.subject_id
     WHERE l.event_type = 'GRADUATION_COMPUTED' AND gp.in_denominator`,
    [cohortId],
  );
  const fromEvents = rows.length;

  const { rows: divergent } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (e.subject_id) e.subject_id, e.event_type
       FROM events e
       WHERE e.cohort_id = $1
         AND e.event_type IN ('GRADUATION_COMPUTED','GRADUATION_REVERSED')
       ORDER BY e.subject_id, e.seq DESC
     )
     SELECT gp.student_id
     FROM graduation_progress gp
     LEFT JOIN latest l ON l.subject_id = gp.student_id
     WHERE gp.cohort_id = $1
       AND (gp.status = 'graduated') <> (coalesce(l.event_type,'') = 'GRADUATION_COMPUTED')`,
    [cohortId],
  );

  return {
    fromReadModel: summary.graduated,
    fromEvents,
    matches: summary.graduated === fromEvents && divergent.length === 0,
    divergentStudentIds: divergent.map((d) => d.student_id),
  };
}
