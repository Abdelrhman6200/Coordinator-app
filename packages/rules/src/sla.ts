/**
 * The follow-up / SLA engine (docs/06 §1).
 *
 * Answers: when must this student next be contacted, and are we late?
 *
 * Every threshold here is CONFIG-PENDING (register item 3) and arrives as a
 * config object. Nothing is hard-coded, and the `configVersionId` used is
 * returned with the decision so a past evaluation can be re-derived exactly.
 */
import {
  addWorkingMinutes,
  workingDaysBetween,
  workingDaysToMinutes,
  workingMinutesBetween,
  type WorkingCalendar,
} from './working-calendar.ts';

export type SlaState = 'compliant' | 'approaching' | 'breached';

export interface SlaRule {
  /** Working days between contacts for this (stage, risk, track) combination. */
  readonly contactIntervalWorkingDays: number;
  /** How long before due the state flips to `approaching`, in working days. */
  readonly approachingWorkingDays: number;
  /** Working days from assignment within which first contact must happen. */
  readonly firstContactWorkingDays: number;
}

export interface SlaRuleset {
  readonly configVersionId: string;
  /** Keyed `${stage}|${risk}|${track}`; lookup falls back progressively. */
  readonly rules: ReadonlyMap<string, SlaRule>;
  readonly fallback: SlaRule;
}

export interface SlaFacts {
  readonly stage: string;
  readonly riskLevel: string;
  readonly track: string | null;
  /** Null when the student has never been contacted. */
  readonly lastContactAt: Date | null;
  /** When the current coordinator assignment opened. */
  readonly assignedAt: Date | null;
  readonly now: Date;
}

export interface SlaEvaluation {
  readonly state: SlaState;
  readonly nextContactDueAt: Date | null;
  readonly workingDaysSinceContact: number | null;
  readonly ruleApplied: SlaRule;
  readonly configVersionId: string;
  /** Why this state, in words the UI can show without further lookup. */
  readonly explanation: string;
}

/**
 * Progressive fallback: the most specific rule wins, then stage+risk, then
 * stage, then the ruleset default. This is what lets a cohort configure "Red
 * students on the coaching track" without enumerating every combination.
 */
export function resolveSlaRule(ruleset: SlaRuleset, facts: SlaFacts): SlaRule {
  const candidates = [
    `${facts.stage}|${facts.riskLevel}|${facts.track ?? ''}`,
    `${facts.stage}|${facts.riskLevel}|`,
    `${facts.stage}||`,
  ];
  for (const key of candidates) {
    const found = ruleset.rules.get(key);
    if (found) return found;
  }
  return ruleset.fallback;
}

export function evaluateSla(
  facts: SlaFacts,
  ruleset: SlaRuleset,
  calendar: WorkingCalendar,
): SlaEvaluation {
  const rule = resolveSlaRule(ruleset, facts);

  // Never contacted: the clock runs from assignment against the first-contact
  // deadline. An unassigned, uncontacted student has no SLA -- it has an
  // ownership exception instead, which the control tower raises (docs/08 §6).
  if (facts.lastContactAt === null) {
    if (facts.assignedAt === null) {
      return {
        state: 'compliant',
        nextContactDueAt: null,
        workingDaysSinceContact: null,
        ruleApplied: rule,
        configVersionId: ruleset.configVersionId,
        explanation:
          'No contact SLA applies: the student has no coordinator assigned. This is ' +
          'an ownership exception, not an SLA breach.',
      };
    }
    const dueAt = addWorkingMinutes(
      facts.assignedAt,
      workingDaysToMinutes(rule.firstContactWorkingDays, calendar),
      calendar,
    );
    return finish(
      dueAt,
      null,
      rule,
      ruleset,
      calendar,
      facts.now,
      `First contact is due within ${rule.firstContactWorkingDays} working day(s) of assignment.`,
    );
  }

  const dueAt = addWorkingMinutes(
    facts.lastContactAt,
    workingDaysToMinutes(rule.contactIntervalWorkingDays, calendar),
    calendar,
  );
  const since = workingDaysBetween(facts.lastContactAt, facts.now, calendar);
  return finish(
    dueAt,
    since,
    rule,
    ruleset,
    calendar,
    facts.now,
    `Contact is required every ${rule.contactIntervalWorkingDays} working day(s) at this ` +
      `stage and risk level.`,
  );
}

function finish(
  dueAt: Date,
  since: number | null,
  rule: SlaRule,
  ruleset: SlaRuleset,
  calendar: WorkingCalendar,
  now: Date,
  basis: string,
): SlaEvaluation {
  let state: SlaState;
  let detail: string;

  if (now > dueAt) {
    state = 'breached';
    const overdueDays =
      workingMinutesBetween(dueAt, now, calendar) /
      (calendar.endMinute - calendar.startMinute);
    detail = `Overdue by ${overdueDays.toFixed(1)} working day(s).`;
  } else {
    const remainingWorkingDays = workingDaysBetween(now, dueAt, calendar);
    if (remainingWorkingDays <= rule.approachingWorkingDays) {
      state = 'approaching';
      detail = `Due in ${remainingWorkingDays.toFixed(1)} working day(s).`;
    } else {
      state = 'compliant';
      detail = `Due in ${remainingWorkingDays.toFixed(1)} working day(s).`;
    }
  }

  return {
    state,
    nextContactDueAt: dueAt,
    workingDaysSinceContact: since,
    ruleApplied: rule,
    configVersionId: ruleset.configVersionId,
    explanation: `${basis} ${detail}`,
  };
}
