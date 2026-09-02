# 14 — Consistency Gate

The build prompt forbids proceeding to build until four conditions hold. This
document evidences each, and specifies the automated check that keeps it true
once code exists.

> **Do not proceed to build until every screen maps to entities that exist in
> the schema, every workflow terminates in a defined state, every dashboard
> metric exists in the metric registry with a drill-down path, and every state
> transition has a defined permission.**

---

## Gate 1 — Every screen maps to entities that exist in the schema

| Screen group (doc 08) | Backing entities (doc 03) |
|---|---|
| Coordinator dashboard, My Work | `task`, `rm_work_queue`, `rm_student_current`, `student_assignment` |
| Team Leader dashboard | `rm_staff_performance`, `rm_sla_daily`, `org_membership`, `team` |
| Coach / Coaching Manager dashboards | `coaching_session`, `coaching_action_item`, `student_coach_assignment`, `staff_capacity`, `rm_coaching_rollup` |
| Quality dashboards | `qa_cycle`, `qa_sample`, `qa_audit`, `qa_finding`, `corrective_action`, `re_audit`, `qa_appeal`, `rm_qa_rollup` |
| Operations control tower | `rm_exceptions` over `student_assignment`, `communication`, `task`, `risk_record`, `escalation`, `gig`, `graduation_progress`, `staff_absence`, `import_batch`, `system_log` |
| PM dashboard & forecast | `rm_graduation_progress`, `rm_stage_history_daily`, `student_stage_history`, `metric_definition` |
| Students list & record header | `student`, `student_assignment`, `student_coach_assignment`, `rm_student_current` |
| Journey tab | `milestone`, `student_milestone_progress` |
| Timeline tab | `events` (projection) |
| Communications tab, contact flow, call log | `communication`, `communication_attempt`, `call_log`, template config |
| Coaching tab | `coaching_session`, `coaching_action_item` |
| Freelancing tab & progress | `freelance_activity`, activity-type config, `milestone` |
| Gigs tab, submission, verification | `gig`, `gig_evidence`, `gig_review`, `fx_rate` |
| Graduation tab, review, approval | `graduation_progress`, `graduation_review`, `graduation_snapshot`, `cohort_config_version` |
| Tasks tab, My Work | `task` |
| Risks tab, register, intervention | `risk_record`, `risk_reason`, `intervention`, `intervention_action` |
| Escalations tab, list, case, matrix | `escalation`, `escalation_action`, routing config |
| Quality tab | `qa_audit`, `qa_finding` (read-only projection) |
| Documents tab | `document` |
| History tab | `entity_version_history` |
| Teams, allocation, capacity, absence | `team`, `org_membership`, `staff_capacity`, `staff_absence`, `delegation` |
| Performance scorecards | `rm_staff_performance`, `metric_definition` |
| Reports | `metric_definition`, read models, `export_log` |
| Search & saved views | `saved_view`, trigram indexes |
| Import wizard | `import_batch`, `import_row_error`, `student` |
| Admin (all areas) | `cohort`, `cohort_config_version`, `config_item`, `role`, `role_permission`, `user_role`, `working_calendar`, `holiday`, `milestone`, `fx_rate`, `qa_scorecard_version`, `sop_link`, `metric_definition` |
| Audit & system logs | `audit_log`, `entity_version_history`, `system_log`, `events` |
| Notifications | `notification`, `notification_preference` |

**No screen references an entity absent from doc 03.**

*Automated check (from increment 5 onward):* each screen module declares the
entities and read models it reads; CI fails on a reference to a table or view
that does not exist in the migrated schema.

---

## Gate 2 — Every workflow terminates in a defined state

| Workflow | Terminal state(s) |
|---|---|
| W01 import | `Imported` (or batch `Failed` / `Rolled Back`) |
| W02 assignment | `Assigned` |
| W03 onboarding | `Onboarded` |
| W04 follow-up | task `Completed`; SLA `compliant` |
| W05 message | `Contacted`; follow-up task `Open` |
| W06 reply | `Unresponsive` cleared; response task `Open` |
| W07 call | as W05; attempt counted |
| W08 no-response | `Unresponsive` + control-tower exception |
| W09 risk identification | risk level `Green` \| `Amber` \| `Red` |
| W10 risk intervention | intervention open with a scheduled review |
| W11 escalation | `Closed` (or `Reopened` → `Closed`) |
| W12 coaching scheduling | session `Scheduled` |
| W13 coaching completion | session `Completed` |
| W14 missed coaching | `Missed by student` \| `Missed by coach` \| `No-show` \| `Cancelled` \| `Rescheduled` |
| W15 freelance readiness | `Freelance Ready` |
| W16 freelancing activity | `Active Freelancing` |
| W17 gig submission | gig `Submitted` |
| W18 gig verification | gig `Approved` (locked) |
| W19 gig rejection / more evidence | gig `Rejected` (terminal) or `Submitted` (resubmitted) |
| W20 graduation eligibility | `Eligibility Met` (or unchanged) |
| W21 graduation review | `Pending Verification` |
| W22 graduation approval | `Approved Graduate` / `Graduated` (terminal, locked) |
| W23 graduation reversal | `Returned for Review` (with snapshot preserved) |
| W24 QA sampling | audits `assigned` |
| W25 QA audit | audit `completed` |
| W26 QA failure | finding `Open` (→ `Closed` \| `Disputed` → decided) |
| W27 corrective action | `Closed` (evidence or waiver) |
| W28 re-audit | corrective action `Closed` or reopened |
| W29 staff reassignment | new assignment open; tasks and escalations carried |
| W30 absence & delegation | delegation active → `DELEGATION_ENDED` |
| W31 withdrawal / exclusion | `Withdrawn` \| `Excluded` (terminal) |
| W32 cohort closure | cohort `Closed` → `Archived` |
| W33 cohort clone | new cohort `Draft` |

**No workflow ends in an undefined or implicit state.** Every terminal state
above appears in a state machine in doc 05.

*Automated check:* each golden-path integration test asserts the terminal state
named here; a workflow without such an assertion fails review.

---

## Gate 3 — Every dashboard metric exists in the registry with a drill-down

Every tile named in doc 08 maps to a `metric_key` in doc 07 §3, and every
registry entry carries a `drilldown_query` plus a
`GET /v1/metrics/{key}/records` endpoint.

| Dashboard | Registry sections used |
|---|---|
| Coordinator | 3.3 contact & SLA, 3.4 risk, 3.7 escalations, 3.6 gigs, 3.1 outcome |
| Team Leader | 3.3, 3.4, 3.7, 3.8 quality, 3.9 workforce, 3.1 |
| Coach | 3.5 coaching, 3.4 |
| Coaching Manager | 3.5, 3.9, 3.7 |
| Quality (Specialist / Lead) | 3.8 |
| Operations control tower | 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10 data quality & system |
| PM | 3.1 outcome, 3.2 funnel, §4 forecast |

*Automated checks (build-time, from increment 19):*
1. A tile referencing a `metric_key` absent from `metric_definition` fails CI.
2. A `metric_definition` row without a `drilldown_query` fails CI.
3. A contract test asserts, for every metric, that the drill-down record count
   equals the tile value for the same filters and as-of timestamp (AC-19).

**Prohibitions 6 and 10 are enforced mechanically, not by convention.**

---

## Gate 4 — Every state transition has a defined permission

Every row in every transition table in doc 05 carries a `required_permission`.
Summary of the permission each machine's transitions draw on:

| Machine | Permissions used |
|---|---|
| Lifecycle | `students.assign`, `students.edit`, `communications.create`, `freelancing.create`, `gigs.create`, `graduation.create`, `graduation.approve`, `graduation.reject`, `graduation.override_lock`; system-only transitions have no user permission and are unreachable from any client |
| Gig | `gigs.create`, `gigs.edit`, `gigs.approve`, `gigs.reject`, `gigs.override_lock` |
| Escalation | `escalations.create`, `escalations.edit`, `escalations.approve` |
| Corrective action | `quality.create`, `quality.edit`, `quality.audit` |
| Graduation | `graduation.create`, `graduation.approve`, `graduation.reject`, `graduation.override_lock` |
| Task | `tasks.create`, `tasks.edit`, `tasks.assign` |
| Coaching session | `coaching.create`, `coaching.edit` |
| Risk | `risks.create`, `risks.edit` (system transitions have no user permission) |
| Cohort | `admin.configure` |
| Import batch | `students.create`, `students.delete` (rollback) |

Every permission named above appears in the matrix in doc 02.

*Automated checks:*
1. A transition row with a `required_permission` absent from the matrix fails
   the seed migration.
2. A transition reachable from an API endpoint whose declared permission differs
   from the transition's requirement fails CI.
3. Terminal-state transitions are asserted unreachable for every role that must
   not hold them — most importantly, no coordinator composition can reach
   `Graduated` (AC-08).

---

## Gate status

| Gate | Status |
|---|---|
| 1 — screens ↔ schema | **Pass** |
| 2 — workflows terminate | **Pass** |
| 3 — metrics ↔ registry + drill-down | **Pass** |
| 4 — transitions ↔ permissions | **Pass** |

**Remaining blocker to Phase D: programme-owner sign-off on Phase A**, per the
operating contract in Section 0 of the build prompt. The Open Decisions Register
(doc 12) does **not** block build — every item ships as configuration with a
conservative default and a visible `CONFIG-PENDING` badge — but items 1, 2, 3
and 6 block **cohort activation**, because the graduation engine and the SLA
engine cannot produce meaningful output until they are set.
