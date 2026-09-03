/**
 * Confirmed DEPI Round 5 configuration.
 *
 * These are the values the programme has CONFIRMED. They live here as seed
 * configuration, not as logic: every one is published into
 * `cohort_config_version` / `config_item` and the engines read them from there
 * at runtime. Nothing in an engine hard-codes a number from this file.
 *
 * That distinction is what makes the next round a configuration exercise: to run
 * Round 6 with different rules, publish a different config version. This module
 * is only the Round 5 starting point.
 *
 * Items the requirements mark PROPOSED or unavailable are flagged
 * `configPending` and carry their register reference.
 */
import type { GraduationRuleset } from './graduation.ts';
import type { WorkingCalendar } from './working-calendar.ts';

export interface PendingValue<T> {
  readonly value: T;
  readonly configPending: true;
  readonly registerRef: string;
  readonly note: string;
}

function pending<T>(value: T, registerRef: string, note: string): PendingValue<T> {
  return { value, configPending: true, registerRef, note };
}

// ---------------------------------------------------------------------------
// Targets (§2). Two distinct numbers, displayed separately everywhere -- the
// contractual threshold and the internal target are different commitments with
// different consequences, and collapsing them into one figure loses the one
// that has contractual force.
// ---------------------------------------------------------------------------

export const GRADUATION_TARGETS = {
  contractualThresholdPercent: 70,
  internalTargetPercent: 85,
} as const;

export const COHORT_SCALE = {
  students: 2948,
  groups: 131,
  staff: 85,
  freelancingGroups: 120,
  industryGroups: 3,
  entrepreneurshipGroups: 8,
  supportTrackGroups: 33,
  serviceAllocationStudents: 600,
} as const;

// ---------------------------------------------------------------------------
// Graduation (§27). CONFIRMED. Register item 1 is closed.
//
//   Route A: 3 gigs AND each gig >= $5 AND total >= $15
//   Route B: 1 gig >= $300
//
// There is no other route: two gigs totalling $200 do not qualify.
// ---------------------------------------------------------------------------

export const FREELANCING_GRADUATION_RULESET: GraduationRuleset = {
  configVersionId: 'depi-r5-graduation-v1',
  routeLogic: 'ANY',
  routes: [
    {
      key: 'route_a',
      label: { en: 'Route A — three gigs', ar: 'المسار أ — ثلاثة أعمال' },
      criteria: [
        {
          key: 'three_gigs_at_or_above_floor',
          type: 'per_gig_minimum_value',
          parameters: { minimum: 5, count: 3 },
          evidenceStandard: 'delivered_paid_evidenced_quality_accepted',
          explain: {
            en: '{shortfall} more Quality-accepted gig(s) worth at least $5 each',
            ar: '{shortfall} عمل موثق إضافي بقيمة 5 دولارات على الأقل لكل عمل',
          },
        },
        {
          key: 'total_at_or_above_fifteen',
          type: 'verified_revenue_total',
          parameters: { minimum: 15 },
          evidenceStandard: 'delivered_paid_evidenced_quality_accepted',
          explain: {
            en: '${shortfall} more in Quality-accepted earnings',
            ar: '{shortfall} دولار إضافية من الأرباح الموثقة',
          },
        },
      ],
    },
    {
      key: 'route_b',
      label: { en: 'Route B — one large gig', ar: 'المسار ب — عمل واحد كبير' },
      criteria: [
        {
          key: 'one_gig_at_or_above_three_hundred',
          type: 'per_gig_minimum_value',
          parameters: { minimum: 300, count: 1 },
          evidenceStandard: 'delivered_paid_evidenced_quality_accepted',
          explain: {
            en: 'a single Quality-accepted gig worth at least $300',
            ar: 'عمل واحد موثق بقيمة 300 دولار على الأقل',
          },
        },
      ],
    },
  ],
};

/** Accepted gig sources (§28). Extensible per round. */
export const ACCEPTED_GIG_SOURCES = [
  'freelance_yard',
  'khamsat',
  'mostaql',
  'upwork',
  'khafil',
  'nafezly',
  'direct_client',
] as const;
export type GigSource = (typeof ACCEPTED_GIG_SOURCES)[number];

/**
 * The amount shown in evidence counts toward the threshold; platform fees are
 * NOT deducted (§28). Register item 11 is closed.
 */
export const GIG_VALUE_POLICY = {
  deductPlatformFees: false,
  currency: 'USD',
} as const;

/** Entrepreneurship pathway (§39): seven components, all must meet the minimum. */
export const ENTREPRENEURSHIP_COMPONENTS = [
  'validated_problem_and_solution',
  'business_model_canvas',
  'marketing_and_sales_plan',
  'financial_plan',
  'team_and_roles',
  'pitch_delivered',
  'final_project_presentation',
] as const;
export type EntrepreneurshipComponent = (typeof ENTREPRENEURSHIP_COMPONENTS)[number];

// ---------------------------------------------------------------------------
// Contact and responsiveness (§14, §15). CONFIRMED. Register items 3 and 4.
// ---------------------------------------------------------------------------

export const CONTACT_POLICY = {
  /** Every student contacted at least once every 7 days (§14). */
  cadenceDays: 7,
  /** Five attempts, across different channels, over two weeks (§15). */
  unresponsiveAttempts: 5,
  unresponsivePeriodDays: 14,
  /**
   * Attempts must span channels: five WhatsApp messages are one channel's worth
   * of effort, not five attempts to reach a person.
   */
  requireDistinctChannels: true,
  minimumDistinctChannels: 2,
  /** Supervisor intervention window after escalation (§15). */
  supervisorInterventionHours: 48,
  /**
   * An unresponsive student REMAINS in the denominator unless the Ministry
   * withdraws them (§15). This is confirmed and is not configurable.
   */
  unresponsiveRemainsInDenominator: true,
} as const;

/** Required follow-up content (§12) -- marked PROPOSED, so configurable. */
export const FOLLOW_UP_CONTENT_FIELDS = pending(
  [
    'current_graduation_position',
    'blocking_factor_for_next_gig_or_service',
    'one_agreed_action',
    'action_deadline',
    'escalation_required',
  ],
  'register item 29',
  'The 1:1 follow-up standard is PROPOSED in the source; these fields are ' +
    'configurable rather than immutable business rules.',
);

// ---------------------------------------------------------------------------
// Sessions and attendance (§16, §20). Slots overlap, so a coach cannot deliver
// two groups on the same day.
// ---------------------------------------------------------------------------

export const SESSION_POLICY = {
  sessionsPerWeekPerGroup: 1,
  sessionsRegularTrack: 8,
  sessionsIndustryTrack: 5,
  sessionDurationHours: 3,
  /** Ministry slots, local time. They overlap by design. */
  slots: [
    { key: 'slot_17_20', startMinute: 17 * 60, endMinute: 20 * 60 },
    { key: 'slot_18_21', startMinute: 18 * 60, endMinute: 21 * 60 },
    { key: 'slot_19_22', startMinute: 19 * 60, endMinute: 22 * 60 },
  ],
  coachConfirmationLeadHours: 24,
  primaryCoaches: 43,
} as const;

/** Attendance operating standard is PROPOSED (§20), so thresholds configure. */
export const ATTENDANCE_POLICY = pending(
  {
    operatingStandardPercent: 75, // 6 of 8 sessions
    atRiskBelowPercent: 70,
    criticalBelowPercent: 50,
    /** Attendance is explicitly NOT a graduation criterion (§20). */
    affectsGraduation: false,
  },
  'register item 30',
  'The 75% (6/8) attendance operating standard is PROPOSED in the source.',
);

// ---------------------------------------------------------------------------
// Services (§25, §26). CONFIRMED.
// ---------------------------------------------------------------------------

export const SERVICE_POLICY = {
  servicesPerStudent: 3,
  fixedValueUsd: 5,
  /** Service follows the student's own skills; categories advise, not mandate. */
  categoriesAreMandatory: false,
  /** A rejected service is never closed by the rejection (§25). */
  rejectionClosesService: false,
  alertRejectionOpenDays: 7,
  alertBehindWaveWeeks: 2,
} as const;

// ---------------------------------------------------------------------------
// Evidence and Quality SLAs (§31, §37, §38). CONFIRMED.
// ---------------------------------------------------------------------------

export const EVIDENCE_SLA_HOURS = {
  coachReview: 24,
  coordinatorL1: 24,
  qualityL2: 48,
} as const;

export const QUALITY_QUEUE_THRESHOLDS = {
  /** Quality Lead review threshold (§37). */
  leadReviewQueueSize: 1000,
  /** Immediate PM escalation (§37). */
  pmEscalationQueueSize: 1400,
} as const;

export const QUALITY_SAMPLING = {
  freelancingEvidenceReviewPercent: 100,
  entrepreneurshipAuditPercent: 15,
  doubleReviewedItemsPerWeek: 20,
  reviewerAgreementTargetPercent: 90,
} as const;

/** Required evidence per gig source (§30). */
export const EVIDENCE_REQUIREMENTS = {
  platform: {
    allRequired: ['completed_order_page', 'earnings_or_balance_proof', 'delivered_work', 'profile_link'],
    anyOfRequired: [],
  },
  direct_client: {
    allRequired: ['delivered_work'],
    // Any ONE of these satisfies the payment/agreement requirement.
    anyOfRequired: ['contract', 'transfer_proof', 'agreement_conversation'],
  },
} as const;

/** A gig counts only if all four hold (§30). */
export const GIG_COUNTING_CONDITIONS = [
  'delivered',
  'paid',
  'evidenced',
  'quality_accepted',
] as const;

// ---------------------------------------------------------------------------
// Escalation SLAs (§46). CONFIRMED. Register item 9.
// ---------------------------------------------------------------------------

export const ESCALATION_ROUTING = [
  { issue: 'complaint_coach', owner: 'quality_lead', nextRoute: 'coach_operations', slaHours: 48 },
  { issue: 'complaint_operations', owner: 'quality_lead', nextRoute: 'project_operations', slaHours: 48 },
  { issue: 'evidence_dispute', owner: 'quality_lead', nextRoute: 'quality', slaHours: 48 },
  { issue: 'operational_blocker', owner: 'team_supervisor', nextRoute: 'project_operations', slaHours: 24 },
  { issue: 'coach_absence_or_performance', owner: 'coach_operations', nextRoute: 'project_manager', slaHours: 24 },
  { issue: 'systemic_or_serious', owner: 'quality_lead', nextRoute: 'project_manager', slaHours: 0 },
] as const;

// ---------------------------------------------------------------------------
// Risk (§21). Thresholds configurable; the source marks the operating standards
// behind them as proposed.
// ---------------------------------------------------------------------------

export const RISK_THRESHOLDS = pending(
  {
    atRiskAttendanceBelowPercent: 70,
    atRiskNoServiceStartedByExpectedPoint: true,
    criticalAttendanceBelowPercent: 50,
    criticalProgressBehindPercentagePoints: 30,
    criticalQualityRejectionCount: 2,
  },
  'register item 30',
  'Derived from the proposed attendance operating standard; configurable.',
);

// ---------------------------------------------------------------------------
// Staff performance thresholds (§52). Review and action bands per role.
// ---------------------------------------------------------------------------

export const PERFORMANCE_THRESHOLDS = {
  project_operations: { metric: 'groups_on_trajectory_percent', review: 80, action: 70, direction: 'below' },
  team_supervisor: { metric: 'groups_meeting_weekly_target_percent', review: 80, action: 70, direction: 'below' },
  coach_operations: { metric: 'session_delivery_percent', review: 98, action: 95, direction: 'below' },
  support_coach: { metric: 'service_rejection_rate_percent', review: 25, action: 35, direction: 'above' },
  quality_member: { metric: 'output_vs_weekly_target_percent', review: 95, action: 85, direction: 'below' },
} as const;

/**
 * Entitlement is TRACKED, never automatically applied (§53). The source requires
 * HR/legal review and signed contractual grounding before any deduction, so the
 * system records the accrual and stops there.
 */
export const ENTITLEMENT_POLICY = {
  trackAccrual: true,
  autoApplyDeductions: false,
} as const;

/** Red-line incidents bypass ordinary performance progression (§54). */
export const RED_LINE_INCIDENTS = [
  'falsifying_evidence',
  'assisting_non_original_submission',
  'collecting_student_payment',
  'student_data_misuse',
  'repeated_no_notice_absence',
  'concealing_group_failure',
  'knowingly_false_reporting',
  'inappropriate_conduct',
] as const;

// ---------------------------------------------------------------------------
// Denominator (§43). Ministry decides withdrawal; whether an approved withdrawal
// leaves the denominator is STILL OPEN, so it stays configurable with the
// conservative default.
// ---------------------------------------------------------------------------

export const DENOMINATOR_POLICY = pending(
  'include_all' as const,
  'register item 26',
  'Whether approved Ministry withdrawals leave the denominator is unresolved. ' +
    'include_all is conservative: it cannot flatter the rate.',
);

/** Working calendar (§ register item 19) -- still unset pending the holiday list. */
export const WORKING_CALENDAR: PendingValue<WorkingCalendar> = pending(
  {
    timeZone: 'Africa/Cairo',
    workingDays: [0, 1, 2, 3, 4],
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    holidays: new Set<string>(),
  },
  'register item 19',
  'The public holiday list has not been supplied; SLA arithmetic is otherwise correct.',
);
