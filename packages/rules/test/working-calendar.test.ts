import { describe, expect, it } from 'vitest';
import {
  addWorkingMinutes,
  dailyWorkingMinutes,
  isWithinWorkingHours,
  rollForwardToWorking,
  workingDaysBetween,
  workingDaysToMinutes,
  workingMinutesBetween,
  type WorkingCalendar,
} from '../src/working-calendar.ts';
import { localDateKey, toZoned } from '../src/time.ts';

/** Seeded default from register item 19: Sun-Thu, 09:00-17:00, Africa/Cairo. */
function cairo(holidays: string[] = []): WorkingCalendar {
  return {
    timeZone: 'Africa/Cairo',
    workingDays: [0, 1, 2, 3, 4], // Sunday..Thursday
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    holidays: new Set(holidays),
  };
}

/** Build an instant from a Cairo wall-clock time, for readable fixtures. */
function cairoAt(date: string, hhmm: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // Cairo is UTC+2 (winter) / UTC+3 (summer); resolve via the same primitive the
  // engine uses so the fixture cannot disagree with the implementation's notion
  // of local time.
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const probe = new Date(guess);
  const zoned = toZoned(probe, 'Africa/Cairo');
  const drift =
    Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute) - guess;
  return new Date(guess - drift);
}

function cairoLabel(d: Date): string {
  const z = toZoned(d, 'Africa/Cairo');
  return `${localDateKey(d, 'Africa/Cairo')} ${String(z.hour).padStart(2, '0')}:${String(
    z.minute,
  ).padStart(2, '0')}`;
}

describe('fixture helper agrees with the engine', () => {
  it('round-trips a wall-clock time', () => {
    expect(cairoLabel(cairoAt('2026-03-01', '09:00'))).toBe('2026-03-01 09:00');
    expect(cairoLabel(cairoAt('2026-07-01', '14:30'))).toBe('2026-07-01 14:30');
  });
});

describe('working hours', () => {
  const cal = cairo();
  it('accepts a time inside the window on a working day', () => {
    // 2026-03-01 is a Sunday.
    expect(isWithinWorkingHours(cairoAt('2026-03-01', '10:00'), cal)).toBe(true);
  });
  it('rejects before opening and at/after closing', () => {
    expect(isWithinWorkingHours(cairoAt('2026-03-01', '08:59'), cal)).toBe(false);
    expect(isWithinWorkingHours(cairoAt('2026-03-01', '17:00'), cal)).toBe(false);
  });
  it('rejects the configured weekend', () => {
    // 2026-03-06 Friday, 2026-03-07 Saturday.
    expect(isWithinWorkingHours(cairoAt('2026-03-06', '10:00'), cal)).toBe(false);
    expect(isWithinWorkingHours(cairoAt('2026-03-07', '10:00'), cal)).toBe(false);
  });
  it('rejects a configured public holiday', () => {
    const withHoliday = cairo(['2026-03-02']);
    expect(isWithinWorkingHours(cairoAt('2026-03-02', '10:00'), withHoliday)).toBe(false);
  });
});

describe('rollForwardToWorking', () => {
  const cal = cairo();
  it('leaves a working instant untouched', () => {
    const t = cairoAt('2026-03-01', '10:00');
    expect(rollForwardToWorking(t, cal).getTime()).toBe(t.getTime());
  });
  it('advances an early-morning instant to opening time', () => {
    expect(cairoLabel(rollForwardToWorking(cairoAt('2026-03-01', '06:00'), cal))).toBe(
      '2026-03-01 09:00',
    );
  });
  it('advances an after-hours instant to the next working morning', () => {
    expect(cairoLabel(rollForwardToWorking(cairoAt('2026-03-01', '18:00'), cal))).toBe(
      '2026-03-02 09:00',
    );
  });
  it('skips the weekend', () => {
    // Thursday 2026-03-05 after hours -> Sunday 2026-03-08 morning.
    expect(cairoLabel(rollForwardToWorking(cairoAt('2026-03-05', '18:00'), cal))).toBe(
      '2026-03-08 09:00',
    );
  });
  it('skips a holiday that falls on a working day', () => {
    const cal2 = cairo(['2026-03-08', '2026-03-09']);
    expect(cairoLabel(rollForwardToWorking(cairoAt('2026-03-05', '18:00'), cal2))).toBe(
      '2026-03-10 09:00',
    );
  });
});

describe('addWorkingMinutes (AC-04)', () => {
  const cal = cairo();

  it('adds within a single working day', () => {
    expect(cairoLabel(addWorkingMinutes(cairoAt('2026-03-01', '09:30'), 120, cal))).toBe(
      '2026-03-01 11:30',
    );
  });

  it('lands on close of business rather than leaking into the next day', () => {
    // Exactly filling the remaining window must be the day's end, not next
    // morning -- otherwise the owner silently gains a day.
    expect(cairoLabel(addWorkingMinutes(cairoAt('2026-03-01', '15:00'), 120, cal))).toBe(
      '2026-03-01 17:00',
    );
  });

  it('carries over into the next working day', () => {
    expect(cairoLabel(addWorkingMinutes(cairoAt('2026-03-01', '16:30'), 60, cal))).toBe(
      '2026-03-02 09:30',
    );
  });

  it('treats three working days from mid-afternoon correctly', () => {
    const due = addWorkingMinutes(
      cairoAt('2026-03-01', '16:30'),
      workingDaysToMinutes(3, cal),
      cal,
    );
    expect(cairoLabel(due)).toBe('2026-03-04 16:30');
  });

  it('does not fall due on a weekend', () => {
    // Thursday 15:00 + 2 working days -> skips Fri/Sat -> Monday.
    const due = addWorkingMinutes(
      cairoAt('2026-03-05', '15:00'),
      workingDaysToMinutes(2, cal),
      cal,
    );
    expect(cairoLabel(due)).toBe('2026-03-09 15:00');
  });

  it('does not fall due on a configured public holiday (AC-04)', () => {
    const withHoliday = cairo(['2026-03-02']);
    const due = addWorkingMinutes(
      cairoAt('2026-03-01', '10:00'),
      workingDaysToMinutes(1, withHoliday),
      withHoliday,
    );
    expect(localDateKey(due, 'Africa/Cairo')).not.toBe('2026-03-02');
    expect(cairoLabel(due)).toBe('2026-03-03 10:00');
  });

  it('starts from the next working period when the origin is out of hours', () => {
    // Friday (weekend) 12:00 + 1 working day -> starts Sunday 09:00.
    const due = addWorkingMinutes(
      cairoAt('2026-03-06', '12:00'),
      workingDaysToMinutes(1, cal),
      cal,
    );
    expect(cairoLabel(due)).toBe('2026-03-08 17:00');
  });

  it('preserves wall-clock time across a DST transition', () => {
    // Egypt moves to DST on the last Friday of April. A deadline set before the
    // shift must still fall at the same local time after it -- staff work by the
    // wall clock, not by UTC offset.
    const before = cairoAt('2026-04-23', '10:00'); // Thursday, pre-DST
    const due = addWorkingMinutes(before, workingDaysToMinutes(3, cal), cal);
    const z = toZoned(due, 'Africa/Cairo');
    expect(`${z.hour}:${String(z.minute).padStart(2, '0')}`).toBe('10:00');
  });

  it('is stable under a zero-length interval', () => {
    expect(cairoLabel(addWorkingMinutes(cairoAt('2026-03-01', '10:00'), 0, cal))).toBe(
      '2026-03-01 10:00',
    );
  });

  it('rejects a negative interval rather than silently reversing', () => {
    expect(() => addWorkingMinutes(cairoAt('2026-03-01', '10:00'), -1, cal)).toThrow();
  });
});

describe('workingMinutesBetween', () => {
  const cal = cairo();

  it('measures within one day', () => {
    expect(
      workingMinutesBetween(cairoAt('2026-03-01', '09:00'), cairoAt('2026-03-01', '12:00'), cal),
    ).toBe(180);
  });

  it('excludes the overnight gap', () => {
    expect(
      workingMinutesBetween(cairoAt('2026-03-01', '16:00'), cairoAt('2026-03-02', '10:00'), cal),
    ).toBe(120);
  });

  it('excludes the weekend entirely', () => {
    // Thursday 16:00 -> Sunday 10:00 is 1h Thursday + 1h Sunday.
    expect(
      workingMinutesBetween(cairoAt('2026-03-05', '16:00'), cairoAt('2026-03-08', '10:00'), cal),
    ).toBe(120);
  });

  it('excludes a public holiday', () => {
    const cal2 = cairo(['2026-03-02']);
    expect(
      workingMinutesBetween(cairoAt('2026-03-01', '16:00'), cairoAt('2026-03-03', '10:00'), cal2),
    ).toBe(120);
  });

  it('returns zero for a reversed or equal range', () => {
    expect(
      workingMinutesBetween(cairoAt('2026-03-01', '12:00'), cairoAt('2026-03-01', '09:00'), cal),
    ).toBe(0);
  });

  it('returns zero across a span containing no working time', () => {
    expect(
      workingMinutesBetween(cairoAt('2026-03-06', '09:00'), cairoAt('2026-03-07', '20:00'), cal),
    ).toBe(0);
  });

  it('round-trips against addWorkingMinutes', () => {
    const start = cairoAt('2026-03-01', '11:15');
    for (const minutes of [15, 90, 480, 1440, 3000]) {
      const end = addWorkingMinutes(start, minutes, cal);
      expect(workingMinutesBetween(start, end, cal)).toBe(minutes);
    }
  });

  it('reports whole working days for staff-facing "days since contact"', () => {
    const start = cairoAt('2026-03-01', '09:00');
    const end = addWorkingMinutes(start, workingDaysToMinutes(3, cal), cal);
    expect(workingDaysBetween(start, end, cal)).toBeCloseTo(3, 6);
  });
});

describe('calendar configuration', () => {
  it('reports the configured daily window', () => {
    expect(dailyWorkingMinutes(cairo())).toBe(480);
  });

  it('supports a different weekend without code change (Mon-Fri)', () => {
    const western: WorkingCalendar = { ...cairo(), workingDays: [1, 2, 3, 4, 5] };
    // 2026-03-01 is a Sunday: not a working day here.
    expect(isWithinWorkingHours(cairoAt('2026-03-01', '10:00'), western)).toBe(false);
    expect(cairoLabel(rollForwardToWorking(cairoAt('2026-03-01', '10:00'), western))).toBe(
      '2026-03-02 09:00',
    );
  });

  it('refuses a calendar with no working days rather than looping', () => {
    const broken: WorkingCalendar = { ...cairo(), workingDays: [] };
    expect(() => rollForwardToWorking(cairoAt('2026-03-01', '10:00'), broken)).toThrow(
      /no working day/,
    );
  });
});
