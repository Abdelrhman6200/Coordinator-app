/**
 * Workbook adapter tests.
 *
 * These pin the column mapping and the price recovery. Both were derived by
 * profiling the real export rather than trusting its header row, so if a future
 * export shifts again these fail loudly -- which is the whole point. A silently
 * wrong price here becomes a silently wrong graduation decision.
 */
import { describe, expect, it } from 'vitest';
import {
  assertGigSheetShape,
  detectRound,
  EXPECTED_GIG_HEADER,
  GIG_COLUMNS,
  numberFromExcelDate,
  parseGigRow,
  priceColumnLooksSane,
  parseGroupCode,
  WorkbookShapeError,
} from '../src/services/workbook.ts';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('recovering a number from a date-formatted cell', () => {
  /**
   * Fixtures use the ExcelJS convention, which is the reader this importer uses:
   * serial 0 is 1899-12-30 and serials map linearly with no leap-bug correction.
   * openpyxl renders the same stored serial one day later, so a conversion
   * calibrated against that library is off by one against this one.
   */
  const fromSerial = (n: number) => new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);

  it('recovers the modal $5 service price', () => {
    expect(numberFromExcelDate(fromSerial(5)).value).toBe(5);
  });

  it('recovers the other common values', () => {
    expect(numberFromExcelDate(fromSerial(10)).value).toBe(10);
    expect(numberFromExcelDate(fromSerial(20)).value).toBe(20);
    expect(numberFromExcelDate(fromSerial(30)).value).toBe(30);
  });

  it('recovers a value at the Route B threshold', () => {
    expect(numberFromExcelDate(fromSerial(300)).value).toBe(300);
  });

  it('recovers zero rather than treating it as absent', () => {
    // $0 is a real, meaningful value in this data -- 242 gigs carry it.
    expect(numberFromExcelDate(fromSerial(0)).value).toBe(0);
  });

  it('keeps 59 and 60 distinct', () => {
    // The reader never collapses them onto the phantom 1900-02-29, so the
    // inverse is exact and no ambiguity arises.
    expect(numberFromExcelDate(fromSerial(59)).value).toBe(59);
    expect(numberFromExcelDate(fromSerial(60)).value).toBe(60);
  });

  it('passes a real number through untouched', () => {
    expect(numberFromExcelDate(1234.5).value).toBe(1234.5);
  });

  it('parses a numeric string', () => {
    expect(numberFromExcelDate(' 42 ').value).toBe(42);
  });

  it('returns null for a blank or unparseable cell rather than zero', () => {
    // Conflating "no value" with "$0" would quietly change what a student is owed.
    expect(numberFromExcelDate(null).value).toBeNull();
    expect(numberFromExcelDate(undefined).value).toBeNull();
    expect(numberFromExcelDate('not a number').value).toBeNull();
  });
});

describe('the price sanity check', () => {
  it('accepts a plausible price column', () => {
    const r = priceColumnLooksSane([5, 5, 10, 0, 300]);
    expect(r.ok).toBe(true);
    expect(r.modal).toBe(5);
  });

  it('rejects a column with negative prices, which means a wrong epoch', () => {
    // This is the guard that would have caught calibrating against the wrong
    // reader: the shift showed up as -1 across hundreds of rows.
    const r = priceColumnLooksSane([-1, -1, 4, 9]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('anchored wrongly');
    expect(r.negative).toBe(2);
  });

  it('rejects an empty column', () => {
    expect(priceColumnLooksSane([null, null]).ok).toBe(false);
  });
});

describe('the shape guard', () => {
  it('accepts the header this mapping was derived against', () => {
    expect(() => assertGigSheetShape(EXPECTED_GIG_HEADER)).not.toThrow();
  });

  it('tolerates the trailing unnamed columns', () => {
    expect(() => assertGigSheetShape([...EXPECTED_GIG_HEADER, ' ', ' ', ' '])).not.toThrow();
  });

  it('refuses an export whose columns have moved', () => {
    const shifted = ['Extra', ...EXPECTED_GIG_HEADER];
    expect(() => assertGigSheetShape(shifted)).toThrow(WorkbookShapeError);
  });

  it('names the offending column so the operator can see what changed', () => {
    const changed = [...EXPECTED_GIG_HEADER];
    changed[6] = 'Email';
    try {
      assertGigSheetShape(changed);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as Error).message).toContain('Column 6');
      expect((err as Error).message).toContain('Student Email');
    }
  });
});

describe('parsing a gig row by position', () => {
  function row(): unknown[] {
    const r: unknown[] = new Array(34).fill(null);
    r[GIG_COLUMNS.id] = 43161;
    r[GIG_COLUMNS.studentExternalId] = 'bedc8cc7-01c7-492a-e27f-08dbfb109288';
    r[GIG_COLUMNS.studentName] = 'Mohamed Ali Elshahat';
    r[GIG_COLUMNS.studentEmail] = 'Alihelal68800@GMAIL.com';
    r[GIG_COLUMNS.phone] = '01093122064';
    r[GIG_COLUMNS.roundCode] = 'CAI4_SWD2_S4';
    r[GIG_COLUMNS.provider] = 'NHA';
    r[GIG_COLUMNS.platform] = 'كفيل';
    r[GIG_COLUMNS.title] = 'Basic Image Optimization';
    r[GIG_COLUMNS.category] = 'Freelance';
    r[GIG_COLUMNS.price] = new Date(Date.UTC(1899, 11, 30) + 5 * 86_400_000);
    r[GIG_COLUMNS.createdOn] = utc(2026, 2, 22);
    r[GIG_COLUMNS.status] = 'Approved';
    r[GIG_COLUMNS.providerStatus] = 'Approved';
    r[GIG_COLUMNS.auditorStatus] = 'Approved';
    return r;
  }

  it('reads the fields the header row misplaces', () => {
    const g = parseGigRow(row(), 2);
    expect(g.price).toBe(5);
    expect(g.platform).toBe('كفيل');
    expect(g.status).toBe('Approved');
    expect(g.createdOn?.getUTCFullYear()).toBe(2026);
  });

  it('lowercases the student email so identity matching is stable', () => {
    expect(parseGigRow(row(), 2).studentEmail).toBe('alihelal68800@gmail.com');
  });

  it('treats a broken formula cell as absent, not as the literal text', () => {
    // Every Coordinator cell in this export is #NAME?. Importing that string as
    // a person's name would create 6,562 records owned by a formula error.
    const r = row();
    r[GIG_COLUMNS.studentName] = '#NAME?';
    r[GIG_COLUMNS.comment] = '#N/A';
    const g = parseGigRow(r, 2);
    expect(g.studentName).toBeNull();
    expect(g.comment).toBeNull();
  });

  it('counts a gig as Quality-accepted only when the AUDITOR approved it', () => {
    const approved = parseGigRow(row(), 2);
    expect(approved.qualityAccepted).toBe(true);

    const r = row();
    r[GIG_COLUMNS.auditorStatus] = 'Pending';
    // Submitted and provider-approved is not accepted: §30 requires the
    // decision, not the submission.
    expect(parseGigRow(r, 2).qualityAccepted).toBe(false);

    const r2 = row();
    r2[GIG_COLUMNS.status] = 'Rejected';
    expect(parseGigRow(r2, 2).qualityAccepted).toBe(false);
  });

  it('recovers a large price without shifting it', () => {
    const r = row();
    r[GIG_COLUMNS.price] = new Date(Date.UTC(1899, 11, 30) + 300 * 86_400_000);
    expect(parseGigRow(r, 2).price).toBe(300);
  });
});

describe('group codes', () => {
  it('parses the site, round, track and segment', () => {
    const g = parseGroupCode('ALX4_SWD6_G1');
    expect(g.site).toBe('ALX');
    expect(g.round).toBe(4);
    expect(g.track).toBe('SWD');
    expect(g.segment).toBe('G1');
  });

  it('handles a student segment as well as a graduate one', () => {
    expect(parseGroupCode('CAI4_AIS3_S4').segment).toBe('S4');
  });

  it('returns nulls rather than throwing on an unrecognised code', () => {
    expect(parseGroupCode('nonsense').round).toBeNull();
    expect(parseGroupCode(null).raw).toBe('');
  });

  it('detects which round an export belongs to', () => {
    // Loading one round's data into another is the mistake this prevents.
    expect(detectRound(['ALX4_SWD6_G1', 'CAI4_AIS3_S4'])).toBe(4);
    expect(detectRound(['ALX5_SWD6_G1', 'CAI5_AIS3_S4'])).toBe(5);
  });

  it('refuses to guess when codes disagree', () => {
    expect(detectRound(['ALX4_SWD6_G1', 'CAI5_AIS3_S4'])).toBeNull();
  });
});
