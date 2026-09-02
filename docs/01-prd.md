# 01 — Product Requirements Document

## 1. Product overview

Coordinator is the central operational system for running a cohort-based
coaching and graduation programme. It is not a reporting layer over other
tools; the operational work happens inside it, and the reporting is a
consequence of that work having happened inside it.

**Scope of the first deployment.** A freelancing coaching and graduation phase:
students are imported, assigned to an operations coordinator, contacted,
onboarded, coached (two independent coaching tracks), guided into freelancing
activity, submit gigs for verification, and — on meeting configurable criteria
— are verified and graduated.

**Scope of the product.** Multi-cohort, multi-program. A second cohort with
different tracks, different milestones, different SLAs, a different coaching
structure and different graduation rules must be launchable **by configuration
alone**. This is the reusability test and it is a release criterion, not an
aspiration.

**What the system is not.** It is not a CRM adapted by convention, not a set of
linked spreadsheets, and not a BI dashboard. Every number it displays is
reconstructible from an immutable event log.

### 1.1 The eight system invariants

These hold for every student record at every point in time. They are enforced in
the database (constraints, triggers, exclusion constraints) **and** in the
service layer. The UI is never the enforcement point.

| # | Invariant | Primary enforcement | Secondary enforcement |
|---|---|---|---|
| 1 | Exactly one master record per student | Unique `(cohort_id, identity_key)`; deterministic dedup on import | Fuzzy-duplicate detection at import preview |
| 2 | Exactly one current lifecycle stage | `student.current_stage` + `student_stage_history` exclusion constraint on overlapping validity | Server-side transition guard |
| 3 | Exactly one responsible coordinator, or an explicit `UNASSIGNED` | `student_assignment` effective-dated, partial unique index on open rows | Ops control tower exception queue |
| 4 | Exactly one hierarchy resolution at any timestamp | Effective-dated `org_membership`; cycle check on write | Nightly reconciliation |
| 5 | ≥1 open next action, or a justified `NO_ACTION_REQUIRED` | Task-engine invariant check on every student-affecting event | Nightly sweeper raises a data-quality exception |
| 6 | Exactly one current risk status | Partial unique index: one open `risk_record` per student | Risk engine single-writer |
| 7 | One complete, gapless operational history | Append-only `events`; no `UPDATE`/`DELETE` grant on the table | Hash-chained sequence check |
| 8 | One graduation progress record, continuously evaluated | One `graduation_progress` per `(student, cohort)`, recomputed on relevant events | Scheduled recomputation + drift check |

Invariant violations are **operational exceptions**, not silent errors: they
appear on the Data Quality dashboard (§10.2 of the build prompt) with an owner
and an age clock.

### 1.2 The event principle

Every meaningful staff action emits a structured domain event. Events are the
source of truth for history, SLA, KPI, dashboards and audit. No UI convenience
path bypasses event emission — enforced by the write-path architecture
(§10 Technical Architecture: all state mutation goes through a command handler
that emits within the same transaction as the state change).

## 2. Goals & success metrics

### 2.1 Programme goal

Primary KPI: **85% student graduation rate**.

Graduation criteria are **not confirmed** (`CONFIG-PENDING`, register item 1).
The system implements a multi-route rules engine; no candidate threshold is
embedded in code. Whether withdrawn/excluded students remain in the denominator
is itself unconfirmed (register item 2) and is a configuration choice that is
recorded and versioned, because it changes the headline number.

### 2.2 Product success metrics

| Metric | Target | Measured by |
|---|---|---|
| Coordinator single-screen day | A coordinator completes a full working day from My Work without opening another module | UAT observation + module-switch telemetry |
| Double entry eliminated | Zero workflows requiring the same fact to be entered twice | Workflow spec audit (Phase C) + UAT |
| Traceability | 100% of dashboard tiles have a registry entry and a drill-down to records | Automated consistency gate test |
| Reconstruction | KPI recomputation from raw events matches read models to the record | Nightly reconciliation test |
| Five-click rule | PM reaches a named student's event history from the headline rate in ≤5 clicks | UAT script PM-01 |
| Thirty-second rule | Ops identifies every unowned/uncontacted/stalled student in <30s | UAT script OPS-01 |
| Cohort clone | New cohort with different graduation rules launched with zero code changes | Release criterion, tested in E2E |

### 2.3 Non-functional targets

| Area | Target |
|---|---|
| Coordinator work screens | p95 < 1.5s at 10,000+ students per cohort |
| Dashboards | p95 < 3s, served from read models only |
| Scale ceiling before redesign | 10,000 students, 500 staff, 5,000,000 events per cohort |
| Concurrency | Multiple active cohorts; row-level security scoped by cohort and hierarchy |
| Time | Store UTC; display in cohort/user timezone; SLA respects a configurable working calendar (weekends, public holidays, working hours) |
| i18n | Arabic/RTL is a first-class layout, not a mirror hack; English and Arabic at launch |
| Availability | RPO ≤ 5 min, RTO ≤ 1 h; PITR enabled; restore procedure tested quarterly |
| Observability | Structured logs, metrics, traces, background-job dashboard, DLQ with replay |
| Offline tolerance | Interaction-logging path works on poor connectivity: optimistic UI, queued submission, conflict-safe retry |

## 3. User roles

Roles are **compositions of permissions stored as data**. Adding a role requires
no code change. The initial set:

| Role | Purpose | Scope |
|---|---|---|
| System Admin | Configuration, users, permissions, overrides, impersonation | `all` |
| Project Manager | Programme outcome, forecast, cross-cohort decisions | `all` / `cohort` |
| Project Operations Associate | Exception clearing, allocation, data quality | `cohort` |
| Team Leader | A coordinator team and its students | `team` |
| Operations Coordinator | Frontline student ownership | `own` |
| Coaching Manager Type 1 | Type-1 coaches and their students | `coaching_team` |
| Coach Type 1 | Assigned students, coaching data only | `own` |
| Coaching Manager Type 2 | Type-2 coaches and their students | `coaching_team` |
| Coach Type 2 | Assigned students, coaching data only | `own` |
| Quality Lead | QA programme, calibration, waivers, appeals | `cohort` (read) / QA (write) |
| Quality Specialist | Executes audits | `cohort` (read) / own audits (write) |
| Reporting/Data User | Reports and exports, no operational write | `cohort` |
| Client/Read-Only Viewer | Aggregates and approved reports, PII masked | `cohort` (masked) |

Coaching Type 1 and Type 2 are configurable and separable: a cohort may enable
one, both, or neither, and may rename them.

## 4. Permission matrix

See [`02-permission-matrix.md`](02-permission-matrix.md). Permissions are
`(role × module × verb × scope)` with `scope ∈ {own, team, coaching_team,
cohort, all}`. Navigation renders from this matrix — a user never sees a tab
they cannot use — and every API endpoint declares the permission it requires,
which is what the exhaustive permission test asserts against.

### 4.1 Separation of duties

Enforced server-side, blocked and logged on violation:

1. The submitter of a gig cannot verify it.
2. The verifier of a gig cannot approve the graduation that relies on it —
   unless an admin explicitly enables documented single-approver mode, which is
   itself a `CONFIG_CHANGED` event and is displayed on the graduation record.
3. Nobody audits their own work or their direct reports' work. QA assignment
   enforces this at sampling time and re-checks at audit start.
4. Nobody approves their own escalation resolution at severity ≥ a configured
   threshold (`CONFIG-PENDING`, register item 9).

## 5. Information architecture

```
Dashboard (role-adaptive)
My Work            — tasks, queues, my students
Students           — master list → student record (13 tabs)
Communications     — contact flow, interaction log, templates
Coaching           — sessions, calendars, notes, action items
Freelancing        — activity log, readiness, progress
Gigs               — submission, verification queue, decisions
Graduation         — progress, eligibility, review, approval
Risks              — register, interventions, reviews
Escalations        — cases, matrix routing, SLA
Quality            — cycles, sampling, audits, findings, corrective actions
Tasks              — cross-module task inbox
Teams              — org, allocation, capacity, absence, performance
Reports            — report set, filters, exports, schedules
Notifications      — inbox, preferences, digests
Audit Logs         — audit trail, data history, system logs
Admin              — the configuration registry (§11)
```

Every operational screen carries a contextual, versioned SOP link resolved by
`(screen, cohort)`: *SOP defines the process → the application enforces it →
QA verifies it → the dashboard measures it.*

## 6. Screen inventory

Full per-screen specifications are in
[`08-screen-specifications.md`](08-screen-specifications.md). Inventory:

**Dashboards (7):** Coordinator · Team Leader · Coach · Coaching Manager ·
Quality (Specialist / Lead) · Operations Control Tower · PM.

**Students (15):** list · record header · Overview · Journey · Timeline ·
Communications · Coaching · Freelancing · Gigs · Graduation · Tasks · Risks ·
Escalations · Quality · Documents · History.

**Work (4):** My Work queue · task detail · saved views · global search results.

**Communications (4):** contact flow · interaction record · call log ·
template library.

**Coaching (4):** session calendar · session detail/notes · action items ·
missed-session queue.

**Freelancing (2):** activity log · progress screen.

**Gigs (3):** gig submission · verification queue · verification screen.

**Graduation (3):** graduation progress · review queue · approval/reversal.

**Risk (3):** risk register · risk record · intervention plan.

**Escalations (3):** case list · case detail · escalation matrix view.

**Quality (8):** cycles · sampling · audit assignment · audit execution ·
finding · corrective action · re-audit · calibration & appeals.

**Teams (5):** team list · staff record · allocation · capacity & absence ·
performance scorecard.

**Reports (3):** report catalogue · report viewer · schedule & delivery.

**Admin (24):** one per registry area (§11 of the build prompt) plus cohort
management, cohort clone, config-change preview, and the Open Decisions
Register view.

**Cross-cutting states (4):** empty · error · loading · permission-denied —
specified once and applied uniformly (§30–32).

## 7. User journeys

| # | Journey | Actors | Terminates in |
|---|---|---|---|
| J1 | Intake → assignment → first contact → onboarded | Ops Associate, Coordinator | `Onboarded` or `Unresponsive` |
| J2 | Coordinator working day | Coordinator | Queue drained; all interactions logged |
| J3 | Student goes quiet → unresponsive flow → escalation | Coordinator, TL, Ops | `Resolved` or `Withdrawn` |
| J4 | Coaching cycle: schedule → deliver → notes → actions | Coach, Coaching Manager | `Completed` with actions, or `Missed` |
| J5 | Freelance readiness → activity → first gig | Coordinator, Coach, Student | `Gig Progress` |
| J6 | Gig submission → verification → approval/rejection | Coordinator, Verifier | `Approved` / `Rejected` |
| J7 | Eligibility → verification → graduation approval | Coordinator, Verifier, Approver | `Approved Graduate` |
| J8 | QA sampling → audit → finding → corrective action → re-audit | Quality Specialist/Lead, audited staff, manager | `Closed` |
| J9 | Staff absence → delegation → return | TL, Ops | Students re-owned |
| J10 | Cohort close → archive → clone into next cohort | PM, Admin | New cohort `Draft` |
| J11 | PM: 61% → the student who explains it | PM | A student's event history (≤5 clicks) |
| J12 | Ops: find every unowned/uncontacted/stalled student | Ops | Exception queues cleared (<30s to identify) |

Each journey is decomposed into the workflows of
[`09-workflow-specifications.md`](09-workflow-specifications.md).

## 8. Student lifecycle

```
Imported → Assigned → Contacted → Onboarded → Coaching → Freelance Ready
        → Active Freelancing → Gig Progress → Graduation Eligible
        → Verification → Graduated
```

Parallel statuses (orthogonal to stage, multi-valued where configured):
`Inactive` · `Unresponsive` · `At Risk` · `Escalated` · `Withdrawn` ·
`Excluded`.

Stage set, ordering, entry conditions and permissions are **configurable per
cohort**. `Withdrawn` and `Excluded` require a reason code and apply the
cohort's configured denominator policy (register item 2); the policy choice in
force is stored on the student's graduation progress record so the headline KPI
is always explainable.

Full transition tables, guards and side effects:
[`05-state-machines.md`](05-state-machines.md).

## 9. Workflow & state diagrams

Five explicit, configurable state machines — lifecycle, gig workflow,
escalation, corrective action, graduation — each defined **as data**:

```
(from_state, to_state, required_permission, required_conditions,
 required_reason, side_effects)
```

Transitions validate server-side. A blocked transition returns a structured
machine-readable reason which the UI displays verbatim. No client may set a
terminal state directly; a coordinator can never set `Graduated`.

## 10. Module requirements

Condensed here; the authoritative behaviour is in the screen specs (Phase B)
and workflow specs (Phase C).

### 10.1 Student Master
Header shows: student ID · name · phone · email · cohort · track · group ·
coordinator · TL · Coach T1 · Coach T2 · coaching managers · lifecycle stage ·
risk status · graduation status · last contact · next action. Thirteen tabs per
§7.1 of the build prompt. The header is a read model, refreshed on event.

### 10.2 Communications
Channels WhatsApp · phone · email · other, extensible. **Manual logging is
always available and is the default implementation** — the system is fully
operable with zero integrations enabled.

The contact flow is one screen: context panel → channel → purpose → template →
send/open → **Record Interaction**. Required fields at capture are deliberately
minimal — outcome, next action, next follow-up date. Deeper evidence is
requested asynchronously through a generated task: speed at the point of
contact, completeness enforced by QA and by SLA on the follow-up task.

On save the system atomically performs all of: create communication record ·
update last contact · recalculate SLA · create the next task if required ·
update coordinator activity metrics · append timeline event · append audit
event · re-evaluate risk rules · fire notifications. **No user ever updates two
modules by hand for one real-world action.**

### 10.3 Follow-up & SLA engine
Contact frequency configurable per stage × risk × track. Tracks last contact,
next contact due, days since contact, attempt count, and SLA state
(`compliant` / `approaching` / `breached`). Working-calendar aware — an SLA does
not breach on a national holiday. A breach emits `SLA_BREACHED` and is
attributable to the owner **at the time of breach**, resolved from the
effective-dated assignment table.

### 10.4 Unresponsive flow
Configurable attempt thresholds and cool-down (register item 4). Attempt 1 →
`Waiting`; attempt 2 → `Warning`; attempt N → `Unresponsive`. On threshold:
flag student, create TL action, recommend escalation, update risk, surface on
the control tower. Attempts are **de-duplicated per configurable window** so
attempt counts cannot be inflated.

### 10.5 Tasks / My Work
Task carries: id · student · type · owner · created by · priority · created ·
due · status · completed · completion notes · source (`manual` / `workflow` /
`risk` / `sla` / `qa` / `gig` / `graduation` / `escalation`) · originating
event id. Statuses: Open · In Progress · Completed · Overdue · Cancelled.
Auto-tasks are **deduplicated**: an unresolved auto-task of the same type for
the same student is updated, never duplicated. Student reassignment reassigns
open tasks with an audit entry.

### 10.6 Coaching
Both types. Session record per §7.10 of the build prompt. Statuses: Scheduled ·
Completed · Missed by student · Missed by coach · Cancelled · Rescheduled ·
No-show. Coach action items assigned to student/coordinator/coach/TL/other
**automatically become tasks** with owners and due dates.

### 10.7 Freelancing
Activity types configurable (suggested set per §7.11). Progress screen shows
profile, portfolio, readiness, proposals, responses, interviews, offers, gigs,
verified revenue, current milestone, deadline, days remaining. No vanity
metrics: every counter on this screen is either a graduation input or a risk
input.

### 10.8 Gigs
`Draft → Submitted → Under Review → Approved | More Evidence Required |
Rejected`. Currency stored as original amount + currency **plus** a converted
value computed with a stored, dated FX rate; historical values are never
recomputed at today's rate. Verification screen includes duplicate detection
(same client/title/value across students). Reject and More-Evidence require a
structured reason code plus free text. Approved gigs lock critical fields;
unlocking requires `override_lock`, a reason and an audit event. Evidence files
are hashed at upload and the hash stored, so tampering is detectable.

### 10.9 Graduation
Multi-route configurable rules engine. Statuses: Not Eligible · Progressing ·
Potentially Eligible · Eligibility Met · Pending Verification · Approved
Graduate · Returned for Review · Rejected. The engine must always **explain the
gap in plain language** — "2 of 3 required verified gigs completed. Missing: 1
verified gig with payment evidence." The record shows route, verified gigs,
revenue, required evidence, criteria met/not met, review history, approver, and
the **config version used**. Reversal requires elevated permission, a reason, an
audit event, and preservation of the pre-reversal state as an immutable
snapshot.

### 10.10 Risk
Green/Amber/Red with multi-reason codes. **Rule-based only; no AI in v1.**
Every automated change records which rule fired, under which config version, on
which evidence. Manual override allowed with a reason and a mandatory review
date. Amber/Red require an intervention plan whose actions become tasks.

### 10.11 Escalations
Case per §7.15. Statuses: Open · Assigned · In Progress · Awaiting Information ·
Resolved · Closed · Reopened. Configurable routing matrix per category with
auto-escalation to the next tier on SLA breach.

### 10.12 Quality
Cycles, assignment, sampling, scorecards, findings, evidence, feedback,
corrective actions, re-audits, reporting. **Sampling is reproducible** — seed,
population definition, filter and timestamp are stored so any sample can be
defended and re-created. Scorecards are versioned; a completed audit stores its
scorecard version. Calibration supports multiple auditors on one record with
inter-auditor variance reporting. Appeals are first-class: dispute, reviewer,
outcome. **A finding cannot be closed without evidence, or an explicit Quality
Lead waiver with a reason.**

### 10.13 Teams, allocation, performance
Allocation modes: individual · bulk · reassignment · team transfer · coach
assignment · track-based · capacity-based (respecting max-load config). Every
reassignment is audited and carries over open tasks and open escalations.
Marking a staff member unavailable surfaces their students on the control tower
and supports temporary delegation with an end date.

Performance scorecards are configurable-weight and **graduation outcome is
never the sole measure**. Scores are normalised for caseload and student-mix
difficulty, and every component drills down to the records behind it.

## 11. User stories

Selected; the full backlog derives mechanically from the screen and workflow
specs. Format: *As a … I need … so that …*

**Coordinator**
- C1. As a coordinator I need a prioritised queue telling me who to contact
  next, so that I do not decide priority myself each morning.
- C2. As a coordinator I need to log a call in under 30 seconds on my phone,
  so that logging does not compete with calling.
- C3. As a coordinator I need the system to schedule my next follow-up when I
  record an outcome, so that nothing depends on my memory.
- C4. As a coordinator I need to see why a student is Red and what the system
  expects me to do, so that risk is actionable rather than decorative.

**Team Leader**
- T1. As a TL I need to see which of my coordinators are breaching SLA and on
  which students, so that I coach the person, not the average.
- T2. As a TL I need reassignment to carry open tasks and escalations, so that
  handover does not drop work.

**Coach / Coaching Manager**
- K1. As a coach I need today's sessions and the notes I owe, so that
  documentation debt is visible.
- K2. As a coaching manager I need students with no coaching at all, so that
  gaps surface before they become risk.

**Quality**
- Q1. As a quality specialist I need my audit queue with due dates, so that
  coverage targets are met.
- Q2. As a quality lead I need to defend any sample to an external client, so
  that I can reproduce it exactly with its seed and population.
- Q3. As an audited coordinator I need to dispute a finding formally, so that
  the score is fair and the dispute is on record.

**Operations**
- O1. As an operations associate I need every exception as a queue with an
  owner and an age clock, so that "nobody owns this" is impossible.
- O2. As an operations associate I need failed imports and failed integrations
  in the same place as operational exceptions, so that data problems are
  operational problems.

**PM**
- P1. As a PM I need a deterministic, explainable forecast with its assumptions
  on the same screen, so that I can act on it rather than believe it.
- P2. As a PM I need to reach the individual student behind a number in five
  clicks, so that reviews are about records, not opinions.

**Admin**
- A1. As an admin I need to preview how many students a rule change would
  reclassify before I save it, so that no cohort is silently re-graded.
- A2. As an admin I need to clone a cohort's configuration in one click, so
  that the next cohort needs no engineering.

## 12. Acceptance criteria

Given/When/Then, testable, one per rule that matters. Selected set; the full set
is generated per workflow in Phase C and per screen in Phase B.

**AC-01 (Invariant 3).** *Given* a student whose coordinator is deactivated,
*when* the deactivation is saved, *then* the student's assignment closes, the
student appears in the Ops "unassigned students" queue with an age clock
starting at the deactivation timestamp, and `STUDENT_REASSIGNED` is not emitted
until a new coordinator is set.

**AC-02 (Atomic interaction).** *Given* a coordinator records an interaction
with outcome `No response` and a next follow-up date, *when* they save, *then*
in a single transaction the communication record is created, `last_contact_at`
updates, the SLA state recomputes, a follow-up task exists for that date,
`INTERACTION_RECORDED` and `MESSAGE_SENT`/`CALL_LOGGED` are appended, risk rules
re-evaluate, and notifications are queued — or, on any failure, none of these
occur.

**AC-03 (Attempt de-duplication).** *Given* the configured de-duplication
window is 4 hours, *when* a coordinator logs three no-answer calls within
2 hours, *then* the attempt counter increments by exactly 1.

**AC-04 (Working calendar).** *Given* a follow-up due on a configured public
holiday, *when* the SLA sweeper runs on that day, *then* no `SLA_BREACHED`
event is emitted and the due date rolls to the next working period.

**AC-05 (Idempotency).** *Given* any event is delivered twice with the same
`event_id`, *when* handlers run, *then* no duplicate task, KPI increment or
notification is produced.

**AC-06 (SoD, gig).** *Given* user U submitted gig G, *when* U opens G's
verification screen, *then* the Approve/Reject controls are absent, a
server-side attempt returns a structured denial, and the attempt is logged.

**AC-07 (SoD, graduation).** *Given* user V verified the gig that satisfies
student S's route, *when* V attempts to approve S's graduation and
single-approver mode is disabled, *then* the transition is blocked with a
verbatim reason and logged.

**AC-08 (Terminal state).** *Given* a coordinator with every operational
permission, *when* they attempt any transition into `Graduated`, *then* it is
denied — the transition requires a permission no coordinator role composition
can hold.

**AC-09 (Config non-retroactivity).** *Given* graduation rules change on
1 March, *when* a graduation approved on 1 February is re-opened, *then* it
displays the February config version under which it was evaluated, and its
historical evaluation is unchanged.

**AC-10 (Config preview).** *Given* an admin edits an SLA rule, *when* they
save, *then* they are shown the count of currently-affected students by
resulting status change, and must supply an audit reason to confirm.

**AC-11 (Gap explanation).** *Given* a student meets 2 of 3 required verified
gigs, *when* the graduation tab renders, *then* it states the shortfall in
plain language naming the missing artefact and the evidence standard.

**AC-12 (FX immutability).** *Given* a gig approved at an FX rate dated
1 January, *when* the gig or any report displaying it is re-rendered later,
*then* the converted value is unchanged.

**AC-13 (Evidence integrity).** *Given* an evidence file is replaced in object
storage, *when* the verification screen loads, *then* the stored hash mismatch
is detected and surfaced as a tampering warning.

**AC-14 (Lock override).** *Given* an approved gig, *when* a user with
`override_lock` edits a locked field, *then* a reason is mandatory, a pre-change
snapshot is preserved, and an audit event records old and new values.

**AC-15 (QA self-audit).** *Given* auditor A is the direct manager of
coordinator B, *when* sampling selects B's record for A, *then* the assignment
is rejected at sampling time and reassigned.

**AC-16 (Finding closure).** *Given* an open finding with no evidence, *when*
a user attempts to close it, *then* closure is denied unless the actor is a
Quality Lead exercising a waiver with a recorded reason.

**AC-17 (Sample reproducibility).** *Given* any completed sample, *when* it is
re-run from its stored seed, population definition, filter and timestamp,
*then* the identical record set is produced.

**AC-18 ("As of" reporting).** *Given* a coordinator moved teams on 15 March,
*when* Team A's SLA compliance for February is computed, *then* that
coordinator's February records count toward Team A.

**AC-19 (Drill-down).** *Given* any dashboard tile, *when* it is clicked,
*then* a permission-scoped record list opens whose count equals the tile value
for the same filters and as-of timestamp.

**AC-20 (Export).** *Given* any export, *when* it completes, *then* it is
permission-checked, PII-scoped to the actor's role, watermarked with user and
timestamp, and `EXPORT_PERFORMED` is appended.

**AC-21 (Import atomicity).** *Given* an import batch with invalid rows and
"import valid rows only" **not** selected, *when* import runs, *then* no rows
are committed and an error report is produced.

**AC-22 (Import rollback).** *Given* a committed batch with no downstream
events, *when* an operator rolls it back, *then* all its records are removed and
the rollback is audited; *given* downstream events exist, *then* rollback is
refused with the blocking event listed.

**AC-23 (Reconciliation).** *Given* the full event log, *when* KPIs are
recomputed from raw events, *then* they match the read models exactly; any
divergence raises a system alert.

**AC-24 (Cohort clone).** *Given* an active cohort, *when* an admin clones its
configuration, *then* a `Draft` cohort exists with every configuration area
copied, zero students, and no code change was required.

**AC-25 (RTL).** *Given* Arabic locale, *when* any operational screen renders,
*then* layout direction, iconography, numerals and date formatting follow the
locale, and no text is clipped or mirrored incorrectly.

**AC-26 (Offline capture).** *Given* a coordinator loses connectivity mid-log,
*when* they save, *then* the interaction queues locally, submits on reconnect,
and a server-side conflict produces a resolvable prompt rather than data loss.

**AC-27 (Permission-driven navigation).** *Given* any role, *when* the shell
renders, *then* the visible modules exactly equal the modules for which the role
holds ≥1 `view` permission in scope.

**AC-28 (Notification fatigue).** *Given* a student triggers five notifiable
events in one minute, *when* notifications dispatch, *then* rate limiting and
deduplication apply per the configured policy and the user's digest preference
is honoured.

## 19. Notification logic

In-app first; a modular provider layer for email/WhatsApp/Teams later. Triggers
per §7.18 of the build prompt. Every notification is
`(trigger, audience_resolver, template, channel_preference, rate_limit_key)` in
configuration. Deduplication is by `(user, rate_limit_key, window)`. Digest
mode batches non-urgent notifications on a per-user schedule. Failures are
recorded in **system logs** (not the audit log) and retried with backoff into a
DLQ.

## 20. Task-generation logic

Tasks are generated by handlers subscribing to events, never by UI code. Each
generator declares:

```
(source, trigger_event, dedup_key, owner_resolver, due_date_rule,
 priority_rule, cancel_conditions)
```

`dedup_key` is typically `(student_id, task_type, open)`. An unresolved auto-task
matching the key is **updated** (due date, priority, originating event) rather
than duplicated. `cancel_conditions` auto-cancel a task when its reason
disappears (e.g. the student replies), emitting a cancellation with a reason so
the queue does not accumulate stale work.

## 26. Dashboard requirements

Seven role-adaptive dashboards per §6 of the build prompt. Rules:

1. Every tile maps to a `metric_key` in the metric registry.
2. Every tile is drillable to a record list, then to a record, then to an event.
3. Coordinators get a work queue, not analytics.
4. Ops gets exceptions, each with an owner and an age clock.
5. All dashboards read from read models, never from OLTP aggregates.
6. Every dashboard supports as-of dating and the standard segmentation set
   (track · team · coordinator · TL · coach · coaching manager · risk reason ·
   milestone · cohort/group · intake date).

The PM forecast is deterministic: `cohort time remaining × observed stage
conversion rates × current pipeline`, with stated assumptions, a sensitivity
band, and a "what must change to hit 85%" gap breakdown, all rendered on the
same screen as the number. **No ML, no black-box prediction in v1.**

## 27. Search & filter requirements

Global search across student ID · name · email · phone · gig ID · escalation
ID · staff · cohort · track, with fuzzy and partial matching, results
permission-scoped at query time (not filtered after fetch). Saved views are
shareable within scope, seeded with: My Red Students · No Contact Within SLA ·
No Gig Yet · Eligible Awaiting Verification · Coaching Missing · Escalations
Overdue — plus user-defined filters.

## 28. Import/export requirements

Import: `Upload → Schema Validation → Business Validation Preview → Error
Report → Confirmation → Import → Results Summary`. Detects duplicate IDs, fuzzy
duplicate persons (name + phone + email), invalid tracks, missing required
fields, invalid assignments, invalid formats and capacity violations. Every
import has a batch id; records carry `source_batch_id`; batches are
transactional and reversible before downstream events accumulate. All-or-nothing
per batch unless the operator explicitly chooses "import valid rows only".

Export: Excel, CSV, PDF where practical; permission-checked, PII-scoped,
watermarked, logged as `EXPORT_PERFORMED`. Scheduled delivery with recipient
lists. Every report carries generation timestamp, filter set, and metric
definitions version.

## 29. Security requirements

- Authentication with MFA support; session management; forced re-auth for
  elevated actions (`override_lock`, `impersonate`, graduation reversal).
- Authorization at three layers: route/permission, service-layer scope
  resolution, and PostgreSQL row-level security scoped by cohort and hierarchy.
- Impersonation is admin-only, time-boxed, banner-visible to the impersonator,
  and always audited.
- PII classification on every field; masking by role; message bodies stored only
  where policy permits and consent is recorded.
- Retention rules and a documented data-subject deletion path that
  **pseudonymises** rather than deleting, preserving the event chain.
- Evidence files hashed at upload; object storage private with signed,
  short-lived URLs.
- Secrets in a managed store; no secrets in configuration rows.
- Security events (failed logins, permission denials, lock overrides,
  impersonation) go to both the audit log and the system log with alerting.

## 30. Error states

Every screen defines: transient (retryable) errors with a retry affordance;
validation errors bound to the offending field with the rule that failed;
conflict errors (someone else changed this) with a diff and a resolution
choice; blocked-transition errors rendering the server's structured reason
**verbatim**; and integration errors that never block manual operation — the
manual path is always available.

## 31. Empty states

Empty is distinguished from "not loaded" and from "filtered to nothing". Each
empty state names the reason and offers the next action (e.g. "No students
assigned to you yet — Ops assigns students after import"). Exception queues at
zero display an explicit "clear" state, because zero is meaningful there.

## 32. Permission-denied states

A user never navigates to a denied screen — navigation renders from the matrix.
Where a denial is still reachable (deep link, shared saved view, scope change
mid-session), the screen states which permission is required, in which scope,
and who to request it from, and the denial is logged. Denied does not leak data:
no record counts, names or existence hints.

## 33. Responsive behaviour

Full function on desktop and tablet. **Fully usable on mobile:** the coordinator
work queue, the contact flow, call logging and session logging. These paths
tolerate poor connectivity with optimistic UI, queued submission and
conflict-safe retry. Dashboards and Admin are desktop/tablet-first and degrade
to read-only summaries on mobile. RTL is a first-class layout at every
breakpoint.

## 34. System administration

The configuration registry (§11 of the build prompt) with versioning and
effective dates on every area. Cohort states: Draft · Active · Closed ·
Archived. Cohort configuration cloning is one click. Changes to graduation
rules, SLA rules or risk rules require a **preview of how many current students
would change status**, a confirmation step, and an audit reason — no silent
reclassification of a cohort. The Open Decisions Register is a first-class Admin
screen, and every `CONFIG-PENDING` item renders a visible badge wherever its
value is used.

## 35–38. Technical architecture, API, database, deployment

See [`10-technical-architecture.md`](10-technical-architecture.md).

## 39–40. Testing plan and UAT plan

See [`11-testing-and-release-plan.md`](11-testing-and-release-plan.md).
