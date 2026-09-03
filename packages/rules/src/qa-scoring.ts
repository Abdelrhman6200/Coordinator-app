/**
 * QA scorecard scoring and sampling reproducibility (docs/06 §6).
 *
 * Two properties carry the whole module: an auto-fail question overrides any
 * weighted score, and a sample is reproducible from its stored seed. Both exist
 * so a Quality Lead can defend a score and a sample to an external client
 * (AC-17, UAT QA-02).
 */

export type QaResult = 'pass' | 'needs_improvement' | 'fail';

export interface QaQuestion {
  readonly id: string;
  readonly weight: number;
  readonly isAutoFail: boolean;
  /** Highest score obtainable; scores are normalised against it. */
  readonly maxScore: number;
}

export interface QaScorecardVersion {
  readonly scorecardVersionId: string;
  readonly questions: readonly QaQuestion[];
  /** Percentage bands. CONFIG-PENDING register item 8. */
  readonly passAtOrAbove: number;
  readonly needsImprovementAtOrAbove: number;
}

export interface QaAnswer {
  readonly questionId: string;
  readonly score: number;
  /** An explicit fail on an auto-fail question. */
  readonly failed: boolean;
}

export interface QaScore {
  readonly percentage: number;
  readonly result: QaResult;
  readonly autoFailed: boolean;
  readonly autoFailedQuestionIds: readonly string[];
  readonly scorecardVersionId: string;
  readonly explanation: string;
}

export function scoreAudit(
  answers: readonly QaAnswer[],
  version: QaScorecardVersion,
): QaScore {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const missing = version.questions.filter((q) => !byId.has(q.id));
  if (missing.length > 0) {
    throw new Error(
      `audit is incomplete: ${missing.length} unanswered question(s) on scorecard ` +
        `version ${version.scorecardVersionId}`,
    );
  }

  let weighted = 0;
  let weightTotal = 0;
  const autoFailedQuestionIds: string[] = [];

  for (const q of version.questions) {
    const a = byId.get(q.id)!;
    if (q.isAutoFail && (a.failed || a.score <= 0)) autoFailedQuestionIds.push(q.id);
    weighted += (a.score / q.maxScore) * q.weight;
    weightTotal += q.weight;
  }

  const percentage = weightTotal === 0 ? 0 : (weighted / weightTotal) * 100;
  const autoFailed = autoFailedQuestionIds.length > 0;

  let result: QaResult;
  if (autoFailed) {
    result = 'fail';
  } else if (percentage >= version.passAtOrAbove) {
    result = 'pass';
  } else if (percentage >= version.needsImprovementAtOrAbove) {
    result = 'needs_improvement';
  } else {
    result = 'fail';
  }

  return {
    percentage,
    result,
    autoFailed,
    autoFailedQuestionIds,
    scorecardVersionId: version.scorecardVersionId,
    explanation: autoFailed
      ? `Automatic fail: ${autoFailedQuestionIds.length} auto-fail question(s) were not met, ` +
        `which overrides the weighted score of ${percentage.toFixed(1)}%.`
      : `Weighted score ${percentage.toFixed(1)}% against bands ` +
        `pass >= ${version.passAtOrAbove}%, needs improvement >= ${version.needsImprovementAtOrAbove}%.`,
  };
}

/**
 * Deterministic PRNG (mulberry32). A sample must be re-creatable years later
 * from its stored seed, which rules out Math.random and any platform-dependent
 * generator.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleDraw<T> {
  readonly selected: readonly T[];
  readonly seed: number;
  readonly populationSize: number;
  readonly requestedSize: number;
}

/**
 * Seeded sample without replacement, preserving the population order so the
 * draw is reproducible given the same stored population definition.
 *
 * `exclude` implements SoD-3 at draw time: rejected candidates are skipped and
 * the draw continues from the SAME seeded stream, so reproducibility survives
 * the exclusion.
 */
export function drawSample<T>(
  population: readonly T[],
  size: number,
  seed: number,
  exclude: (candidate: T) => boolean = () => false,
): SampleDraw<T> {
  const rng = seededRandom(seed);
  const pool = population.map((item, index) => ({ item, index }));

  // Fisher-Yates over a copy, driven entirely by the seeded stream.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = a;
  }

  const selected: T[] = [];
  for (const entry of pool) {
    if (selected.length >= size) break;
    if (exclude(entry.item)) continue;
    selected.push(entry.item);
  }

  return { selected, seed, populationSize: population.length, requestedSize: size };
}

/** Inter-auditor variance for calibration (docs/06 §6). */
export function calibrationVariance(scores: readonly number[]): {
  mean: number;
  variance: number;
  spread: number;
} {
  if (scores.length === 0) return { mean: 0, variance: 0, spread: 0 };
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const variance =
    scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
  return { mean, variance, spread: Math.max(...scores) - Math.min(...scores) };
}
