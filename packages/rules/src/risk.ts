/**
 * The risk engine (docs/06 §3).
 *
 * Rule-based only. No AI, no scoring model, no learned weights (Prohibition 7).
 * Every level change records WHICH rule fired, under WHICH config version, on
 * WHICH evidence -- so "why is this student Red?" is answered by data rather
 * than by reading code.
 *
 * Thresholds are CONFIG-PENDING (register items 4, 5, 6) and arrive in the
 * ruleset. This file knows the shape of a rule, never its numbers.
 */

export type RiskLevel = 'green' | 'amber' | 'red';

export const RISK_REASONS = [
  'unresponsive',
  'missed_coaching',
  'behind_milestone',
  'no_freelance_activity',
  'no_gig_progress',
  'gig_verification_failure',
  'documentation_issue',
  'motivation_issue',
  'quality_concern',
  'other',
] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

/** The typed fact object every rule is evaluated against. */
export interface RiskFacts {
  readonly workingDaysSinceContact: number | null;
  readonly failedContactAttempts: number;
  readonly missedCoachingSessions: number;
  readonly milestonesOverdue: number;
  readonly workingDaysSinceFreelanceActivity: number | null;
  readonly pastGigMilestoneWithoutSubmission: boolean;
  readonly rejectedGigCount: number;
  readonly overdueEvidenceTasks: number;
}

export type Comparator = 'gte' | 'gt' | 'eq' | 'is_true';

export interface RiskRule {
  readonly key: string;
  readonly fact: keyof RiskFacts;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly resultingLevel: Exclude<RiskLevel, 'green'>;
  readonly reason: RiskReason;
  readonly enabled: boolean;
  /** Human sentence shown beside the risk, per locale. */
  readonly explain: Readonly<Record<string, string>>;
}

export interface RiskRuleset {
  readonly configVersionId: string;
  readonly rules: readonly RiskRule[];
  /**
   * How many concurrent amber reasons escalate to red. Undefined disables the
   * multi-signal rule entirely -- a cohort may not want it.
   */
  readonly multiSignalAmberToRed?: number;
}

export interface FiredRule {
  readonly ruleKey: string;
  readonly reason: RiskReason;
  readonly level: Exclude<RiskLevel, 'green'>;
  readonly evidence: Readonly<Record<string, number | boolean | null>>;
  readonly explain: Readonly<Record<string, string>>;
}

export interface RiskEvaluation {
  readonly level: RiskLevel;
  readonly reasons: readonly RiskReason[];
  readonly firedRules: readonly FiredRule[];
  readonly configVersionId: string;
  /** True when the multi-signal rule, not a single rule, produced red. */
  readonly escalatedByMultiSignal: boolean;
}

function compare(value: unknown, comparator: Comparator, threshold: number): boolean {
  if (comparator === 'is_true') return value === true;
  if (value === null || value === undefined || typeof value !== 'number') return false;
  switch (comparator) {
    case 'gte':
      return value >= threshold;
    case 'gt':
      return value > threshold;
    case 'eq':
      return value === threshold;
  }
}

export function evaluateRisk(facts: RiskFacts, ruleset: RiskRuleset): RiskEvaluation {
  const fired: FiredRule[] = [];

  for (const rule of ruleset.rules) {
    if (!rule.enabled) continue;
    const value = facts[rule.fact];
    if (!compare(value, rule.comparator, rule.threshold)) continue;
    fired.push({
      ruleKey: rule.key,
      reason: rule.reason,
      level: rule.resultingLevel,
      evidence: { [rule.fact]: (value ?? null) as number | boolean | null, threshold: rule.threshold },
      explain: rule.explain,
    });
  }

  if (fired.length === 0) {
    return {
      level: 'green',
      reasons: [],
      firedRules: [],
      configVersionId: ruleset.configVersionId,
      escalatedByMultiSignal: false,
    };
  }

  // Highest level among firing rules wins; ALL firing reasons attach to the one
  // open risk record (Invariant 6: one record, many reasons).
  let level: RiskLevel = fired.some((f) => f.level === 'red') ? 'red' : 'amber';

  const amberReasons = new Set(fired.filter((f) => f.level === 'amber').map((f) => f.reason));
  let escalatedByMultiSignal = false;
  if (
    level === 'amber' &&
    ruleset.multiSignalAmberToRed !== undefined &&
    amberReasons.size >= ruleset.multiSignalAmberToRed
  ) {
    level = 'red';
    escalatedByMultiSignal = true;
  }

  // Distinct reasons, in the ruleset's configured rule order -- stable output
  // matters because it is rendered to staff and compared between evaluations.
  const reasons: RiskReason[] = [];
  for (const f of fired) if (!reasons.includes(f.reason)) reasons.push(f.reason);

  return {
    level,
    reasons,
    firedRules: fired,
    configVersionId: ruleset.configVersionId,
    escalatedByMultiSignal,
  };
}

export interface ManualOverride {
  readonly level: RiskLevel;
  readonly reason: string;
  readonly reviewDueAt: Date;
  readonly overriddenBy: string;
}

/**
 * A manual override holds until its review date: automated evaluation may not
 * silently undo a human judgement, but neither may it persist unexamined.
 * Returns the level actually in force plus whether automation was suppressed.
 */
export function applyOverride(
  automated: RiskEvaluation,
  override: ManualOverride | null,
  now: Date,
): { level: RiskLevel; origin: 'rule' | 'manual'; suppressedAutomated: boolean } {
  if (override && now < override.reviewDueAt) {
    return {
      level: override.level,
      origin: 'manual',
      suppressedAutomated: override.level !== automated.level,
    };
  }
  return { level: automated.level, origin: 'rule', suppressedAutomated: false };
}
