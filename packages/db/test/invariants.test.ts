/**
 * Data-integrity tests (docs/11 §6).
 *
 * These deliberately bypass every layer of application code and attack the
 * database directly. The claim under test is not "the service layer prevents
 * this" -- it is "if the service layer were removed entirely, the database would
 * still refuse". Each test names the invariant it defends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { client, expectRefused, insertEvent, seed, type Fixture } from './helpers.ts';

let c: pg.Client;
let f: Fixture;

beforeAll(async () => {
  c = client();
  await c.connect();
  f = await seed(c);
});

afterAll(async () => {
  await c.end();
});

describe('Invariant 1 -- exactly one master record per student', () => {
  it('refuses a duplicate identity key within a cohort', async () => {
    const { rows } = await c.query('SELECT identity_key FROM student WHERE id = $1', [f.studentId]);
    const err = await expectRefused(
      c,
      `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164)
       VALUES ($1, $2, 'Duplicate', '+201000000001')`,
      [f.cohortId, rows[0].identity_key],
    );
    expect(err.code).toBe('23505');
  });

  it('allows the same person in a different cohort', async () => {
    const g = await seed(c);
    const { rows } = await c.query('SELECT identity_key FROM student WHERE id = $1', [f.studentId]);
    await expect(
      c.query(
        `INSERT INTO student (cohort_id, identity_key, full_name, phone_e164)
         VALUES ($1, $2, 'Same person, next cohort', '+201000000002')`,
        [g.cohortId, rows[0].identity_key],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a student with neither phone nor email', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO student (cohort_id, identity_key, full_name) VALUES ($1, $2, 'Unreachable')`,
      [f.cohortId, `unreachable_${Date.now()}`],
    );
    expect(err.message).toContain('student_contactable');
  });
});

describe('Invariant 2 -- exactly one current lifecycle stage', () => {
  it('refuses overlapping stage ranges', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_stage_history (student_id, stage, entered_at)
       VALUES ($1, 'assigned', now() - interval '5 days')`,
      [s],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO student_stage_history (student_id, stage, entered_at)
       VALUES ($1, 'contacted', now() - interval '2 days')`,
      [s],
    );
    expect(err.code).toBe('23P01'); // exclusion_violation
  });

  it('accepts a new stage once the previous one is closed', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_stage_history (student_id, stage, entered_at, exited_at)
       VALUES ($1, 'assigned', now() - interval '5 days', now() - interval '2 days')`,
      [s],
    );
    await expect(
      c.query(
        `INSERT INTO student_stage_history (student_id, stage, entered_at)
         VALUES ($1, 'contacted', now() - interval '2 days')`,
        [s],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a stage that exits before it is entered', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO student_stage_history (student_id, stage, entered_at, exited_at)
       VALUES ($1, 'assigned', now(), now() - interval '1 day')`,
      [s],
    );
    expect(err.message).toContain('stage_range');
  });
});

describe('Invariant 3 -- exactly one coordinator, or an explicit UNASSIGNED', () => {
  it('refuses two open assignments for one student', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
       VALUES ($1, $2, now() - interval '3 days')`,
      [s, f.userA],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
       VALUES ($1, $2, now() - interval '1 day')`,
      [s, f.userB],
    );
    expect(err.code).toBe('23P01');
  });

  it('permits a reassignment once the prior row is closed', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from, effective_to)
       VALUES ($1, $2, now() - interval '3 days', now() - interval '1 day')`,
      [s, f.userA],
    );
    await expect(
      c.query(
        `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
         VALUES ($1, $2, now() - interval '1 day')`,
        [s, f.userB],
      ),
    ).resolves.toBeTruthy();
  });

  it('models UNASSIGNED as an open row with a null coordinator, not a missing row', async () => {
    // This is what gives "unassigned" an age clock on the control tower rather
    // than making it an invisible gap.
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from, reason_code)
       VALUES ($1, NULL, now(), 'coordinator_deactivated')`,
      [s],
    );
    const { rows } = await c.query(
      `SELECT coordinator_user_id, effective_from FROM student_assignment
       WHERE student_id = $1 AND effective_to IS NULL`,
      [s],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].coordinator_user_id).toBeNull();
    expect(rows[0].effective_from).toBeInstanceOf(Date);
  });

  it('keeps coach assignments independent per coaching type', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO student_coach_assignment (student_id, coach_user_id, coaching_type, effective_from)
       VALUES ($1, $2, 't1', now())`,
      [s, f.userA],
    );
    await expect(
      c.query(
        `INSERT INTO student_coach_assignment (student_id, coach_user_id, coaching_type, effective_from)
         VALUES ($1, $2, 't2', now())`,
        [s, f.userB],
      ),
    ).resolves.toBeTruthy();
    const err = await expectRefused(
      c,
      `INSERT INTO student_coach_assignment (student_id, coach_user_id, coaching_type, effective_from)
       VALUES ($1, $2, 't1', now())`,
      [s, f.userB],
    );
    expect(err.code).toBe('23P01');
  });
});

describe('Invariant 4 -- one hierarchy resolution at any timestamp', () => {
  it('refuses overlapping memberships of the same team type', async () => {
    const t1 = await c.query(
      `INSERT INTO team (cohort_id, name, team_type) VALUES ($1, $2, 'operations') RETURNING id`,
      [f.cohortId, `ops_a_${Date.now()}`],
    );
    const t2 = await c.query(
      `INSERT INTO team (cohort_id, name, team_type) VALUES ($1, $2, 'operations') RETURNING id`,
      [f.cohortId, `ops_b_${Date.now()}`],
    );
    await c.query(
      `INSERT INTO org_membership (user_id, team_id, effective_from) VALUES ($1, $2, now())`,
      [f.userA, t1.rows[0].id],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO org_membership (user_id, team_id, effective_from) VALUES ($1, $2, now())`,
      [f.userA, t2.rows[0].id],
    );
    expect(err.code).toBe('23P01');
  });

  it('allows one person to sit in an operations team and a coaching team at once', async () => {
    const coaching = await c.query(
      `INSERT INTO team (cohort_id, name, team_type) VALUES ($1, $2, 'coaching_t1') RETURNING id`,
      [f.cohortId, `coach_${Date.now()}`],
    );
    await expect(
      c.query(
        `INSERT INTO org_membership (user_id, team_id, effective_from) VALUES ($1, $2, now())`,
        [f.userA, coaching.rows[0].id],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('Invariant 6 -- exactly one current risk status', () => {
  it('refuses a second open risk record', async () => {
    const s = (await seed(c)).studentId;
    await c.query(`INSERT INTO risk_record (student_id, level) VALUES ($1, 'amber')`, [s]);
    const err = await expectRefused(
      c,
      `INSERT INTO risk_record (student_id, level) VALUES ($1, 'red')`,
      [s],
    );
    expect(err.code).toBe('23505');
  });

  it('allows a new record once the previous one is closed', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO risk_record (student_id, level, closed_at) VALUES ($1, 'amber', now())`,
      [s],
    );
    await expect(
      c.query(`INSERT INTO risk_record (student_id, level) VALUES ($1, 'red')`, [s]),
    ).resolves.toBeTruthy();
  });

  it('refuses a manual override without a reason and a review date', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO risk_record (student_id, level, origin) VALUES ($1, 'red', 'manual')`,
      [s],
    );
    expect(err.message).toContain('manual_override_needs_review');
  });

  it('accepts a manual override that carries both', async () => {
    const s = (await seed(c)).studentId;
    await expect(
      c.query(
        `INSERT INTO risk_record (student_id, level, origin, override_reason, review_due_at)
         VALUES ($1, 'red', 'manual', 'coach judgement', now() + interval '14 days')`,
        [s],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('Invariant 7 -- one complete, gapless operational history', () => {
  it('refuses an UPDATE to the event log', async () => {
    const id = await insertEvent(c, f);
    const err = await expectRefused(c, `UPDATE events SET event_type = 'TAMPERED' WHERE event_id = $1`, [
      id,
    ]);
    expect(err.message).toContain('append-only');
  });

  it('refuses a DELETE from the event log', async () => {
    const id = await insertEvent(c, f);
    const err = await expectRefused(c, `DELETE FROM events WHERE event_id = $1`, [id]);
    expect(err.message).toContain('append-only');
  });

  it('refuses mutation of the audit log', async () => {
    await c.query(
      `INSERT INTO audit_log (module, record_type, record_id, action)
       VALUES ('students', 'student', $1, 'assign')`,
      [f.studentId],
    );
    const err = await expectRefused(c, `DELETE FROM audit_log WHERE record_id = $1`, [f.studentId]);
    expect(err.message).toContain('append-only');
  });

  it('chains each event to its predecessor so tampering is detectable', async () => {
    const a = await insertEvent(c, f);
    const b = await insertEvent(c, f);
    const { rows } = await c.query(
      `SELECT event_id, prev_hash, hash FROM events WHERE event_id = ANY($1) ORDER BY seq`,
      [[a, b]],
    );
    expect(rows[0].hash).not.toBeNull();
    expect(rows[1].prev_hash).toEqual(rows[0].hash);
  });

  it('rejects an event from an unknown source', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO events (event_type, occurred_at, subject_type, subject_id, correlation_id, source)
       VALUES ('X', now(), 'student', $1, gen_random_uuid(), 'SPREADSHEET')`,
      [f.studentId],
    );
    expect(err.code).toBe('23514');
  });
});

describe('Invariant 8 -- one graduation progress record', () => {
  it('refuses a second record for the same student', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO graduation_progress (student_id, cohort_id, denominator_policy_applied)
       VALUES ($1, $2, 'include_all')`,
      [s, f.cohortId],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO graduation_progress (student_id, cohort_id, denominator_policy_applied)
       VALUES ($1, $2, 'include_all')`,
      [s, f.cohortId],
    );
    expect(err.code).toBe('23505');
  });
});

describe('task de-duplication (AC-05)', () => {
  it('refuses a second open task with the same dedup key', async () => {
    const s = (await seed(c)).studentId;
    const key = `${s}:followup`;
    await c.query(
      `INSERT INTO task (student_id, task_type, owner_user_id, source, dedup_key)
       VALUES ($1, 'followup', $2, 'sla', $3)`,
      [s, f.userA, key],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO task (student_id, task_type, owner_user_id, source, dedup_key)
       VALUES ($1, 'followup', $2, 'sla', $3)`,
      [s, f.userA, key],
    );
    expect(err.code).toBe('23505');
  });

  it('permits a new task once the previous one is completed', async () => {
    const s = (await seed(c)).studentId;
    const key = `${s}:followup`;
    await c.query(
      `INSERT INTO task (student_id, task_type, owner_user_id, source, dedup_key, status, completed_at)
       VALUES ($1, 'followup', $2, 'sla', $3, 'completed', now())`,
      [s, f.userA, key],
    );
    await expect(
      c.query(
        `INSERT INTO task (student_id, task_type, owner_user_id, source, dedup_key)
         VALUES ($1, 'followup', $2, 'sla', $3)`,
        [s, f.userA, key],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a cancellation with no reason', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO task (student_id, task_type, owner_user_id, source, status)
       VALUES ($1, 'followup', $2, 'sla', 'cancelled')`,
      [s, f.userA],
    );
    expect(err.message).toContain('cancel_needs_reason');
  });
});

describe('configuration safety', () => {
  it('refuses two published config versions in force at once', async () => {
    await c.query(
      `INSERT INTO cohort_config_version (cohort_id, version_no, effective_from, published_at)
       VALUES ($1, 1, now() - interval '10 days', now())`,
      [f.cohortId],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO cohort_config_version (cohort_id, version_no, effective_from, published_at)
       VALUES ($1, 2, now() - interval '5 days', now())`,
      [f.cohortId],
    );
    expect(err.code).toBe('23P01');
  });

  it('allows an unpublished draft to overlap a published version', async () => {
    await expect(
      c.query(
        `INSERT INTO cohort_config_version (cohort_id, version_no, effective_from)
         VALUES ($1, 3, now() - interval '5 days')`,
        [f.cohortId],
      ),
    ).resolves.toBeTruthy();
  });

  it('defaults a cohort to the conservative denominator policy (register item 2)', async () => {
    const { rows } = await c.query('SELECT denominator_policy, single_approver_mode FROM cohort WHERE id = $1', [
      f.cohortId,
    ]);
    expect(rows[0].denominator_policy).toBe('include_all');
    expect(rows[0].single_approver_mode).toBe(false);
  });
});

describe('delegation cannot become an ownership leak', () => {
  it('requires an end date', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO delegation (from_user_id, to_user_id, scope, from_date, created_by, reason)
       VALUES ($1, $2, 'students', now(), $1, 'leave')`,
      [f.userA, f.userB],
    );
    expect(err.code).toBe('23502'); // not-null violation
  });

  it('refuses self-delegation', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO delegation (from_user_id, to_user_id, scope, from_date, to_date, created_by, reason)
       VALUES ($1, $1, 'students', now(), now() + interval '5 days', $1, 'leave')`,
      [f.userA],
    );
    expect(err.message).toContain('delegation_not_self');
  });
});
