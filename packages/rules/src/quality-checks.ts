/**
 * Quality evidence review (requirements §33-§36).
 *
 * Quality is BINARY, not scored. Seven checks; all seven must pass. There is no
 * weighted score and no middle band -- the weighted scorecard in qa-scoring.ts
 * applies to staff performance auditing and is deliberately not used here.
 *
 * Rejection carries a structured code. Free text may accompany it, but reason
 * analytics use the coded field only (§34), so an uncoded rejection is refused
 * rather than silently analysed as "other".
 */

export const QUALITY_CHECKS = [
  'evidence_completeness',
  'identity_match',
  'delivery_confirmed',
  'payment_confirmed',
  'value_threshold',
  'work_authenticity',
  'no_duplication',
] as const;
export type QualityCheck = (typeof QUALITY_CHECKS)[number];

export const REJECTION_CODES = {
  R01: 'Evidence component missing',
  R02: 'Evidence illegible or truncated',
  R03: 'Identity or profile mismatch',
  R04: 'Order not completed',
  R05: 'Payment proof missing',
  R06: 'Value below threshold',
  R07: 'Delivered work missing',
  R08: 'Work outside student track',
  R09: 'Work quality below standard',
  R10: 'Duplicate evidence',
  R11: 'Date outside allowed window',
  R12: 'Suspected fabrication',
} as const;
export type RejectionCode = keyof typeof REJECTION_CODES;

/** R12 escalates to the Quality Lead automatically (§34). */
export const AUTO_ESCALATING_CODES: readonly RejectionCode[] = ['R12'];

export type QualityOutcome = 'accepted' | 'rejected' | 'escalated';

export interface QualityReviewInput {
  readonly checks: Readonly<Record<QualityCheck, boolean>>;
  readonly rejectionCodes: readonly RejectionCode[];
  readonly reviewerComments?: string;
  /** Prior rejections of this submission. A second rejection escalates (§36). */
  readonly priorRejectionCount: number;
  /** The student has formally disputed the decision. */
  readonly disputed: boolean;
}

export interface QualityDecision {
  readonly outcome: QualityOutcome;
  readonly failedChecks: readonly QualityCheck[];
  readonly rejectionCodes: readonly RejectionCode[];
  readonly escalationReason: 'auto_code' | 'second_rejection' | 'dispute' | null;
  /** A rejected item stays OPEN until corrected -- it never leaves the pipeline. */
  readonly remainsOpen: boolean;
  readonly explanation: string;
}

export class QualityReviewError extends Error {}

export function reviewEvidence(input: QualityReviewInput): QualityDecision {
  const missing = QUALITY_CHECKS.filter((c) => !(c in input.checks));
  if (missing.length > 0) {
    throw new QualityReviewError(
      `all seven checks must be answered; missing: ${missing.join(', ')}`,
    );
  }

  const failedChecks = QUALITY_CHECKS.filter((c) => !input.checks[c]);
  const passed = failedChecks.length === 0;

  if (passed) {
    if (input.rejectionCodes.length > 0) {
      throw new QualityReviewError(
        'a rejection code was supplied but every check passed; the decision is ' +
          'contradictory and will not be recorded',
      );
    }
    // A dispute against an acceptance is not a Quality matter to re-decide here;
    // acceptance with all seven checks passing is the defined outcome (§36).
    return {
      outcome: 'accepted',
      failedChecks: [],
      rejectionCodes: [],
      escalationReason: null,
      remainsOpen: false,
      explanation: 'All seven Quality checks passed. Evidence accepted.',
    };
  }

  // Any failed check is a rejection, and a rejection requires a code (§67).
  if (input.rejectionCodes.length === 0) {
    throw new QualityReviewError(
      `rejection requires at least one structured code (${failedChecks.length} check(s) ` +
        'failed); free text alone is not recorded as a reason',
    );
  }

  const autoEscalating = input.rejectionCodes.filter((c) => AUTO_ESCALATING_CODES.includes(c));

  let escalationReason: QualityDecision['escalationReason'] = null;
  if (autoEscalating.length > 0) escalationReason = 'auto_code';
  else if (input.disputed) escalationReason = 'dispute';
  else if (input.priorRejectionCount >= 1) escalationReason = 'second_rejection';

  const codeList = input.rejectionCodes
    .map((c) => `${c} ${REJECTION_CODES[c]}`)
    .join('; ');

  return {
    outcome: escalationReason ? 'escalated' : 'rejected',
    failedChecks,
    rejectionCodes: input.rejectionCodes,
    escalationReason,
    // Escalated items are also unresolved: neither state closes the pipeline.
    remainsOpen: true,
    explanation: escalationReason
      ? `${failedChecks.length} check(s) failed (${codeList}). Escalated to the Quality Lead: ` +
        `${explainEscalation(escalationReason)}. The submission remains open.`
      : `${failedChecks.length} check(s) failed (${codeList}). Returned for correction; the ` +
        'submission remains open until resubmitted and accepted.',
  };
}

function explainEscalation(reason: NonNullable<QualityDecision['escalationReason']>): string {
  switch (reason) {
    case 'auto_code':
      return 'suspected fabrication (R12) escalates automatically';
    case 'second_rejection':
      return 'this is the second rejection of the same submission';
    case 'dispute':
      return 'the decision has been disputed';
  }
}

/**
 * Duplicate detection signals (§35).
 *
 * The system flags; Quality decides. Nothing here rejects anything on its own --
 * an automatic rejection on a hash collision would make the seventh check a
 * machine's opinion rather than a reviewer's.
 */
export interface DuplicateSignalInput {
  readonly fileHashes: readonly string[];
  readonly urls: readonly string[];
  readonly clientOrderId: string | null;
  readonly fileFingerprints: readonly string[]; // `${name}:${sizeBytes}`
}

export interface KnownEvidenceIndex {
  /** hash -> the submission and student that used it before. */
  readonly byHash: ReadonlyMap<string, { submissionId: string; studentId: string }>;
  readonly byUrl: ReadonlyMap<string, { submissionId: string; studentId: string }>;
  readonly byOrderId: ReadonlyMap<string, { submissionId: string; studentId: string }>;
  readonly byFingerprint: ReadonlyMap<string, { submissionId: string; studentId: string }>;
}

export interface DuplicateFlag {
  readonly kind: 'file_hash' | 'url' | 'client_order_id' | 'file_fingerprint';
  readonly value: string;
  readonly matchedSubmissionId: string;
  readonly matchedStudentId: string;
  readonly crossStudent: boolean;
  readonly explanation: string;
}

export function detectDuplicates(
  input: DuplicateSignalInput,
  studentId: string,
  index: KnownEvidenceIndex,
): DuplicateFlag[] {
  const flags: DuplicateFlag[] = [];

  const scan = (
    values: readonly string[],
    map: KnownEvidenceIndex[keyof KnownEvidenceIndex],
    kind: DuplicateFlag['kind'],
    label: string,
  ) => {
    for (const value of values) {
      const hit = map.get(value);
      if (!hit) continue;
      const crossStudent = hit.studentId !== studentId;
      flags.push({
        kind,
        value,
        matchedSubmissionId: hit.submissionId,
        matchedStudentId: hit.studentId,
        crossStudent,
        explanation: crossStudent
          ? `${label} was already submitted by a different student (${hit.submissionId}).`
          : `${label} was already submitted by this student (${hit.submissionId}).`,
      });
    }
  };

  scan(input.fileHashes, index.byHash, 'file_hash', 'This exact file');
  scan(input.urls, index.byUrl, 'url', 'This URL');
  scan(input.fileFingerprints, index.byFingerprint, 'file_fingerprint', 'A file of this name and size');
  if (input.clientOrderId) {
    scan([input.clientOrderId], index.byOrderId, 'client_order_id', 'This client/order ID');
  }

  return flags;
}
