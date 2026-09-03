import { describe, expect, it } from 'vitest';
import { evaluateSla, resolveSlaRule, type SlaRule, type SlaRuleset } from '../src/sla.ts';
import type { WorkingCalendar } from '../src/working-calendar.ts';
import { toZoned } from '../src/time.ts';

const cal: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(['2026-03-10']),
};

function at(date: string, hhmm: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mi!);
  const z = toZoned(new Date(guess), cal.timeZone);
  const drift = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute) - guess;
  return new Date(guess - drift);
}

const green: SlaRule = {
  contactIntervalWorkingDays: 7,
  approachingWorkingDays: 1,
  firstContactWorkingDays: 1,
};
const amber: SlaRule = {
  contactIntervalWorkingDays: 3,
  approachingWorkingDays: 1,
  firstContactWorkingDays: 1,
};
const red: SlaRule = {
  contactIntervalWorkingDays: 1,
  approachingWorkingDays: 0.5,
  firstContactWorkingDays: 1,
};

const ruleset: SlaRuleset = {
  configVersionId: 'cfg-1',
  rules: new Map([
    ['coaching|amber|', amber],
    ['coaching|red|', red],
    ['coaching|amber|fast_track', { ...amber, contactIntervalWorkingDays: 2 }],
  ]),
  fallback: green,
};

const base = { stage: 'coaching', riskLevel: 'green', track: null, assignedAt: at('2026-03-01', '09:00') };

describe('rule resolution falls back progressively', () => {
  it('prefers the most specific stage|risk|track rule', () => {
    const r = resolveSlaRule(ruleset, {
      ...base,
      riskLevel: 'amber',
      track: 'fast_track',
      lastContactAt: null,
      now: at('2026-03-01', '10:00'),
    });
    expect(r.contactIntervalWorkingDays).toBe(2);
  });

  it('falls back to stage|risk when the track has no rule', () => {
    const r = resolveSlaRule(ruleset, {
      ...base,
      riskLevel: 'amber',
      track: 'other',
      lastContactAt: null,
      now: at('2026-03-01', '10:00'),
    });
    expect(r.contactIntervalWorkingDays).toBe(3);
  });

  it('falls back to the ruleset default for an unconfigured combination', () => {
    const r = resolveSlaRule(ruleset, {
      ...base,
      stage: 'onboarded',
      lastContactAt: null,
      now: at('2026-03-01', '10:00'),
    });
    expect(r.contactIntervalWorkingDays).toBe(7);
  });
});

describe('first contact', () => {
  it('runs the clock from assignment when never contacted', () => {
    const e = evaluateSla(
      { ...base, riskLevel: 'amber', lastContactAt: null, now: at('2026-03-01', '10:00') },
      ruleset,
      cal,
    );
    // A one-working-day first-contact deadline with a one-day warning window is
    // 'approaching' from the moment of assignment -- which is the intended
    // signal: a first contact due today belongs in the queue today, not
    // tomorrow. It is emphatically not a breach.
    expect(e.state).toBe('approaching');
    expect(e.workingDaysSinceContact).toBeNull();
    expect(e.explanation).toContain('First contact');
  });

  it('is compliant when the first-contact window is wider than the warning', () => {
    const relaxed: SlaRuleset = {
      ...ruleset,
      fallback: { ...green, firstContactWorkingDays: 3 },
    };
    const e = evaluateSla(
      { ...base, lastContactAt: null, now: at('2026-03-01', '10:00') },
      relaxed,
      cal,
    );
    expect(e.state).toBe('compliant');
  });

  it('breaches when the first-contact deadline passes', () => {
    const e = evaluateSla(
      { ...base, riskLevel: 'amber', lastContactAt: null, now: at('2026-03-04', '10:00') },
      ruleset,
      cal,
    );
    expect(e.state).toBe('breached');
  });

  it('reports an ownership exception, not a breach, when unassigned', () => {
    const e = evaluateSla(
      { ...base, assignedAt: null, lastContactAt: null, now: at('2026-03-20', '10:00') },
      ruleset,
      cal,
    );
    expect(e.state).toBe('compliant');
    expect(e.nextContactDueAt).toBeNull();
    expect(e.explanation).toContain('ownership exception');
  });
});

describe('follow-up cadence', () => {
  it('is compliant well inside the interval', () => {
    const e = evaluateSla(
      {
        ...base,
        riskLevel: 'amber',
        lastContactAt: at('2026-03-01', '10:00'),
        now: at('2026-03-01', '12:00'),
      },
      ruleset,
      cal,
    );
    expect(e.state).toBe('compliant');
  });

  it('flips to approaching inside the warning window', () => {
    // amber = 3 working days, approaching at 1 working day remaining.
    const e = evaluateSla(
      {
        ...base,
        riskLevel: 'amber',
        lastContactAt: at('2026-03-01', '10:00'),
        now: at('2026-03-03', '14:00'),
      },
      ruleset,
      cal,
    );
    expect(e.state).toBe('approaching');
  });

  it('breaches after the due instant', () => {
    const e = evaluateSla(
      {
        ...base,
        riskLevel: 'amber',
        lastContactAt: at('2026-03-01', '10:00'),
        now: at('2026-03-05', '10:00'),
      },
      ruleset,
      cal,
    );
    expect(e.state).toBe('breached');
    expect(e.explanation).toContain('Overdue by');
  });

  it('does not breach across a weekend that consumes the interval (AC-04)', () => {
    // Red = 1 working day. Contacted Thursday 16:00; Friday and Saturday are
    // non-working, so Sunday morning is not yet a breach.
    const e = evaluateSla(
      {
        ...base,
        riskLevel: 'red',
        lastContactAt: at('2026-03-05', '16:00'),
        now: at('2026-03-08', '10:00'),
      },
      ruleset,
      cal,
    );
    expect(e.state).not.toBe('breached');
  });

  it('does not breach on a configured public holiday (AC-04)', () => {
    // 2026-03-10 is configured as a holiday. Contacted 2026-03-09 10:00 with a
    // 1-working-day interval: the deadline rolls past the holiday.
    const e = evaluateSla(
      {
        ...base,
        riskLevel: 'red',
        lastContactAt: at('2026-03-09', '10:00'),
        now: at('2026-03-10', '14:00'),
      },
      ruleset,
      cal,
    );
    expect(e.state).not.toBe('breached');
  });

  it('tightens the interval when risk rises', () => {
    const facts = { ...base, lastContactAt: at('2026-03-01', '10:00'), now: at('2026-03-04', '12:00') };
    const asGreen = evaluateSla({ ...facts, riskLevel: 'green' }, ruleset, cal);
    const asRed = evaluateSla({ ...facts, riskLevel: 'red' }, ruleset, cal);
    expect(asGreen.state).toBe('compliant');
    expect(asRed.state).toBe('breached');
  });
});

describe('evaluation is re-derivable', () => {
  it('records the config version it was evaluated under (AC-09)', () => {
    const e = evaluateSla(
      { ...base, lastContactAt: at('2026-03-01', '10:00'), now: at('2026-03-02', '10:00') },
      ruleset,
      cal,
    );
    expect(e.configVersionId).toBe('cfg-1');
    expect(e.ruleApplied).toEqual(green);
  });

  it('is pure: identical inputs give identical output', () => {
    const facts = { ...base, lastContactAt: at('2026-03-01', '10:00'), now: at('2026-03-04', '10:00') };
    expect(evaluateSla(facts, ruleset, cal)).toEqual(evaluateSla(facts, ruleset, cal));
  });
});
