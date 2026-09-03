/**
 * The working calendar (docs/06 §1, register item 19).
 *
 * Every SLA deadline in the system is computed here. The rule that matters:
 * deadlines advance in WORKING PERIODS, not calendar days. Weekends, configured
 * public holidays and non-working hours are excluded, so an SLA does not breach
 * on a national holiday (AC-04).
 *
 * Pure: no I/O, no clock reads. The calendar is passed in, so a historical
 * evaluation can be re-derived under the calendar that was actually in force.
 */
import {
  fromZoned,
  localDateKey,
  localDayOfWeek,
  MINUTE_MS,
  toZoned,
  type ZonedParts,
} from './time.ts';

export interface WorkingCalendar {
  readonly timeZone: string;
  /** Working days as 0 = Sunday .. 6 = Saturday. Seeded Sun-Thu for the region. */
  readonly workingDays: readonly number[];
  /** Local start of the working day, minutes from midnight (e.g. 9*60). */
  readonly startMinute: number;
  /** Local end of the working day, minutes from midnight (e.g. 17*60). */
  readonly endMinute: number;
  /** Local dates 'YYYY-MM-DD' that are not working days. */
  readonly holidays: ReadonlySet<string>;
}

export function dailyWorkingMinutes(cal: WorkingCalendar): number {
  return cal.endMinute - cal.startMinute;
}

/** Working minutes in `days` working days -- the unit SLA intervals are configured in. */
export function workingDaysToMinutes(days: number, cal: WorkingCalendar): number {
  return Math.round(days * dailyWorkingMinutes(cal));
}

function isWorkingDate(instant: Date, cal: WorkingCalendar): boolean {
  if (!cal.workingDays.includes(localDayOfWeek(instant, cal.timeZone))) return false;
  return !cal.holidays.has(localDateKey(instant, cal.timeZone));
}

function minuteOfLocalDay(instant: Date, cal: WorkingCalendar): number {
  const z = toZoned(instant, cal.timeZone);
  return z.hour * 60 + z.minute;
}

function localMidnightParts(instant: Date, cal: WorkingCalendar): ZonedParts {
  const z = toZoned(instant, cal.timeZone);
  return { year: z.year, month: z.month, day: z.day, hour: 0, minute: 0, second: 0 };
}

function atLocalMinute(instant: Date, minute: number, cal: WorkingCalendar): Date {
  const base = localMidnightParts(instant, cal);
  return fromZoned(
    { ...base, hour: Math.floor(minute / 60), minute: minute % 60 },
    cal.timeZone,
  );
}

function nextLocalDay(instant: Date, cal: WorkingCalendar): Date {
  const z = toZoned(instant, cal.timeZone);
  // Step through UTC noon of the following local date to stay clear of DST
  // boundaries, then normalise back to that local day's midnight.
  const utcNoonNext = new Date(Date.UTC(z.year, z.month - 1, z.day + 1, 12));
  return atLocalMinute(utcNoonNext, 0, cal);
}

export function isWithinWorkingHours(instant: Date, cal: WorkingCalendar): boolean {
  if (!isWorkingDate(instant, cal)) return false;
  const m = minuteOfLocalDay(instant, cal);
  return m >= cal.startMinute && m < cal.endMinute;
}

/**
 * The first working instant at or after `instant`. An instant already inside a
 * working period is returned unchanged; anything else rolls forward to the next
 * working period's start.
 */
export function rollForwardToWorking(instant: Date, cal: WorkingCalendar): Date {
  let cursor = instant;
  for (let guard = 0; guard < 3660; guard++) {
    if (isWorkingDate(cursor, cal)) {
      const m = minuteOfLocalDay(cursor, cal);
      if (m < cal.startMinute) return atLocalMinute(cursor, cal.startMinute, cal);
      if (m < cal.endMinute) return cursor;
    }
    cursor = nextLocalDay(cursor, cal);
    cursor = atLocalMinute(cursor, cal.startMinute, cal);
  }
  throw new Error(
    'working calendar has no working day within ten years -- check workingDays and holidays',
  );
}

/**
 * `from` + `minutes` of working time.
 *
 * Consumes the remainder of the current working period, then whole working days,
 * then the remainder within a final day. Because it works in local wall-clock
 * minutes, a DST shift inside the span does not add or lose an hour of work.
 */
export function addWorkingMinutes(from: Date, minutes: number, cal: WorkingCalendar): Date {
  if (minutes < 0) throw new Error('addWorkingMinutes expects a non-negative duration');
  let cursor = rollForwardToWorking(from, cal);
  let remaining = minutes;

  for (let guard = 0; guard < 3660; guard++) {
    const dayEndMinute = cal.endMinute;
    const currentMinute = minuteOfLocalDay(cursor, cal);
    const availableToday = dayEndMinute - currentMinute;

    if (remaining < availableToday) {
      return new Date(cursor.getTime() + remaining * MINUTE_MS);
    }
    // Exactly filling the day lands on the day's end; the deadline is the close
    // of business, not the start of the next period. Consuming it here and
    // rolling forward would silently give the owner an extra day.
    if (remaining === availableToday) {
      return atLocalMinute(cursor, dayEndMinute, cal);
    }

    remaining -= availableToday;
    cursor = rollForwardToWorking(atLocalMinute(nextLocalDay(cursor, cal), 0, cal), cal);
  }
  throw new Error('addWorkingMinutes exceeded ten years of calendar');
}

/**
 * Working minutes elapsed between two instants. Used for "days since contact"
 * and for measuring SLA consumption. Non-working time contributes nothing, which
 * is why a case raised on Thursday evening is not overdue on Sunday morning.
 */
export function workingMinutesBetween(
  from: Date,
  to: Date,
  cal: WorkingCalendar,
): number {
  if (to <= from) return 0;
  let cursor = rollForwardToWorking(from, cal);
  if (cursor >= to) return 0;
  let total = 0;

  for (let guard = 0; guard < 3660; guard++) {
    const endOfDay = atLocalMinute(cursor, cal.endMinute, cal);
    if (to <= endOfDay) {
      total += Math.max(0, Math.round((to.getTime() - cursor.getTime()) / MINUTE_MS));
      return total;
    }
    total += Math.max(0, Math.round((endOfDay.getTime() - cursor.getTime()) / MINUTE_MS));
    const next = rollForwardToWorking(
      atLocalMinute(nextLocalDay(cursor, cal), 0, cal),
      cal,
    );
    if (next >= to) return total;
    cursor = next;
  }
  throw new Error('workingMinutesBetween exceeded ten years of calendar');
}

/** Whole working days elapsed -- what "days since contact" reports to staff. */
export function workingDaysBetween(from: Date, to: Date, cal: WorkingCalendar): number {
  return workingMinutesBetween(from, to, cal) / dailyWorkingMinutes(cal);
}
