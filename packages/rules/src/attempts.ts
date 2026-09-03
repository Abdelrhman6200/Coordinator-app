/**
 * Contact attempt counting with de-duplication (docs/01 §10.4, AC-03).
 *
 * A coordinator re-dialling a number that is not answering is one attempt to
 * reach the student, not three. Without this, attempt counts inflate, students
 * cross the unresponsive threshold early, and the risk engine acts on a number
 * that measures dialling rather than outreach.
 *
 * De-duplication is by a window key derived from the attempt's instant, so it is
 * enforceable as a database unique constraint -- `UNIQUE (student_id,
 * window_key)` -- rather than depending on a read-then-write race.
 */
export interface AttemptPolicy {
  /** Attempts inside one window collapse to one. Register item 4. */
  readonly dedupWindowHours: number;
  /** Attempts before the student is declared unresponsive. */
  readonly unresponsiveThreshold: number;
  /** Quiet period after the threshold before outreach resumes. */
  readonly cooldownHours: number;
  readonly configVersionId: string;
}

/**
 * Deterministic window key. Two attempts share a key exactly when they fall in
 * the same fixed window, so the key can be computed client-side for an offline
 * submission and still collide correctly on the server.
 */
export function windowKey(at: Date, policy: AttemptPolicy): string {
  const windowMs = policy.dedupWindowHours * 3_600_000;
  return `w${Math.floor(at.getTime() / windowMs)}`;
}

export type AttemptOutcome = 'counted' | 'deduplicated';

export interface AttemptResult {
  readonly outcome: AttemptOutcome;
  readonly attemptCount: number;
  readonly windowKey: string;
  readonly reachedThreshold: boolean;
  readonly explanation: string;
}

/**
 * Records an outreach attempt against the attempt windows already seen.
 * `seenWindowKeys` is what the database holds for this student; passing it in
 * keeps this function pure and lets the caller supply it from a single query.
 */
export function recordAttempt(
  at: Date,
  seenWindowKeys: ReadonlySet<string>,
  policy: AttemptPolicy,
): AttemptResult {
  const key = windowKey(at, policy);
  if (seenWindowKeys.has(key)) {
    return {
      outcome: 'deduplicated',
      attemptCount: seenWindowKeys.size,
      windowKey: key,
      reachedThreshold: seenWindowKeys.size >= policy.unresponsiveThreshold,
      explanation:
        `An attempt was already recorded in this ${policy.dedupWindowHours}-hour window, ` +
        'so the attempt count is unchanged.',
    };
  }
  const count = seenWindowKeys.size + 1;
  return {
    outcome: 'counted',
    attemptCount: count,
    windowKey: key,
    reachedThreshold: count >= policy.unresponsiveThreshold,
    explanation: `Attempt ${count} of ${policy.unresponsiveThreshold} before the student is ` +
      'marked unresponsive.',
  };
}

export type AttemptStatus = 'waiting' | 'warning' | 'unresponsive';

/** Attempt 1 -> Waiting; attempt 2 -> Warning; attempt N -> Unresponsive. */
export function attemptStatus(count: number, policy: AttemptPolicy): AttemptStatus {
  if (count >= policy.unresponsiveThreshold) return 'unresponsive';
  if (count >= 2) return 'warning';
  return 'waiting';
}

/** A reply resets outreach: the student is responsive again. */
export function resetOnReply(): { attemptCount: 0; status: AttemptStatus } {
  return { attemptCount: 0, status: 'waiting' };
}
