/**
 * The confirmed DEPI Round 5 graduation rule (§27), locked by test.
 *
 *   Route A: 3 gigs AND each >= $5 AND total >= $15
 *   Route B: 1 gig >= $300
 *   There is no other route.
 *
 * These tests exist so the rule cannot drift silently. If a future round changes
 * it, the change belongs in a new config version -- and these tests, which name
 * Round 5 explicitly, should keep passing against the Round 5 ruleset.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateGraduation,
  FREELANCING_GRADUATION_RULESET as R5,
  GRADUATION_TARGETS,
  type GraduationFacts,
  type VerifiedGig,
} from '../src/index.ts';

/** Only Quality-accepted gigs reach this engine (§30, §40). */
const gig = (id: string, amount: number): VerifiedGig => ({
  gigId: id,
  amountBase: amount,
  hasPaymentEvidence: true,
});

function facts(gigs: VerifiedGig[], timeRemaining = 0.5): GraduationFacts {
  return {
    verifiedGigs: gigs,
    achievedMilestoneKeys: [],
    completedCoachingSessions: 0,
    presentEvidenceKeys: [],
    cohortTimeRemainingFraction: timeRemaining,
  };
}

describe('Route A — three gigs, each at least $5, total at least $15', () => {
  it('qualifies on exactly three gigs at exactly the floor', () => {
    const e = evaluateGraduation(facts([gig('g1', 5), gig('g2', 5), gig('g3', 5)]), R5);
    expect(e.status).toBe('eligibility_met');
    expect(e.matchedRouteKey).toBe('route_a');
  });

  it('does not qualify on two gigs, however many dollars they carry', () => {
    // The requirement names this case: two gigs totalling $200 do not qualify.
    const e = evaluateGraduation(facts([gig('g1', 100), gig('g2', 100)]), R5);
    expect(e.status).not.toBe('eligibility_met');
    expect(e.matchedRouteKey).toBeNull();
  });

  it('does not count a gig below the $5 floor toward the three', () => {
    const e = evaluateGraduation(facts([gig('g1', 5), gig('g2', 5), gig('g3', 4.99)]), R5);
    expect(e.status).not.toBe('eligibility_met');
  });

  it('qualifies on four gigs when three clear the floor', () => {
    const e = evaluateGraduation(
      facts([gig('g1', 5), gig('g2', 6), gig('g3', 7), gig('g4', 1)]),
      R5,
    );
    expect(e.status).toBe('eligibility_met');
  });

  it('states the shortfall plainly at two of three gigs', () => {
    const e = evaluateGraduation(facts([gig('g1', 10), gig('g2', 10)]), R5);
    expect(e.gapExplanation.en).toContain('1 more Quality-accepted gig(s) worth at least $5');
    expect(e.gapExplanation.en).toContain('2 of 3 so far');
    expect(e.gapExplanation.ar).toContain('عمل موثق إضافي');
  });

  it('tells a student with NO gigs they need three, not one', () => {
    // The shortfall has to be arithmetic on the real numbers. Describing the
    // requirement as prose made it incalculable and the gap silently reported
    // "1 more" to every student, however far behind they were.
    const e = evaluateGraduation(facts([]), R5);
    expect(e.gapExplanation.en).toContain('3 more Quality-accepted gig(s)');
    expect(e.gapExplanation.en).toContain('0 of 3 so far');
  });

  it('counts down correctly as gigs are accepted', () => {
    const one = evaluateGraduation(facts([gig('g1', 10)]), R5);
    expect(one.gapExplanation.en).toContain('2 more Quality-accepted gig(s)');
    const two = evaluateGraduation(facts([gig('g1', 10), gig('g2', 10)]), R5);
    expect(two.gapExplanation.en).toContain('1 more Quality-accepted gig(s)');
  });
});

describe('Route B — one gig of at least $300', () => {
  it('qualifies on a single gig at exactly $300', () => {
    const e = evaluateGraduation(facts([gig('g1', 300)]), R5);
    expect(e.status).toBe('eligibility_met');
    expect(e.matchedRouteKey).toBe('route_b');
  });

  it('does not qualify at $299.99', () => {
    expect(evaluateGraduation(facts([gig('g1', 299.99)]), R5).status).not.toBe('eligibility_met');
  });

  it('qualifies a single large gig that Route A would reject', () => {
    // One gig is not three, so Route A fails; Route B is the whole point.
    const e = evaluateGraduation(facts([gig('g1', 500)]), R5);
    expect(e.matchedRouteKey).toBe('route_b');
    expect(e.routes.find((r) => r.routeKey === 'route_a')!.met).toBe(false);
  });
});

describe('there is no third route', () => {
  it('does not qualify one gig of $250 plus one of $60', () => {
    expect(evaluateGraduation(facts([gig('g1', 250), gig('g2', 60)]), R5).status).not.toBe(
      'eligibility_met',
    );
  });

  it('does not qualify on no gigs at all', () => {
    const e = evaluateGraduation(facts([]), R5);
    expect(e.status).toBe('not_eligible');
  });

  it('exposes exactly two routes', () => {
    expect(R5.routes.map((r) => r.key)).toEqual(['route_a', 'route_b']);
    expect(R5.routeLogic).toBe('ANY');
  });
});

describe('the route a student is pointed at', () => {
  it('points a student with no gigs at Route A, not the $300 exception', () => {
    // Counting outstanding criteria alone would pick Route B, because it has
    // one condition rather than two. Telling a student with nothing yet that
    // they need a single $300 gig is the wrong advice: three $5 gigs is the
    // path the programme actually coaches.
    const e = evaluateGraduation(facts([]), R5);
    expect(e.bestRouteKey).toBe('route_a');
    expect(e.gapExplanation.en).toContain('Route A');
    expect(e.gapExplanation.en).toContain('at least $5');
    expect(e.gapExplanation.en).not.toContain('$300');
  });

  it('points a student with two small gigs at Route A', () => {
    const e = evaluateGraduation(facts([gig('g1', 10), gig('g2', 10)]), R5);
    expect(e.bestRouteKey).toBe('route_a');
  });

  it('points a student holding a large gig at Route B', () => {
    // Real progress on Route B outweighs Route A's box count.
    const e = evaluateGraduation(facts([gig('g1', 250)]), R5);
    expect(e.routes.find((r) => r.routeKey === 'route_b')!.metCount).toBe(0);
    // Route A has one criterion met (revenue >= 15), so it is the closer path.
    expect(e.bestRouteKey).toBe('route_a');
  });

  it('still reports every route so a coordinator can see both', () => {
    const e = evaluateGraduation(facts([gig('g1', 10)]), R5);
    expect(e.routes.map((r) => r.routeKey)).toEqual(['route_a', 'route_b']);
  });
});

describe('regression when evidence is withdrawn', () => {
  it('loses eligibility if an accepted gig is later unlocked', () => {
    const eligible = evaluateGraduation(facts([gig('g1', 5), gig('g2', 5), gig('g3', 5)]), R5);
    expect(eligible.status).toBe('eligibility_met');

    const afterUnlock = evaluateGraduation(facts([gig('g1', 5), gig('g2', 5)]), R5);
    expect(afterUnlock.status).not.toBe('eligibility_met');
    expect(afterUnlock.matchedRouteKey).toBeNull();
  });
});

describe('the two targets are distinct (§2, §41)', () => {
  it('keeps the contractual threshold and the internal target separate', () => {
    expect(GRADUATION_TARGETS.contractualThresholdPercent).toBe(70);
    expect(GRADUATION_TARGETS.internalTargetPercent).toBe(85);
    expect(GRADUATION_TARGETS.contractualThresholdPercent).not.toBe(
      GRADUATION_TARGETS.internalTargetPercent,
    );
  });
});

describe('the ruleset is configuration, not code', () => {
  it('carries a config version so an evaluation is re-derivable', () => {
    expect(evaluateGraduation(facts([gig('g1', 300)]), R5).configVersionId).toBe(
      'depi-r5-graduation-v1',
    );
  });

  it('evaluates a different round’s rule with no code change', () => {
    // The reusability claim: swap the ruleset, get the new behaviour.
    const roundSix = {
      ...R5,
      configVersionId: 'depi-r6-graduation-v1',
      routes: [
        {
          key: 'route_a',
          label: { en: 'Route A', ar: 'أ' },
          criteria: [
            {
              key: 'five_gigs',
              type: 'per_gig_minimum_value' as const,
              parameters: { minimum: 10, count: 5 },
              explain: { en: '{shortfall} more gigs', ar: '{shortfall}' },
            },
          ],
        },
      ],
    };
    const threeGigs = facts([gig('g1', 5), gig('g2', 5), gig('g3', 5)]);
    expect(evaluateGraduation(threeGigs, R5).status).toBe('eligibility_met');
    expect(evaluateGraduation(threeGigs, roundSix).status).not.toBe('eligibility_met');
  });
});
