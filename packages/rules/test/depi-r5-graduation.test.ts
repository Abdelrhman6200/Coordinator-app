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
    expect(e.gapExplanation.ar).toContain('عمل موثق إضافي');
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
