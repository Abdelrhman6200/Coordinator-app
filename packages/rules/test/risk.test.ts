import { describe, expect, it } from 'vitest';
import {
  applyOverride,
  evaluateRisk,
  type RiskFacts,
  type RiskRule,
  type RiskRuleset,
} from '../src/risk.ts';

const noSignals: RiskFacts = {
  workingDaysSinceContact: 0,
  failedContactAttempts: 0,
  missedCoachingSessions: 0,
  milestonesOverdue: 0,
  workingDaysSinceFreelanceActivity: 0,
  pastGigMilestoneWithoutSubmission: false,
  rejectedGigCount: 0,
  overdueEvidenceTasks: 0,
};

function rule(p: Partial<RiskRule> & Pick<RiskRule, 'key' | 'fact' | 'resultingLevel' | 'reason'>): RiskRule {
  return {
    comparator: 'gte',
    threshold: 1,
    enabled: true,
    explain: { en: `${p.key} fired`, ar: `${p.key}` },
    ...p,
  } as RiskRule;
}

// Seeded rules from docs/06 §3. Thresholds are CONFIG-PENDING placeholders.
const ruleset: RiskRuleset = {
  configVersionId: 'risk-cfg-1',
  multiSignalAmberToRed: 2,
  rules: [
    rule({ key: 'no_contact_days', fact: 'workingDaysSinceContact', threshold: 5, resultingLevel: 'amber', reason: 'unresponsive' }),
    rule({ key: 'repeated_failed_contact', fact: 'failedContactAttempts', threshold: 3, resultingLevel: 'red', reason: 'unresponsive' }),
    rule({ key: 'missed_coaching', fact: 'missedCoachingSessions', threshold: 2, resultingLevel: 'amber', reason: 'missed_coaching' }),
    rule({ key: 'behind_milestone', fact: 'milestonesOverdue', threshold: 1, resultingLevel: 'amber', reason: 'behind_milestone' }),
    rule({ key: 'no_freelance_activity', fact: 'workingDaysSinceFreelanceActivity', threshold: 10, resultingLevel: 'amber', reason: 'no_freelance_activity' }),
    rule({ key: 'no_gig_by_milestone', fact: 'pastGigMilestoneWithoutSubmission', comparator: 'is_true', threshold: 0, resultingLevel: 'red', reason: 'no_gig_progress' }),
    rule({ key: 'gig_verification_failure', fact: 'rejectedGigCount', threshold: 2, resultingLevel: 'amber', reason: 'gig_verification_failure' }),
    rule({ key: 'documentation_gap', fact: 'overdueEvidenceTasks', threshold: 1, resultingLevel: 'amber', reason: 'documentation_issue' }),
  ],
};

describe('green when nothing fires', () => {
  it('reports green with no reasons', () => {
    const e = evaluateRisk(noSignals, ruleset);
    expect(e.level).toBe('green');
    expect(e.reasons).toEqual([]);
    expect(e.firedRules).toEqual([]);
  });
});

describe('each seeded rule fires at its boundary and not below it', () => {
  const cases: Array<[string, Partial<RiskFacts>, Partial<RiskFacts>, string]> = [
    ['no_contact_days', { workingDaysSinceContact: 5 }, { workingDaysSinceContact: 4 }, 'amber'],
    ['repeated_failed_contact', { failedContactAttempts: 3 }, { failedContactAttempts: 2 }, 'red'],
    ['missed_coaching', { missedCoachingSessions: 2 }, { missedCoachingSessions: 1 }, 'amber'],
    ['behind_milestone', { milestonesOverdue: 1 }, { milestonesOverdue: 0 }, 'amber'],
    ['no_freelance_activity', { workingDaysSinceFreelanceActivity: 10 }, { workingDaysSinceFreelanceActivity: 9 }, 'amber'],
    ['no_gig_by_milestone', { pastGigMilestoneWithoutSubmission: true }, { pastGigMilestoneWithoutSubmission: false }, 'red'],
    ['gig_verification_failure', { rejectedGigCount: 2 }, { rejectedGigCount: 1 }, 'amber'],
    ['documentation_gap', { overdueEvidenceTasks: 1 }, { overdueEvidenceTasks: 0 }, 'amber'],
  ];

  it.each(cases)('%s', (key, atThreshold, below, expectedLevel) => {
    const fired = evaluateRisk({ ...noSignals, ...atThreshold }, ruleset);
    expect(fired.firedRules.map((f) => f.ruleKey)).toContain(key);
    expect(fired.level).toBe(expectedLevel);

    const notFired = evaluateRisk({ ...noSignals, ...below }, ruleset);
    expect(notFired.firedRules.map((f) => f.ruleKey)).not.toContain(key);
  });
});

describe('level resolution', () => {
  it('lets red win over a concurrent amber', () => {
    const e = evaluateRisk(
      { ...noSignals, missedCoachingSessions: 2, failedContactAttempts: 3 },
      ruleset,
    );
    expect(e.level).toBe('red');
    expect(e.reasons).toContain('missed_coaching');
    expect(e.reasons).toContain('unresponsive');
  });

  it('escalates two distinct amber reasons to red', () => {
    const e = evaluateRisk(
      { ...noSignals, missedCoachingSessions: 2, milestonesOverdue: 1 },
      ruleset,
    );
    expect(e.level).toBe('red');
    expect(e.escalatedByMultiSignal).toBe(true);
  });

  it('does not escalate two rules that share one reason', () => {
    // Both map to `unresponsive`; that is one signal seen twice, not two signals.
    const oneReasonTwice: RiskRuleset = {
      ...ruleset,
      rules: [
        rule({ key: 'a', fact: 'workingDaysSinceContact', threshold: 5, resultingLevel: 'amber', reason: 'unresponsive' }),
        rule({ key: 'b', fact: 'overdueEvidenceTasks', threshold: 1, resultingLevel: 'amber', reason: 'unresponsive' }),
      ],
    };
    const e = evaluateRisk(
      { ...noSignals, workingDaysSinceContact: 5, overdueEvidenceTasks: 1 },
      oneReasonTwice,
    );
    expect(e.level).toBe('amber');
    expect(e.escalatedByMultiSignal).toBe(false);
  });

  it('leaves multi-signal escalation off when the cohort has not configured it', () => {
    const { multiSignalAmberToRed: _omit, ...withoutMultiSignal } = ruleset;
    const e = evaluateRisk(
      { ...noSignals, missedCoachingSessions: 2, milestonesOverdue: 1 },
      withoutMultiSignal as RiskRuleset,
    );
    expect(e.level).toBe('amber');
  });

  it('attaches every firing reason to the single record (Invariant 6)', () => {
    const e = evaluateRisk(
      { ...noSignals, missedCoachingSessions: 2, milestonesOverdue: 1, overdueEvidenceTasks: 1 },
      ruleset,
    );
    expect(new Set(e.reasons)).toEqual(
      new Set(['missed_coaching', 'behind_milestone', 'documentation_issue']),
    );
  });
});

describe('transparency: every change is explainable', () => {
  it('records the rule key, config version and the evidence that fired it', () => {
    const e = evaluateRisk({ ...noSignals, missedCoachingSessions: 4 }, ruleset);
    expect(e.configVersionId).toBe('risk-cfg-1');
    const fired = e.firedRules.find((f) => f.ruleKey === 'missed_coaching');
    expect(fired?.evidence).toEqual({ missedCoachingSessions: 4, threshold: 2 });
    expect(fired?.explain.en).toBeTruthy();
    expect(fired?.explain.ar).toBeTruthy();
  });

  it('ignores a disabled rule without removing it from configuration', () => {
    const disabled: RiskRuleset = {
      ...ruleset,
      rules: ruleset.rules.map((r) =>
        r.key === 'missed_coaching' ? { ...r, enabled: false } : r,
      ),
    };
    expect(evaluateRisk({ ...noSignals, missedCoachingSessions: 9 }, disabled).level).toBe('green');
  });

  it('treats a null fact as not firing rather than as zero', () => {
    // A student with no freelance activity recorded yet is not the same as one
    // whose last activity was zero days ago.
    expect(
      evaluateRisk({ ...noSignals, workingDaysSinceFreelanceActivity: null }, ruleset).level,
    ).toBe('green');
  });

  it('is pure: identical facts give identical output', () => {
    const facts = { ...noSignals, milestonesOverdue: 2 };
    expect(evaluateRisk(facts, ruleset)).toEqual(evaluateRisk(facts, ruleset));
  });
});

describe('manual override', () => {
  const now = new Date('2026-03-01T10:00:00Z');
  const review = new Date('2026-03-15T10:00:00Z');

  it('suppresses an automated downgrade until the review date', () => {
    const automated = evaluateRisk(noSignals, ruleset); // green
    const r = applyOverride(
      automated,
      { level: 'red', reason: 'coach judgement', reviewDueAt: review, overriddenBy: 'u1' },
      now,
    );
    expect(r.level).toBe('red');
    expect(r.origin).toBe('manual');
    expect(r.suppressedAutomated).toBe(true);
  });

  it('yields back to automation once the review date passes', () => {
    const automated = evaluateRisk(noSignals, ruleset);
    const r = applyOverride(
      automated,
      { level: 'red', reason: 'coach judgement', reviewDueAt: review, overriddenBy: 'u1' },
      new Date('2026-03-16T10:00:00Z'),
    );
    expect(r.level).toBe('green');
    expect(r.origin).toBe('rule');
  });

  it('reports no suppression when the override agrees with automation', () => {
    const automated = evaluateRisk({ ...noSignals, failedContactAttempts: 3 }, ruleset);
    const r = applyOverride(
      automated,
      { level: 'red', reason: 'agrees', reviewDueAt: review, overriddenBy: 'u1' },
      now,
    );
    expect(r.suppressedAutomated).toBe(false);
  });
});
