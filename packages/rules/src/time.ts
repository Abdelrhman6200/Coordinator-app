/**
 * Timezone primitives.
 *
 * Everything in the system is stored as UTC and displayed in the cohort/user
 * timezone (docs/01 §2.3). SLA arithmetic, however, must reason in the cohort's
 * *local* wall clock -- "09:00 to 17:00, Sunday to Thursday" is a local-time
 * statement, and it stays true across a DST transition even though the UTC
 * offset changes underneath it.
 *
 * These helpers convert between an instant and its local wall-clock parts using
 * the platform's IANA database, so no offset table is maintained here.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

export function toZoned(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`missing ${type} for ${timeZone}`);
    return Number(p.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset in milliseconds in `timeZone` at `instant`. */
export function offsetMs(instant: Date, timeZone: string): number {
  const z = toZoned(instant, timeZone);
  const asIfUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  // Drop sub-second precision on both sides so the difference is a clean offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which `timeZone` shows these wall-clock parts.
 *
 * Two passes: the first guess uses the offset at the naive UTC interpretation,
 * the second corrects it when that guess landed on the far side of a DST
 * transition. Where a wall-clock time does not exist (spring-forward gap) this
 * returns the instant just after the gap, which is the behaviour SLA wants -- a
 * deadline in a skipped hour becomes due when the clock reaches the far side.
 */
export function fromZoned(parts: ZonedParts, timeZone: string): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let instant = new Date(naive - offsetMs(new Date(naive), timeZone));
  instant = new Date(naive - offsetMs(instant, timeZone));
  return instant;
}

/** Local calendar date as 'YYYY-MM-DD' -- the key holidays are configured by. */
export function localDateKey(instant: Date, timeZone: string): string {
  const z = toZoned(instant, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

/** Day of week in `timeZone`: 0 = Sunday .. 6 = Saturday. */
export function localDayOfWeek(instant: Date, timeZone: string): number {
  const z = toZoned(instant, timeZone);
  // Date.UTC on the local parts gives a UTC instant whose UTC weekday equals the
  // local weekday, which is exactly what is wanted.
  return new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay();
}

export const MINUTE_MS = 60_000;
