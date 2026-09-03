/**
 * Adapter for the DEPI operations workbook.
 *
 * This exists because the exported workbook does not match its own header row.
 * Three unnamed columns were inserted into the gig sheet over time, so from
 * column 17 onwards the header lags the data by one, then two, then three
 * positions -- and the last three headers are literally blank. Reading it by
 * header name yields client phone numbers under "Client Name" and a screenshot
 * URL under "Created On".
 *
 * Worse, the Price column carries an Excel DATE format, so every gig value comes
 * back as a datetime: $5 reads as 1900-01-05. Recovering it needs the Excel
 * serial, including the 1900 leap-year bug.
 *
 * None of this is guesswork -- the mapping below was derived by profiling every
 * column's actual contents across all 6,562 rows. It is pinned by tests so a
 * future export that shifts again fails loudly instead of importing nonsense.
 */

/**
 * ExcelJS's serial anchor: serial 0 is 1899-12-30 UTC, and it maps serials to
 * dates linearly with NO correction for Excel's phantom 1900-02-29.
 *
 * That convention is reader-specific and is the whole reason this constant is
 * documented rather than assumed. openpyxl models the leap-year bug and renders
 * the same stored serial one day later, so a conversion calibrated against one
 * library is off by a day against the other. Since the goal is to recover the
 * NUMBER Excel stored, the correct inverse is simply the exact inverse of what
 * the reader in use did -- which for ExcelJS is plain division, and which
 * round-trips serial 59 and 60 distinctly because the reader never collapses
 * them.
 */
const EXCELJS_SERIAL_ANCHOR_UTC = Date.UTC(1899, 11, 30);

/**
 * Recovers the number from a cell that Excel formatted as a date.
 *
 * The gig sheet stores Price with a date number-format, so every value arrives
 * as a Date: $5 reads as a date five days after the anchor. Reversing that is
 * the difference between a $5 gig and a nonsensical one, and therefore between
 * a correct and an incorrect graduation decision.
 */
export function numberFromExcelDate(value: unknown): { value: number | null; ambiguous: boolean } {
  if (value === null || value === undefined) return { value: null, ambiguous: false };
  if (typeof value === 'number') return { value, ambiguous: false };
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed)
      ? { value: parsed, ambiguous: false }
      : { value: null, ambiguous: false };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return { value: null, ambiguous: false };
    const serial = (ms - EXCELJS_SERIAL_ANCHOR_UTC) / 86_400_000;
    return { value: serial, ambiguous: false };
  }
  return { value: null, ambiguous: false };
}

/**
 * Sanity check on a recovered price column.
 *
 * The conversion above depends on the reader's epoch convention, and getting it
 * wrong shifts every value by a constant -- which is invisible in a spot check
 * but changes who graduates. This asserts the recovered values look like money:
 * non-negative, and mostly whole. It is deliberately weak, because the point is
 * to catch a systematic shift, not to second-guess the programme's prices.
 */
export function priceColumnLooksSane(values: readonly (number | null)[]): {
  ok: boolean;
  reason: string;
  negative: number;
  modal: number | null;
} {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { ok: false, reason: 'no prices recovered at all', negative: 0, modal: null };
  const negative = present.filter((v) => v < 0).length;
  const counts = new Map<number, number>();
  for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (negative > 0) {
    return {
      ok: false,
      // A negative price means the epoch is off: dates before the anchor.
      reason: `${negative} price(s) recovered as negative, which means the date-to-serial ` +
        `conversion is anchored wrongly for this reader`,
      negative,
      modal,
    };
  }
  return { ok: true, reason: 'prices are non-negative', negative, modal };
}

/**
 * Real column positions in `GigsDataFromPortal`, by index.
 *
 * Named for what the data actually contains, not for what the header claims.
 */
export const GIG_COLUMNS = {
  id: 3,
  studentExternalId: 4,
  studentName: 5,
  studentEmail: 6,
  phone: 7,
  roundCode: 8,
  city: 9,
  provider: 10,
  profile: 12,
  coachingCompany: 13,
  title: 14,
  url: 15,
  category: 16,
  skills: 17,
  platform: 18, // header says "Client Number"
  clientNumber: 19, // header says "Client Name"
  clientName: 20, // header says "Client Email"
  clientEmail: 21, // header says "Group Name"
  groupName: 22, // header says "Status Proof Screenshot"
  workLocation: 23, // unnamed in the header
  proofScreenshot: 24, // header says "Created On"
  price: 25, // header says "Status" -- and is DATE-FORMATTED
  createdOn: 26, // header says "Provider Status"
  secondaryDate: 27, // unnamed in the header
  status: 28, // header says "Comment"
  providerStatus: 29, // header says "Suggestion"
  auditorStatus: 30, // header says "Action By"
  comment: 31,
  suggestion: 32,
  actionBy: 33,
} as const;

/**
 * The header row this mapping was derived against.
 *
 * Checked on every import: if the export changes shape, the run stops rather
 * than silently reading the wrong columns. A wrong price here becomes a wrong
 * graduation decision.
 */
export const EXPECTED_GIG_HEADER: readonly string[] = [
  'Account Manager', 'Team Leader', 'Coordinator', 'ID', 'Student ID', 'Student Name',
  'Student Email', 'Phone', 'Round Code', 'City', 'Provider', 'Track', 'Profile',
  'Coaching Company', 'Title', 'URL', 'Category', 'Organization', 'Client Number',
  'Client Name', 'Client Email', 'Group Name', 'Status Proof Screenshot', 'Price',
  'Created On', 'Status', 'Provider Status', 'Auditor Status', 'Comment', 'Suggestion',
  'Action By',
];

export class WorkbookShapeError extends Error {
  readonly expected: readonly string[];
  readonly received: readonly string[];
  constructor(message: string, expected: readonly string[], received: readonly string[]) {
    super(message);
    this.name = 'WorkbookShapeError';
    this.expected = expected;
    this.received = received;
  }
}

export function assertGigSheetShape(header: readonly (string | null | undefined)[]): void {
  const trimmed = header.map((h) => (h ?? '').toString().trim());
  const named = trimmed.slice(0, EXPECTED_GIG_HEADER.length);
  const mismatch = EXPECTED_GIG_HEADER.findIndex((h, i) => named[i] !== h);
  if (mismatch !== -1) {
    throw new WorkbookShapeError(
      `The gig sheet does not match the shape this importer was written against. ` +
        `Column ${mismatch} reads "${named[mismatch]}", expected "${EXPECTED_GIG_HEADER[mismatch]}". ` +
        `The header row in this export is already misaligned with its data, so the importer ` +
        `reads by POSITION -- if the export shifts again the positions are wrong and the ` +
        `import must not proceed.`,
      EXPECTED_GIG_HEADER,
      named,
    );
  }
}

export interface ParsedGig {
  rowNo: number;
  externalId: number | null;
  studentExternalId: string | null;
  studentName: string | null;
  studentEmail: string | null;
  phone: string | null;
  roundCode: string | null;
  provider: string | null;
  profile: string | null;
  platform: string | null;
  title: string | null;
  url: string | null;
  category: string | null;
  price: number | null;
  priceAmbiguous: boolean;
  createdOn: Date | null;
  status: string | null;
  providerStatus: string | null;
  auditorStatus: string | null;
  comment: string | null;
  /**
   * Quality-accepted means the auditor approved it. The submission status alone
   * is not acceptance: §30 requires the decision, not the submission.
   */
  qualityAccepted: boolean;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(typeof v === 'object' && v !== null && 'text' in v ? (v as { text: unknown }).text : v).trim();
  if (!s || s === '#NAME?' || s === '#N/A' || s === 'null') return null;
  return s;
}

export function parseGigRow(row: readonly unknown[], rowNo: number): ParsedGig {
  const at = (i: number) => row[i];
  const price = numberFromExcelDate(at(GIG_COLUMNS.price));
  const status = text(at(GIG_COLUMNS.status));
  const auditorStatus = text(at(GIG_COLUMNS.auditorStatus));
  const created = at(GIG_COLUMNS.createdOn);

  return {
    rowNo,
    externalId: typeof at(GIG_COLUMNS.id) === 'number' ? (at(GIG_COLUMNS.id) as number) : null,
    studentExternalId: text(at(GIG_COLUMNS.studentExternalId)),
    studentName: text(at(GIG_COLUMNS.studentName)),
    studentEmail: text(at(GIG_COLUMNS.studentEmail))?.toLowerCase() ?? null,
    phone: text(at(GIG_COLUMNS.phone)),
    roundCode: text(at(GIG_COLUMNS.roundCode)),
    provider: text(at(GIG_COLUMNS.provider)),
    profile: text(at(GIG_COLUMNS.profile)),
    platform: text(at(GIG_COLUMNS.platform)),
    title: text(at(GIG_COLUMNS.title)),
    url: text(at(GIG_COLUMNS.url)),
    category: text(at(GIG_COLUMNS.category)),
    price: price.value,
    priceAmbiguous: price.ambiguous,
    createdOn: created instanceof Date ? created : null,
    status,
    providerStatus: text(at(GIG_COLUMNS.providerStatus)),
    auditorStatus,
    comment: text(at(GIG_COLUMNS.comment)),
    qualityAccepted: status === 'Approved' && auditorStatus === 'Approved',
  };
}

/**
 * Group code shape: `ALX4_SWD6_G1` -- site, round digit, track, group, cohort
 * segment. The round digit is what tells you which round an export belongs to,
 * and getting that wrong loads one round's data into another.
 */
export interface ParsedGroupCode {
  raw: string;
  site: string | null;
  round: number | null;
  track: string | null;
  segment: string | null;
}

export function parseGroupCode(code: string | null): ParsedGroupCode {
  const raw = (code ?? '').trim();
  const m = /^([A-Z]+)(\d+)_([A-Z]+)(\d+)_([A-Z]\d+)$/.exec(raw);
  if (!m) return { raw, site: null, round: null, track: null, segment: null };
  return { raw, site: m[1]!, round: Number(m[2]), track: m[3]!, segment: m[5]! };
}

/** The round a set of group codes belongs to, or null when they disagree. */
export function detectRound(codes: readonly string[]): number | null {
  const rounds = new Set(
    codes.map((c) => parseGroupCode(c).round).filter((r): r is number => r !== null),
  );
  return rounds.size === 1 ? [...rounds][0]! : null;
}
