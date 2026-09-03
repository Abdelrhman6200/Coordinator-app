/**
 * The graduation rules engine (docs/06 §5).
 *
 * Multi-route, configurable, explainable. NO candidate threshold appears in this
 * file -- the actual criteria are CONFIG-PENDING (register item 1) and arrive as
 * a ruleset. An unconfigured ruleset reports "not configured" rather than
 * guessing, because a guessed graduation rule is a fabricated programme
 * requirement.
 *
 * The engine computes eligibility. It NEVER grants graduation: approval is a
 * human transition guarded by `graduation.approve` and SoD-2 (Prohibition 4).
 */

export type GraduationStatus =
  | 'not_configured'
  | 'not_eligible'
  | 'progressing'
  | 'potentially_eligible'
  | 'eligibility_met';

export type CriterionType =
  | 'verified_gig_count'
  | 'verified_revenue_total'
  | 'per_gig_minimum_value'
  | 'milestone_achieved'
  | 'coaching_sessions_completed'
  | 'evidence_present';

export interface Criterion {
  readonly key: string;
  readonly type: CriterionType;
  /** e.g. { minimum: 3 } or { milestoneKey: 'portfolio' }. */
  readonly parameters: Readonly<Record<string, number | string>>;
  readonly evidenceStandard?: string;
  /** ICU-ish templates keyed by locale; `{required}`/`{actual}`/`{shortfall}`. */
  readonly explain: Readonly<Record<string, string>>;
}

export interface Route {
  readonly key: string;
  readonly label: Readonly<Record<string, string>>;
  readonly criteria: readonly Criterion[];
}

export interface GraduationRuleset {
  readonly configVersionId: string;
  readonly routes: readonly Route[];
  /** 'ANY' -- satisfying one route suffices. Configurable for future rulesets. */
  readonly routeLogic: 'ANY' | 'ALL';
}

export interface VerifiedGig {
  readonly gigId: string;
  readonly amountBase: number;
  readonly hasPaymentEvidence: boolean;
}

export interface GraduationFacts {
  readonly verifiedGigs: readonly VerifiedGig[];
  readonly achievedMilestoneKeys: readonly string[];
  readonly completedCoachingSessions: number;
  readonly presentEvidenceKeys: readonly string[];
  /** Fraction of the cohort still to run, 0..1. Drives `potentially_eligible`. */
  readonly cohortTimeRemainingFraction: number;
}

export interface CriterionEvaluation {
  readonly routeKey: string;
  readonly criterionKey: string;
  readonly required: number | string;
  readonly actual: number | string;
  readonly met: boolean;
  readonly evidenceRefs: readonly string[];
  readonly gap: Readonly<Record<string, string>>;
}

export interface RouteEvaluation {
  readonly routeKey: string;
  readonly criteria: readonly CriterionEvaluation[];
  readonly met: boolean;
  readonly metCount: number;
  readonly totalCount: number;
}

export interface GraduationEvaluation {
  readonly status: GraduationStatus;
  readonly configVersionId: string;
  readonly matchedRouteKey: string | null;
  /** The route the student is closest to completing, for the UI to highlight. */
  readonly bestRouteKey: string | null;
  readonly routes: readonly RouteEvaluation[];
  /** Plain-language shortfall, per locale. A first-class output (AC-11). */
  readonly gapExplanation: Readonly<Record<string, string>>;
}

const LOCALES = ['en', 'ar'] as const;

function num(v: number | string | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function render(
  template: string | undefined,
  vars: Record<string, string | number>,
): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

function evaluateCriterion(
  routeKey: string,
  c: Criterion,
  facts: GraduationFacts,
): CriterionEvaluation {
  let required: number | string = '';
  let actual: number | string = '';
  let met = false;
  const evidenceRefs: string[] = [];
  // Extra template variables a criterion type can expose to its explain string.
  const extraVars: Record<string, string | number> = {};

  switch (c.type) {
    case 'verified_gig_count': {
      const minimum = num(c.parameters.minimum);
      const requiresPayment = c.parameters.requiresPaymentEvidence === 1;
      const qualifying = facts.verifiedGigs.filter(
        (g) => !requiresPayment || g.hasPaymentEvidence,
      );
      required = minimum;
      actual = qualifying.length;
      met = qualifying.length >= minimum;
      evidenceRefs.push(...qualifying.map((g) => g.gigId));
      break;
    }
    case 'verified_revenue_total': {
      const minimum = num(c.parameters.minimum);
      const total = facts.verifiedGigs.reduce((s, g) => s + g.amountBase, 0);
      required = minimum;
      actual = total;
      met = total >= minimum;
      evidenceRefs.push(...facts.verifiedGigs.map((g) => g.gigId));
      break;
    }
    case 'per_gig_minimum_value': {
      const floor = num(c.parameters.minimum);
      const count = num(c.parameters.count, 1);
      const qualifying = facts.verifiedGigs.filter((g) => g.amountBase >= floor);
      // `required` stays NUMERIC so the shortfall is computable. Describing it
      // as "3 gig(s) of at least $5" reads well but makes the shortfall
      // incalculable, and the gap then understates what the student needs --
      // telling someone with no gigs at all that they need "1 more".
      required = count;
      actual = qualifying.length;
      met = qualifying.length >= count;
      extraVars.minimum = floor;
      extraVars.count = count;
      evidenceRefs.push(...qualifying.map((g) => g.gigId));
      break;
    }
    case 'milestone_achieved': {
      const key = String(c.parameters.milestoneKey ?? '');
      required = key;
      met = facts.achievedMilestoneKeys.includes(key);
      actual = met ? key : '';
      break;
    }
    case 'coaching_sessions_completed': {
      const minimum = num(c.parameters.minimum);
      required = minimum;
      actual = facts.completedCoachingSessions;
      met = facts.completedCoachingSessions >= minimum;
      break;
    }
    case 'evidence_present': {
      const key = String(c.parameters.evidenceKey ?? '');
      required = key;
      met = facts.presentEvidenceKeys.includes(key);
      actual = met ? key : '';
      break;
    }
  }

  const shortfall =
    typeof required === 'number' && typeof actual === 'number'
      ? Math.max(0, required - actual)
      : met
        ? 0
        : 1;

  const gap: Record<string, string> = {};
  if (!met) {
    for (const locale of LOCALES) {
      gap[locale] = render(c.explain[locale] ?? c.explain.en, {
        required,
        actual,
        shortfall,
        ...extraVars,
      });
    }
  }

  return { routeKey, criterionKey: c.key, required, actual, met, evidenceRefs, gap };
}

export function evaluateGraduation(
  facts: GraduationFacts,
  ruleset: GraduationRuleset,
): GraduationEvaluation {
  // An unconfigured ruleset is not "not eligible" -- it is a configuration gap,
  // and saying so is the honest answer (register item 1).
  if (ruleset.routes.length === 0) {
    const msg = {
      en: 'Graduation criteria have not been configured for this cohort yet, so eligibility cannot be evaluated.',
      ar: 'لم يتم بعد ضبط معايير التخرج لهذه الدفعة، لذلك لا يمكن تقييم الأهلية.',
    };
    return {
      status: 'not_configured',
      configVersionId: ruleset.configVersionId,
      matchedRouteKey: null,
      bestRouteKey: null,
      routes: [],
      gapExplanation: msg,
    };
  }

  const routes: RouteEvaluation[] = ruleset.routes.map((route) => {
    const criteria = route.criteria.map((c) => evaluateCriterion(route.key, c, facts));
    const metCount = criteria.filter((c) => c.met).length;
    return {
      routeKey: route.key,
      criteria,
      met: metCount === criteria.length && criteria.length > 0,
      metCount,
      totalCount: criteria.length,
    };
  });

  const matched = routes.find((r) => r.met) ?? null;

  // Which route the student is pointed at.
  //
  // Progress comes first: a student who has satisfied criteria on one route is
  // closer to it, whatever the arithmetic of outstanding boxes says. Only then
  // does fewest-outstanding break the tie, and the ruleset's configured order
  // breaks what remains.
  //
  // The order matters most for a student with NO progress at all. Counting
  // outstanding criteria alone would point them at whichever route has the
  // fewest conditions -- in Round 5 that is "one gig worth $300", which is the
  // exceptional path, not the one the programme is coaching them toward. With no
  // progress to go on, the configured order is the honest answer, and the
  // ruleset author puts the intended route first.
  const anyProgressForRouting = routes.some((r) => r.metCount > 0);
  const best = anyProgressForRouting
    ? [...routes].sort((a, b) => {
        if (b.metCount !== a.metCount) return b.metCount - a.metCount;
        return a.totalCount - a.metCount - (b.totalCount - b.metCount);
      })[0]
    : routes[0];

  // Status reflects progress across ALL routes, not just the route the student
  // is pointed at: a student who has met criteria on any route is progressing.
  const anyProgress = anyProgressForRouting;

  let status: GraduationStatus;
  if (matched) {
    status = 'eligibility_met';
  } else if (!anyProgress) {
    status = 'not_eligible';
  } else if (facts.cohortTimeRemainingFraction > 0) {
    status = 'potentially_eligible';
  } else {
    status = 'progressing';
  }

  return {
    status,
    configVersionId: ruleset.configVersionId,
    matchedRouteKey: matched?.routeKey ?? null,
    bestRouteKey: best?.routeKey ?? null,
    routes,
    gapExplanation: buildGapExplanation(status, best, ruleset),
  };
}

function buildGapExplanation(
  status: GraduationStatus,
  best: RouteEvaluation | undefined,
  ruleset: GraduationRuleset,
): Record<string, string> {
  if (status === 'eligibility_met') {
    return {
      en: 'All criteria for the matched graduation route are met.',
      ar: 'تم استيفاء جميع معايير مسار التخرج المطابق.',
    };
  }
  if (!best) return { en: '', ar: '' };

  const route = ruleset.routes.find((r) => r.key === best.routeKey);
  const outstanding = best.criteria.filter((c) => !c.met);
  const out: Record<string, string> = {};

  for (const locale of LOCALES) {
    const routeLabel = route?.label[locale] ?? route?.label.en ?? best.routeKey;
    const missing = outstanding.map((c) => c.gap[locale] ?? c.gap.en ?? '').filter(Boolean);
    out[locale] =
      locale === 'ar'
        ? `${routeLabel}: تم استيفاء ${best.metCount} من ${best.totalCount} من المعايير المطلوبة. المتبقي: ${missing.join('؛ ')}`
        : `${routeLabel}: ${best.metCount} of ${best.totalCount} required criteria met. Missing: ${missing.join('; ')}`;
  }
  return out;
}
