# 05 — State Machines

## 1. Definition format

Every state machine is **data**, not branching code. One row per transition:

```
(machine_key, from_state, to_state, required_permission,
 required_conditions[], required_reason, side_effects[],
 config_version_id, effective_from, effective_to)
```

- `required_conditions` are named, server-evaluated predicates
  (e.g. `has_open_intervention`, `evidence_present`, `engine_says_eligible`).
  Each returns a structured failure reason.
- `required_reason` ∈ `none` / `optional` / `mandatory_reason_code` /
  `mandatory_reason_code_and_text`.
- `side_effects` are named handlers (emit event, create task, notify, recompute)
  — declared, so a transition's consequences are auditable from configuration.

**Rules:**
1. All transitions validate **server-side**. The client never decides.
2. A blocked transition returns a structured reason the UI renders **verbatim**.
3. No client may set a terminal state directly.
4. A transition not present in the table does not exist. There is no default
   "allow".
5. The `config_version_id` in force at transition time is recorded on the
   resulting history row, so a past transition is always explainable under the
   rules that actually applied.

## 2. Student lifecycle

States: `Imported` · `Assigned` · `Contacted` · `Onboarded` · `Coaching` ·
`Freelance Ready` · `Active Freelancing` · `Gig Progress` ·
`Graduation Eligible` · `Verification` · `Graduated`.

Terminal: `Graduated`, `Withdrawn`, `Excluded`.

Parallel statuses (orthogonal, multi-valued): `Inactive` · `Unresponsive` ·
`At Risk` · `Escalated` · `Withdrawn` · `Excluded`.

| From | To | Permission | Conditions | Reason | Side effects |
|---|---|---|---|---|---|
| Imported | Assigned | `students.assign` | coordinator active, in cohort, capacity ok (or override) | none | `STUDENT_ASSIGNED`; first-contact task; notify coordinator |
| Assigned | Contacted | `communications.create` | ≥1 outbound interaction recorded | none | `STUDENT_STAGE_CHANGED`; SLA clock starts |
| Contacted | Onboarded | `students.edit` @own | onboarding checklist complete (configurable) | optional | stage event; schedule coaching task |
| Contacted | *(status)* Unresponsive | system | attempt count ≥ threshold (config) | auto | `RISK_CHANGED`; TL task; control-tower exception |
| Onboarded | Coaching | `students.edit` @own | ≥1 coach assigned of an enabled type | none | stage event; coaching schedule task |
| Coaching | Freelance Ready | `students.edit` @own | readiness milestone achieved (config) | none | stage event; freelancing tasks |
| Freelance Ready | Active Freelancing | `freelancing.create` | ≥1 qualifying freelance activity | none | stage event |
| Active Freelancing | Gig Progress | `gigs.create` | ≥1 gig in `submitted`+ | none | stage event |
| Gig Progress | Graduation Eligible | system | graduation engine returns `eligibility_met` | auto | `GRADUATION_ELIGIBLE`; verification task; notify ops |
| Graduation Eligible | Verification | `graduation.create` | submission complete, required evidence attached | none | `GRADUATION_SUBMITTED`; reviewer task |
| Verification | Graduated | `graduation.approve` | engine re-confirms; **SoD-2**; approver ≠ verifier | mandatory_reason_code | `GRADUATION_APPROVED`; lock record; snapshot; notify |
| Verification | Gig Progress | `graduation.reject` | — | mandatory_reason_code_and_text | `GRADUATION_REJECTED`; remediation task |
| Graduated | Verification | `graduation.override_lock` + `graduation.approve` @all | elevated; re-auth | mandatory_reason_code_and_text | `GRADUATION_REVERSED`; immutable snapshot of prior state |
| *any non-terminal* | Withdrawn | `students.edit` @team | — | mandatory_reason_code | `STUDENT_WITHDRAWN`; close open tasks with reason; apply denominator policy |
| *any non-terminal* | Excluded | `students.edit` @cohort | — | mandatory_reason_code_and_text | `STUDENT_EXCLUDED`; same as above |

**A coordinator can never set `Graduated`** — the transition requires
`graduation.approve`, a permission no coordinator role composition holds
(AC-08). Backwards transitions other than those listed require Ops/Admin and a
mandatory reason; they are configuration, so a cohort may permit or forbid them.

Stage regression on withdrawal is not modelled as a stage change: `Withdrawn`
and `Excluded` are terminal states of the lifecycle machine **and** parallel
statuses, so the last operational stage remains visible for funnel leakage
analysis.

## 3. Gig verification

States: `Draft` → `Submitted` → `Under Review` →
`Approved` | `More Evidence Required` | `Rejected`.

| From | To | Permission | Conditions | Reason | Side effects |
|---|---|---|---|---|---|
| Draft | Submitted | `gigs.create` @own | required fields complete; ≥1 work evidence; FX rate resolvable | none | `GIG_SUBMITTED`; verification task; duplicate scan |
| Submitted | Under Review | `gigs.edit` @cohort | **SoD-1** reviewer ≠ submitter | none | assign reviewer; notify |
| Under Review | Approved | `gigs.approve` | identity, evidence, payment evidence, value, dates all checked; duplicate warning acknowledged | mandatory_reason_code | `GIG_APPROVED`; **lock critical fields**; recompute graduation; notify |
| Under Review | More Evidence Required | `gigs.edit` | — | mandatory_reason_code_and_text | `GIG_EVIDENCE_REQUESTED`; task to submitter; SLA on response |
| Under Review | Rejected | `gigs.reject` | — | mandatory_reason_code_and_text | `GIG_REJECTED`; recompute graduation; risk re-evaluation |
| More Evidence Required | Submitted | `gigs.create` @own | new evidence attached | none | `GIG_SUBMITTED` (v2); back to queue |
| Approved | Under Review | `gigs.override_lock` | elevated; re-auth | mandatory_reason_code_and_text | `GIG_LOCK_OVERRIDDEN`; snapshot; recompute graduation; notify graduation approver if the gig backs an approved graduation |

Approved gigs lock: amount, currency, FX rate, client, title, dates and
evidence set. Evidence hashes are re-verified on every render of the
verification screen (AC-13).

## 4. Escalation

States: `Open` → `Assigned` → `In Progress` → `Awaiting Information` →
`Resolved` → `Closed`; `Reopened` from `Closed`.

| From | To | Permission | Conditions | Reason | Side effects |
|---|---|---|---|---|---|
| — | Open | `escalations.create` | category + severity valid | mandatory_reason_code | `ESCALATION_RAISED`; route to tier 1; SLA from working calendar |
| Open | Assigned | `escalations.edit` @tier | assignee resolvable from matrix | none | `ESCALATION_ASSIGNED`; task; notify |
| Assigned | In Progress | `escalations.edit` @own | — | none | first-response SLA stops |
| In Progress | Awaiting Information | `escalations.edit` @own | — | mandatory_reason_code | SLA clock **pauses** (configurable); task to information owner |
| Awaiting Information | In Progress | `escalations.edit` @own | — | none | SLA resumes |
| In Progress | Resolved | `escalations.edit` @own | resolution code + notes | mandatory_reason_code_and_text | `ESCALATION_RESOLVED`; approval task if severity ≥ threshold |
| Resolved | Closed | `escalations.approve` | **SoD-4** approver ≠ resolver when severity ≥ threshold | optional | close; recompute risk; notify raiser |
| Closed | Reopened | `escalations.create` @tier | within reopen window (config) | mandatory_reason_code_and_text | `ESCALATION_REOPENED`; new SLA; increment counter |
| *any open* | *next tier* | system | tier SLA breached | auto | `ESCALATION_TIER_ADVANCED`; notify next tier; audit |

Routing matrix is configuration. Seeded examples (all `CONFIG-PENDING` on their
SLAs, register item 9):

| Category | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| Unresponsive student | Coordinator | Team Leader | Operations |
| Coaching issue | Coach | Coaching Manager | PM |
| Invalid gig | Verifier | Operations | PM |
| Coordinator issue | Team Leader | Operations | PM |
| QA failure | Quality Specialist | Quality Lead | PM |

## 5. Corrective action

States: `Open` → `In Progress` → `Implemented` → `Re-audit Required` →
`Closed`.

| From | To | Permission | Conditions | Reason | Side effects |
|---|---|---|---|---|---|
| — | Open | `quality.create` | linked to a finding | none | `CORRECTIVE_ACTION_CREATED`; task to owner; notify manager |
| Open | In Progress | `quality.edit` @own | — | none | — |
| In Progress | Implemented | `quality.edit` @own | evidence attached | mandatory_reason_code | evidence hashed |
| Implemented | Re-audit Required | `quality.audit` | finding severity or policy requires re-audit | none | schedule re-audit; assign auditor (SoD-3) |
| Re-audit Required | Closed | `quality.audit` @cohort | re-audit result recorded | mandatory_reason_code | `RE_AUDIT_COMPLETED`; `CORRECTIVE_ACTION_CLOSED` |
| Implemented | Closed | `quality.audit` @cohort | re-audit not required | mandatory_reason_code | `CORRECTIVE_ACTION_CLOSED` |

A finding cannot be closed without **either** evidence **or** an explicit
Quality Lead waiver carrying a reason (AC-16). This is a database constraint,
not a UI rule.

## 6. Graduation

States: `Not Eligible` · `Progressing` · `Potentially Eligible` ·
`Eligibility Met` · `Pending Verification` · `Approved Graduate` ·
`Returned for Review` · `Rejected`.

The first four are **engine-computed** — no user sets them. The engine
recomputes on: gig approval/rejection/unlock, freelance activity, milestone
change, withdrawal, configuration change (prospectively only), and on schedule.

| From | To | Set by | Conditions |
|---|---|---|---|
| Not Eligible | Progressing | engine | ≥1 criterion partially satisfied |
| Progressing | Potentially Eligible | engine | all criteria satisfiable within remaining cohort time |
| Potentially Eligible | Eligibility Met | engine | every criterion of ≥1 route satisfied with verified evidence |
| Eligibility Met | Pending Verification | user, `graduation.create` | submission complete |
| Pending Verification | Approved Graduate | user, `graduation.approve` | engine re-confirms; **SoD-2** |
| Pending Verification | Returned for Review | user, `graduation.reject` | reason code + text |
| Pending Verification | Rejected | user, `graduation.reject` @cohort | reason code + text |
| Returned for Review | Pending Verification | user, `graduation.create` | remediation complete |
| Approved Graduate | Returned for Review | user, `graduation.override_lock` | elevated; re-auth; **immutable snapshot preserved** |
| *any* | Not Eligible | engine | a supporting gig was unlocked or reversed |

Approved graduation **locks the record**. Reversal requires elevated permission,
a reason, an audit event, and preservation of the original state as an immutable
snapshot (`graduation_snapshot`).

## 7. Supporting machines

**Task:** `Open` → `In Progress` → `Completed`; `Open`/`In Progress` →
`Overdue` (system, working-calendar aware) → `Completed`; any → `Cancelled`
(with reason). Auto-cancel fires when the generating condition disappears.

**Coaching session:** `Scheduled` → `Completed` | `Missed by student` |
`Missed by coach` | `Cancelled` | `Rescheduled` | `No-show`. `Completed`
requires notes; missing notes generates a documentation task and appears on the
coach and coaching-manager dashboards.

**Risk:** `Green` ⇄ `Amber` ⇄ `Red`. Every automated change records the rule
key, the config version and the evidence. Amber and Red require an intervention
plan; closing a risk record requires a resolution code.

**Cohort:** `Draft` → `Active` → `Closed` → `Archived`. `Closed` makes core
operational records read-only; override requires elevated permission, a reason,
an audit event and a preserved snapshot.

**Import batch:** `Validating` → `Previewed` → `Committed` | `Failed`;
`Committed` → `Rolled Back` **only while no downstream events reference the
batch's records**; otherwise rollback is refused and names the blocking events
(AC-22).
