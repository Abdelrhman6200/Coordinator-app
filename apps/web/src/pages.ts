/**
 * The screens.
 *
 * Each answers the four questions §73 requires: what is happening, why, what
 * should happen next, and who owns it with what deadline. A screen that only
 * displays data without making the next action clear does not belong here.
 */
import type pg from 'pg';
import type { Actor } from '@coordinator/permissions';
import {
  GRADUATION_TARGETS,
  QUALITY_CHECKS,
  REJECTION_CODES,
  QUALITY_QUEUE_THRESHOLDS,
} from '@coordinator/rules';
import { graduationSummary, workQueue } from '@coordinator/core';
import type { DuplicateFlag } from '@coordinator/rules';
import { card, esc, riskPill, slaPill, type Locale } from './html.ts';

const T = {
  en: {
    myDay: 'My Day', whatNow: 'What needs action today',
    assigned: 'Students assigned', contactDue: 'Contact due', overdue: 'Overdue',
    atRisk: 'At Risk', critical: 'Critical', openEvidence: 'Evidence open',
    student: 'Student', group: 'Group', problem: 'Problem', lastContact: 'Last contact',
    nextAction: 'Next action', due: 'Due', risk: 'Risk', act: 'Contact',
    queueClear: 'Your queue is clear.', noStudents: 'No students assigned yet.',
  },
  ar: {
    myDay: 'يومي', whatNow: 'ما يحتاج إجراءً اليوم',
    assigned: 'الطلاب المسندون', contactDue: 'تواصل مستحق', overdue: 'متأخر',
    atRisk: 'في خطر', critical: 'حرج', openEvidence: 'أدلة مفتوحة',
    student: 'الطالب', group: 'المجموعة', problem: 'المشكلة', lastContact: 'آخر تواصل',
    nextAction: 'الإجراء التالي', due: 'الاستحقاق', risk: 'الخطر', act: 'تواصل',
    queueClear: 'قائمتك خالية.', noStudents: 'لا يوجد طلاب مسندون بعد.',
  },
} as const;

function when(value: Date | string | null): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The coordinator's day (§11). A work queue, not analytics: the tiles are counts
 * that route INTO the queue, filtered. A coordinator is never handed a chart to
 * interpret.
 */
export async function coordinatorDay(
  pool: pg.Pool,
  actor: Actor,
  locale: Locale,
): Promise<string> {
  const t = T[locale];
  const { rows: counts } = await pool.query(
    `SELECT
       count(*)::int AS assigned,
       count(*) FILTER (WHERE rm.sla_state = 'approaching')::int AS due,
       count(*) FILTER (WHERE rm.sla_state = 'breached')::int AS overdue,
       count(*) FILTER (WHERE rm.risk_level = 'amber')::int AS amber,
       count(*) FILTER (WHERE rm.risk_level = 'red')::int AS red,
       coalesce(sum(rm.open_evidence_count), 0)::int AS evidence
     FROM rm_student_current rm
     WHERE rm.coordinator_user_id = $1`,
    [actor.userId],
  );
  const c = counts[0] ?? {};

  const tasks = await workQueue(pool, actor.userId, 50);

  const rows = tasks
    .map((task) => {
      const overdue = task.overdue ? ' style="background:var(--red-bg)"' : '';
      return `<tr${overdue}>
        <td><a href="/students/${esc(task.student_id)}">${esc(task.student_name ?? '—')}</a></td>
        <td>${esc(task.group_code ?? '—')}</td>
        <td>${esc(String(task.task_type).replaceAll('_', ' '))}</td>
        <td>${slaPill(task.sla_state)}</td>
        <td>${when(task.due_at)}</td>
        <td>${riskPill(task.risk_level ?? 'green')}</td>
        <td>${
          task.student_id
            ? `<a class="card" style="padding:.3rem .6rem;display:inline-block"
                  href="/contact/${esc(task.student_id)}">${esc(t.act)}</a>`
            : ''
        }</td>
      </tr>`;
    })
    .join('');

  return `<h1>${esc(t.myDay)}</h1>
<p class="sub">${esc(t.whatNow)}</p>
<div class="cards">
  ${card(t.assigned, c.assigned ?? 0, '/students')}
  ${card(t.contactDue, c.due ?? 0, '/students?sla=approaching')}
  ${card(t.overdue, c.overdue ?? 0, '/students?sla=breached')}
  ${card(t.atRisk, c.amber ?? 0, '/students?risk=amber')}
  ${card(t.critical, c.red ?? 0, '/students?risk=red')}
  ${card(t.openEvidence, c.evidence ?? 0, '/students')}
</div>
<h2>${esc(t.whatNow)}</h2>
${
  tasks.length === 0
    ? `<div class="empty">${esc((c.assigned ?? 0) === 0 ? t.noStudents : t.queueClear)}</div>`
    : `<div class="wrap"><table>
        <tr><th>${esc(t.student)}</th><th>${esc(t.group)}</th><th>${esc(t.problem)}</th>
            <th>SLA</th><th>${esc(t.due)}</th><th>${esc(t.risk)}</th><th></th></tr>
        ${rows}
      </table></div>`
}`;
}

/** The student list, already scoped by the caller's predicate. */
export function studentList(rows: readonly Record<string, unknown>[], locale: Locale): string {
  const t = T[locale];
  if (rows.length === 0) {
    return `<h1>${esc(t.student)}</h1><div class="empty">${esc(t.noStudents)}</div>`;
  }
  const body = rows
    .map(
      (s) => `<tr>
      <td><a href="/students/${esc(s.student_id)}">${esc(s.full_name)}</a></td>
      <td>${esc(s.group_code ?? '—')}</td>
      <td>${esc(s.stage)}</td>
      <td>${riskPill(String(s.risk_level))}</td>
      <td>${slaPill(s.sla_state as string | null)}</td>
      <td>${when(s.last_contact_at as string | null)}</td>
      <td>${esc(s.accepted_gig_count)}</td>
      <td>${esc(s.graduation_status)}</td>
      <td><a href="/contact/${esc(s.student_id)}">${esc(t.act)}</a></td>
    </tr>`,
    )
    .join('');
  return `<h1>${esc(t.student)}</h1>
<p class="sub">${rows.length} ${locale === 'ar' ? 'سجل' : 'records in your scope'}</p>
<div class="wrap"><table>
  <tr><th>${esc(t.student)}</th><th>${esc(t.group)}</th><th>Stage</th><th>${esc(t.risk)}</th>
      <th>SLA</th><th>${esc(t.lastContact)}</th><th>Gigs</th><th>Graduation</th><th></th></tr>
  ${body}
</table></div>`;
}

/**
 * The contact flow (§12). One screen: context, channel, purpose, outcome, and
 * the follow-up content the standard asks for. Required fields are deliberately
 * few -- speed at the point of contact; completeness enforced afterwards.
 */
export function contactFlow(
  student: Record<string, unknown>,
  graduation: Record<string, unknown> | null,
  locale: Locale,
  notice?: string,
): string {
  const gap =
    graduation && typeof graduation.gap_explanation_i18n === 'object'
      ? ((graduation.gap_explanation_i18n as Record<string, string>)[locale] ?? '')
      : '';
  return `
<h1>${esc(student.full_name)}</h1>
<p class="sub">
  ${esc(student.stage)} · ${riskPill(String(student.risk_level))} ·
  ${locale === 'ar' ? 'آخر تواصل' : 'last contact'} ${when(student.last_contact_at as string)}
</p>
${notice ? `<div class="notice ok">${esc(notice)}</div>` : ''}

<div class="cards">
  ${card('Accepted gigs', student.accepted_gig_count)}
  ${card('Open evidence', student.open_evidence_count)}
  ${card('Attempts', student.contact_attempts)}
  ${card('Graduation', student.graduation_status, `/students/${esc(student.student_id)}`)}
</div>

${
  gap
    ? `<div class="notice"><strong>${
        locale === 'ar' ? 'ما ينقص للتخرج' : 'What blocks graduation'
      }:</strong> ${esc(gap)}</div>`
    : ''
}

<h2>${locale === 'ar' ? 'تسجيل التواصل' : 'Record the contact'}</h2>
<form class="panel" method="post" action="/contact/${esc(student.student_id)}">
  <div class="row">
    <label style="flex:1 1 160px">${locale === 'ar' ? 'القناة' : 'Channel'}
      <select name="channel" required>
        <option value="whatsapp">WhatsApp</option>
        <option value="phone">${locale === 'ar' ? 'هاتف' : 'Phone'}</option>
        <option value="email">${locale === 'ar' ? 'بريد' : 'Email'}</option>
        <option value="sms">SMS</option>
        <option value="other">${locale === 'ar' ? 'أخرى' : 'Other'}</option>
      </select></label>
    <label style="flex:1 1 200px">${locale === 'ar' ? 'الغرض' : 'Purpose'}
      <select name="purpose" required>
        <option value="onboarding">Onboarding</option>
        <option value="session_reminder">Session reminder</option>
        <option value="weekly_follow_up" selected>Weekly follow-up</option>
        <option value="attendance_issue">Attendance issue</option>
        <option value="freelancing_follow_up">Freelancing follow-up</option>
        <option value="service_follow_up">Service follow-up</option>
        <option value="evidence_follow_up">Evidence follow-up</option>
        <option value="risk_intervention">Risk intervention</option>
        <option value="escalation_follow_up">Escalation follow-up</option>
        <option value="other">Other</option>
      </select></label>
    <label style="flex:1 1 200px">${locale === 'ar' ? 'النتيجة' : 'Outcome'}
      <select name="outcome" required>
        <option value="responded">Responded</option>
        <option value="no_response">No response</option>
        <option value="waiting_for_response">Waiting for response</option>
        <option value="callback_required">Callback required</option>
        <option value="issue_identified">Issue identified</option>
        <option value="student_needs_support">Student needs support</option>
        <option value="incorrect_contact_data">Incorrect contact data</option>
      </select></label>
  </div>

  <label>${locale === 'ar' ? 'ما يعيق العمل/الخدمة التالية' : "What blocks the next gig or service"}
    <input name="blockingFactor" maxlength="300"></label>
  <label>${locale === 'ar' ? 'الإجراء المتفق عليه' : 'One agreed action'}
    <input name="agreedAction" maxlength="300"></label>
  <div class="row">
    <label style="flex:1 1 220px">${locale === 'ar' ? 'موعد الإجراء' : 'Action deadline'}
      <input name="actionDeadline" type="date"></label>
    <label style="flex:1 1 220px; align-self:center">
      <span style="display:flex;gap:.5rem;align-items:center;font-weight:500;color:var(--ink)">
        <input type="checkbox" name="escalationRequired" value="1" style="width:auto">
        ${locale === 'ar' ? 'يتطلب تصعيداً' : 'Escalation required'}
      </span></label>
  </div>
  <label>${locale === 'ar' ? 'ملاحظات' : 'Notes'}<textarea name="notes" rows="3"></textarea></label>

  <!-- Idempotency for a queued offline submission: the same key never produces
       a second interaction. -->
  <input type="hidden" name="clientDedupKey" value="${esc(crypto.randomUUID())}">
  <div class="row">
    <button type="submit">${locale === 'ar' ? 'تسجيل' : 'Record interaction'}</button>
    <a class="card" style="padding:.5rem 1rem" href="/my-work">${
      locale === 'ar' ? 'إلغاء' : 'Cancel'
    }</a>
  </div>
</form>`;
}

/** The student record with its timeline (§7). */
export function studentRecord(
  student: Record<string, unknown>,
  graduation: Record<string, unknown> | null,
  timeline: readonly Record<string, unknown>[],
  locale: Locale,
): string {
  const gap =
    graduation && typeof graduation.gap_explanation_i18n === 'object'
      ? ((graduation.gap_explanation_i18n as Record<string, string>)[locale] ?? '')
      : '';
  const events = timeline
    .map(
      (e) => `<tr><td>${when(e.occurred_at as string)}</td>
        <td>${esc(String(e.event_type).replaceAll('_', ' ').toLowerCase())}</td>
        <td class="muted">${esc(e.actor_role ?? 'system')}</td></tr>`,
    )
    .join('');

  return `<h1>${esc(student.full_name)}</h1>
<p class="sub">${esc(student.group_code ?? '—')} · ${esc(student.stage)} ·
  ${riskPill(String(student.risk_level))} · ${slaPill(student.sla_state as string | null)}</p>
<div class="cards">
  ${card('Accepted gigs', student.accepted_gig_count)}
  ${card('Accepted value', `$${Number(student.accepted_gig_value ?? 0).toFixed(2)}`)}
  ${card('Services accepted', student.accepted_service_count)}
  ${card('Open evidence', student.open_evidence_count)}
  ${card('Attendance', student.attendance_percent === null ? '—' : `${Math.round(Number(student.attendance_percent))}%`)}
  ${card('Session position', `${student.current_session_number ?? 0}/${student.planned_session_count ?? 0}`)}
</div>
${
  gap
    ? `<div class="notice"><strong>Graduation:</strong> ${esc(gap)}
       <div class="muted">Rule version ${esc(graduation?.rule_version ?? '—')} ·
       ${graduation?.in_denominator ? 'counted in the denominator' : 'excluded from the denominator'}</div>
       </div>`
    : ''
}
<div class="row"><a class="card" style="padding:.5rem 1rem" href="/contact/${esc(student.student_id)}">
  Contact student</a></div>
<h2>Timeline</h2>
<div class="wrap"><table>
  <tr><th>When</th><th>Event</th><th>Actor</th></tr>
  ${events || '<tr><td colspan="3" class="muted">No events yet.</td></tr>'}
</table></div>`;
}

/**
 * The Quality queue (§32): oldest first, always. Reviewers do not choose
 * convenient work, so the ordering is not a user preference.
 */
export function qualityQueuePage(
  items: readonly Record<string, unknown>[],
  locale: Locale,
): string {
  const size = items.length;
  const banner =
    size >= QUALITY_QUEUE_THRESHOLDS.pmEscalationQueueSize
      ? `<div class="notice error">Queue is ${size}: above the ${QUALITY_QUEUE_THRESHOLDS.pmEscalationQueueSize} immediate-PM-escalation threshold.</div>`
      : size >= QUALITY_QUEUE_THRESHOLDS.leadReviewQueueSize
        ? `<div class="notice">Queue is ${size}: above the ${QUALITY_QUEUE_THRESHOLDS.leadReviewQueueSize} Quality Lead review threshold.</div>`
        : '';

  const rows = items
    .map((i) => {
      const age = Math.round(Number(i.age_hours ?? 0));
      const cls = age > 72 ? 'red' : age > 48 ? 'red' : age > 24 ? 'amber' : 'green';
      return `<tr>
        <td><span class="pill ${cls}">${age}h</span></td>
        <td><a href="/quality/${esc(i.id)}">${esc(i.reference)}</a></td>
        <td>${esc(i.full_name)}</td>
        <td>${esc(i.subject_type)}</td>
        <td>${esc(i.current_stage)}</td>
        <td>${esc(i.rejection_count)}</td>
      </tr>`;
    })
    .join('');

  return `<h1>${locale === 'ar' ? 'قائمة الجودة' : 'Quality queue'}</h1>
<p class="sub">${locale === 'ar' ? 'الأقدم أولاً' : 'Oldest first'} · ${size} ${
    locale === 'ar' ? 'عنصر' : 'items'
  }</p>
${banner}
${
  size === 0
    ? `<div class="empty">${locale === 'ar' ? 'لا توجد عناصر في الانتظار.' : 'Nothing awaiting review.'}</div>`
    : `<div class="wrap"><table>
        <tr><th>Age</th><th>Submission</th><th>Student</th><th>Type</th><th>Stage</th>
            <th>Rejections</th></tr>
        ${rows}
      </table></div>`
}`;
}

/**
 * The Quality review screen (§33, §34).
 *
 * Seven binary checks, all of which must pass. There is no score and no slider:
 * presenting this as a rating would misrepresent the decision the reviewer is
 * actually making.
 */
export function qualityReviewPage(
  submission: Record<string, unknown>,
  files: readonly Record<string, unknown>[],
  duplicates: readonly DuplicateFlag[],
  locale: Locale,
  notice?: string,
): string {
  const checks = QUALITY_CHECKS.map(
    (c) => `<label><input type="checkbox" name="check_${c}" value="1" checked>
      ${esc(c.replaceAll('_', ' '))}</label>`,
  ).join('');

  const codes = Object.entries(REJECTION_CODES)
    .map(([code, reason]) => `<option value="${code}">${code} — ${esc(reason)}</option>`)
    .join('');

  const fileRows = files
    .map(
      (f) => `<tr><td>${esc(f.kind)}</td><td class="muted">${esc(f.file_name ?? f.file_ref)}</td>
        <td class="muted">${esc((f.content_hash as Buffer | null)?.toString('hex').slice(0, 16) ?? '')}…</td></tr>`,
    )
    .join('');

  const dupNotice =
    duplicates.length > 0
      ? `<div class="notice error"><strong>${duplicates.length} duplicate signal(s).</strong>
         <ul>${duplicates.map((d) => `<li>${esc(d.explanation)}</li>`).join('')}</ul>
         <div class="muted">The system flags; you decide.</div></div>`
      : '';

  return `<h1>${esc(submission.reference)}</h1>
<p class="sub">${esc(submission.full_name)} · ${esc(submission.subject_type)} ·
  ${locale === 'ar' ? 'مرات الرفض' : 'rejections'} ${esc(submission.rejection_count)}</p>
${notice ? `<div class="notice error">${esc(notice)}</div>` : ''}
${dupNotice}

<h2>${locale === 'ar' ? 'الأدلة' : 'Evidence'}</h2>
<div class="wrap"><table><tr><th>Kind</th><th>File</th><th>Hash</th></tr>${
    fileRows || '<tr><td colspan="3" class="muted">No files.</td></tr>'
  }</table></div>

<h2>${locale === 'ar' ? 'الفحوص السبعة' : 'The seven checks'}</h2>
<form class="panel" method="post" action="/quality/${esc(submission.id)}">
  <p class="muted">${
    locale === 'ar'
      ? 'جميع الفحوص السبعة يجب أن تنجح. أي فحص فاشل يعني الرفض مع رمز سبب.'
      : 'All seven must pass. Any failed check is a rejection and needs a coded reason.'
  }</p>
  <div class="checks">${checks}</div>
  <label>${locale === 'ar' ? 'رموز الرفض' : 'Rejection codes'}
    <select name="rejectionCodes" multiple size="6">${codes}</select></label>
  <label>${locale === 'ar' ? 'تعليقات' : 'Comments'}
    <textarea name="comments" rows="3"></textarea></label>
  <div class="row">
    <button type="submit">${locale === 'ar' ? 'تسجيل القرار' : 'Record decision'}</button>
    <a class="card" style="padding:.5rem 1rem" href="/quality">${
      locale === 'ar' ? 'رجوع' : 'Back to queue'
    }</a>
  </div>
</form>`;
}

/**
 * The PM command centre (§51).
 *
 * The two targets are rendered side by side and never merged: 70% carries
 * contractual force, 85% is the internal operating target, and they have
 * different consequences.
 */
export async function pmCommandCentre(
  pool: pg.Pool,
  cohortId: string,
  locale: Locale,
): Promise<string> {
  const s = await graduationSummary(pool, cohortId);
  const { rows: pipeline } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE rm.risk_level = 'red')::int AS critical,
       count(*) FILTER (WHERE rm.risk_level = 'amber')::int AS at_risk,
       coalesce(sum(rm.open_evidence_count), 0)::int AS evidence_open,
       count(*) FILTER (WHERE rm.accepted_gig_count > 0
                          AND rm.graduation_status <> 'graduated')::int AS progressing
     FROM rm_student_current rm WHERE rm.cohort_id = $1`,
    [cohortId],
  );
  const p = pipeline[0] ?? {};

  const rate = s.ratePercent.toFixed(1);
  const contractualMet = s.ratePercent >= GRADUATION_TARGETS.contractualThresholdPercent;
  const internalMet = s.ratePercent >= GRADUATION_TARGETS.internalTargetPercent;

  return `<h1>${locale === 'ar' ? 'مركز القيادة' : 'Command centre'}</h1>
<p class="sub">${locale === 'ar' ? 'التخرج' : 'Graduation'} · ${s.graduated}/${s.denominator}</p>

<div class="target-row">
  <div class="card" style="border-color:${contractualMet ? 'var(--green)' : 'var(--red)'}">
    <div class="label">${
      locale === 'ar' ? 'الحد التعاقدي (الوزارة)' : 'Contractual threshold (Ministry)'
    }</div>
    <div class="value">${rate}% <span class="muted" style="font-size:1rem">/ ${
      GRADUATION_TARGETS.contractualThresholdPercent
    }%</span></div>
    <div class="foot">${
      contractualMet
        ? locale === 'ar' ? 'تم تحقيقه' : 'Met'
        : `${s.studentsNeededForContractual} ${
            locale === 'ar' ? 'طالب إضافي مطلوب' : 'more students needed'
          }`
    }</div>
  </div>
  <div class="card" style="border-color:${internalMet ? 'var(--green)' : 'var(--amber)'}">
    <div class="label">${locale === 'ar' ? 'الهدف الداخلي' : 'Internal target'}</div>
    <div class="value">${rate}% <span class="muted" style="font-size:1rem">/ ${
      GRADUATION_TARGETS.internalTargetPercent
    }%</span></div>
    <div class="foot">${
      internalMet
        ? locale === 'ar' ? 'تم تحقيقه' : 'Met'
        : `${s.studentsNeededForInternal} ${
            locale === 'ar' ? 'طالب إضافي مطلوب' : 'more students needed'
          }`
    }</div>
  </div>
</div>

<h2>${locale === 'ar' ? 'الخط' : 'Pipeline'}</h2>
<div class="cards">
  ${card('Denominator', s.denominator, `/graduation/records`)}
  ${card('Graduated', s.graduated, `/graduation/records?status=graduated`)}
  ${card('Progressing', p.progressing ?? 0, `/graduation/records?status=progressing`)}
  ${card('Evidence open', p.evidence_open ?? 0, '/quality')}
  ${card('At Risk', p.at_risk ?? 0, '/students?risk=amber')}
  ${card('Critical', p.critical ?? 0, '/students?risk=red')}
  ${card('Excluded', s.withdrawnExcluded, '/graduation/records')}
</div>
<p class="muted">${
    locale === 'ar'
      ? 'الطالب غير المستجيب يبقى في المقام. سياسة المقام المطبقة تُسجَّل على كل سجل تخرج.'
      : 'An unresponsive student remains in the denominator. The denominator policy applied is ' +
        'stamped on every graduation record, so the headline number is always explainable.'
  }</p>`;
}

/** Operations control tower (§48): exceptions, each with an owner and an age. */
export async function controlTower(
  pool: pg.Pool,
  cohortId: string,
  locale: Locale,
): Promise<string> {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE rm.coordinator_user_id IS NULL)::int AS unassigned,
       count(*) FILTER (WHERE rm.last_contact_at IS NULL
                          AND rm.coordinator_user_id IS NOT NULL)::int AS never_contacted,
       count(*) FILTER (WHERE rm.sla_state = 'breached')::int AS sla_breached,
       count(*) FILTER (WHERE rm.risk_level = 'red')::int AS critical,
       count(*) FILTER (WHERE rm.coach_user_id IS NULL)::int AS no_coach,
       count(*) FILTER (WHERE rm.open_escalations > 0)::int AS escalations,
       coalesce(sum(rm.open_evidence_count), 0)::int AS evidence_open
     FROM rm_student_current rm WHERE rm.cohort_id = $1`,
    [cohortId],
  );
  const e = rows[0] ?? {};

  const { rows: gaps } = await pool.query(
    `SELECT code, count(*)::int AS n, max(occurred_at) AS latest
     FROM system_log
     WHERE level IN ('warn','error') AND occurred_at > now() - interval '7 days'
     GROUP BY code ORDER BY n DESC LIMIT 8`,
  );

  const exceptions: Array<[string, number, string]> = [
    ['Unassigned students', e.unassigned ?? 0, '/students'],
    ['Never contacted', e.never_contacted ?? 0, '/students'],
    ['Contact SLA breached', e.sla_breached ?? 0, '/students?sla=breached'],
    ['Critical students', e.critical ?? 0, '/students?risk=red'],
    ['Missing coach assignment', e.no_coach ?? 0, '/students'],
    ['Open escalations', e.escalations ?? 0, '/escalations'],
    ['Evidence in the pipeline', e.evidence_open ?? 0, '/quality'],
  ];

  const tiles = exceptions
    .map(([label, n, href]) =>
      card(label, n, href, n === 0 ? (locale === 'ar' ? 'خالٍ' : 'clear') : undefined),
    )
    .join('');

  const dq = gaps
    .map(
      (g) => `<tr><td>${esc(g.code)}</td><td>${esc(g.n)}</td>
        <td class="muted">${when(g.latest as string)}</td></tr>`,
    )
    .join('');

  return `<h1>${locale === 'ar' ? 'برج التحكم' : 'Control tower'}</h1>
<p class="sub">${
    locale === 'ar' ? 'الاستثناءات أولاً' : 'Exceptions first — every one has an owner and a clock'
  }</p>
<div class="cards">${tiles}</div>
<h2>${locale === 'ar' ? 'جودة البيانات' : 'Data quality and system exceptions'}</h2>
<div class="wrap"><table><tr><th>Code</th><th>Count (7d)</th><th>Latest</th></tr>${
    dq || '<tr><td colspan="3" class="muted">Nothing logged.</td></tr>'
  }</table></div>`;
}

/** The student portal (§10): own record only. */
export function portalPage(
  student: Record<string, unknown> | null,
  submissions: readonly Record<string, unknown>[],
  graduation: Record<string, unknown> | null,
  locale: Locale,
): string {
  if (!student) {
    return `<div class="empty">${
      locale === 'ar' ? 'لا يوجد سجل طالب مرتبط بهذا الحساب.' : 'No student record is linked to this account.'
    }</div>`;
  }
  const gap =
    graduation && typeof graduation.gap_explanation_i18n === 'object'
      ? ((graduation.gap_explanation_i18n as Record<string, string>)[locale] ?? '')
      : '';

  const rows = submissions
    .map((s) => {
      const state = s.is_open
        ? s.current_stage === 'coach'
          ? locale === 'ar' ? 'قيد المراجعة' : 'With your coach'
          : locale === 'ar' ? 'قيد المراجعة' : 'Under review'
        : locale === 'ar' ? 'مقبول' : 'Accepted';
      const cls = s.is_open ? 'amber' : 'green';
      return `<tr><td>${esc(s.reference)}</td><td>${esc(s.subject_type)}</td>
        <td><span class="pill ${cls}">${esc(state)}</span></td>
        <td>${when(s.submitted_at as string)}</td>
        <td>${esc(s.rejection_count)}</td></tr>`;
    })
    .join('');

  return `<h1>${locale === 'ar' ? 'تقدمي' : 'My progress'}</h1>
<div class="cards">
  ${card(locale === 'ar' ? 'أعمال مقبولة' : 'Accepted gigs', student.accepted_gig_count)}
  ${card(locale === 'ar' ? 'القيمة الموثقة' : 'Verified value', `$${Number(student.accepted_gig_value ?? 0).toFixed(2)}`)}
  ${card(locale === 'ar' ? 'خدمات مقبولة' : 'Accepted services', student.accepted_service_count)}
  ${card(locale === 'ar' ? 'حالة التخرج' : 'Graduation', student.graduation_status)}
</div>
${gap ? `<div class="notice"><strong>${locale === 'ar' ? 'ما ينقصك' : 'What you still need'}:</strong> ${esc(gap)}</div>` : ''}
<h2>${locale === 'ar' ? 'مشاركاتي' : 'My submissions'}</h2>
${
  submissions.length === 0
    ? `<div class="empty">${locale === 'ar' ? 'لم ترسل أي دليل بعد.' : 'You have not submitted any evidence yet.'}</div>`
    : `<div class="wrap"><table>
        <tr><th>Reference</th><th>Type</th><th>State</th><th>Submitted</th><th>Returns</th></tr>
        ${rows}
      </table></div>`
}`;
}
