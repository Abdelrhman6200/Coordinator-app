import { describe, expect, it } from 'vitest';
import {
  AUTO_ESCALATING_CODES,
  detectDuplicates,
  QUALITY_CHECKS,
  QualityReviewError,
  REJECTION_CODES,
  reviewEvidence,
  type KnownEvidenceIndex,
  type QualityCheck,
} from '../src/index.ts';

const allPass = Object.fromEntries(QUALITY_CHECKS.map((c) => [c, true])) as Record<
  QualityCheck,
  boolean
>;
const base = { rejectionCodes: [], priorRejectionCount: 0, disputed: false } as const;

describe('Quality is binary: all seven checks must pass (§33)', () => {
  it('defines exactly the seven confirmed checks', () => {
    expect([...QUALITY_CHECKS]).toEqual([
      'evidence_completeness',
      'identity_match',
      'delivery_confirmed',
      'payment_confirmed',
      'value_threshold',
      'work_authenticity',
      'no_duplication',
    ]);
  });

  it('accepts when all seven pass', () => {
    const d = reviewEvidence({ ...base, checks: allPass });
    expect(d.outcome).toBe('accepted');
    expect(d.failedChecks).toEqual([]);
    expect(d.remainsOpen).toBe(false);
  });

  it.each(QUALITY_CHECKS)('rejects when %s alone fails', (check) => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, [check]: false },
      rejectionCodes: ['R01'],
    });
    expect(d.outcome).toBe('rejected');
    expect(d.failedChecks).toEqual([check]);
  });

  it('has no partial credit: six of seven is a rejection, not a middle band', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, payment_confirmed: false },
      rejectionCodes: ['R05'],
    });
    expect(d.outcome).toBe('rejected');
    expect(d).not.toHaveProperty('percentage');
  });

  it('refuses to score an incomplete review rather than assuming a pass', () => {
    const { no_duplication: _omitted, ...partial } = allPass;
    expect(() =>
      reviewEvidence({ ...base, checks: partial as Record<QualityCheck, boolean> }),
    ).toThrow(QualityReviewError);
  });
});

describe('rejection requires a structured code (§34, §67)', () => {
  it('refuses a rejection carrying only free text', () => {
    expect(() =>
      reviewEvidence({
        ...base,
        checks: { ...allPass, delivery_confirmed: false },
        reviewerComments: 'looks wrong to me',
      }),
    ).toThrow(/structured code/);
  });

  it('refuses a contradictory decision: all checks passed but a code supplied', () => {
    expect(() => reviewEvidence({ ...base, checks: allPass, rejectionCodes: ['R05'] })).toThrow(
      /contradictory/,
    );
  });

  it('defines all twelve confirmed codes R01-R12', () => {
    expect(Object.keys(REJECTION_CODES)).toEqual([
      'R01', 'R02', 'R03', 'R04', 'R05', 'R06',
      'R07', 'R08', 'R09', 'R10', 'R11', 'R12',
    ]);
  });

  it('reports the coded reasons in the explanation for analytics and for the student', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, payment_confirmed: false },
      rejectionCodes: ['R05'],
    });
    expect(d.explanation).toContain('R05 Payment proof missing');
  });
});

describe('a rejected submission stays open (§25, §36)', () => {
  it('marks a rejection as remaining open', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, evidence_completeness: false },
      rejectionCodes: ['R01'],
    });
    expect(d.remainsOpen).toBe(true);
    expect(d.explanation).toContain('remains open');
  });

  it('marks an escalation as remaining open too', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, work_authenticity: false },
      rejectionCodes: ['R12'],
    });
    expect(d.outcome).toBe('escalated');
    expect(d.remainsOpen).toBe(true);
  });

  it('closes the item only on acceptance', () => {
    expect(reviewEvidence({ ...base, checks: allPass }).remainsOpen).toBe(false);
  });
});

describe('escalation to the Quality Lead (§34, §36)', () => {
  it('escalates R12 suspected fabrication automatically', () => {
    expect([...AUTO_ESCALATING_CODES]).toEqual(['R12']);
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, work_authenticity: false },
      rejectionCodes: ['R12'],
    });
    expect(d.outcome).toBe('escalated');
    expect(d.escalationReason).toBe('auto_code');
    expect(d.explanation).toContain('suspected fabrication');
  });

  it('escalates a second rejection of the same submission', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, identity_match: false },
      rejectionCodes: ['R03'],
      priorRejectionCount: 1,
    });
    expect(d.outcome).toBe('escalated');
    expect(d.escalationReason).toBe('second_rejection');
  });

  it('does not escalate a first rejection', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, identity_match: false },
      rejectionCodes: ['R03'],
      priorRejectionCount: 0,
    });
    expect(d.outcome).toBe('rejected');
    expect(d.escalationReason).toBeNull();
  });

  it('escalates a disputed decision', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, value_threshold: false },
      rejectionCodes: ['R06'],
      disputed: true,
    });
    expect(d.escalationReason).toBe('dispute');
  });

  it('prefers the automatic code over other escalation reasons', () => {
    const d = reviewEvidence({
      ...base,
      checks: { ...allPass, work_authenticity: false },
      rejectionCodes: ['R12', 'R09'],
      priorRejectionCount: 3,
      disputed: true,
    });
    expect(d.escalationReason).toBe('auto_code');
  });
});

describe('duplicate detection flags, it does not decide (§35)', () => {
  const index: KnownEvidenceIndex = {
    byHash: new Map([['h1', { submissionId: 'SUB-1', studentId: 'other-student' }]]),
    byUrl: new Map([['https://x/order/9', { submissionId: 'SUB-2', studentId: 'me' }]]),
    byOrderId: new Map([['ORD-77', { submissionId: 'SUB-3', studentId: 'other-student' }]]),
    byFingerprint: new Map([['proof.png:10240', { submissionId: 'SUB-4', studentId: 'me' }]]),
  };

  it('flags a file hash previously used by a different student', () => {
    const flags = detectDuplicates(
      { fileHashes: ['h1'], urls: [], clientOrderId: null, fileFingerprints: [] },
      'me',
      index,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe('file_hash');
    expect(flags[0]!.crossStudent).toBe(true);
    expect(flags[0]!.explanation).toContain('different student');
  });

  it('flags a reused URL by the same student without calling it cross-student', () => {
    const flags = detectDuplicates(
      { fileHashes: [], urls: ['https://x/order/9'], clientOrderId: null, fileFingerprints: [] },
      'me',
      index,
    );
    expect(flags[0]!.crossStudent).toBe(false);
  });

  it('flags a duplicate client/order ID', () => {
    const flags = detectDuplicates(
      { fileHashes: [], urls: [], clientOrderId: 'ORD-77', fileFingerprints: [] },
      'me',
      index,
    );
    expect(flags[0]!.kind).toBe('client_order_id');
  });

  it('flags an identical file name and size', () => {
    const flags = detectDuplicates(
      { fileHashes: [], urls: [], clientOrderId: null, fileFingerprints: ['proof.png:10240'] },
      'me',
      index,
    );
    expect(flags[0]!.kind).toBe('file_fingerprint');
  });

  it('returns nothing for genuinely new evidence', () => {
    expect(
      detectDuplicates(
        { fileHashes: ['new'], urls: ['https://new'], clientOrderId: 'NEW', fileFingerprints: ['a:1'] },
        'me',
        index,
      ),
    ).toEqual([]);
  });

  it('never decides: a flagged submission with all checks passing still accepts', () => {
    // The reviewer weighs the flag. Auto-rejecting on a hash collision would
    // make the seventh check a machine's opinion rather than a reviewer's.
    expect(reviewEvidence({ ...base, checks: allPass }).outcome).toBe('accepted');
  });
});
