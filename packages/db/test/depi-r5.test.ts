/**
 * Confirmed DEPI Round 5 rules, enforced by the database and attacked directly.
 *
 * Each test names the requirement it defends. As in 0001, the claim is not "the
 * service layer prevents this" but "the database refuses it even with the
 * application removed".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { client, expectRefused, seed, type Fixture } from './helpers.ts';

let c: pg.Client;
let f: Fixture;
let trackId: string;
let groupId: string;

const SEVEN_CHECKS = {
  evidence_completeness: true,
  identity_match: true,
  delivery_confirmed: true,
  payment_confirmed: true,
  value_threshold: true,
  work_authenticity: true,
  no_duplication: true,
};

beforeAll(async () => {
  c = client();
  await c.connect();
  f = await seed(c);
  const t = await c.query(
    `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1, $2, '{"en":"Data"}'::jsonb)
     RETURNING id`,
    [f.cohortId, `trk_${Date.now()}`],
  );
  trackId = t.rows[0].id;
  const g = await c.query(
    `INSERT INTO cohort_group (cohort_id, code, track_id, planned_session_count)
     VALUES ($1, $2, $3, 8) RETURNING id`,
    [f.cohortId, `grp_${Date.now()}`, trackId],
  );
  groupId = g.rows[0].id;
  await c.query(
    `INSERT INTO coach_specialisation (coach_user_id, track_id) VALUES ($1, $2)`,
    [f.userA, trackId],
  );
});

afterAll(async () => {
  await c.end();
});

async function newGroup(code = `g_${Math.random().toString(36).slice(2)}`) {
  const r = await c.query(
    `INSERT INTO cohort_group (cohort_id, code, track_id) VALUES ($1, $2, $3) RETURNING id`,
    [f.cohortId, code, trackId],
  );
  return r.rows[0].id as string;
}

describe('coach scheduling (§16, §17)', () => {
  it('refuses two groups for one coach on the same day', async () => {
    // The three Ministry slots overlap, so same-day is same-time in practice.
    const g1 = await newGroup();
    const g2 = await newGroup();
    await c.query(
      `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                            scheduled_date, slot_key)
       VALUES ($1, $2, $3, 1, DATE '2026-04-05', 'slot_17_20')`,
      [g1, trackId, f.userA],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                            scheduled_date, slot_key)
       VALUES ($1, $2, $3, 1, DATE '2026-04-05', 'slot_19_22')`,
      [g2, trackId, f.userA],
    );
    expect(err.code).toBe('23505');
  });

  it('allows the same coach on consecutive days', async () => {
    const g = await newGroup();
    await expect(
      c.query(
        `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                              scheduled_date, slot_key)
         VALUES ($1, $2, $3, 1, DATE '2026-04-06', 'slot_17_20')`,
        [g, trackId, f.userA],
      ),
    ).resolves.toBeTruthy();
  });

  it('frees the day once a session is cancelled, so a replacement can be scheduled', async () => {
    const g1 = await newGroup();
    const g2 = await newGroup();
    await c.query(
      `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                            scheduled_date, slot_key, status)
       VALUES ($1, $2, $3, 1, DATE '2026-04-07', 'slot_17_20', 'cancelled')`,
      [g1, trackId, f.userA],
    );
    await expect(
      c.query(
        `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                              scheduled_date, slot_key)
         VALUES ($1, $2, $3, 1, DATE '2026-04-07', 'slot_17_20')`,
        [g2, trackId, f.userA],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a coach assigned outside their specialist track', async () => {
    const other = await c.query(
      `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1, $2, '{"en":"Design"}'::jsonb)
       RETURNING id`,
      [f.cohortId, `trk2_${Date.now()}`],
    );
    const g = await newGroup();
    const err = await expectRefused(
      c,
      `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                            scheduled_date, slot_key)
       VALUES ($1, $2, $3, 1, DATE '2026-05-01', 'slot_17_20')`,
      [g, other.rows[0].id, f.userA],
    );
    expect(err.message).toContain('not specialised');
  });

  it('refuses delivery while attendance is still pending (§67)', async () => {
    const g = await newGroup();
    const s = await c.query(
      `INSERT INTO session (cohort_group_id, track_id, coach_user_id, session_number,
                            scheduled_date, slot_key)
       VALUES ($1, $2, $3, 1, DATE '2026-06-01', 'slot_17_20') RETURNING id`,
      [g, trackId, f.userA],
    );
    await c.query(`INSERT INTO attendance (session_id, student_id) VALUES ($1, $2)`, [
      s.rows[0].id,
      f.studentId,
    ]);
    const err = await expectRefused(c, `UPDATE session SET status = 'delivered' WHERE id = $1`, [
      s.rows[0].id,
    ]);
    expect(err.message).toContain('attendance is still pending');

    await c.query(
      `UPDATE attendance SET state = 'attended', recorded_at = now() WHERE session_id = $1`,
      [s.rows[0].id],
    );
    await expect(
      c.query(`UPDATE session SET status = 'delivered' WHERE id = $1`, [s.rows[0].id]),
    ).resolves.toBeTruthy();
  });
});

describe('rolling cohort (§2)', () => {
  it('tracks the group’s own session position, not calendar elapsed time', async () => {
    const { rows } = await c.query(
      `SELECT current_session_number, planned_session_count FROM cohort_group WHERE id = $1`,
      [groupId],
    );
    expect(rows[0].current_session_number).toBe(0);
    expect(rows[0].planned_session_count).toBe(8);
  });

  it('refuses a session position beyond the plan', async () => {
    const err = await expectRefused(
      c,
      `UPDATE cohort_group SET current_session_number = 9 WHERE id = $1`,
      [groupId],
    );
    expect(err.message).toContain('group_session_position');
  });
});

describe('contact attempts are per channel (§15)', () => {
  it('de-duplicates within a channel and window', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO contact_attempt (student_id, attempt_no, channel, window_key)
       VALUES ($1, 1, 'whatsapp', 'w100')`,
      [s],
    );
    const err = await expectRefused(
      c,
      `INSERT INTO contact_attempt (student_id, attempt_no, channel, window_key)
       VALUES ($1, 2, 'whatsapp', 'w100')`,
      [s],
    );
    expect(err.code).toBe('23505');
  });

  it('counts a different channel in the same window as a separate attempt', async () => {
    // Five WhatsApp messages are one channel's worth of effort; the requirement
    // is attempts across DIFFERENT channels.
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO contact_attempt (student_id, attempt_no, channel, window_key)
       VALUES ($1, 1, 'whatsapp', 'w100')`,
      [s],
    );
    await expect(
      c.query(
        `INSERT INTO contact_attempt (student_id, attempt_no, channel, window_key)
         VALUES ($1, 2, 'phone', 'w100')`,
        [s],
      ),
    ).resolves.toBeTruthy();
  });

  it('distinguishes "never contacted" from "contacted, no response" (§13)', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO interaction (student_id, staff_user_id, channel, purpose, outcome)
       VALUES ($1, $2, 'whatsapp', 'weekly_follow_up', 'no_response')`,
      [s, f.userA],
    );
    const { rows } = await c.query(
      `SELECT s.last_contact_at, s.last_successful_contact_at,
              (SELECT count(*) FROM interaction WHERE student_id = s.id)::int AS attempts
       FROM student s WHERE s.id = $1`,
      [s],
    );
    // An attempt exists, but no successful contact: two different facts, two
    // different columns, two different accountabilities.
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_successful_contact_at).toBeNull();
  });
});

describe('withdrawal is the Ministry’s decision (§43)', () => {
  it('refuses a withdrawal with no Ministry reference', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO withdrawal (student_id, withdrawn_on, reason, ministry_reference,
                               previous_status, recorded_by)
       VALUES ($1, CURRENT_DATE, 'left', '', 'coaching', $2)`,
      [s, f.userA],
    );
    expect(err.message).toContain('ministry_reference_not_blank');
  });

  it('records the withdrawal without deleting the student', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO withdrawal (student_id, withdrawn_on, reason, ministry_reference,
                               previous_status, recorded_by)
       VALUES ($1, CURRENT_DATE, 'left', 'MIN-2026-114', 'coaching', $2)`,
      [s, f.userA],
    );
    const { rows } = await c.query('SELECT 1 FROM student WHERE id = $1', [s]);
    expect(rows).toHaveLength(1);
  });
});

describe('services: three per student, rejection never closes (§25)', () => {
  it('refuses a fourth service', async () => {
    const s = (await seed(c)).studentId;
    for (const i of [1, 2, 3]) {
      await c.query(
        `INSERT INTO service (student_id, service_index) VALUES ($1, $2)`,
        [s, i],
      );
    }
    const err = await expectRefused(
      c,
      `INSERT INTO service (student_id, service_index) VALUES ($1, 4)`,
      [s],
    );
    expect(err.code).toBe('23514');
  });

  it('refuses a duplicate service index', async () => {
    const s = (await seed(c)).studentId;
    await c.query(`INSERT INTO service (student_id, service_index) VALUES ($1, 1)`, [s]);
    const err = await expectRefused(
      c,
      `INSERT INTO service (student_id, service_index) VALUES ($1, 1)`,
      [s],
    );
    expect(err.code).toBe('23505');
  });

  it('refuses a rejection with no code', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO service (student_id, service_index, state) VALUES ($1, 1, 'rejected')`,
      [s],
    );
    expect(err.message).toContain('rejection_requires_code');
  });

  it('refuses to treat a rejected service as accepted', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO service (student_id, service_index, state, rejection_code, accepted_at)
       VALUES ($1, 1, 'rejected', 'R05', now())`,
      [s],
    );
    expect(err.message).toContain('rejected_service_not_accepted');
  });

  it('permits the correction loop back to acceptance', async () => {
    const s = (await seed(c)).studentId;
    await c.query(
      `INSERT INTO service (student_id, service_index, state, rejection_code)
       VALUES ($1, 1, 'rejected', 'R05')`,
      [s],
    );
    await c.query(`UPDATE service SET state = 'correction' WHERE student_id = $1`, [s]);
    await c.query(`UPDATE service SET state = 'resubmitted' WHERE student_id = $1`, [s]);
    await expect(
      c.query(
        `UPDATE service SET state = 'accepted', accepted_at = now() WHERE student_id = $1`,
        [s],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('gigs count only when delivered, paid and accepted (§30)', () => {
  it('refuses acceptance without delivery and payment dates', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO gig (student_id, source, title, value_amount, quality_accepted)
       VALUES ($1, 'khamsat', 'Logo', 10, true)`,
      [s],
    );
    expect(err.message).toContain('gig_accepted_requires_delivery_and_payment');
  });

  it('refuses a payment date before delivery', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO gig (student_id, source, title, value_amount, started_on, delivered_on, paid_on)
       VALUES ($1, 'khamsat', 'Logo', 10, DATE '2026-01-01', DATE '2026-02-01', DATE '2026-01-15')`,
      [s],
    );
    expect(err.message).toContain('gig_dates_ordered');
  });

  it('refuses a negative gig value (§67)', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO gig (student_id, source, title, value_amount) VALUES ($1, 'upwork', 'X', -1)`,
      [s],
    );
    expect(err.code).toBe('23514');
  });
});

describe('the evidence pipeline keeps rejections open (§36)', () => {
  async function submission(studentId: string) {
    const g = await c.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1, 'khamsat', 'Logo', 10, DATE '2026-01-01', DATE '2026-01-02') RETURNING id`,
      [studentId],
    );
    const r = await c.query(
      `INSERT INTO evidence_submission (student_id, submitted_by, subject_type, gig_id)
       VALUES ($1, $2, 'gig', $3) RETURNING id`,
      [studentId, f.userA, g.rows[0].id],
    );
    return r.rows[0].id as string;
  }

  it('refuses to close a submission that has not been accepted', async () => {
    const s = (await seed(c)).studentId;
    const sub = await submission(s);
    const err = await expectRefused(
      c,
      `UPDATE evidence_submission SET is_open = false WHERE id = $1`,
      [sub],
    );
    expect(err.message).toContain('closed_only_when_accepted_or_withdrawn');
  });

  it('requires an acceptance timestamp exactly when the stage is accepted', async () => {
    const s = (await seed(c)).studentId;
    const sub = await submission(s);
    const err = await expectRefused(
      c,
      `UPDATE evidence_submission SET current_stage = 'accepted' WHERE id = $1`,
      [sub],
    );
    expect(err.message).toContain('accepted_evidence_is_closed');

    await expect(
      c.query(
        `UPDATE evidence_submission
         SET current_stage = 'accepted', accepted_at = now(), is_open = false WHERE id = $1`,
        [sub],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a submission whose subject type and foreign key disagree', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO evidence_submission (student_id, submitted_by, subject_type)
       VALUES ($1, $2, 'gig')`,
      [s, f.userA],
    );
    expect(err.message).toContain('evidence_subject_matches');
  });
});

describe('Quality decisions are binary and immutable (§33, §36, §59)', () => {
  async function submissionFor(studentId: string) {
    const g = await c.query(
      `INSERT INTO gig (student_id, source, title, value_amount, delivered_on, paid_on)
       VALUES ($1, 'mostaql', 'Site', 20, DATE '2026-01-01', DATE '2026-01-02') RETURNING id`,
      [studentId],
    );
    const r = await c.query(
      `INSERT INTO evidence_submission (student_id, submitted_by, subject_type, gig_id)
       VALUES ($1, $2, 'gig', $3) RETURNING id`,
      [studentId, f.userA, g.rows[0].id],
    );
    return r.rows[0].id as string;
  }

  it('refuses a decision that does not record all seven checks', async () => {
    const sub = await submissionFor((await seed(c)).studentId);
    const { no_duplication: _drop, ...six } = SEVEN_CHECKS;
    const err = await expectRefused(
      c,
      `INSERT INTO quality_decision (submission_id, level, reviewer_id, received_at, due_at,
                                     outcome, checks)
       VALUES ($1, 'l2', $2, now(), now(), 'accepted', $3::jsonb)`,
      [sub, f.userB, JSON.stringify(six)],
    );
    expect(err.message).toContain('all_seven_checks_recorded');
  });

  it('refuses a rejection with no coded reason (§34)', async () => {
    const sub = await submissionFor((await seed(c)).studentId);
    const err = await expectRefused(
      c,
      `INSERT INTO quality_decision (submission_id, level, reviewer_id, received_at, due_at,
                                     outcome, checks)
       VALUES ($1, 'l2', $2, now(), now(), 'rejected', $3::jsonb)`,
      [sub, f.userB, JSON.stringify({ ...SEVEN_CHECKS, payment_confirmed: false })],
    );
    expect(err.message).toContain('rejection_requires_coded_reason');
  });

  it('refuses an acceptance that also carries a rejection code', async () => {
    const sub = await submissionFor((await seed(c)).studentId);
    const err = await expectRefused(
      c,
      `INSERT INTO quality_decision (submission_id, level, reviewer_id, received_at, due_at,
                                     outcome, checks, rejection_codes)
       VALUES ($1, 'l2', $2, now(), now(), 'accepted', $3::jsonb, ARRAY['R05'])`,
      [sub, f.userB, JSON.stringify(SEVEN_CHECKS)],
    );
    expect(err.message).toContain('acceptance_carries_no_rejection_code');
  });

  it('refuses any update or delete of a recorded decision', async () => {
    const sub = await submissionFor((await seed(c)).studentId);
    const d = await c.query(
      `INSERT INTO quality_decision (submission_id, level, reviewer_id, received_at, due_at,
                                     outcome, checks)
       VALUES ($1, 'l2', $2, now(), now(), 'accepted', $3::jsonb) RETURNING id`,
      [sub, f.userB, JSON.stringify(SEVEN_CHECKS)],
    );
    const upd = await expectRefused(
      c,
      `UPDATE quality_decision SET outcome = 'rejected' WHERE id = $1`,
      [d.rows[0].id],
    );
    expect(upd.message).toContain('append-only');
    const del = await expectRefused(c, `DELETE FROM quality_decision WHERE id = $1`, [
      d.rows[0].id,
    ]);
    expect(del.message).toContain('append-only');
  });
});

describe('graduation is computed, never typed (§40)', () => {
  it('refuses a graduated record with no calculation behind it', async () => {
    const s = (await seed(c)).studentId;
    const err = await expectRefused(
      c,
      `INSERT INTO graduation_progress (student_id, cohort_id, denominator_policy_applied, status)
       VALUES ($1, $2, 'include_all', 'graduated')`,
      [s, f.cohortId],
    );
    expect(err.message).toContain('graduation_must_be_computed');
  });

  it('accepts a graduated record that records its rule version and calculation', async () => {
    const s = (await seed(c)).studentId;
    await expect(
      c.query(
        `INSERT INTO graduation_progress (student_id, cohort_id, denominator_policy_applied,
                                          status, rule_version, calculated_at, pathway)
         VALUES ($1, $2, 'include_all', 'graduated', 'depi-r5-graduation-v1', now(), 'outcome')`,
        [s, f.cohortId],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('complaints stay independent (§44)', () => {
  it('refuses an owner who is the subject of the complaint', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO complaint (category, subject_user_id, owner_user_id, description)
       VALUES ('coach', $1, $1, 'concern about conduct')`,
      [f.userA],
    );
    expect(err.message).toContain('complaint_owner_not_subject');
  });

  it('refuses closure with no resolution recorded (§67)', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO complaint (category, subject_user_id, owner_user_id, description, status)
       VALUES ('coach', $1, $2, 'concern', 'closed')`,
      [f.userA, f.userB],
    );
    expect(err.message).toContain('complaint_closure_requires_resolution');
  });
});

describe('entitlement is tracked, not auto-applied (§53)', () => {
  it('refuses an applied entitlement with no reference', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO entitlement (subject_type, subject_id, cohort_id, kind, amount, applied)
       VALUES ('staff', $1, $2, 'commission', 100, true)`,
      [f.userA, f.cohortId],
    );
    expect(err.message).toContain('application_requires_reference');
  });

  it('accrues without applying by default', async () => {
    const r = await c.query(
      `INSERT INTO entitlement (subject_type, subject_id, cohort_id, kind, amount)
       VALUES ('staff', $1, $2, 'commission', 100) RETURNING applied`,
      [f.userA, f.cohortId],
    );
    expect(r.rows[0].applied).toBe(false);
  });
});

describe('performance: red-line incidents bypass staged progression (§54)', () => {
  it('refuses a red-line record carrying a stage', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO performance_record (staff_user_id, metric_key, threshold_kind, stage,
                                       incident_kind)
       VALUES ($1, 'conduct', 'red_line', 1, 'falsifying_evidence')`,
      [f.userA],
    );
    expect(err.message).toContain('red_line_has_no_stage');
  });

  it('requires a named incident kind for a red-line record', async () => {
    const err = await expectRefused(
      c,
      `INSERT INTO performance_record (staff_user_id, metric_key, threshold_kind)
       VALUES ($1, 'conduct', 'red_line')`,
      [f.userA],
    );
    expect(err.message).toContain('red_line_has_no_stage');
  });

  it('accepts an ordinary staged performance record', async () => {
    await expect(
      c.query(
        `INSERT INTO performance_record (staff_user_id, metric_key, threshold_kind, stage)
         VALUES ($1, 'contact_compliance', 'review', 1)`,
        [f.userA],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('report snapshots are immutable (§61)', () => {
  it('refuses to rewrite a generated report', async () => {
    const r = await c.query(
      `INSERT INTO report_snapshot (report_key, cohort_id, payload)
       VALUES ('weekly_consolidated', $1, '{"graduation_percent": 63}'::jsonb) RETURNING id`,
      [f.cohortId],
    );
    const err = await expectRefused(
      c,
      `UPDATE report_snapshot SET payload = '{"graduation_percent": 99}'::jsonb WHERE id = $1`,
      [r.rows[0].id],
    );
    expect(err.message).toContain('append-only');
  });
});
