import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SEED_ROLES_BY_KEY, type Actor } from '@coordinator/permissions';
import type { WorkingCalendar } from '@coordinator/rules';
import type { RequestContext } from '../src/context.ts';

export const URL =
  process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator';

export function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: URL, max: 6 });
}

export const CALENDAR: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(),
};

export interface World {
  cohortId: string;
  groupId: string;
  trackId: string;
  studentId: string;
  studentUserId: string;
  coordinatorId: string;
  supervisorId: string;
  coachId: string;
  qualityMemberId: string;
  qualityLeadId: string;
  opsId: string;
}

async function user(pool: pg.Pool, name: string, roleKey: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
    [`${name}_${randomUUID().slice(0, 8)}@example.test`, name],
  );
  const id = rows[0].id as string;
  const { rows: role } = await pool.query(`SELECT id FROM role WHERE key = $1`, [roleKey]);
  if (role[0]) {
    await pool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
      id,
      role[0].id,
    ]);
  }
  return id;
}

/** A complete, isolated DEPI world: one group, one student, one of each role. */
export async function buildWorld(pool: pg.Pool): Promise<World> {
  const n = randomUUID().slice(0, 8);

  const { rows: prog } = await pool.query(
    `INSERT INTO program (code, name) VALUES ($1, 'DEPI') RETURNING id`,
    [`depi_${n}`],
  );
  const { rows: cohort } = await pool.query(
    `INSERT INTO cohort (program_id, code, name, state, timezone)
     VALUES ($1, $2, 'Round 5', 'active', 'Africa/Cairo') RETURNING id`,
    [prog[0].id, `r5_${n}`],
  );
  const cohortId = cohort[0].id as string;

  const { rows: track } = await pool.query(
    `INSERT INTO track (cohort_id, code, name_i18n) VALUES ($1, $2, '{"en":"Data"}'::jsonb)
     RETURNING id`,
    [cohortId, `data_${n}`],
  );
  const trackId = track[0].id as string;

  const coordinatorId = await user(pool, 'Coordinator', 'operations_coordinator');
  const supervisorId = await user(pool, 'Supervisor', 'team_supervisor');
  const coachId = await user(pool, 'Coach', 'outcome_coach');
  const qualityMemberId = await user(pool, 'QualityMember', 'quality_member');
  const qualityLeadId = await user(pool, 'QualityLead', 'quality_lead');
  const opsId = await user(pool, 'ProjectOps', 'project_operations');
  const studentUserId = await user(pool, 'StudentUser', 'student');

  await pool.query(
    `INSERT INTO coach_specialisation (coach_user_id, track_id) VALUES ($1, $2)`,
    [coachId, trackId],
  );

  const { rows: group } = await pool.query(
    `INSERT INTO cohort_group (cohort_id, code, track_id, pathway, planned_session_count,
                               current_session_number, coordinator_user_id, supervisor_user_id,
                               coach_user_id)
     VALUES ($1, $2, $3, 'outcome', 8, 4, $4, $5, $6) RETURNING id`,
    [cohortId, `G-${n}`, trackId, coordinatorId, supervisorId, coachId],
  );
  const groupId = group[0].id as string;

  const { rows: student } = await pool.query(
    `INSERT INTO student (cohort_id, cohort_group_id, identity_key, full_name, phone_e164,
                          track_id, pathway, current_stage)
     VALUES ($1, $2, $3, 'Test Student', '+201000000000', $4, 'outcome', 'coaching')
     RETURNING id`,
    [cohortId, groupId, `idk_${n}`, trackId],
  );
  const studentId = student[0].id as string;

  await pool.query(`INSERT INTO student_account (user_id, student_id) VALUES ($1, $2)`, [
    studentUserId,
    studentId,
  ]);
  await pool.query(
    `INSERT INTO student_assignment (student_id, coordinator_user_id, effective_from)
     VALUES ($1, $2, now() - interval '30 days')`,
    [studentId, coordinatorId],
  );
  await pool.query(
    `INSERT INTO student_coach_assignment (student_id, coach_user_id, coaching_type, effective_from)
     VALUES ($1, $2, 't1', now() - interval '30 days')`,
    [studentId, coachId],
  );

  return {
    cohortId, groupId, trackId, studentId, studentUserId,
    coordinatorId, supervisorId, coachId, qualityMemberId, qualityLeadId, opsId,
  };
}

export function ctxFor(userId: string, roleKey: string, now = new Date()): RequestContext {
  const role = SEED_ROLES_BY_KEY.get(roleKey);
  const actor: Actor = { userId, roles: role ? [role] : [], cohortIds: [] };
  return {
    actor,
    realUserId: userId,
    actorRoleKey: roleKey,
    correlationId: randomUUID(),
    source: 'UI',
    elevated: false,
    now,
  };
}
