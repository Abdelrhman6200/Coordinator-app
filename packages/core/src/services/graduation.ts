/**
 * The graduation calculation service.
 *
 * Requirement §69 is the governing constraint: ONE calculation layer. The
 * dashboard, the export, the staff KPI and the entitlement report all call this
 * -- there is no second implementation of "graduated", which is the only way the
 * "no conflicting figures across reports" requirement can actually hold.
 *
 * Requirement §40: graduation is COMPUTED. Nothing here accepts a graduation
 * decision as input; it derives one from Quality-accepted evidence and writes
 * the record with the rule version it used.
 */
import type pg from 'pg';
import {
  evaluateGraduation,
  ENTREPRENEURSHIP_COMPONENTS,
  FREELANCING_GRADUATION_RULESET,
  GRADUATION_TARGETS,
  type GraduationRuleset,
  type VerifiedGig,
} from '@coordinator/rules';
import type { CommandScope } from '../write-path.ts';

export interface GraduationOutcome {
  studentId: string;
  status: string;
  pathway: string | null;
  matchedRoute: string | null;
  gapExplanation: Record<string, string>;
  ruleVersion: string;
  evidenceIds: string[];
  becameGraduate: boolean;
}

/**
 * Facts are read inside the caller's transaction, so a recomputation triggered by
 * a gig acceptance sees that acceptance. Only Quality-ACCEPTED gigs are counted:
 * §30 requires delivered AND paid AND evidenced AND accepted, and the first
 * three are already constraints on the row.
 */
async function loadFacts(tx: pg.PoolClient, studentId: string) {
  const { rows: gigs } = await tx.query(
    `SELECT id, value_amount FROM gig WHERE student_id = $1 AND quality_accepted = true`,
    [studentId],
  );
  const { rows: student } = await tx.query(
    `SELECT s.pathway, s.cohort_id, c.denominator_policy,
            (SELECT count(*) FROM withdrawal w WHERE w.student_id = s.id)::int AS withdrawn
     FROM student s JOIN cohort c ON c.id = s.cohort_id WHERE s.id = $1`,
    [studentId],
  );
  const { rows: ent } = await tx.query(
    `SELECT components, accepted FROM entrepreneurship_assessment WHERE student_id = $1`,
    [studentId],
  );
  const { rows: services } = await tx.query(
    `SELECT count(*)::int AS accepted FROM service WHERE student_id = $1 AND state = 'accepted'`,
    [studentId],
  );
  return {
    gigs: gigs.map(
      (g): VerifiedGig => ({
        gigId: g.id,
        amountBase: Number(g.value_amount),
        // A gig only reaches `quality_accepted` with payment confirmed, so
        // payment evidence is implied by acceptance.
        hasPaymentEvidence: true,
      }),
    ),
    student: student[0],
    entrepreneurship: ent[0] ?? null,
    acceptedServices: services[0]?.accepted ?? 0,
  };
}

/**
 * Recomputes and persists a student's graduation state.
 *
 * Idempotent: called again with unchanged evidence it writes the same row and
 * emits no duplicate GRADUATION event, because the event is emitted only on a
 * transition INTO graduated.
 */
export async function recomputeGraduation(
  scope: CommandScope,
  studentId: string,
  ruleset: GraduationRuleset = FREELANCING_GRADUATION_RULESET,
): Promise<GraduationOutcome> {
  const { tx } = scope;
  const facts = await loadFacts(tx, studentId);
  if (!facts.student) throw new Error(`unknown student ${studentId}`);

  const pathway: string | null = facts.student.pathway ?? null;

  let status: string;
  let matchedRoute: string | null = null;
  let gapExplanation: Record<string, string>;
  let evidenceIds: string[] = [];
  let ruleVersion: string;

  if (pathway === 'entrepreneurship') {
    // A separate pathway (§39): seven components, all must meet the minimum.
    const components = (facts.entrepreneurship?.components ?? {}) as Record<string, unknown>;
    const met = ENTREPRENEURSHIP_COMPONENTS.filter((k) => components[k] === true);
    const complete = met.length === ENTREPRENEURSHIP_COMPONENTS.length;
    const accepted = facts.entrepreneurship?.accepted === true;
    status = complete && accepted ? 'graduated' : met.length > 0 ? 'progressing' : 'not_eligible';
    matchedRoute = complete && accepted ? 'entrepreneurship' : null;
    ruleVersion = 'depi-r5-entrepreneurship-v1';
    const missing = ENTREPRENEURSHIP_COMPONENTS.filter((k) => components[k] !== true);
    gapExplanation = complete
      ? {
          en: accepted
            ? 'All seven entrepreneurship components are complete and accepted.'
            : 'All seven components are complete; the assessment is awaiting coach acceptance.',
          ar: accepted
            ? 'اكتملت جميع مكونات ريادة الأعمال السبعة وتم قبولها.'
            : 'اكتملت المكونات السبعة؛ التقييم في انتظار قبول المدرب.',
        }
      : {
          en: `${met.length} of ${ENTREPRENEURSHIP_COMPONENTS.length} components complete. Missing: ${missing.join(', ')}.`,
          ar: `${met.length} من ${ENTREPRENEURSHIP_COMPONENTS.length} مكونات مكتملة. المتبقي: ${missing.join('، ')}.`,
        };
  } else {
    const evaluation = evaluateGraduation(
      {
        verifiedGigs: facts.gigs,
        achievedMilestoneKeys: [],
        completedCoachingSessions: 0,
        presentEvidenceKeys: [],
        cohortTimeRemainingFraction: 1,
      },
      ruleset,
    );
    matchedRoute = evaluation.matchedRouteKey;
    status = evaluation.status === 'eligibility_met' ? 'graduated' : evaluation.status;
    gapExplanation = evaluation.gapExplanation;
    ruleVersion = evaluation.configVersionId;
    evidenceIds = evaluation.routes
      .flatMap((r) => r.criteria)
      .flatMap((c) => c.evidenceRefs as string[]);
    evidenceIds = [...new Set(evidenceIds)];
  }

  // The denominator policy in force is stamped on the record, so the headline
  // KPI is always explainable (register item 26).
  const policy: string = facts.student.denominator_policy;
  const withdrawn = facts.student.withdrawn > 0;
  const inDenominator =
    policy === 'include_all'
      ? true
      : !(withdrawn && policy !== 'include_all');

  const { rows: prior } = await tx.query(
    `SELECT status FROM graduation_progress WHERE student_id = $1`,
    [studentId],
  );
  const previousStatus: string | null = prior[0]?.status ?? null;

  await tx.query(
    `INSERT INTO graduation_progress (student_id, cohort_id, status, matched_route_key,
                                      gap_explanation_i18n, denominator_policy_applied,
                                      pathway, rule_version, evidence_ids, calculated_at,
                                      effective_at, in_denominator, evaluated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::uuid[],now(),
             CASE WHEN $3 = 'graduated' THEN now() ELSE NULL END, $10, now())
     ON CONFLICT (student_id) DO UPDATE SET
       status = EXCLUDED.status,
       matched_route_key = EXCLUDED.matched_route_key,
       gap_explanation_i18n = EXCLUDED.gap_explanation_i18n,
       denominator_policy_applied = EXCLUDED.denominator_policy_applied,
       pathway = EXCLUDED.pathway,
       rule_version = EXCLUDED.rule_version,
       evidence_ids = EXCLUDED.evidence_ids,
       calculated_at = now(),
       -- The graduation date is when it FIRST became true, not when it was last
       -- recomputed: a nightly sweep must not silently move a graduation date.
       effective_at = COALESCE(graduation_progress.effective_at, EXCLUDED.effective_at),
       in_denominator = EXCLUDED.in_denominator,
       evaluated_at = now()`,
    [
      studentId,
      facts.student.cohort_id,
      status,
      matchedRoute,
      JSON.stringify(gapExplanation),
      policy,
      pathway,
      ruleVersion,
      evidenceIds,
      inDenominator,
    ],
  );

  await tx.query(`UPDATE student SET graduation_status = $2 WHERE id = $1`, [studentId, status]);

  const becameGraduate = status === 'graduated' && previousStatus !== 'graduated';
  if (becameGraduate) {
    await scope.emit({
      type: 'GRADUATION_COMPUTED',
      subjectType: 'student',
      subjectId: studentId,
      cohortId: facts.student.cohort_id,
      payload: { status, matchedRoute, ruleVersion, evidenceIds, pathway },
    });
  } else if (previousStatus === 'graduated' && status !== 'graduated') {
    // Losing graduation is a material event: it moves the headline number
    // downward and someone must be able to see why.
    await scope.emit({
      type: 'GRADUATION_REVERSED',
      subjectType: 'student',
      subjectId: studentId,
      cohortId: facts.student.cohort_id,
      payload: { from: previousStatus, to: status, ruleVersion, reason: 'evidence_withdrawn' },
    });
  }

  return {
    studentId,
    status,
    pathway,
    matchedRoute,
    gapExplanation,
    ruleVersion,
    evidenceIds,
    becameGraduate,
  };
}

export interface GraduationSummary {
  denominator: number;
  graduated: number;
  ratePercent: number;
  contractualThresholdPercent: number;
  internalTargetPercent: number;
  gapToContractual: number;
  gapToInternal: number;
  studentsNeededForContractual: number;
  studentsNeededForInternal: number;
  withdrawnExcluded: number;
}

/**
 * The headline figure, computed in exactly one place.
 *
 * Both targets are returned separately and always (§2, §41): the 70% threshold
 * has contractual force and the 85% is the internal operating target. Collapsing
 * them into one number loses the one that carries consequences.
 */
export async function graduationSummary(
  db: pg.Pool | pg.PoolClient,
  cohortId: string,
): Promise<GraduationSummary> {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE gp.in_denominator)::int                                AS denominator,
       count(*) FILTER (WHERE gp.in_denominator AND gp.status = 'graduated')::int    AS graduated,
       count(*) FILTER (WHERE NOT gp.in_denominator)::int                            AS excluded
     FROM graduation_progress gp
     WHERE gp.cohort_id = $1`,
    [cohortId],
  );
  const denominator: number = rows[0]?.denominator ?? 0;
  const graduated: number = rows[0]?.graduated ?? 0;
  const ratePercent = denominator === 0 ? 0 : (graduated / denominator) * 100;

  const needFor = (target: number) =>
    denominator === 0 ? 0 : Math.max(0, Math.ceil((target / 100) * denominator) - graduated);

  return {
    denominator,
    graduated,
    ratePercent,
    contractualThresholdPercent: GRADUATION_TARGETS.contractualThresholdPercent,
    internalTargetPercent: GRADUATION_TARGETS.internalTargetPercent,
    gapToContractual: GRADUATION_TARGETS.contractualThresholdPercent - ratePercent,
    gapToInternal: GRADUATION_TARGETS.internalTargetPercent - ratePercent,
    studentsNeededForContractual: needFor(GRADUATION_TARGETS.contractualThresholdPercent),
    studentsNeededForInternal: needFor(GRADUATION_TARGETS.internalTargetPercent),
    withdrawnExcluded: rows[0]?.excluded ?? 0,
  };
}
