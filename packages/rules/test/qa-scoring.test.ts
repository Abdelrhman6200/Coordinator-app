import { describe, expect, it } from 'vitest';
import {
  calibrationVariance,
  drawSample,
  scoreAudit,
  seededRandom,
  type QaAnswer,
  type QaScorecardVersion,
} from '../src/qa-scoring.ts';

const version: QaScorecardVersion = {
  scorecardVersionId: 'sc-v3',
  passAtOrAbove: 85,
  needsImprovementAtOrAbove: 70,
  questions: [
    { id: 'q1', weight: 2, isAutoFail: false, maxScore: 5 },
    { id: 'q2', weight: 1, isAutoFail: false, maxScore: 5 },
    { id: 'q3', weight: 1, isAutoFail: true, maxScore: 1 },
  ],
};

const answer = (id: string, score: number, failed = false): QaAnswer => ({
  questionId: id,
  score,
  failed,
});

describe('weighted scoring and bands (register item 8)', () => {
  it('scores a perfect audit as a pass', () => {
    const s = scoreAudit([answer('q1', 5), answer('q2', 5), answer('q3', 1)], version);
    expect(s.percentage).toBe(100);
    expect(s.result).toBe('pass');
  });

  it('applies question weights rather than a flat average', () => {
    // q1 carries double weight: losing it costs more than losing q2.
    const loseHeavy = scoreAudit([answer('q1', 0), answer('q2', 5), answer('q3', 1)], version);
    const loseLight = scoreAudit([answer('q1', 5), answer('q2', 0), answer('q3', 1)], version);
    expect(loseHeavy.percentage).toBeLessThan(loseLight.percentage);
    expect(loseHeavy.percentage).toBe(50);
    expect(loseLight.percentage).toBe(75);
  });

  it('lands in needs_improvement between the bands', () => {
    const s = scoreAudit([answer('q1', 5), answer('q2', 0), answer('q3', 1)], version);
    expect(s.percentage).toBe(75);
    expect(s.result).toBe('needs_improvement');
  });

  it('fails below the lower band', () => {
    const s = scoreAudit([answer('q1', 1), answer('q2', 1), answer('q3', 1)], version);
    expect(s.result).toBe('fail');
  });

  it('treats the band edges as inclusive', () => {
    const edge: QaScorecardVersion = {
      ...version,
      questions: [{ id: 'q1', weight: 1, isAutoFail: false, maxScore: 100 }],
    };
    expect(scoreAudit([answer('q1', 85)], edge).result).toBe('pass');
    expect(scoreAudit([answer('q1', 70)], edge).result).toBe('needs_improvement');
    expect(scoreAudit([answer('q1', 69.9)], edge).result).toBe('fail');
  });
});

describe('auto-fail overrides the weighted score', () => {
  it('fails a high-scoring audit when an auto-fail question is missed', () => {
    // The auto-fail question carries little weight here, so the weighted score
    // comfortably clears the pass band. It must still fail: an auto-fail is a
    // categorical judgement, not another term in the average.
    const lightAutoFail: QaScorecardVersion = {
      ...version,
      questions: [
        { id: 'q1', weight: 10, isAutoFail: false, maxScore: 5 },
        { id: 'q2', weight: 10, isAutoFail: false, maxScore: 5 },
        { id: 'q3', weight: 1, isAutoFail: true, maxScore: 1 },
      ],
    };
    const s = scoreAudit([answer('q1', 5), answer('q2', 5), answer('q3', 0)], lightAutoFail);
    expect(s.percentage).toBeGreaterThan(version.passAtOrAbove);
    expect(s.result).toBe('fail');
    expect(s.autoFailed).toBe(true);
    expect(s.autoFailedQuestionIds).toEqual(['q3']);
    expect(s.explanation).toContain('Automatic fail');
  });

  it('honours an explicit failed flag even with a non-zero score', () => {
    const s = scoreAudit([answer('q1', 5), answer('q2', 5), answer('q3', 1, true)], version);
    expect(s.result).toBe('fail');
  });

  it('does not auto-fail on a zero score for a non-auto-fail question', () => {
    const s = scoreAudit([answer('q1', 0), answer('q2', 5), answer('q3', 1)], version);
    expect(s.autoFailed).toBe(false);
  });
});

describe('audit completeness', () => {
  it('refuses to score an incomplete audit rather than assuming zero', () => {
    expect(() => scoreAudit([answer('q1', 5)], version)).toThrow(/incomplete/);
  });

  it('records the scorecard version the audit was scored against', () => {
    const s = scoreAudit([answer('q1', 5), answer('q2', 5), answer('q3', 1)], version);
    expect(s.scorecardVersionId).toBe('sc-v3');
  });
});

describe('sampling is reproducible (AC-17, UAT QA-02)', () => {
  const population = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, auditee: `u${i % 20}` }));

  it('re-draws the identical set from the same seed', () => {
    const a = drawSample(population, 20, 424242);
    const b = drawSample(population, 20, 424242);
    expect(b.selected).toEqual(a.selected);
  });

  it('produces a different set from a different seed', () => {
    const a = drawSample(population, 20, 1);
    const b = drawSample(population, 20, 2);
    expect(b.selected).not.toEqual(a.selected);
  });

  it('does not repeat a record within one draw', () => {
    const { selected } = drawSample(population, 50, 99);
    expect(new Set(selected.map((s) => s.id)).size).toBe(50);
  });

  it('returns the whole population when the requested size exceeds it', () => {
    const { selected } = drawSample(population.slice(0, 5), 10, 7);
    expect(selected).toHaveLength(5);
  });

  it('records what is needed to defend the draw', () => {
    const draw = drawSample(population, 20, 555);
    expect(draw.seed).toBe(555);
    expect(draw.populationSize).toBe(200);
    expect(draw.requestedSize).toBe(20);
  });

  it('keeps reproducibility when SoD-3 excludes candidates', () => {
    // Excluding the auditor's own reports must not desynchronise the stream:
    // the same seed and the same exclusion must give the same result.
    const exclude = (c: { auditee: string }) => c.auditee === 'u3';
    const a = drawSample(population, 20, 777, exclude);
    const b = drawSample(population, 20, 777, exclude);
    expect(b.selected).toEqual(a.selected);
    expect(a.selected.some((s) => s.auditee === 'u3')).toBe(false);
    expect(a.selected).toHaveLength(20);
  });

  it('uses a generator that does not depend on the platform', () => {
    const rng = seededRandom(12345);
    const first = [rng(), rng(), rng()];
    const rng2 = seededRandom(12345);
    expect([rng2(), rng2(), rng2()]).toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('calibration variance', () => {
  it('is zero when auditors agree', () => {
    expect(calibrationVariance([80, 80, 80])).toEqual({ mean: 80, variance: 0, spread: 0 });
  });

  it('reports the spread between the most divergent auditors', () => {
    const v = calibrationVariance([60, 80, 100]);
    expect(v.mean).toBe(80);
    expect(v.spread).toBe(40);
    expect(v.variance).toBeGreaterThan(0);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(calibrationVariance([])).toEqual({ mean: 0, variance: 0, spread: 0 });
  });
});
