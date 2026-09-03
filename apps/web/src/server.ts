/**
 * The web server.
 *
 * Pages go through the same authorization as the API: a page declares the
 * permission it needs, navigation renders from the matrix, and record-level
 * scope is a query predicate. Nothing here re-implements a rule -- the screens
 * call the same services.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  authorize,
  grantedScopes,
  visibleModules,
  type Actor,
  type Module,
  type RoleDefinition,
  type Verb,
  SEED_ROLES_BY_KEY,
} from '@coordinator/permissions';
import {
  createExecutor,
  DomainError,
  login,
  logout,
  recordInteraction,
  decideQuality,
  duplicateSignals,
  qualityQueue,
  resolveSession,
  type RequestContext,
} from '@coordinator/core';
import { QUALITY_CHECKS, type QualityCheck, type RejectionCode, type WorkingCalendar } from '@coordinator/rules';
import { layout, loginPage, type Locale } from './html.ts';
import {
  contactFlow,
  controlTower,
  coordinatorDay,
  pmCommandCentre,
  portalPage,
  qualityQueuePage,
  qualityReviewPage,
  studentList,
  studentRecord,
} from './pages.ts';

const CALENDAR: WorkingCalendar = {
  timeZone: 'Africa/Cairo',
  workingDays: [0, 1, 2, 3, 4],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: new Set(),
};

const COOKIE = 'coordinator_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error('form too large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    // No inline script anywhere, so a strict policy costs nothing.
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:",
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(html);
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}) {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

async function loadActor(pool: pg.Pool, userId: string): Promise<Actor> {
  const { rows } = await pool.query(
    `SELECT r.key, array_remove(array_agg(DISTINCT ur.cohort_id), NULL) AS cohorts
     FROM user_role ur JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND ur.effective_to IS NULL GROUP BY r.key`,
    [userId],
  );
  const roles: RoleDefinition[] = [];
  const cohortIds = new Set<string>();
  for (const row of rows) {
    const role = SEED_ROLES_BY_KEY.get(row.key);
    if (role) roles.push(role);
    for (const c of row.cohorts ?? []) cohortIds.add(c);
  }
  if (cohortIds.size === 0) {
    const { rows: active } = await pool.query(`SELECT id FROM cohort WHERE state = 'active'`);
    for (const c of active) cohortIds.add(c.id);
  }
  return { userId, roles, cohortIds: [...cohortIds] };
}

async function scopedStudents(pool: pg.Pool, actor: Actor, extra: string, params: unknown[]) {
  const own = actor.roles.some((r) =>
    r.permissions.some((p) => p.module === 'students' && p.verb === 'view' && p.scope === 'own'),
  );
  const wide = actor.roles.some((r) =>
    r.permissions.some(
      (p) =>
        p.module === 'students' &&
        p.verb === 'view' &&
        (p.scope === 'cohort' || p.scope === 'all'),
    ),
  );
  // Predicate composed into the query, never a filter over fetched rows.
  const clause = wide
    ? `rm.cohort_id = ANY($1)`
    : own
      ? `(rm.coordinator_user_id = $1 OR rm.coach_user_id = $1)`
      : `false`;
  const scopeParam = wide ? [actor.cohortIds] : [actor.userId];
  const { rows } = await pool.query(
    `SELECT rm.*, g.code AS group_code, g.current_session_number, g.planned_session_count
     FROM rm_student_current rm
     LEFT JOIN cohort_group g ON g.id = rm.cohort_group_id
     WHERE ${clause} ${extra}
     ORDER BY rm.full_name LIMIT 300`,
    [...scopeParam, ...params],
  );
  return rows;
}

export function createWebApp(pool: pg.Pool) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const cookies = parseCookies(req.headers.cookie);
    const localeParam = url.searchParams.get('locale');
    const locale: Locale = localeParam === 'ar' ? 'ar' : localeParam === 'en' ? 'en' : 'en';

    try {
      // ---- Unauthenticated -------------------------------------------------
      if (path === '/login' && req.method === 'GET') return send(res, 200, loginPage());
      if (path === '/login' && req.method === 'POST') {
        const form = await readForm(req);
        try {
          const result = await login(
            pool,
            form.get('email') ?? '',
            form.get('password') ?? '',
            { ip: req.socket.remoteAddress ?? undefined, userAgent: req.headers['user-agent'] },
          );
          return redirect(res, '/', {
            'set-cookie': `${COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
          });
        } catch (err) {
          const message = err instanceof DomainError ? err.message : 'Sign-in failed.';
          return send(res, 401, loginPage(message));
        }
      }

      const token = cookies[COOKIE];
      const session = token ? await resolveSession(pool, token) : null;
      if (!session) return redirect(res, '/login');

      if (path === '/logout' && req.method === 'POST') {
        await logout(pool, session.sessionId);
        return redirect(res, '/login', {
          'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        });
      }

      const actor = await loadActor(pool, session.effectiveUserId);
      const modules = visibleModules(actor);
      const { rows: me } = await pool.query(`SELECT full_name FROM app_user WHERE id = $1`, [
        actor.userId,
      ]);
      const userName: string = me[0]?.full_name ?? '';
      const cohortId = actor.cohortIds[0] ?? '';

      const ctx: RequestContext = {
        actor,
        realUserId: session.userId,
        actorRoleKey: actor.roles[0]?.key ?? 'unknown',
        correlationId: randomUUID(),
        source: 'UI',
        ip: req.socket.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'],
        sessionId: session.sessionId,
        elevated: session.elevated,
        now: new Date(),
      };

      const page = (title: string, body: string, status = 200) =>
        send(res, status, layout({ title, locale, modules, currentPath: path, userName, body }));

      /**
       * `minScope` matters for screens that are cohort-wide by nature.
       *
       * A coordinator legitimately holds `graduation.view` at `own` scope -- they
       * must see a student's graduation position on the student record. That is
       * not the same as being handed the PM command centre, which is programme
       * analytics and which Prohibition 12 keeps away from the frontline. So a
       * page may demand the verb AND a wide enough scope.
       */
      const require = (module: Module, verb: Verb, minScope?: 'cohort'): boolean => {
        const decision = authorize(actor, module, verb);
        const scopes = grantedScopes(actor, module, verb);
        const wideEnough =
          minScope !== 'cohort' || scopes.includes('cohort') || scopes.includes('all');
        if (decision.allowed && wideEnough) return true;
        if (decision.allowed && !wideEnough) {
          page(
            'Not available',
            `<h1>${locale === 'ar' ? 'غير متاح' : 'Not available'}</h1>
             <div class="notice error">${
               locale === 'ar'
                 ? 'هذه الشاشة على مستوى الدفعة. صلاحيتك على مستوى طلابك فقط.'
                 : 'This screen covers the whole cohort. Your access to ' +
                   module +
                   ' is limited to your own students, so it is not available to you. ' +
                   'A student’s graduation position is shown on their record.'
             }</div>
             <p class="muted">${locale === 'ar' ? 'مطلوب' : 'Required'}: ` +
              `<code>${module}.${verb}</code> @ cohort</p>`,
            403,
          );
          return false;
        }
        // Reachable only by deep link, since navigation renders from the matrix.
        if (decision.allowed) return false;
        page(
          'Not available',
          `<h1>${locale === 'ar' ? 'غير متاح' : 'Not available'}</h1>
           <div class="notice error">${decision.denial.reason}</div>
           <p class="muted">${
             locale === 'ar' ? 'مطلوب' : 'Required'
           }: <code>${module}.${verb}</code></p>`,
          403,
        );
        return false;
      };

      // ---- Home ------------------------------------------------------------
      if (path === '/') {
        if (modules.includes('portal')) return redirect(res, '/portal');
        if (authorize(actor, 'my_work', 'view').allowed) return redirect(res, '/my-work');
        const gradScopes = grantedScopes(actor, 'graduation', 'view');
        if (gradScopes.includes('cohort') || gradScopes.includes('all')) {
          return redirect(res, '/graduation');
        }
        return page('Home', `<h1>Welcome</h1><p class="sub">${esc(userName)}</p>`);
      }

      // ---- My Work ---------------------------------------------------------
      if (path === '/my-work') {
        if (!require('my_work', 'view')) return;
        return page('My Work', await coordinatorDay(pool, actor, locale));
      }

      // ---- Students --------------------------------------------------------
      if (path === '/students') {
        if (!require('students', 'view')) return;
        const filters: string[] = [];
        const params: unknown[] = [];
        const risk = url.searchParams.get('risk');
        const sla = url.searchParams.get('sla');
        if (risk) {
          params.push(risk);
          filters.push(`AND rm.risk_level = $${params.length + 1}`);
        }
        if (sla) {
          params.push(sla);
          filters.push(`AND rm.sla_state = $${params.length + 1}`);
        }
        const rows = await scopedStudents(pool, actor, filters.join(' '), params);
        return page('Students', studentList(rows, locale));
      }

      const studentMatch = /^\/students\/([0-9a-f-]{36})$/.exec(path);
      if (studentMatch) {
        if (!require('students', 'view')) return;
        const rows = await scopedStudents(pool, actor, 'AND rm.student_id = $2', [
          studentMatch[1],
        ]);
        if (rows.length === 0) return page('Not found', '<div class="empty">Not found.</div>', 404);
        const { rows: grad } = await pool.query(
          `SELECT status, matched_route_key, gap_explanation_i18n, rule_version, in_denominator
           FROM graduation_progress WHERE student_id = $1`,
          [studentMatch[1]],
        );
        const { rows: timeline } = await pool.query(
          `SELECT event_type, occurred_at, actor_role FROM events
           WHERE subject_id = $1 ORDER BY seq DESC LIMIT 40`,
          [studentMatch[1]],
        );
        return page(String(rows[0].full_name), studentRecord(rows[0], grad[0] ?? null, timeline, locale));
      }

      // ---- Contact flow ----------------------------------------------------
      const contactMatch = /^\/contact\/([0-9a-f-]{36})$/.exec(path);
      if (contactMatch) {
        if (!require('communications', 'create')) return;
        const rows = await scopedStudents(pool, actor, 'AND rm.student_id = $2', [
          contactMatch[1],
        ]);
        if (rows.length === 0) return page('Not found', '<div class="empty">Not found.</div>', 404);
        const { rows: grad } = await pool.query(
          `SELECT gap_explanation_i18n FROM graduation_progress WHERE student_id = $1`,
          [contactMatch[1]],
        );

        if (req.method === 'POST') {
          const form = await readForm(req);
          const exec = createExecutor(pool);
          try {
            await exec.execute(ctx, (scope) =>
              recordInteraction(scope, {
                studentId: contactMatch[1]!,
                channel: (form.get('channel') ?? 'whatsapp') as 'whatsapp',
                purpose: form.get('purpose') ?? 'weekly_follow_up',
                outcome: (form.get('outcome') ?? 'no_response') as 'no_response',
                blockingFactor: form.get('blockingFactor') || undefined,
                agreedAction: form.get('agreedAction') || undefined,
                actionDeadline: form.get('actionDeadline')
                  ? new Date(form.get('actionDeadline')!)
                  : undefined,
                escalationRequired: form.get('escalationRequired') === '1',
                notes: form.get('notes') || undefined,
                clientDedupKey: form.get('clientDedupKey') || undefined,
                calendar: CALENDAR,
              }),
            );
            return redirect(res, '/my-work');
          } catch (err) {
            const message = err instanceof DomainError ? err.message : 'Could not record.';
            return page(
              'Contact',
              `<div class="notice error">${message}</div>` +
                contactFlow(rows[0]!, grad[0] ?? null, locale),
              422,
            );
          }
        }
        return page('Contact', contactFlow(rows[0]!, grad[0] ?? null, locale));
      }

      // ---- Quality ---------------------------------------------------------
      if (path === '/quality') {
        if (!require('quality', 'view')) return;
        const items = await qualityQueue(pool, cohortId, 100);
        return page('Quality', qualityQueuePage(items, locale));
      }

      const qualityMatch = /^\/quality\/([0-9a-f-]{36})$/.exec(path);
      if (qualityMatch) {
        if (!require('quality', 'view')) return;
        const { rows: sub } = await pool.query(
          `SELECT es.*, s.full_name FROM evidence_submission es
           JOIN student s ON s.id = es.student_id WHERE es.id = $1`,
          [qualityMatch[1]],
        );
        if (!sub[0]) return page('Not found', '<div class="empty">Not found.</div>', 404);
        const { rows: files } = await pool.query(
          `SELECT kind, file_name, file_ref, content_hash FROM evidence_file WHERE submission_id = $1`,
          [qualityMatch[1]],
        );
        const dupes = await duplicateSignals(pool, qualityMatch[1]!);

        if (req.method === 'POST') {
          if (!require('quality', 'approve')) return;
          const form = await readForm(req);
          const checks = Object.fromEntries(
            QUALITY_CHECKS.map((c) => [c, form.get(`check_${c}`) === '1']),
          ) as Record<QualityCheck, boolean>;
          const isLead = actor.roles.some((r) => r.key === 'quality_lead');
          const exec = createExecutor(pool);
          try {
            await exec.execute(ctx, (scope) =>
              decideQuality(scope, {
                submissionId: qualityMatch[1]!,
                level: isLead && sub[0].current_stage === 'l3' ? 'l3' : 'l2',
                checks,
                rejectionCodes: form.getAll('rejectionCodes') as RejectionCode[],
                comments: form.get('comments') || undefined,
                actorIsQualityLead: isLead,
                calendar: CALENDAR,
              }),
            );
            return redirect(res, '/quality');
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Could not record the decision.';
            return page(
              'Quality review',
              qualityReviewPage(sub[0], files, dupes, locale, message),
              422,
            );
          }
        }
        return page('Quality review', qualityReviewPage(sub[0], files, dupes, locale));
      }

      // ---- Graduation / PM -------------------------------------------------
      if (path === '/graduation') {
        if (!require('graduation', 'view', 'cohort')) return;
        return page('Graduation', await pmCommandCentre(pool, cohortId, locale));
      }

      if (path === '/graduation/records') {
        if (!require('graduation', 'view', 'cohort')) return;
        const status = url.searchParams.get('status');
        const { rows } = await pool.query(
          `SELECT s.full_name, gp.status, gp.matched_route_key, gp.rule_version,
                  gp.in_denominator, gp.student_id
           FROM graduation_progress gp JOIN student s ON s.id = gp.student_id
           WHERE gp.cohort_id = $1 AND ($2::text IS NULL OR gp.status = $2)
           ORDER BY s.full_name LIMIT 500`,
          [cohortId, status],
        );
        const body = rows
          .map(
            (r) => `<tr><td><a href="/students/${esc(r.student_id)}">${esc(r.full_name)}</a></td>
              <td>${esc(r.status)}</td><td>${esc(r.matched_route_key ?? '—')}</td>
              <td class="muted">${esc(r.rule_version ?? '—')}</td>
              <td>${r.in_denominator ? 'yes' : 'no'}</td></tr>`,
          )
          .join('');
        return page(
          'Graduation records',
          `<h1>Graduation records</h1>
           <p class="sub">The records behind the number${status ? ` · ${esc(status)}` : ''}</p>
           <div class="wrap"><table>
             <tr><th>Student</th><th>Status</th><th>Route</th><th>Rule version</th>
                 <th>In denominator</th></tr>
             ${body || '<tr><td colspan="5" class="muted">No records.</td></tr>'}
           </table></div>`,
        );
      }

      // ---- Control tower ---------------------------------------------------
      if (path === '/control-tower' || path === '/groups') {
        if (!require('groups', 'view', 'cohort')) return;
        return page('Control tower', await controlTower(pool, cohortId, locale));
      }

      // ---- Student portal --------------------------------------------------
      if (path === '/portal') {
        if (!require('portal', 'view')) return;
        const { rows: bound } = await pool.query(
          `SELECT rm.* FROM student_account sa
           JOIN rm_student_current rm ON rm.student_id = sa.student_id
           WHERE sa.user_id = $1`,
          [actor.userId],
        );
        const { rows: subs } = await pool.query(
          `SELECT es.reference, es.subject_type, es.current_stage, es.is_open,
                  es.rejection_count, es.submitted_at
           FROM evidence_submission es
           JOIN student_account sa ON sa.student_id = es.student_id
           WHERE sa.user_id = $1 ORDER BY es.submitted_at DESC`,
          [actor.userId],
        );
        const { rows: grad } = await pool.query(
          `SELECT gap_explanation_i18n FROM graduation_progress gp
           JOIN student_account sa ON sa.student_id = gp.student_id WHERE sa.user_id = $1`,
          [actor.userId],
        );
        return page('My progress', portalPage(bound[0] ?? null, subs, grad[0] ?? null, locale));
      }

      return page('Not found', `<div class="empty">No such page.</div>`, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      await pool
        .query(
          `INSERT INTO system_log (level, component, code, message, context)
           VALUES ('error','web','UNHANDLED',$1,$2::jsonb)`,
          [message, JSON.stringify({ path })],
        )
        .catch(() => {});
      return send(
        res,
        500,
        `<!doctype html><meta charset="utf-8"><p>Something went wrong. It has been logged.</p>`,
      );
    }
  };
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

if (process.argv[1]?.endsWith('server.ts')) {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://coordinator@127.0.0.1:5433/coordinator',
  });
  const port = Number(process.env.PORT ?? 3000);
  createServer(createWebApp(pool)).listen(port, () => {
    console.log(`coordinator web listening on :${port}`);
  });
}
