import { describe, expect, it } from 'vitest';
import {
  evaluateGraduation,
  type GraduationFacts,
  type GraduationRuleset,
  type VerifiedGig,
} from '../src/graduation.ts';

const gig = (id: string, amount: number, paid = true): VerifiedGig => ({
  gigId: id,
  amountBase: amount,
  hasPaymentEvidence: paid,
});

const noFacts: GraduationFacts = {
  verifiedGigs: [],
  achievedMilestoneKeys: [],
  completedCoachingSessions: 0,
  presentEvidenceKeys: [],
  cohortTimeRemainingFraction: 0.5,
};

/**
 * Illustrative ruleset ONLY. The real thresholds are CONFIG-PENDING (register
 * item 1); these numbers exist to exercise the engine and appear nowhere in
 * src/.
 */
const ruleset: GraduationRuleset = {
  configVersionId: 'grad-cfg-1',
  routeLogic: 'ANY',
  routes: [
    {
      key: 'route_a',
      label: { en: 'Route A', ar: 'المسار أ' },
      criteria: [
        {
          key: 'three_paid_gigs',
          type: 'verified_gig_count',
          parameters: { minimum: 3, requiresPaymentEvidence: 1 },
          explain: {
            en: '{shortfall} more verified gig(s) with payment evidence',
            ar: '{shortfall} عمل موثق إضافي مع إثبات الدفع',
          },
        },
      ],
    },
    {
      key: 'route_b',
      label: { en: 'Route B', ar: 'المسار ب' },
      criteria: [
        {
          key: 'two_gigs',
          type: 'verified_gig_count',
          parameters: { minimum: 2 },
          explain: { en: '{shortfall} more verified gig(s)', ar: '{shortfall} عمل موثق إضافي' },
        },
        {
          key: 'revenue',
          type: 'verified_revenue_total',
          parameters: { minimum: 1000 },
          explain: {
            en: '{shortfall} more in verified revenue',
            ar: '{shortfall} إضافية من الإيرادات الموثقة',
          },
        },
      ],
    },
  ],
};

describe('unconfigured criteria are reported, never guessed (register item 1)', () => {
  it('returns not_configured for an empty ruleset', () => {
    const e = evaluateGraduation(noFacts, { ...ruleset, routes: [] });
    expect(e.status).toBe('not_configured');
    expect(e.gapExplanation.en).toContain('not been configured');
    expect(e.gapExplanation.ar).toBeTruthy();
  });
});

describe('route evaluation', () => {
  it('is not eligible with zero criteria met', () => {
    const e = evaluateGraduation(noFacts, ruleset);
    expect(e.status).toBe('not_eligible');
    expect(e.matchedRouteKey).toBeNull();
  });

  it('is potentially eligible with partial progress and time remaining', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 600), gig('g2', 200)] },
      ruleset,
    );
    // Route B: 2-gig criterion met, revenue not.
    expect(e.status).toBe('potentially_eligible');
    expect(e.bestRouteKey).toBe('route_b');
  });

  it('is progressing when the cohort has run out of time', () => {
    const e = evaluateGraduation(
      {
        ...noFacts,
        verifiedGigs: [gig('g1', 600), gig('g2', 200)],
        cohortTimeRemainingFraction: 0,
      },
      ruleset,
    );
    expect(e.status).toBe('progressing');
  });

  it('meets eligibility via route A', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10), gig('g3', 10)] },
      ruleset,
    );
    expect(e.status).toBe('eligibility_met');
    expect(e.matchedRouteKey).toBe('route_a');
  });

  it('meets eligibility via route B while route A is unmet', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 800), gig('g2', 400)] },
      ruleset,
    );
    expect(e.status).toBe('eligibility_met');
    expect(e.matchedRouteKey).toBe('route_b');
  });

  it('excludes gigs lacking payment evidence where the criterion demands it', () => {
    const e = evaluateGraduation(
      {
        ...noFacts,
        verifiedGigs: [gig('g1', 10), gig('g2', 10), gig('g3', 10, false)],
      },
      ruleset,
    );
    const routeA = e.routes.find((r) => r.routeKey === 'route_a')!;
    expect(routeA.met).toBe(false);
    expect(routeA.criteria[0]!.actual).toBe(2);
  });

  it('regresses when a supporting gig is unlocked', () => {
    const eligible = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10), gig('g3', 10)] },
      ruleset,
    );
    expect(eligible.status).toBe('eligibility_met');

    const afterUnlock = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10)] },
      ruleset,
    );
    expect(afterUnlock.status).not.toBe('eligibility_met');
    expect(afterUnlock.matchedRouteKey).toBeNull();
  });
});

describe('the plain-language gap is a first-class output (AC-11)', () => {
  it('names the shortfall and the missing artefact in English', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10)] },
      { ...ruleset, routes: [ruleset.routes[0]!] },
    );
    expect(e.gapExplanation.en).toBe(
      'Route A: 0 of 1 required criteria met. Missing: 1 more verified gig(s) with payment evidence',
    );
  });

  it('produces the same explanation in Arabic', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10)] },
      { ...ruleset, routes: [ruleset.routes[0]!] },
    );
    expect(e.gapExplanation.ar).toContain('المسار أ');
    expect(e.gapExplanation.ar).toContain('عمل موثق إضافي');
  });

  it('highlights the closest route so the coordinator can see the better path', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 900), gig('g2', 50)] },
      ruleset,
    );
    // Both routes need exactly one more thing, but route B has progress on the
    // board, so it is the one the coordinator should be pointed at.
    expect(e.bestRouteKey).toBe('route_b');
    expect(e.gapExplanation.en).toContain('Route B');
  });

  it('states plainly when all criteria are met', () => {
    const e = evaluateGraduation(
      { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10), gig('g3', 10)] },
      ruleset,
    );
    expect(e.gapExplanation.en).toContain('All criteria');
  });

  it('reports every criterion with required, actual and evidence refs', () => {
    const e = evaluateGraduation({ ...noFacts, verifiedGigs: [gig('g1', 400)] }, ruleset);
    const revenue = e.routes
      .find((r) => r.routeKey === 'route_b')!
      .criteria.find((c) => c.criterionKey === 'revenue')!;
    expect(revenue.required).toBe(1000);
    expect(revenue.actual).toBe(400);
    expect(revenue.met).toBe(false);
    expect(revenue.evidenceRefs).toEqual(['g1']);
  });
});

describe('other criterion types', () => {
  const varied: GraduationRuleset = {
    configVersionId: 'grad-cfg-2',
    routeLogic: 'ANY',
    routes: [
      {
        key: 'mixed',
        label: { en: 'Mixed', ar: 'مختلط' },
        criteria: [
          {
            key: 'portfolio',
            type: 'milestone_achieved',
            parameters: { milestoneKey: 'portfolio_complete' },
            explain: { en: 'portfolio milestone', ar: 'معلم الملف' },
          },
          {
            key: 'sessions',
            type: 'coaching_sessions_completed',
            parameters: { minimum: 4 },
            explain: { en: '{shortfall} more coaching session(s)', ar: '{shortfall} جلسة' },
          },
          {
            key: 'high_value',
            type: 'per_gig_minimum_value',
            parameters: { minimum: 500, count: 1 },
            explain: { en: 'a gig worth at least 500', ar: 'عمل بقيمة 500' },
          },
          {
            key: 'id_doc',
            type: 'evidence_present',
            parameters: { evidenceKey: 'identity' },
            explain: { en: 'identity evidence', ar: 'إثبات الهوية' },
          },
        ],
      },
    ],
  };

  it('evaluates milestone, session count, per-gig floor and evidence together', () => {
    const e = evaluateGraduation(
      {
        verifiedGigs: [gig('g1', 500)],
        achievedMilestoneKeys: ['portfolio_complete'],
        completedCoachingSessions: 4,
        presentEvidenceKeys: ['identity'],
        cohortTimeRemainingFraction: 0.4,
      },
      varied,
    );
    expect(e.status).toBe('eligibility_met');
  });

  it('fails the per-gig floor when no single gig clears it', () => {
    const e = evaluateGraduation(
      {
        verifiedGigs: [gig('g1', 300), gig('g2', 300)],
        achievedMilestoneKeys: ['portfolio_complete'],
        completedCoachingSessions: 4,
        presentEvidenceKeys: ['identity'],
        cohortTimeRemainingFraction: 0.4,
      },
      varied,
    );
    expect(e.status).not.toBe('eligibility_met');
    expect(e.gapExplanation.en).toContain('at least 500');
  });
});

describe('re-derivability', () => {
  it('records the config version used (AC-09)', () => {
    expect(evaluateGraduation(noFacts, ruleset).configVersionId).toBe('grad-cfg-1');
  });

  it('reproduces a historical result under the historical ruleset', () => {
    const facts = { ...noFacts, verifiedGigs: [gig('g1', 10), gig('g2', 10)] };
    const old = evaluateGraduation(facts, { ...ruleset, routes: [ruleset.routes[1]!] });
    const stricter: GraduationRuleset = {
      ...ruleset,
      configVersionId: 'grad-cfg-2',
      routes: [
        {
          ...ruleset.routes[1]!,
          criteria: [
            { ...ruleset.routes[1]!.criteria[0]!, parameters: { minimum: 5 } },
            ruleset.routes[1]!.criteria[1]!,
          ],
        },
      ],
    };
    // The new ruleset is stricter, but evaluating under the OLD one must still
    // give the old answer -- configuration never rewrites history.
    expect(evaluateGraduation(facts, { ...ruleset, routes: [ruleset.routes[1]!] })).toEqual(old);
    expect(evaluateGraduation(facts, stricter).routes[0]!.criteria[0]!.met).toBe(false);
  });

  it('is pure', () => {
    const facts = { ...noFacts, verifiedGigs: [gig('g1', 700)] };
    expect(evaluateGraduation(facts, ruleset)).toEqual(evaluateGraduation(facts, ruleset));
  });
});
