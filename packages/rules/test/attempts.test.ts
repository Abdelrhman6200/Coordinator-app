import { describe, expect, it } from 'vitest';
import {
  attemptStatus,
  recordAttempt,
  resetOnReply,
  windowKey,
  type AttemptPolicy,
} from '../src/attempts.ts';

const policy: AttemptPolicy = {
  dedupWindowHours: 4,
  unresponsiveThreshold: 3,
  cooldownHours: 48,
  configVersionId: 'cfg-1',
};

const t = (iso: string) => new Date(iso);

describe('attempt de-duplication (AC-03)', () => {
  it('collapses three calls inside the window to one attempt', () => {
    const seen = new Set<string>();
    let count = 0;
    for (const time of ['2026-03-01T09:00:00Z', '2026-03-01T10:00:00Z', '2026-03-01T10:45:00Z']) {
      const r = recordAttempt(t(time), seen, policy);
      if (r.outcome === 'counted') {
        seen.add(r.windowKey);
        count = r.attemptCount;
      }
    }
    expect(count).toBe(1);
    expect(seen.size).toBe(1);
  });

  it('counts a second attempt once the window has passed', () => {
    const seen = new Set<string>();
    const first = recordAttempt(t('2026-03-01T09:00:00Z'), seen, policy);
    seen.add(first.windowKey);
    const later = recordAttempt(t('2026-03-01T15:00:00Z'), seen, policy);
    expect(later.outcome).toBe('counted');
    expect(later.attemptCount).toBe(2);
  });

  it('reports de-duplication explicitly rather than silently discarding', () => {
    const seen = new Set([windowKey(t('2026-03-01T09:00:00Z'), policy)]);
    const r = recordAttempt(t('2026-03-01T09:30:00Z'), seen, policy);
    expect(r.outcome).toBe('deduplicated');
    expect(r.explanation).toContain('4-hour window');
  });

  it('produces a stable key an offline client can compute in advance', () => {
    // The same instant must yield the same key on client and server, so an
    // offline submission collides correctly on arrival.
    expect(windowKey(t('2026-03-01T09:00:00Z'), policy)).toBe(
      windowKey(t('2026-03-01T09:00:00Z'), policy),
    );
    expect(windowKey(t('2026-03-01T09:00:00Z'), policy)).not.toBe(
      windowKey(t('2026-03-01T14:00:00Z'), policy),
    );
  });

  it('respects a different configured window without code change', () => {
    const hourly: AttemptPolicy = { ...policy, dedupWindowHours: 1 };
    const seen = new Set([windowKey(t('2026-03-01T09:00:00Z'), hourly)]);
    expect(recordAttempt(t('2026-03-01T10:30:00Z'), seen, hourly).outcome).toBe('counted');
  });
});

describe('unresponsive progression', () => {
  it('maps attempt 1 to waiting, 2 to warning, threshold to unresponsive', () => {
    expect(attemptStatus(1, policy)).toBe('waiting');
    expect(attemptStatus(2, policy)).toBe('warning');
    expect(attemptStatus(3, policy)).toBe('unresponsive');
    expect(attemptStatus(9, policy)).toBe('unresponsive');
  });

  it('flags the threshold on the attempt that reaches it', () => {
    const seen = new Set(['w1', 'w2']);
    const r = recordAttempt(t('2026-03-05T09:00:00Z'), seen, policy);
    expect(r.attemptCount).toBe(3);
    expect(r.reachedThreshold).toBe(true);
  });

  it('does not flag the threshold early', () => {
    const seen = new Set(['w1']);
    expect(recordAttempt(t('2026-03-05T09:00:00Z'), seen, policy).reachedThreshold).toBe(false);
  });

  it('resets on a reply', () => {
    expect(resetOnReply()).toEqual({ attemptCount: 0, status: 'waiting' });
  });
});
