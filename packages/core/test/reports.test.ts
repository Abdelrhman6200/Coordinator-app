/**
 * Reports and reconciliation.
 *
 * The reconciliation test is the one that matters: it recomputes the headline
 * figure from the RAW EVENT LOG and asserts it matches the read model. That is
 * the mechanical guarantee behind "every number in every report traces to
 * records" -- without it, the claim is a promise rather than a property.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { seedRoles } from '@coordinator/db';
import { createExecutor, type Executor } from '../src/write-path.ts';
import {
  dailyOperationsReport,
  reconcileGraduation,
  snapshotReport,
  weeklyConsolidatedReport,
} from '../src/services/reports.ts';
import { ALL_CHECKS_PASS, decideQuality, reviewStage, submitEvidence } from '../src/services/evidence.ts';
import { projectStudent } from '../src/services/projection.ts';
import { buildWorld, CALENDAR, ctxFor, makePool, type World } from './fixture.ts';

let pool: pg.Pool;
let exec: Executor;
let w: World;

beforeAll(async () => {
  pool = makePool();
  const c = await pool.connect();
  try {
    await seedRoles(c);
  } finally {
    c.release();
  }
  exec = createExecutor(pool);
  w = await buildWorld(pool);
});

afterAll(async () => {
  await pool.end();
});

async function acceptGig(value: number): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
     VALUES ($1,'khamsat',$2,$3,DATE '2026-01-05',DATE '2026-01-06') RETURNING id`,
    [w.studentId, `Report gig ${value}`, value],
  );
  const { value: sub } = await exec.execute(ctxFor(w.studentUserId, 'student'), (scope) =>
    submitEvidence(scope, {
      studentId: w.studentId,
      subjectType: 'gig',
      gigId: rows[0].id,
      files: [
        { kind: 'delivered_work', fileRef: `s3://${randomUUID()}`, contentHash: Buffer.from(randomUUID()) },
      ],
      calendar: CALENDAR,
    }),
  );
  await exec.execute(ctxFor(w.coachId, 'outcome_coach'), (scope) =>
    reviewStage(scope, { submissionId: sub.submissionId, stage: 'coach', decision: 'passed', calendar: CALENDAR }),
  );
  await exec.execute(ctxFor(w.coordinatorId, 'operations_coordinator'), (scope) =>
    reviewStage(scope, { submissionId: sub.submissionId, stage: 'l1', decision: 'passed', calendar: CALENDAR }),
  );
  await exec.execute(ctxFor(w.qualityMemberId, 'quality_member'), (scope) =>
    decideQuality(scope, {
      submissionId: sub.submissionId,
      level: 'l2',
      checks: ALL_CHECKS_PASS,
      rejectionCodes: [],
      calendar: CALENDAR,
    }),
  );
}

describe('daily operations report (§60)', () => {
  it('generates without manual assembly', async () => {
    const report = await dailyOperationsReport(pool, w.cohortId);
    expect(report.cohortId).toBe(w.cohortId);
    expect(report.generatedAt).toBeTruthy();
    expect(report.quality).toHaveProperty('queueSize');
    expect(report.quality).toHaveProperty('oldestHours');
    expect(report.escalations).toHaveProperty('pastSla');
    expect(typeof report.studentsWithoutUpdate7d).toBe('number');
  });

  it('classifies the Quality queue against the confirmed thresholds', async () => {
    const report = await dailyOperationsReport(pool, w.cohortId);
    expect(['normal', 'lead_review', 'pm_escalation']).toContain(report.quality.threshold);
  });

  it('counts a student with no update in seven days', async () => {
    await pool.query(
      `UPDATE student SET last_contact_at = now() - interval '10 days' WHERE id = $1`,
      [w.studentId],
    );
    await projectStudent(pool, w.studentId, CALENDAR);
    const report = await dailyOperationsReport(pool, w.cohortId);
    expect(report.studentsWithoutUpdate7d).toBeGreaterThan(0);
  });
});

describe('weekly consolidated report (§61)', () => {
  it('uses the same calculation layer as the dashboard (§69)', async () => {
    await acceptGig(10);
    await projectStudent(pool, w.studentId, CALENDAR);

    const report = await weeklyConsolidatedReport(pool, w.cohortId);
    const { graduationSummary } = await import('../src/services/graduation.ts');
    const dashboard = await graduationSummary(pool, w.cohortId);

    // Identical because there is exactly one implementation, not because two
    // implementations happen to agree today.
    expect(report.headline).toEqual(dashboard);
  });

  it('reports both targets, never merged', async () => {
    const report = await weeklyConsolidatedReport(pool, w.cohortId);
    expect(report.headline.contractualThresholdPercent).toBe(70);
    expect(report.headline.internalTargetPercent).toBe(85);
  });

  it('breaks Quality rejections down by coded reason (§34)', async () => {
    const report = await weeklyConsolidatedReport(pool, w.cohortId);
    expect(report.quality).toHaveProperty('byCode');
    expect(report.quality.rejectionRatePercent).toBeGreaterThanOrEqual(0);
  });

  it('includes group classification, coaching and risk', async () => {
    const report = await weeklyConsolidatedReport(pool, w.cohortId);
    expect(report.groups).toHaveProperty('onTrack');
    expect(report.coaching).toHaveProperty('planned');
    expect(report.risk).toHaveProperty('red');
  });
});

describe('report snapshots are immutable (§59)', () => {
  it('stores the payload, filters and metric version', async () => {
    const report = await weeklyConsolidatedReport(pool, w.cohortId);
    const id = await snapshotReport(pool, {
      reportKey: 'weekly_consolidated',
      cohortId: w.cohortId,
      filters: { week: '2026-W10' },
      payload: report,
    });
    const { rows } = await pool.query(
      `SELECT payload, filters, metric_version FROM report_snapshot WHERE id = $1`,
      [id],
    );
    expect(rows[0].filters.week).toBe('2026-W10');
    expect(rows[0].metric_version).toBe('depi-r5-metrics-v1');
    expect(rows[0].payload.headline.internalTargetPercent).toBe(85);
  });

  it('cannot be rewritten after the fact', async () => {
    const id = await snapshotReport(pool, {
      reportKey: 'daily_operations',
      cohortId: w.cohortId,
      payload: { queueSize: 3 },
    });
    await expect(
      pool.query(`UPDATE report_snapshot SET payload = '{"queueSize": 0}'::jsonb WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('reconciliation: every number traces to the event log (§69)', () => {
  it('matches the read model against a recomputation from raw events', async () => {
    const result = await reconcileGraduation(pool, w.cohortId);
    expect(result.divergentStudentIds).toEqual([]);
    expect(result.fromEvents).toBe(result.fromReadModel);
    expect(result.matches).toBe(true);
  });

  it('still matches after the student graduates', async () => {
    await acceptGig(10);
    await acceptGig(10);
    const { rows } = await pool.query(
      `SELECT status FROM graduation_progress WHERE student_id = $1`,
      [w.studentId],
    );
    expect(rows[0].status).toBe('graduated');

    const result = await reconcileGraduation(pool, w.cohortId);
    expect(result.matches).toBe(true);
    expect(result.fromReadModel).toBe(1);
    expect(result.fromEvents).toBe(1);
  });

  it('detects a read model that has been tampered with out of band', async () => {
    // The reconciliation earns its place only if it can actually catch drift,
    // so this forces a divergence the event log does not justify.
    await pool.query(
      `UPDATE graduation_progress SET status = 'progressing' WHERE student_id = $1`,
      [w.studentId],
    );
    const result = await reconcileGraduation(pool, w.cohortId);
    expect(result.matches).toBe(false);
    expect(result.divergentStudentIds).toContain(w.studentId);

    // Restore, and it reconciles again.
    await pool.query(
      `UPDATE graduation_progress SET status = 'graduated' WHERE student_id = $1`,
      [w.studentId],
    );
    expect((await reconcileGraduation(pool, w.cohortId)).matches).toBe(true);
  });
});
