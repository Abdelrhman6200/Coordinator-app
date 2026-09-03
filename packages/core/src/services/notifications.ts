/**
 * Notifications (§56).
 *
 * A notification INFORMS; a task REQUIRES ACTION. They are separate objects on
 * purpose: conflating them produces either a task list full of noise or an alert
 * stream people stop reading.
 *
 * Deduplication is by `(user, rate_limit_key)`, backed by a unique index, so an
 * alert that fires on every sweep reaches a person once.
 */
import type pg from 'pg';

export interface NotifyInput {
  userId?: string | undefined;
  roleKey?: string | undefined;
  triggerKey: string;
  title: string;
  body?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  rateLimitKey?: string | undefined;
}

export async function notify(db: pg.Pool | pg.PoolClient, input: NotifyInput): Promise<number> {
  let userIds: string[] = [];
  if (input.userId) {
    userIds = [input.userId];
  } else if (input.roleKey) {
    const { rows } = await db.query(
      `SELECT ur.user_id FROM user_role ur JOIN role r ON r.id = ur.role_id
       JOIN app_user u ON u.id = ur.user_id
       WHERE r.key = $1 AND u.status = 'active' AND ur.effective_to IS NULL`,
      [input.roleKey],
    );
    userIds = rows.map((r) => r.user_id);
  }

  let sent = 0;
  for (const userId of userIds) {
    const { rows: pref } = await db.query(
      `SELECT enabled FROM notification_preference
       WHERE user_id = $1 AND trigger_key = $2 AND channel = 'in_app'`,
      [userId, input.triggerKey],
    );
    if (pref[0] && pref[0].enabled === false) continue;

    const { rowCount } = await db.query(
      `INSERT INTO notification (user_id, trigger_key, subject_type, subject_id, title, body,
                                 rate_limit_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'delivered')
       ON CONFLICT (user_id, rate_limit_key) WHERE rate_limit_key IS NOT NULL DO NOTHING`,
      [
        userId,
        input.triggerKey,
        input.subjectType ?? null,
        input.subjectId ?? null,
        input.title,
        input.body ?? null,
        input.rateLimitKey ?? null,
      ],
    );
    sent += rowCount ?? 0;
  }
  return sent;
}

export async function inbox(db: pg.Pool | pg.PoolClient, userId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, trigger_key, title, body, created_at, read_at, subject_type, subject_id
     FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function markRead(db: pg.Pool | pg.PoolClient, userId: string, id: string) {
  await db.query(`UPDATE notification SET read_at = now() WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
}
