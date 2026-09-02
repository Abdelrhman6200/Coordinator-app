# 04 — Event & Audit Model

## 1. Why four separate things

These are routinely conflated and must not be. They have different consumers,
different retention, different access control and different shapes.

| # | Artefact | Question it answers | Consumer | Mutability |
|---|---|---|---|---|
| 1 | **Student activity timeline** | "What happened to this student, in plain language?" | Coordinator, TL, coach | Derived (a projection of events) |
| 2 | **Data/version history** | "What did this field say before, and what does it say now?" | Ops, QA, support | Append-only rows |
| 3 | **Audit log** | "Who did what, why, under which permission?" | Compliance, QA, client | Immutable, exportable |
| 4 | **System/technical log** | "What broke?" | Engineering, Ops | Retention-bounded |

The timeline is generated; it is never hand-written. The audit log is a
compliance artefact and is not the same thing as the event log — an event says
*the world changed*; an audit entry says *a person caused it, with this
authority, for this reason*.

## 2. The event backbone

### 2.1 `events` table

| Column | Type | Notes |
|---|---|---|
| `event_id` | uuid | PK; also the idempotency key for every handler |
| `event_type` | text | From the catalogue (§3) |
| `event_version` | int | Schema version of `payload`; handlers upcast old versions |
| `occurred_at` | timestamptz | When the real-world thing happened (may be backdated by the user) |
| `recorded_at` | timestamptz | When the system learned of it (never backdated) |
| `actor_user_id` | uuid | Null for `SYSTEM_JOB` |
| `actor_role` | text | The role in force at the time — resolved, not looked up later |
| `effective_actor_user_id` | uuid | Set when impersonating; both actors are recorded |
| `subject_type` | text | `student` / `gig` / `escalation` / `audit` / `user` / `cohort` / `config` … |
| `subject_id` | uuid | |
| `cohort_id` | uuid | Denormalised for RLS and partitioning |
| `payload` | jsonb | Type-specific; schema-validated per `(event_type, event_version)` |
| `correlation_id` | uuid | One real-world action; shared by every event it causes |
| `causation_id` | uuid | The event that directly caused this one |
| `source` | text | `UI` / `API` / `IMPORT` / `SYSTEM_JOB` |
| `seq` | bigserial | Global ordering for replay |
| `prev_hash`, `hash` | bytea | Hash chain for tamper evidence |

**Rules, enforced not assumed:**

- The application role holds `INSERT` and `SELECT` on `events` only. No
  `UPDATE`, no `DELETE` grant exists. A trigger raises on any attempt.
- **Corrections are compensating events** referencing the original via
  `causation_id` plus a `corrects_event_id` in the payload. A "delete" is a
  soft-delete event.
- The event is written **in the same transaction** as the state change it
  describes. There is no code path that mutates state without emitting (§15.9
  of the build prompt) — the command handler base class writes both or neither.
- Partitioned by `cohort_id` then range on `occurred_at`, for the 5M-events-per
  -cohort target.

### 2.2 Idempotency

Every handler is keyed on `event_id` via a `handler_offsets(handler_key,
event_id)` unique table written inside the handler's own transaction. A replay
of the same event is a no-op. This is what makes AC-05 hold: replaying every
event type twice produces no duplicate tasks, KPI increments or notifications.

Additional layers:
- Task creation is further protected by the `task.dedup_key` partial unique
  index, so even a handler bug cannot duplicate an open auto-task.
- Notifications dedupe on `(user, rate_limit_key, window)`.
- Read-model updates are computed as **set-to-value**, not `+= 1`, wherever the
  value is derivable, so double-application is harmless by construction.

### 2.3 Handlers plus a sweeper — both are mandatory

Rule evaluation runs as event-driven handlers **and** a scheduled
reconciliation job. This is not redundancy. Time-based rules — "no contact for
X days", "milestone deadline passed", "follow-up now overdue", "escalation SLA
elapsed" — have **no triggering event**: the absence of an event is the
signal. A system built on handlers alone silently fails to notice students
going quiet, which is precisely the failure mode this platform exists to
prevent.

| Job | Cadence | Idempotent by |
|---|---|---|
| SLA sweeper | Hourly | `(student, sla_window)` breach key |
| Risk re-evaluation sweeper | Hourly | `(student, rule, evaluation_window)` |
| Milestone deadline sweeper | Daily | `(student, milestone, deadline)` |
| Escalation SLA sweeper | Hourly | `(escalation, tier)` |
| Task overdue sweeper | Hourly | Status transition is naturally idempotent |
| Graduation re-evaluation | Daily + on relevant events | Set-to-value on `graduation_progress` |
| Read-model reconciliation | Nightly | Full recompute, compared to incremental; divergence alerts |
| Invariant check | Nightly | Emits data-quality exceptions, never auto-fixes |

Sweepers respect the working calendar: an SLA does not breach on a national
holiday (AC-04).

## 3. Event catalogue

Versioned and extensible. Adding an event type is configuration of handlers plus
a payload schema; it is not a schema migration of `events`.

| Domain | Event types |
|---|---|
| Intake | `STUDENT_IMPORTED`, `STUDENT_ASSIGNED`, `STUDENT_REASSIGNED` |
| Contact | `MESSAGE_SENT`, `CALL_LOGGED`, `STUDENT_REPLIED`, `INTERACTION_RECORDED` |
| Follow-up | `FOLLOWUP_SCHEDULED`, `FOLLOWUP_COMPLETED`, `SLA_BREACHED` |
| Coaching | `COACHING_SCHEDULED`, `COACHING_COMPLETED`, `COACHING_MISSED`, `COACH_ACTION_CREATED` |
| Freelancing | `FREELANCE_ACTIVITY_LOGGED` |
| Gigs | `GIG_SUBMITTED`, `GIG_EVIDENCE_REQUESTED`, `GIG_APPROVED`, `GIG_REJECTED` |
| Risk | `RISK_CHANGED`, `INTERVENTION_CREATED` |
| Escalation | `ESCALATION_RAISED`, `ESCALATION_RESOLVED` |
| Quality | `QA_AUDIT_ASSIGNED`, `QA_AUDIT_COMPLETED`, `QA_FINDING_RAISED`, `CORRECTIVE_ACTION_CREATED`, `CORRECTIVE_ACTION_CLOSED`, `RE_AUDIT_COMPLETED` |
| Graduation | `GRADUATION_ELIGIBLE`, `GRADUATION_SUBMITTED`, `GRADUATION_APPROVED`, `GRADUATION_REVERSED` |
| Lifecycle | `STUDENT_WITHDRAWN`, `COHORT_CLOSED` |
| Governance | `CONFIG_CHANGED`, `PERMISSION_CHANGED`, `EXPORT_PERFORMED` |

Additional types this design requires (extensions, same rules apply):
`STUDENT_STAGE_CHANGED`, `TASK_CREATED`, `TASK_COMPLETED`, `TASK_CANCELLED`,
`ESCALATION_ASSIGNED`, `ESCALATION_TIER_ADVANCED`, `ESCALATION_REOPENED`,
`GIG_MORE_EVIDENCE_REQUIRED`, `GIG_LOCK_OVERRIDDEN`, `RISK_OVERRIDDEN`,
`QA_APPEAL_RAISED`, `QA_APPEAL_DECIDED`, `QA_SAMPLE_DRAWN`,
`STAFF_ABSENCE_RECORDED`, `DELEGATION_STARTED`, `DELEGATION_ENDED`,
`IMPORT_BATCH_COMMITTED`, `IMPORT_BATCH_ROLLED_BACK`, `IMPERSONATION_STARTED`,
`IMPERSONATION_ENDED`, `LOCK_OVERRIDDEN`, `STUDENT_EXCLUDED`,
`COHORT_CONFIG_CLONED`, `NOTIFICATION_DISPATCH_FAILED` (system log mirror).

### 3.1 Payload contract

Each `(event_type, event_version)` has a JSON Schema stored with the code and
validated on write. Payloads carry:

- the **inputs** to any rule that fired (`config_version_id`, `rule_key`,
  `evidence`), so an evaluation can be re-derived years later;
- **before/after** values for anything that changed;
- **reason codes** where the transition required one.

An event whose payload does not validate is rejected at write time. There is no
"best effort" event.

## 4. Audit log

`audit_log` — append-only, immutable, exportable:

`id`, `occurred_at`, `user_id`, `effective_user_id`, `role`, `module`,
`record_type`, `record_id`, `action`, `old_value` (jsonb), `new_value` (jsonb),
`reason`, `source`, `related_object`, `correlation_id`, `permission_used`,
`ip`, `user_agent`, `session_id`, `event_id`.

**Covers, mandatorily:** assignment · reassignment · status changes · risk
changes · gig decisions · graduation decisions · QA changes · permission changes
· deletions · configuration changes · exports · lock overrides · impersonation ·
login and security events · every blocked separation-of-duties attempt.

`permission_used` is recorded because "who did this" is insufficient for an
external reviewer — the defensible question is *under what authority*.

Retention: the audit log outlives operational retention. Pseudonymisation
rewrites identity references to surrogates; it never removes rows.

## 5. Data/version history

`entity_version_history` — `id`, `entity_type`, `entity_id`, `field`,
`old_value`, `new_value`, `changed_at`, `changed_by`, `event_id`,
`correlation_id`. Written by a generic trigger on tracked tables. This answers
field-level "what did this say before" questions without forcing a reader to
reconstruct state from the event stream.

## 6. System log

`system_log` — `id`, `occurred_at`, `level`, `component`, `code`, `message`,
`context` (jsonb), `correlation_id`, `trace_id`.

Captures failed logins, import errors, API errors, notification failures,
background job errors, permission errors, integration errors and unhandled
exceptions, with alerting thresholds. Backed by a **job/DLQ replay console**:
failed jobs are visible, inspectable and replayable by an operator, and replay
is safe precisely because handlers are idempotent.

## 7. Timeline projection

The student timeline is a read model over `events` filtered to the student,
rendered through per-event-type i18n templates (English and Arabic). It is
filterable by module, actor and date, and must be **sufficient to reconstruct
the full case from first contact to graduation or exit** — that sufficiency is
asserted by a test that replays a seeded student's full lifecycle and checks
every workflow step appears.

## 8. Reconstruction guarantee

Every number in every report is reconstructible from `events` alone. The nightly
reconciliation recomputes each registry metric from raw events and compares it
to the read model; divergence raises a system alert and blocks the "verified"
badge on reports until resolved (AC-23).
