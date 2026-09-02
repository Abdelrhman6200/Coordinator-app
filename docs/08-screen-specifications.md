# 08 — Screen Specifications (Phase B)

## 0. Specification template

Every screen is specified with: **name · roles with access · purpose · data
displayed · filters · actions · permissions · buttons · forms · required fields
· validation · empty state · error state · loading state · success state ·
related workflows · audit events generated · notifications generated · tasks
generated · data updated · next screen/action.**

## 0.1 Global patterns (specified once, applied everywhere)

- **Loading:** skeleton matching the final layout; lists stream first page; no
  spinner-only screens. Any wait > 400ms shows progressive content.
- **Empty:** distinguishes *nothing exists* / *nothing matches your filter* /
  *you have no access to anything here*, and names the next action. On an
  exception queue, zero renders an explicit **clear** state — zero is a result.
- **Error:** transient errors offer retry; validation errors bind to the field
  and name the failed rule; conflicts show a diff and a resolution choice;
  blocked transitions render the server's structured reason **verbatim**;
  integration errors never block the manual path.
- **Permission-denied:** states the required `(module, verb, scope)` and who
  grants it. Leaks nothing — no counts, names or existence hints. Logged.
- **SOP:** every operational screen shows a contextual, versioned SOP link
  resolved by `(screen_key, cohort_id)`.
- **RTL/i18n:** all screens render in Arabic with correct direction, numerals
  and date formatting. Arabic is a first-class layout at every breakpoint.
- **Drill-down:** every metric tile links to a record list whose count equals
  the tile for the same filters and as-of timestamp.
- **Offline:** contact flow, call logging, session logging and task completion
  queue locally and submit on reconnect, keyed by `client_dedup_key`.

---

## 1. Coordinator Dashboard

| | |
|---|---|
| **Roles** | Operations Coordinator (own); TL/Ops/Admin may view a coordinator's dashboard in scope |
| **Purpose** | Answer *"what do I do now?"* — a work queue, not analytics (Prohibition 12) |
| **Data** | Tiles: assigned students · new students · follow-ups due today · overdue follow-ups · awaiting response · unresponsive · Amber · Red · open escalations · upcoming coaching actions · students with gig progress · students approaching graduation. **Primary element:** prioritised action queue |
| **Queue columns** | `Student │ Problem │ Last Contact │ Next Action │ Deadline │ Risk` |
| **Sort** | Configurable priority score: SLA breach > Red risk > escalation > graduation-critical > routine |
| **Filters** | Risk · stage · track · due window · problem type · saved views |
| **Actions** | One-click **Contact** into the contact flow from every row · open student · complete task · snooze with reason (audited) |
| **Permissions** | `dashboard.view@own`, `communications.create@own`, `tasks.edit@own` |
| **Forms** | None (queue only); snooze requires a reason code |
| **Validation** | Snooze reason mandatory; snooze bounded by config |
| **Empty** | "Your queue is clear." Shows next scheduled follow-up date. Distinct from "no students assigned — Ops assigns after import" |
| **Error** | Tile-level failure degrades that tile only; the queue is never blocked by a failed tile |
| **Success** | Row disappears from the queue with an undo affordance for 5s |
| **Workflows** | W04 coordinator follow-up · W05 send message · W07 call · W08 no-response |
| **Events** | None on view. Row actions emit their own workflow events |
| **Notifications** | None generated |
| **Tasks** | None generated (consumes them) |
| **Next** | Contact flow, or student record |

Tiles are analytics-light by design: they are **counts that route into the
queue**, filtered. A coordinator is never given a chart to interpret.

---

## 2. Team Leader Dashboard

**Roles:** Team Leader (team), Ops, PM, Admin.
**Purpose:** *"what is going wrong and who owns it?"*
**Data:** coordinator count · total students · follow-up compliance · overdue
follow-ups · at-risk students · Red students · open escalations · coordinator
workload · coordinator performance · QA results · graduation progress.
**Drill path (mandatory):** Team KPI → Coordinator → Students → Student
Record → Event.
**Filters:** coordinator · track · risk · stage · date range · as-of date.
**Actions:** reassign students (`students.reassign@team`) · assign task ·
open coordinator scorecard · raise escalation.
**Validation:** reassignment respects capacity or requires an override reason.
**Empty:** "No coordinators in this team yet."
**Events:** `STUDENT_REASSIGNED`, `TASK_CREATED`, `ESCALATION_RAISED` from
actions. **Notifications:** to affected coordinators on reassignment.

---

## 3. Coach Dashboard

**Roles:** Coach T1/T2 (own), Coaching Manager (coaching_team), Ops, Admin.
**Purpose:** today's delivery and documentation debt.
**Data:** today's sessions · upcoming sessions · **missing session notes** ·
student action items · missed sessions · at-risk students · coaching
escalations.
**Actions:** start session · complete notes · reschedule (reason required) ·
mark missed (by student / by coach) · create action item · recommend risk ·
raise escalation.
**Required fields:** completing a session requires notes; marking missed
requires a reason code.
**Events:** `COACHING_COMPLETED`, `COACHING_MISSED`, `COACH_ACTION_CREATED`.
**Tasks:** action items with staff assignees materialise as tasks; missing notes
generates a documentation task due +1 working day.
**Empty:** "No sessions scheduled today" with a link to the calendar.

---

## 4. Coaching Manager Dashboard

**Roles:** Coaching Manager T1/T2 (coaching_team), PM, Ops, Admin.
**Data:** coaches · sessions planned/completed · attendance · missed sessions ·
coach utilization · **students with no coaching** · missing notes · coaching
escalations · coach QA · student progress. Type 1 and Type 2 are configurable
and separable — a cohort may enable one, both or neither.
**Drill:** metric → coach → students → student record → event.
**Actions:** assign coach · rebalance load · raise escalation · request notes.
**Validation:** coach assignment respects `staff_capacity`.

---

## 5. Quality Dashboards

**5a — Quality Specialist.** Assigned audits · due today · overdue · re-audits ·
open findings. Actions: start audit · complete audit · raise finding · request
evidence. Empty: "No audits assigned — the Quality Lead draws samples."

**5b — Quality Lead.** Audit coverage vs target · average QA score · failure
rate · findings by category · team comparison · corrective actions · repeated
failures · re-audit outcomes · **calibration variance between auditors**.
Actions: draw sample (`quality.audit@cohort`) · assign auditors · open
calibration view · decide appeal · issue waiver (reason mandatory) · configure
scorecard version.
**Validation:** SoD-3 applied at draw and re-checked at audit start; waiver
requires a reason; scorecard changes create a new version, never edit in place.
**Events:** `QA_SAMPLE_DRAWN`, `QA_AUDIT_ASSIGNED`, `QA_APPEAL_DECIDED`,
`CONFIG_CHANGED`.

---

## 6. Operations Control Tower

**Roles:** Project Operations Associate, PM, Admin.
**Purpose:** *"what are the exceptions?"* — exception-first, nothing else.
**Each exception is a work queue with an owner and an age clock.**

| Exception queue | Owner resolver | Age clock starts |
|---|---|---|
| Unassigned students | Ops | assignment closed / import |
| Never contacted | coordinator | assignment |
| Overdue follow-ups | coordinator | due date |
| Missing coach assignment | coaching manager | stage `Coaching` entry |
| Missing coaching sessions | coaching manager | stage entry + config window |
| Red students | coordinator + TL | risk opened |
| SLA breaches | owner at breach | breach |
| Open escalations | assignee | raised |
| Gigs pending verification | verification pool | submitted |
| Graduation-eligible awaiting review | ops/verifier | `GRADUATION_ELIGIBLE` |
| Missing required data | coordinator | detection |
| Overdue corrective actions | action owner | due date |
| Staff over capacity | TL / coaching manager | breach of cap |
| Staff absent with unowned students | Ops | absence start |
| Failed imports | uploader | failure |
| Failed integrations | Admin | failure |

**Actions:** bulk assign · bulk reassign · delegate · open record · escalate ·
export (audited).
**Empty:** each queue at zero renders an explicit **clear** badge with the
timestamp it cleared — because zero is the goal state, not an absence of data.
**Design target:** every unowned, uncontacted or stalled student identifiable in
**under thirty seconds** (UAT OPS-01).

---

## 7. PM Dashboard

**Roles:** PM, Admin; Client Viewer sees a masked aggregate variant.
**Data:** total students · graduation target · graduated · current graduation
rate · eligible · pending verification · on-track · at-risk · critical ·
**graduation forecast**.
**Funnel:** Total → Onboarded → Coaching → Freelance Ready → Active
Freelancing → Gig Progress → Graduation Eligible → Verified → Graduated, with
conversion, **average dwell time** per stage, and stage-to-stage leakage.
**Forecast panel:** the number, its **assumptions**, a **sensitivity band**, and
the **"what must change to hit 85%" gap breakdown** — all on the same screen
(§4 of the metric registry). Deterministic; no ML.
**Segmentation:** track · team · coordinator · TL · coach · coaching manager ·
risk reason · milestone · cohort/group · intake date.
**Drill (five-click rule, UAT PM-01):** rate tile → segment → student list →
student record → Timeline tab → event.
**Empty:** pre-intake cohort shows the target and "no students imported yet".
**Export:** permission-checked, PII-scoped, watermarked, logged.

---

## 8. Students — list

**Roles:** all operational roles, scope-limited; coach sees the coaching
projection; client viewer sees masked aggregates only.
**Columns:** ID · name · phone (masked by role) · track · group · stage · risk ·
coordinator · TL · coach T1/T2 · last contact · next action · graduation status.
**Filters:** cohort · track · group · stage · status · risk · coordinator · TL ·
coach · graduation status · last-contact window · saved views.
**Actions:** open · bulk assign · bulk reassign · bulk task · export.
**Permissions:** `students.view@scope`; bulk actions require
`students.assign`/`reassign` at the covering scope.
**Validation:** bulk actions preview the affected set and require confirmation;
capacity violations are listed and require an override reason.
**Empty:** "No students match these filters" with a one-click clear.
**Events:** `STUDENT_ASSIGNED` / `STUDENT_REASSIGNED`, `EXPORT_PERFORMED`.

---

## 9. Student record — header and tabs

**Header (always visible):** Student ID · name · phone · email · cohort · track
· group · coordinator · TL · Coach T1 · Coach T2 · coaching managers ·
lifecycle stage · risk status · graduation status · last contact · next action.
Header actions: **Contact** · Log call · Add task · Change stage · Raise
escalation · Open SOP.

| Tab | Shows | Key actions | Events |
|---|---|---|---|
| **Overview** | summary, next action, open risks/escalations, graduation gap | quick actions | — |
| **Journey** | milestone path: date achieved · owner · required evidence · deadline · state · **blocking reason** | mark achieved (evidence required), reassign owner | milestone events |
| **Timeline** | chronological merge of all module events, filterable by module/actor/date, human-readable | filter, export | — |
| **Communications** | interaction history + contact flow entry | new interaction, log call | `MESSAGE_SENT`, `CALL_LOGGED`, `INTERACTION_RECORDED` |
| **Coaching** | sessions both types, notes, action items | schedule, complete, mark missed | `COACHING_*` |
| **Freelancing** | activity log + progress panel | log activity | `FREELANCE_ACTIVITY_LOGGED` |
| **Gigs** | gigs, status, evidence, review history | submit, add evidence | `GIG_SUBMITTED` |
| **Graduation** | route, criteria met/not met, **plain-language gap**, review history, approver, **config version used** | submit for verification | `GRADUATION_SUBMITTED` |
| **Tasks** | open and historical tasks | create, complete, cancel (reason) | `TASK_*` |
| **Risks** | current level, reasons, evidence, **firing rule + config version**, interventions | override (reason + review date), create intervention | `RISK_CHANGED`, `RISK_OVERRIDDEN`, `INTERVENTION_CREATED` |
| **Escalations** | cases, tier, SLA, actions | raise, act, resolve | `ESCALATION_*` |
| **Quality** | audits touching this student, findings | view (QA writes only from QA module) | — |
| **Documents** | files, hashes, uploader | upload, download (audited) | document events |
| **History** | field-level before/after with actor and reason | export | — |

**Timeline sufficiency is a tested property:** replaying a seeded student's full
lifecycle must render every workflow step.

---

## 10. Contact flow *(the most important screen in the product)*

**Roles:** Coordinator (own), TL (team), Ops (cohort).
**Purpose:** complete one real-world contact in one screen with minimal clicks.
**Mobile: fully usable.** Offline-tolerant.

**Layout — four zones, one screen:**

1. **Context panel** — name, ID, stage, risk, last interaction, phone /
   WhatsApp / email, open tasks, open escalations, **SOP link**.
2. **Channel** — WhatsApp · phone · email · other.
3. **Purpose → template** — purpose code drives the template list; template
   preview in the student's language.
4. **Record Interaction** — the form below.

**Record Interaction form:**

| Field | Required | Validation |
|---|---|---|
| Outcome | **yes** | one of `Responded`, `Waiting`, `No response`, `Needs support`, `Callback requested`, `Issue identified` |
| Next action | **yes** | from the configured action list |
| Next follow-up date | **yes** | ≥ now; snapped to a working period |
| Progress notes | no | — |
| Notes | no | — |
| Risk recommendation | no | drives the risk engine as a signal, does not set risk directly |
| Escalation required | no | ticking opens the escalation form inline |
| Message body | conditional | stored only where policy **and** student consent permit |

Required fields are **deliberately minimal** — speed at the point of contact.
Deeper evidence is requested asynchronously via a generated task; completeness
is enforced by QA and by SLA on that task.

**On save the system performs atomically, in one transaction:** create the
communication record · update last contact · recalculate SLA · create the next
task if required · update coordinator activity metrics · append the timeline
event · append the audit event · re-evaluate risk rules · fire notifications.
**No user ever updates two modules by hand for one real-world action**
(AC-02, Prohibition 2).

**Buttons:** Send / Open channel · Record Interaction · Record & Next
(advances to the next queue item) · Cancel.
**Empty:** N/A (always has a subject).
**Error:** offline → queued with a visible "will submit" badge; server conflict
→ diff and resolve; template failure → manual body still permitted.
**Success:** toast plus, in *Record & Next* mode, immediate advance to the next
queue row.
**Events:** `MESSAGE_SENT` | `CALL_LOGGED`, `INTERACTION_RECORDED`,
`FOLLOWUP_SCHEDULED`, conditionally `RISK_CHANGED`, `ESCALATION_RAISED`.
**Tasks:** follow-up task; evidence-gap task where configured.
**Next:** next queue item, or the student record.

---

## 11. Call logging

Specialisation of the contact flow with channel pre-set to phone.
**Additional fields:** connect result (`Connected` · `No answer` · `Busy` ·
`Wrong number` · `Callback requested`) · duration (required when connected) ·
topics · progress · challenges · notes · next action · deadline · risk ·
escalation requirement.
**Attempt de-duplication:** attempts within the configured window collapse to
one attempt (AC-03). The screen shows the current attempt count and the window,
so the behaviour is visible rather than surprising.
**Mobile:** single-thumb operation; target < 30 seconds to log (user story C2).

---

## 12. Freelancing — activity log & progress

**Activity log:** student · date · platform · type · result · evidence · notes ·
entered by. Activity types are configurable per cohort.
**Progress screen:** profile status · portfolio status · readiness · proposals ·
responses · interviews · offers · gigs · **verified revenue** · current
milestone · deadline · days remaining.
**No vanity metrics:** every counter here is either a graduation input or a risk
input, and each links to the criterion or rule that consumes it.
**Events:** `FREELANCE_ACTIVITY_LOGGED`; triggers graduation and risk
re-evaluation.

---

## 13. Gig submission

**Roles:** Coordinator (own), Coach (own), Ops.
**Fields:** platform/source · client · title · value + currency · date won ·
completion date · payment date · work evidence · payment evidence · notes.
**Validation:** amount > 0; `completed_on ≥ won_on`; `paid_on ≥ completed_on`;
FX rate must exist for the currency on the reference date; ≥1 work evidence to
submit. Files are **hashed at upload** and the hash stored.
**Events:** `GIG_SUBMITTED`. **Tasks:** verification task to the pool.
**Next:** verification queue (for the reviewer), gig list (for the submitter).

---

## 14. Gig verification

**Roles:** Ops / designated verifiers / Admin. **SoD-1: the submitter cannot
appear here for their own gig** — controls are absent and a server-side attempt
is blocked and logged (AC-06).
**Panels:** identity check · gig details · work evidence · payment evidence ·
value (original + converted at the **stored dated FX rate**) · dates ·
graduation relevance (which criteria this gig would satisfy) · **duplicate
detection warning** (same client/title/value across students).
**Evidence integrity:** stored hashes are re-verified on render; a mismatch
raises a tampering warning (AC-13).
**Decisions:** Approve · Request Additional Evidence · Reject. The latter two
require a **structured reason code plus free text**.
**On approve:** lock critical fields · recompute graduation · notify · emit
`GIG_APPROVED`.
**Unlock:** requires `override_lock`, a reason, re-auth, a preserved snapshot
and `GIG_LOCK_OVERRIDDEN`; if the gig backs an approved graduation, the
graduation approver is notified.
**Empty:** "No gigs awaiting verification" with the last-cleared timestamp.

---

## 15. Graduation — progress, review, approval

**Progress (student tab and standalone):** route · verified gigs · verified
revenue · required evidence · **criteria met / not met** · review history ·
approver · **config version used** · plain-language gap (AC-11).
**Review queue:** eligible and pending-verification students, aged, with the
gigs backing each.
**Approval screen:** the engine's re-confirmation, the SoD-2 check result, the
config version, and a mandatory reason code. Approval **locks the record** and
writes an immutable snapshot.
**Reversal:** elevated permission, re-auth, mandatory reason code and text,
`GRADUATION_REVERSED`, and preservation of the pre-reversal state as an
immutable snapshot.
**Blocked-transition rendering:** where SoD-2 blocks the actor, the screen
displays the server's structured reason verbatim and names who may approve.

---

## 16. Risk register, risk record, intervention plan

**Register:** students by level, reason, age, owner, next review; filters by
reason code and by firing rule.
**Record:** current level · reasons (multi) · opened date · owner ·
intervention · review date · resolution · closed date · **which rule fired,
under which config version, on which evidence**.
**Override:** allowed with a reason and a **mandatory review date**; marked
`origin = manual` and excluded from automated downgrade until review.
**Intervention plan (mandatory on Amber/Red):** risk · root cause · required
actions · owners · deadlines · next review · notes · outcome. Actions become
tasks on save.
**Exception:** a Red student without an intervention plan appears on the control
tower.

---

## 17. Escalations — list, case, matrix

**List:** open cases by tier, severity, age against SLA, assignee.
**Case:** ID · student · category · severity · raised by · raised at · assigned
to · SLA · description · attachments · status · actions · resolution · resolved
at. Overdue is auto-flagged and auto-notified up the matrix.
**Actions:** assign · act · request information (pauses SLA if configured) ·
resolve (reason + notes) · approve closure (**SoD-4** at severity ≥ threshold) ·
reopen (reason, within window).
**Matrix view:** read-only rendering of the configured routing per category and
severity, with the resolved names for this cohort — so staff can see where a
case will go before raising it.

---

## 18. Quality — cycles, sampling, audit, finding, corrective action, re-audit, calibration, appeals

**Cycles:** period, coverage target, scorecard version, status.
**Sampling:** method (random · targeted · risk-based · manual · re-audit),
population definition, filter, size, **seed**. The drawn sample stores seed,
population, filter and timestamp; a **Reproduce** button re-draws and asserts an
identical set (AC-17). SoD-3 rejections are resampled from the same stream.
**Audit execution:** per question — score · weight · comments · evidence ·
pass/fail, with auto-fail questions. Shows the scorecard version in use and the
SOP reference per question. Output: QA score plus Pass / Needs Improvement /
Fail from configured bands.
**Finding:** category · severity · description · evidence · status. **Closure
requires evidence, or an explicit Quality Lead waiver with a reason** (AC-16).
**Corrective action:** finding · user/team · root cause · required action ·
owner · manager · due date · evidence · status · re-audit requirement · result.
**Re-audit:** links the corrective action to a new audit and its result.
**Calibration:** several auditors on one subject; per-question and overall
inter-auditor variance.
**Appeals:** the audited staff member disputes; the dispute, reviewer and
outcome (`upheld`/`overturned`/`amended`) are recorded and feed the scorecard.

---

## 19. Teams, allocation, capacity & absence, performance

**Team list / staff record:** user · role · team · manager · capacity ·
assigned students · active students · workload · performance · QA score ·
status · availability.
**Allocation:** individual · bulk · reassignment · team transfer · coach
assignment · track-based · capacity-based (respects max-load config). Every
reassignment is audited and **carries over open tasks and open escalations**.
**Absence:** marking a staff member unavailable surfaces their students on the
control tower and supports **temporary delegation with an end date**; delegation
expiry returns ownership and emits `DELEGATION_ENDED`.
**Performance scorecard:** configurable weights; graduation outcome is never the
sole measure; scores normalised for caseload and student-mix difficulty with the
**un-normalised value shown alongside**; every component drills to records.

---

## 20. Tasks / My Work

**Columns:** task ID · student · type · owner · created by · priority · created
· due · status · completed · completion notes · source · originating event ID.
**Filters:** status · type · source · due window · student · priority.
**Actions:** start · complete (notes required for QA-relevant types) · cancel
(reason required) · reassign (`tasks.assign` at scope).
**Behaviour:** auto-tasks deduplicate on `dedup_key`; auto-cancel when the
generating condition disappears, with a visible reason.
**Empty:** "Nothing due" plus the next due date.

---

## 21. Reports

**Catalogue:** Daily Operations · Weekly Operations · PM Review · Coordinator
Performance · TL Performance · Coaching Performance · Freelancing Progress ·
Gig Report · Graduation Report · Risk Report · Escalation Report · QA Report ·
Corrective Action Report · Client Report.
**Filters:** cohort · date range · track · team · coordinator · TL · coach ·
status · risk · graduation status; plus **as-of date** on every report.
**Every report carries** its generation timestamp, its full filter set and the
**metric definitions version** used.
**Exports:** Excel · CSV · PDF where practical; permission-checked, PII-scoped
to the actor's role, **watermarked with user and timestamp**, and logged as
`EXPORT_PERFORMED` (AC-20).
**Scheduling:** recipient lists, cadence, format; failures are logged in system
logs and retried.
**Drill-down:** every figure in every report links to its record list.

---

## 22. Search & saved views

Global search over student ID · name · email · phone · gig ID · escalation ID ·
staff · cohort · track, fuzzy and partial, **permission-scoped at query time**
(scope is a predicate in the query, never a post-filter — otherwise result
counts leak).
Saved views shareable within scope, seeded with: My Red Students · No Contact
Within SLA · No Gig Yet · Eligible Awaiting Verification · Coaching Missing ·
Escalations Overdue.

---

## 23. Import

Wizard: **Upload → Schema Validation → Business Validation Preview → Error
Report → Confirmation → Import → Results Summary.**
**Preview detects:** duplicate IDs · fuzzy duplicate persons (name + phone +
email) · invalid tracks · missing required fields · invalid assignments ·
invalid formats · capacity violations.
**Mode:** all-or-nothing (default) or an explicit "import valid rows only".
**Results summary:** batch ID, counts, per-row errors, and a **Roll back**
action — permitted only while no downstream events reference the batch's
records; otherwise refused with the blocking events named (AC-21, AC-22).
**Events:** `STUDENT_IMPORTED` per row, `IMPORT_BATCH_COMMITTED`,
`IMPORT_BATCH_ROLLED_BACK`.

---

## 24. Admin — configuration registry

One screen per area, all sharing a common specification:

**Areas:** users · roles · permissions · teams · reporting hierarchy · cohorts ·
tracks · groups · coach types · lifecycle stages · student statuses ·
state-transition rules · risk reasons · risk rules · escalation categories ·
escalation routing · SLAs · working calendar & holidays · milestones ·
graduation rules · gig platforms · currencies & FX rates · freelancing activity
types · coaching types · QA scorecards · sampling policies · communication
templates · notification rules · report definitions · metric definitions ·
integrations · imports · archived cohorts · feature flags.

**Common spec for every admin screen:**

| | |
|---|---|
| Roles | System Admin (`configure@all`); Quality Lead for QA config; read-only for PM/Ops |
| Data | Current version, effective dates, change history, `CONFIG-PENDING` badge where applicable |
| Actions | Create new version · edit draft · **preview impact** · publish · revert to version · view history |
| Required | Audit reason on publish |
| Validation | Schema validation of the config payload; referential checks (a stage referenced by a transition cannot be deleted) |
| **Preview** | For graduation, SLA and risk rules: a dry run reporting **how many current students would change status**, by from→to, before publish (AC-10) |
| Empty | Seeded defaults with `CONFIG-PENDING` badges |
| Events | `CONFIG_CHANGED` (and `PERMISSION_CHANGED` for roles/permissions) |
| Non-retroactivity | Publishing sets `effective_from`; historical evaluations keep their own `config_version_id` and are never rewritten (AC-09) |

**Cohort management:** states Draft · Active · Closed · Archived; each cohort
owns its dates, tracks, milestones, teams, graduation rules, SLAs, risk rules
and QA configuration.
**Cohort clone: one click** — copies every configuration area into a new Draft
cohort with zero students and no code change (AC-24). This is the reusability
test and it is a release criterion.
**Open Decisions Register** is a first-class Admin screen (see doc 12); every
`CONFIG-PENDING` item renders a visible badge wherever its value is used.

---

## 25. Audit logs & system logs

**Audit log viewer:** timestamp · user · effective user · role ·
**permission used** · module · record · action · old value · new value · reason
· source · related object · correlation ID · IP/session. Filterable, exportable
(itself audited), immutable.
**Data/version history viewer:** field-level before/after per entity.
**System log & job console:** failed logins · import errors · API errors ·
notification failures · background job errors · permission errors · integration
errors · unhandled exceptions; with alerting thresholds, a background-job
dashboard, and a **DLQ replay console** — replay is safe because handlers are
idempotent.

---

## 26. Notifications

**Inbox:** grouped by subject, unread first. **Preferences:** per trigger, per
channel, with digest mode. **Rate limiting and deduplication** are applied per
the configured policy so the system does not train staff to ignore it (AC-28).
Dispatch failures go to system logs and are retried into the DLQ.
