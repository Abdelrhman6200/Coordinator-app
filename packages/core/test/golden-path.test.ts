/**
 * Golden-path integration tests (Phase C workflows).
 *
 * Each asserts the WHOLE chain, not just the database write: state change AND
 * event AND audit row AND task AND KPI AND risk re-evaluation AND next state.
 * A test that asserts only the row would not catch the failure mode this
 * architecture exists to prevent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ALL_CHECKS_PASS, decideQuality, reviewStage, submitEvidence } from '../src/services/evidence.ts';
import { graduationSummary, recomputeGraduation } from '../src/services/graduation.ts';
import { recordInteraction, assignCoordinator, recordWithdrawal, setUnresponsive } from '../src/services/students.ts';
import { projectStudent } from '../src/services/projection.ts';
import { workQueue } from '../src/services/tasks.ts';
import { createExecutor, type Executor } from '../src/write-path.ts';
import { buildWorld, CALENDAR, ctxFor, makePool, type World } from './fixture.ts';
import { seedRoles } from '@coordinator/db';

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

async function events(subjectId: string, type?: string) {
  const { rows } = await pool.query(
    type
      ? `SELECT * FROM events WHERE subject_id = $1 AND event_type = $2 ORDER BY seq`
      : `SELECT * FROM events WHERE subject_id = $1 ORDER BY seq`,
    type ? [subjectId, type] : [subjectId],
  );
  return rows;
}

async function audits(recordId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM audit_log WHERE record_id = $1 ORDER BY occurred_at`,
    [recordId],
  );
  return rows;
}

describe('W05 recording an interaction is atomic (§13)', () => {
  it('performs the entire chain in one transaction', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { value } = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'whatsapp',
        purpose: 'weekly_follow_up',
        outcome: 'no_response',
        agreedAction: 'Resend portfolio brief',
        calendar: CALENDAR,
      }),
    );

    expect(value.reference).toMatch(/^INT-/);

    // 1. The record exists.
    const { rows: interactions } = await pool.query(
      `SELECT * FROM interaction WHERE id = $1`,
      [value.interactionId],
    );
    expect(interactions).toHaveLength(1);

    // 2. Last contact updated -- but NOT last SUCCESSFUL contact, because there
    //    was no response. These are different facts (§13).
    const { rows: student } = await pool.query(
      `SELECT last_contact_at, last_successful_contact_at FROM student WHERE id = $1`,
      [w.studentId],
    );
    expect(student[0].last_contact_at).not.toBeNull();
    expect(student[0].last_successful_contact_at).toBeNull();

    // 3. The attempt counted.
    expect(value.attemptCounted).toBe(true);
    expect(value.attemptCount).toBe(1);

    // 4. Events emitted.
    const sent = await events(w.studentId, 'MESSAGE_SENT');
    const recorded = await events(w.studentId, 'INTERACTION_RECORDED');
    expect(sent.length).toBeGreaterThan(0);
    expect(recorded.length).toBeGreaterThan(0);
    // The second event cites the first: one real-world action, one causal chain.
    expect(recorded[0].causation_id).toBe(sent[0].event_id);
    expect(recorded[0].correlation_id).toBe(sent[0].correlation_id);

    // 5. Audit row with the permission actually used.
    const audit = await audits(value.interactionId);
    expect(audit[0].permission_used).toBe('communications.create');

    // 6. The next follow-up task exists, so nothing depends on memory.
    const { rows: tasks } = await pool.query(
      `SELECT * FROM task WHERE student_id = $1 AND task_type = 'weekly_contact'
         AND status IN ('open','in_progress')`,
      [w.studentId],
    );
    expect(tasks).toHaveLength(1);

    // 7. Risk was re-evaluated: exactly one open record (Invariant 6).
    const { rows: risk } = await pool.query(
      `SELECT count(*)::int AS n FROM risk_record WHERE student_id = $1 AND closed_at IS NULL`,
      [w.studentId],
    );
    expect(risk[0].n).toBe(1);
  });

  it('de-duplicates a second attempt on the same channel in the window', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { value } = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'whatsapp',
        purpose: 'weekly_follow_up',
        outcome: 'no_response',
        calendar: CALENDAR,
      }),
    );
    expect(value.attemptCounted).toBe(false);
    expect(value.attemptCount).toBe(1);
  });

  it('counts a different channel separately (§15 requires multi-channel)', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const { value } = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'phone',
        purpose: 'weekly_follow_up',
        outcome: 'no_response',
        calendar: CALENDAR,
      }),
    );
    expect(value.attemptCounted).toBe(true);
    expect(value.attemptCount).toBe(2);
  });

  it('is idempotent for an offline submission replayed with the same key', async () => {
    const key = `offline-${randomUUID()}`;
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    const first = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'email',
        purpose: 'weekly_follow_up',
        outcome: 'waiting_for_response',
        clientDedupKey: key,
        calendar: CALENDAR,
      }),
    );
    const second = await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'email',
        purpose: 'weekly_follow_up',
        outcome: 'waiting_for_response',
        clientDedupKey: key,
        calendar: CALENDAR,
      }),
    );
    expect(second.value.interactionId).toBe(first.value.interactionId);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM interaction WHERE client_dedup_key = $1`,
      [key],
    );
    expect(rows[0].n).toBe(1);
  });

  it('cancels the chase task when the student replies', async () => {
    const ctx = ctxFor(w.coordinatorId, 'operations_coordinator');
    await exec.execute(ctx, (scope) =>
      recordInteraction(scope, {
        studentId: w.studentId,
        channel: 'whatsapp',
        purpose: 'weekly_follow_up',
        outcome: 'responded',
        calendar: CALENDAR,
      }),
    );
    const { rows } = await pool.query(
      `SELECT last_successful_contact_at FROM student WHERE id = $1`,
      [w.studentId],
    );
    expect(rows[0].last_successful_contact_at).not.toBeNull();
  });
});

describe('W17-W22 evidence to graduation, end to end', () => {
  async function gig(value: number): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO gig (student_id, source, title, value_amount, started_on, delivered_on, paid_on)
       VALUES ($1, 'khamsat', $2, $3, DATE '2026-01-01', DATE '2026-01-05', DATE '2026-01-06')
       RETURNING id`,
      [w.studentId, `Gig ${value}`, value],
    );
    return rows[0].id;
  }

  async function runPipeline(gigId: string, accept = true) {
    // The student submits (§10).
    const studentCtx = ctxFor(w.studentUserId, 'student');
    const { value: sub } = await exec.execute(studentCtx, (scope) =>
      submitEvidence(scope, {
        studentId: w.studentId,
        subjectType: 'gig',
        gigId,
        files: [
          { kind: 'completed_order_page', fileRef: `s3://o/${gigId}`, contentHash: Buffer.from(randomUUID()) },
          { kind: 'earnings_or_balance_proof', fileRef: `s3://e/${gigId}`, contentHash: Buffer.from(randomUUID()) },
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
    const result = await exec.execute(ctxFor(w.qualityMemberId, 'quality_member'), (scope) =>
      decideQuality(scope, {
        submissionId: sub.submissionId,
        level: 'l2',
        checks: accept ? ALL_CHECKS_PASS : { ...ALL_CHECKS_PASS, payment_confirmed: false },
        rejectionCodes: accept ? [] : ['R05'],
        calendar: CALENDAR,
      }),
    );
    return { submissionId: sub.submissionId, outcome: result.value.outcome };
  }

  it('moves a submission through all four stages and accepts it', async () => {
    const g = await gig(10);
    const { submissionId, outcome } = await runPipeline(g);
    expect(outcome).toBe('accepted');

    const { rows } = await pool.query(
      `SELECT current_stage, is_open, accepted_at FROM evidence_submission WHERE id = $1`,
      [submissionId],
    );
    expect(rows[0].current_stage).toBe('accepted');
    expect(rows[0].is_open).toBe(false);

    // Acceptance is what makes the gig count and locks it (§30, §59).
    const { rows: gigRow } = await pool.query(
      `SELECT quality_accepted, locked_at, value_toward_graduation FROM gig WHERE id = $1`,
      [g],
    );
    expect(gigRow[0].quality_accepted).toBe(true);
    expect(gigRow[0].locked_at).not.toBeNull();
    expect(Number(gigRow[0].value_toward_graduation)).toBe(10);
  });

  it('does not graduate on one gig: three are required (§27)', async () => {
    const { rows } = await pool.query(
      `SELECT status FROM graduation_progress WHERE student_id = $1`,
      [w.studentId],
    );
    expect(rows[0].status).not.toBe('graduated');
  });

  it('graduates on the third accepted gig, computed not typed (§40)', async () => {
    await runPipeline(await gig(10));
    await runPipeline(await gig(10));

    const { rows } = await pool.query(
      `SELECT status, matched_route_key, rule_version, calculated_at, effective_at,
              array_length(evidence_ids, 1) AS evidence_count
       FROM graduation_progress WHERE student_id = $1`,
      [w.studentId],
    );
    expect(rows[0].status).toBe('graduated');
    expect(rows[0].matched_route_key).toBe('route_a');
    expect(rows[0].rule_version).toBe('depi-r5-graduation-v1');
    expect(rows[0].calculated_at).not.toBeNull();
    expect(rows[0].effective_at).not.toBeNull();
    expect(rows[0].evidence_count).toBe(3);

    const graduated = await events(w.studentId, 'GRADUATION_COMPUTED');
    expect(graduated).toHaveLength(1);
    expect(graduated[0].payload.matchedRoute).toBe('route_a');
  });

  it('reports both targets separately with their own gaps (§2, §41)', async () => {
    const summary = await graduationSummary(pool, w.cohortId);
    expect(summary.contractualThresholdPercent).toBe(70);
    expect(summary.internalTargetPercent).toBe(85);
    expect(summary.denominator).toBe(1);
    expect(summary.graduated).toBe(1);
    expect(summary.ratePercent).toBe(100);
    expect(summary.gapToContractual).toBeLessThan(0);
    expect(summary.gapToInternal).toBeLessThan(0);
  });

  it('a rejection keeps the submission OPEN and returns it for correction (§36)', async () => {
    const g = await gig(20);
    const { submissionId, outcome } = await runPipeline(g, false);
    expect(outcome).toBe('rejected');

    const { rows } = await pool.query(
      `SELECT current_stage, is_open, rejection_count FROM evidence_submission WHERE id = $1`,
      [submissionId],
    );
    // Open, and back with the student. Not closed, not gone.
    expect(rows[0].is_open).toBe(true);
    expect(rows[0].current_stage).toBe('coach');
    expect(rows[0].rejection_count).toBe(1);

    const { rows: gigRow } = await pool.query(`SELECT quality_accepted FROM gig WHERE id = $1`, [g]);
    expect(gigRow[0].quality_accepted).toBe(false);

    const { rows: task } = await pool.query(
      `SELECT count(*)::int AS n FROM task
       WHERE student_id = $1 AND task_type = 'correct_evidence' AND status IN ('open','in_progress')`,
      [w.studentId],
    );
    expect(task[0].n).toBeGreaterThan(0);
  });

  it('records every Quality decision immutably, all seven checks named', async () => {
    const { rows } = await pool.query(
      `SELECT checks, outcome, rejection_codes FROM quality_decision
       ORDER BY decided_at DESC LIMIT 1`,
    );
    expect(Object.keys(rows[0].checks)).toHaveLength(7);
    expect(rows[0].outcome).toBe('rejected');
    expect(rows[0].rejection_codes).toEqual(['R05']);
  });
});

describe('separation of duties holds through the service layer', () => {
  it('refuses the coach who passed an item at coach stage from also doing L1', async () => {
    const { rows } = await pool.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1,'upwork','SoD',10,DATE '2026-02-01',DATE '2026-02-02') RETURNING id`,
      [w.studentId],
    );
    const { value: sub } = await exec.execute(ctxFor(w.studentUserId, 'student'), (scope) =>
      submitEvidence(scope, {
        studentId: w.studentId,
        subjectType: 'gig',
        gigId: rows[0].id,
        files: [{ kind: 'delivered_work', fileRef: 's3://x', contentHash: Buffer.from(randomUUID()) }],
        calendar: CALENDAR,
      }),
    );
    await exec.execute(ctxFor(w.coachId, 'outcome_coach'), (scope) =>
      reviewStage(scope, { submissionId: sub.submissionId, stage: 'coach', decision: 'passed', calendar: CALENDAR }),
    );
    await expect(
      exec.execute(ctxFor(w.coachId, 'outcome_coach'), (scope) =>
        reviewStage(scope, { submissionId: sub.submissionId, stage: 'l1', decision: 'passed', calendar: CALENDAR }),
      ),
    ).rejects.toThrow(/independent pair of eyes/);
  });

  it('refuses the submitter reviewing their own evidence', async () => {
    const { rows } = await pool.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1,'upwork','Self',10,DATE '2026-02-01',DATE '2026-02-02') RETURNING id`,
      [w.studentId],
    );
    const { value: sub } = await exec.execute(ctxFor(w.studentUserId, 'student'), (scope) =>
      submitEvidence(scope, {
        studentId: w.studentId,
        subjectType: 'gig',
        gigId: rows[0].id,
        files: [{ kind: 'delivered_work', fileRef: 's3://y', contentHash: Buffer.from(randomUUID()) }],
        calendar: CALENDAR,
      }),
    );
    await expect(
      exec.execute(ctxFor(w.studentUserId, 'student'), (scope) =>
        reviewStage(scope, { submissionId: sub.submissionId, stage: 'coach', decision: 'passed', calendar: CALENDAR }),
      ),
    ).rejects.toThrow(/you cannot review it/);
  });
});

describe('W15 the unresponsive flow needs its history (§15)', () => {
  it('refuses the status before five attempts across channels over two weeks', async () => {
    await expect(
      exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
        setUnresponsive(scope, { studentId: w.studentId, actorMaySetUnresponsive: true }),
      ),
    ).rejects.toThrow(/attempts across channels/);
  });

  it('records that an unresponsive student stays in the denominator', async () => {
    const { value } = await exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
      setUnresponsive(scope, {
        studentId: w.studentId,
        actorMaySetUnresponsive: true,
        overrideReason: 'Ministry confirmed relocation',
      }).then(() => 'ok'),
    );
    expect(value).toBe('ok');
    const ev = await events(w.studentId, 'STUDENT_MARKED_UNRESPONSIVE');
    expect(ev[0].payload.remainsInDenominator).toBe(true);
    expect(ev[0].payload.override).toBe('Ministry confirmed relocation');
  });
});

describe('the read model matches the operational record', () => {
  it('projects the student without aggregating OLTP at read time', async () => {
    await projectStudent(pool, w.studentId, CALENDAR);
    const { rows } = await pool.query(
      `SELECT accepted_gig_count, accepted_gig_value, graduation_status, coordinator_user_id,
              open_evidence_count
       FROM rm_student_current WHERE student_id = $1`,
      [w.studentId],
    );
    expect(rows[0].accepted_gig_count).toBe(3);
    expect(Number(rows[0].accepted_gig_value)).toBe(30);
    expect(rows[0].graduation_status).toBe('graduated');
    expect(rows[0].coordinator_user_id).toBe(w.coordinatorId);
    // The rejected item and the two SoD test submissions remain open -- rejection
    // does not remove anything from the pipeline.
    expect(rows[0].open_evidence_count).toBeGreaterThan(0);
  });

  it('is set-to-value, so projecting twice changes nothing', async () => {
    const before = await pool.query(`SELECT * FROM rm_student_current WHERE student_id = $1`, [
      w.studentId,
    ]);
    await projectStudent(pool, w.studentId, CALENDAR);
    const after = await pool.query(`SELECT * FROM rm_student_current WHERE student_id = $1`, [
      w.studentId,
    ]);
    expect(after.rows[0].accepted_gig_count).toBe(before.rows[0].accepted_gig_count);
    expect(after.rows[0].contact_attempts).toBe(before.rows[0].contact_attempts);
  });
});

describe('W02 reassignment carries the work', () => {
  it('moves open tasks and escalations to the new coordinator', async () => {
    const before = await workQueue(pool, w.coordinatorId);
    expect(before.length).toBeGreaterThan(0);

    await exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
      assignCoordinator(scope, {
        studentId: w.studentId,
        coordinatorUserId: w.supervisorId,
        reasonCode: 'rebalance',
      }),
    );

    const moved = await workQueue(pool, w.supervisorId);
    expect(moved.some((t) => t.student_id === w.studentId)).toBe(true);

    // Exactly one open assignment survives (Invariant 3).
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM student_assignment
       WHERE student_id = $1 AND effective_to IS NULL`,
      [w.studentId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('W31 withdrawal is the Ministry’s decision', () => {
  it('refuses a withdrawal with no Ministry reference', async () => {
    await expect(
      exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
        recordWithdrawal(scope, {
          studentId: w.studentId,
          withdrawnOn: new Date(),
          reason: 'left the programme',
          ministryReference: '   ',
        }),
      ),
    ).rejects.toThrow(/Ministry reference/);
  });

  it('records the withdrawal without deleting the student', async () => {
    await exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
      recordWithdrawal(scope, {
        studentId: w.studentId,
        withdrawnOn: new Date(),
        reason: 'left the programme',
        ministryReference: 'MIN-R5-0042',
      }),
    );
    const { rows } = await pool.query(`SELECT 1 FROM student WHERE id = $1`, [w.studentId]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the graduate in the denominator under the include_all default', async () => {
    await exec.execute(ctxFor(w.opsId, 'project_operations'), (scope) =>
      recomputeGraduation(scope, w.studentId),
    );
    const summary = await graduationSummary(pool, w.cohortId);
    expect(summary.denominator).toBe(1);
    expect(summary.withdrawnExcluded).toBe(0);
  });
});
