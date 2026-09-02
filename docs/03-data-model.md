# 03 — Data Model

PostgreSQL 16. All timestamps `timestamptz`, stored UTC. All ids `uuid` unless
stated. Money is `numeric(18,4)` plus an ISO-4217 currency code — never floats.

## 1. Entity map (ERD, textual)

```
tenant/program
  └─ cohort ──────────────┬─ cohort_config_version ─ config_item(*)
       │                  ├─ track ─ milestone
       │                  └─ working_calendar ─ holiday
       │
  user ─ user_role ─ role ─ role_permission
   │  └─ org_membership (effective-dated) ─ team ─ team_type
   │  └─ staff_capacity, staff_absence, delegation
   │
  student ──┬─ student_assignment (effective-dated: coordinator)
            ├─ student_coach_assignment (effective-dated: coach, type)
            ├─ student_stage_history (effective-dated)
            ├─ risk_record ─ risk_reason ─ intervention ─ intervention_action
            ├─ communication ─ communication_attempt
            ├─ coaching_session ─ coaching_action_item
            ├─ freelance_activity
            ├─ gig ─ gig_evidence ─ gig_review
            ├─ graduation_progress ─ graduation_review ─ graduation_snapshot
            ├─ escalation ─ escalation_action
            ├─ task
            ├─ document
            └─ student_milestone_progress

qa_cycle ─ qa_sample ─ qa_audit ─ qa_audit_answer ─ qa_finding
                                       │              └─ qa_appeal
                                       └─ corrective_action ─ re_audit
qa_scorecard ─ qa_scorecard_version ─ qa_question

events (append-only)      audit_log (append-only)      entity_version_history
system_log                notification ─ notification_preference
import_batch ─ import_row_error
metric_definition ─ metric_snapshot ─ read_model_*(materialized)
fx_rate    sop_link    saved_view    export_log
```

## 2. Core tables

### 2.1 Identity & organisation

**`user`** — `id`, `email` (unique, citext), `full_name`, `phone`, `locale`
(`en`/`ar`), `timezone`, `status` (`active`/`suspended`/`deactivated`),
`mfa_enabled`, `created_at`, `deactivated_at`.

**`role`** — `id`, `key` (unique), `name_i18n` (jsonb), `is_system`,
`created_at`. **`role_permission`** — `role_id`, `module`, `verb`, `scope`.
PK `(role_id, module, verb)`. **`user_role`** — `user_id`, `role_id`,
`cohort_id` (nullable = all cohorts), `effective_from`, `effective_to`.

**`team`** — `id`, `cohort_id`, `name`, `team_type` (`operations` /
`coaching_t1` / `coaching_t2` / `quality`), `parent_team_id`, `manager_user_id`.

**`org_membership`** (effective-dated) — `id`, `user_id`, `team_id`,
`role_in_team`, `manager_user_id`, `effective_from`, `effective_to`.
*Constraint:* no overlapping open memberships of the same team type per user;
`parent_team_id` graph is acyclic (checked on write).

**`staff_capacity`** — `user_id`, `cohort_id`, `max_students`,
`max_sessions_per_week`, `effective_from`, `effective_to`.
**`staff_absence`** — `id`, `user_id`, `from_date`, `to_date`, `reason_code`,
`created_by`. **`delegation`** — `id`, `from_user_id`, `to_user_id`, `scope`,
`from_date`, `to_date`, `created_by`, `reason`.

### 2.2 Programme configuration

**`cohort`** — `id`, `program_id`, `code` (unique), `name`, `state`
(`draft`/`active`/`closed`/`archived`), `start_date`, `end_date`, `timezone`,
`working_calendar_id`, `denominator_policy` (`CONFIG-PENDING`, item 2),
`single_approver_mode` (bool, default false), `created_at`.

**`cohort_config_version`** — `id`, `cohort_id`, `version_no`, `effective_from`,
`effective_to`, `created_by`, `reason`, `published_at`. Every rule evaluation
stores the `config_version_id` it used. **Configuration changes never rewrite
history.**

**`config_item`** — `id`, `config_version_id`, `area` (enum: `lifecycle`,
`sla`, `risk_rules`, `graduation_rules`, `escalation_matrix`, `qa_sampling`,
`scorecard`, `notification`, `task_generation`, `freelance_activity_types`,
`coaching_types`, `gig_platforms`, `milestones`, `templates`, `metrics`,
`feature_flags`, …), `key`, `value` (jsonb), `is_config_pending` (bool),
`decision_register_ref`. The `is_config_pending` flag is what renders the
visible badge in Admin.

**`track`** — `id`, `cohort_id`, `code`, `name_i18n`.
**`milestone`** — `id`, `cohort_id`, `track_id` (nullable = all tracks), `key`,
`name_i18n`, `sequence`, `target_offset_days` | `target_date`,
`required_evidence` (jsonb), `owner_role`.

**`working_calendar`** — `id`, `cohort_id`, `timezone`, `working_days` (int[]),
`work_start`, `work_end`. **`holiday`** — `calendar_id`, `date`, `name_i18n`.

### 2.3 Student

**`student`** — `id`, `cohort_id`, `external_student_id`, `identity_key`
(deterministic, see §4), `full_name`, `phone_e164`, `email`, `track_id`,
`group_id`, `current_stage`, `current_status` (jsonb array of parallel
statuses), `current_risk_level`, `graduation_status`, `last_contact_at`,
`next_action_at`, `source_batch_id`, `consent_message_storage` (bool),
`pii_class` handled at column level, `created_at`, `updated_at`.
*Constraints:* `UNIQUE (cohort_id, identity_key)` — **Invariant 1**;
`UNIQUE (cohort_id, external_student_id)` where not null.

> `current_stage`, `current_risk_level`, `graduation_status`,
> `last_contact_at`, `next_action_at` are **denormalised read fields**
> maintained by event handlers inside the same transaction as the write. They
> are conveniences for the list query; the authority is the history tables and
> the event log, and the nightly reconciliation asserts they agree.

**`student_assignment`** (effective-dated) — `id`, `student_id`,
`coordinator_user_id` (nullable → the explicit `UNASSIGNED` exception),
`reason_code`, `effective_from`, `effective_to`, `created_by`.
*Constraint:* `EXCLUDE USING gist (student_id WITH =, tstzrange(effective_from,
effective_to) WITH &&)` — **Invariant 3**. Exactly one row is open at a time;
a NULL coordinator is an explicit, queryable exception, never an absent row.

**`student_coach_assignment`** — same shape, plus `coaching_type`
(`t1`/`t2`); exclusion constraint per `(student_id, coaching_type)`.

**`student_stage_history`** (effective-dated) — `id`, `student_id`, `stage`,
`entered_at`, `exited_at`, `entered_by`, `reason_code`, `causing_event_id`,
`config_version_id`. Exclusion constraint on overlapping ranges —
**Invariant 2**. Dwell time per stage is computed from this table, which is why
funnel dwell metrics are exact rather than estimated.

**`student_milestone_progress`** — `student_id`, `milestone_id`, `state`
(`not_started`/`in_progress`/`achieved`/`blocked`), `achieved_at`,
`owner_user_id`, `evidence_ref`, `deadline_at`, `blocking_reason`.

### 2.4 Communications

**`communication`** — `id`, `student_id`, `staff_user_id`, `actor_role`,
`occurred_at`, `channel` (`whatsapp`/`phone`/`email`/`other`, extensible),
`direction` (`outbound`/`inbound`), `purpose_code`, `template_id`,
`body` (nullable; stored **only** where policy and `consent_message_storage`
permit), `outcome_code` (`responded`/`waiting`/`no_response`/`needs_support`/
`callback_requested`/`issue_identified`), `progress_notes`, `notes`,
`next_action_code`, `next_followup_at`, `risk_recommendation`,
`escalation_required`, `created_task_id`, `source` (`ui`/`api`/`integration`),
`client_dedup_key` (for offline retry idempotency).

**`communication_attempt`** — `id`, `student_id`, `attempt_no`, `occurred_at`,
`window_key`, `communication_id`. *Constraint:* `UNIQUE (student_id,
window_key)` implements attempt de-duplication per configurable window (§7.7 of
the build prompt, register item 4) — a coordinator cannot inflate attempt
counts by re-dialling.

**`call_log`** *(specialisation of communication where channel = phone)* —
`communication_id` (PK/FK), `connect_result` (`connected`/`no_answer`/`busy`/
`wrong_number`/`callback_requested`), `duration_seconds`, `topics` (text[]),
`challenges`.

### 2.5 Coaching

**`coaching_session`** — `id`, `student_id`, `coach_user_id`, `coaching_type`,
`scheduled_at`, `actual_at`, `attendance` (`attended`/`absent`/`partial`),
`status` (`scheduled`/`completed`/`missed_by_student`/`missed_by_coach`/
`cancelled`/`rescheduled`/`no_show`), `objective`, `topics`, `challenges`,
`notes`, `next_session_at`, `risk_recommendation`, `escalation_recommendation`,
`notes_completed_at`, `rescheduled_from_id`.

**`coaching_action_item`** — `id`, `session_id`, `student_id`,
`assignee_type` (`student`/`coordinator`/`coach`/`team_leader`/`other`),
`assignee_user_id`, `description`, `due_at`, `task_id`, `status`.
Every action item with a staff assignee **materialises a task** (§20).

### 2.6 Freelancing & gigs

**`freelance_activity`** — `id`, `student_id`, `activity_type_key`
(configurable), `occurred_on`, `platform_id`, `result_code`, `evidence_ref`,
`notes`, `entered_by`, `created_at`.

**`gig`** — `id`, `student_id`, `platform_id`, `client_name`, `title`,
`amount_original` `numeric(18,4)`, `currency_original`, `fx_rate_id`,
`amount_base` `numeric(18,4)`, `won_on`, `completed_on`, `paid_on`,
`verification_status` (`draft`/`submitted`/`under_review`/`approved`/
`more_evidence_required`/`rejected`), `submitted_by`, `submitted_at`,
`reviewer_user_id`, `reviewed_at`, `decision_reason_code`, `decision_notes`,
`locked_at`, `duplicate_of_gig_id`.
*Constraint:* `submitted_by <> reviewer_user_id` (SoD-1, DB-level backstop).

**`gig_evidence`** — `id`, `gig_id`, `kind` (`work`/`payment`/`identity`/
`other`), `file_ref`, `content_hash` (sha-256, **stored at upload** so tampering
is detectable), `mime`, `size_bytes`, `uploaded_by`, `uploaded_at`.

**`gig_review`** — `id`, `gig_id`, `reviewer_user_id`, `decision`,
`reason_code`, `notes`, `reviewed_at`, `config_version_id`.

**`fx_rate`** — `id`, `from_currency`, `to_currency`, `rate` `numeric(18,8)`,
`rate_date`, `source`, `created_at`. `UNIQUE (from_currency, to_currency,
rate_date, source)`. A gig stores `fx_rate_id`, so **historical values are never
recomputed at today's rate** (AC-12).

### 2.7 Graduation

**`graduation_progress`** — `id`, `student_id` (unique — **Invariant 8**),
`cohort_id`, `status`, `matched_route_key`, `evaluation` (jsonb: per-criterion
met/not-met with evidence refs), `gap_explanation_i18n` (jsonb, plain
language), `config_version_id`, `evaluated_at`, `denominator_policy_applied`.

**`graduation_review`** — `id`, `student_id`, `stage`
(`submission`/`verification`/`approval`/`reversal`), `actor_user_id`,
`decision`, `reason_code`, `notes`, `occurred_at`, `config_version_id`.

**`graduation_snapshot`** — `id`, `student_id`, `taken_at`, `reason`
(`approval`/`reversal`), `payload` (jsonb, immutable full state). Reversal
preserves the original state here.

### 2.8 Risk, escalation, tasks

**`risk_record`** — `id`, `student_id`, `level` (`green`/`amber`/`red`),
`opened_at`, `closed_at`, `owner_user_id`, `origin` (`rule`/`manual`),
`fired_rule_key`, `config_version_id`, `evidence` (jsonb), `review_due_at`,
`resolution_code`, `override_reason`.
*Constraint:* partial `UNIQUE (student_id) WHERE closed_at IS NULL` —
**Invariant 6**.

**`risk_reason`** — `risk_record_id`, `reason_code` (configurable:
`unresponsive`, `missed_coaching`, `behind_milestone`, `no_freelance_activity`,
`no_gig_progress`, `gig_verification_failure`, `documentation_issue`,
`motivation_issue`, `quality_concern`, `other`), `evidence` (jsonb).

**`intervention`** — `id`, `risk_record_id`, `root_cause`, `next_review_at`,
`outcome_code`, `notes`, `created_by`. **`intervention_action`** — `id`,
`intervention_id`, `description`, `owner_user_id`, `due_at`, `task_id`,
`status`.

**`escalation`** — `id`, `student_id`, `category_key`, `severity`,
`raised_by`, `raised_at`, `assigned_to`, `assigned_tier`, `sla_due_at`,
`description`, `status` (`open`/`assigned`/`in_progress`/`awaiting_information`/
`resolved`/`closed`/`reopened`), `resolution_code`, `resolution_notes`,
`resolved_at`, `resolved_by`, `approved_by`, `closed_at`, `reopened_count`.
**`escalation_action`** — `id`, `escalation_id`, `actor_user_id`, `action`,
`occurred_at`, `notes`, `attachment_ref`.

**`task`** — `id`, `student_id` (nullable for non-student tasks), `task_type`,
`owner_user_id`, `created_by`, `priority` `int`, `created_at`, `due_at`,
`status` (`open`/`in_progress`/`completed`/`overdue`/`cancelled`),
`completed_at`, `completion_notes`, `source` (`manual`/`workflow`/`risk`/`sla`/
`qa`/`gig`/`graduation`/`escalation`), `originating_event_id`, `dedup_key`,
`cancel_reason`.
*Constraint:* partial `UNIQUE (dedup_key) WHERE status IN ('open',
'in_progress')` — an unresolved auto-task of the same type for the same student
is **updated, not duplicated** (§20, AC-05).

### 2.9 Quality

**`qa_scorecard`** / **`qa_scorecard_version`** (`id`, `scorecard_id`,
`version_no`, `published_at`, `pass_bands` jsonb — `CONFIG-PENDING` item 8) /
**`qa_question`** (`version_id`, `sequence`, `text_i18n`, `weight`,
`is_auto_fail`, `guidance_i18n`, `sop_ref`).

**`qa_cycle`** — `id`, `cohort_id`, `name`, `from_date`, `to_date`,
`coverage_target`, `scorecard_version_id`, `status`.

**`qa_sample`** — `id`, `cycle_id`, `method` (`random`/`targeted`/`risk_based`/
`manual`/`re_audit`), `population_definition` (jsonb), `filter` (jsonb),
`seed` `bigint`, `drawn_at`, `drawn_by`, `size`. **Reproducibility is a stored
property**, not a promise (AC-17).

**`qa_audit`** — `id`, `sample_id`, `auditee_user_id`, `subject_type`
(`coordinator`/`coach`/`team_leader`/`student_record`/`gig`/
`graduation_record`/`process`), `subject_id`, `auditor_user_id`,
`scorecard_version_id`, `assigned_at`, `due_at`, `started_at`, `completed_at`,
`score`, `result` (`pass`/`needs_improvement`/`fail`), `is_calibration`,
`calibration_group_id`.
*Constraint:* SoD-3 checked at insert and re-checked at start.

**`qa_audit_answer`** — `audit_id`, `question_id`, `score`, `comments`,
`evidence_ref`, `is_fail`.

**`qa_finding`** — `id`, `audit_id`, `category_key`, `severity`, `description`,
`evidence_ref`, `status` (`open`/`disputed`/`accepted`/`closed`),
`closed_by`, `closed_at`, `closure_evidence_ref`, `waiver_reason`,
`waived_by`. *Constraint:* closure requires `closure_evidence_ref IS NOT NULL
OR (waiver_reason IS NOT NULL AND waived_by has Quality Lead)` (AC-16).

**`qa_appeal`** — `id`, `finding_id`, `raised_by`, `raised_at`, `grounds`,
`reviewer_user_id`, `outcome` (`upheld`/`overturned`/`amended`),
`outcome_notes`, `decided_at`.

**`corrective_action`** — `id`, `finding_id`, `subject_user_id` /
`subject_team_id`, `root_cause`, `required_action`, `owner_user_id`,
`manager_user_id`, `due_at`, `evidence_ref`, `status` (`open`/`in_progress`/
`implemented`/`re_audit_required`/`closed`), `re_audit_required`,
`re_audit_id`, `task_id`.

**`re_audit`** — `id`, `corrective_action_id`, `audit_id`, `result`,
`completed_at`.

### 2.10 Cross-cutting

**`events`**, **`audit_log`**, **`entity_version_history`**, **`system_log`** —
see [`04-event-and-audit-model.md`](04-event-and-audit-model.md).

**`notification`** — `id`, `user_id`, `trigger_key`, `subject_type`,
`subject_id`, `payload`, `created_at`, `read_at`, `dispatched_at`,
`channel`, `rate_limit_key`, `digest_batch_id`, `status`.
**`notification_preference`** — `user_id`, `trigger_key`, `channel`, `enabled`,
`digest_mode`.

**`import_batch`** — `id`, `cohort_id`, `filename`, `uploaded_by`,
`uploaded_at`, `mode` (`all_or_nothing`/`valid_rows_only`), `status`
(`validating`/`previewed`/`committed`/`rolled_back`/`failed`), `row_count`,
`committed_at`, `rolled_back_at`, `rollback_blocked_reason`.
**`import_row_error`** — `batch_id`, `row_no`, `field`, `error_code`, `detail`.

**`document`** — `id`, `student_id`, `kind`, `file_ref`, `content_hash`,
`uploaded_by`, `uploaded_at`, `pii_class`.

**`sop_link`** — `id`, `cohort_id`, `screen_key`, `title_i18n`, `url`,
`version`, `effective_from`, `effective_to`.

**`saved_view`** — `id`, `owner_user_id`, `name`, `module`, `filter` (jsonb),
`share_scope` (`private`/`team`/`cohort`), `is_system`.

**`export_log`** — `id`, `user_id`, `report_key`, `filter` (jsonb), `format`,
`row_count`, `pii_scope_applied`, `watermark`, `created_at`, `event_id`.

**`metric_definition`** — see [`07-metric-registry.md`](07-metric-registry.md).

## 3. Effective dating (SCD-2)

Assignment, coach assignment, stage, org membership, capacity, role grants and
configuration are all effective-dated. Every "as of" query resolves against
`tstzrange(effective_from, coalesce(effective_to, 'infinity'))` containing the
asked-for timestamp.

This is what makes AC-18 true: *Team A's SLA compliance last month* uses last
month's team membership, not today's. It is also what makes SLA breach
attribution honest — the breach names the owner **at the moment of breach**.

## 4. Identity & deduplication

`identity_key` is deterministic and computed at import:

```
identity_key = sha256(lower(trim(external_student_id)))            -- if present
             | sha256(e164(phone) || '|' || lower(trim(email)))    -- else
             | sha256(normalize(name) || '|' || e164(phone))       -- else
```

Normalisation handles Arabic orthographic variants (alef forms, ta marbuta,
tatweel, diacritics) and Arabic-Indic digits before hashing — without this,
Arabic-language intake produces silent duplicates.

Exact collision on `identity_key` is a **hard duplicate** (rejected or merged).
Fuzzy duplicates (trigram similarity on normalised name + phone/email overlap)
are surfaced in the import preview for human decision — never auto-merged.

## 5. Required fields & validation rules

| Entity | Required at create | Key validations |
|---|---|---|
| student | cohort, name, (phone \| email), track | E.164 phone; unique identity key; track ∈ cohort tracks |
| student_assignment | student, effective_from | coordinator active, in cohort, under capacity (or explicit override with reason) |
| communication | student, staff, channel, occurred_at, outcome, next_action, next_followup_at | `next_followup_at` ≥ occurred_at and a working period; body only if consent + policy allow |
| call_log | connect_result | duration required when `connected` |
| coaching_session | student, coach, type, scheduled_at | coach assigned to student & type; no double-booking; notes required to reach `completed` |
| coaching_action_item | description, assignee_type, due_at | staff assignee ⇒ task created |
| freelance_activity | student, type, occurred_on | type ∈ cohort activity types; evidence required where the type declares it |
| gig | student, platform, client, title, amount, currency, won_on | amount > 0; `completed_on ≥ won_on`; `paid_on ≥ completed_on`; FX rate exists for currency on the reference date; submission requires ≥1 work evidence |
| gig_review | decision | reject / more-evidence require reason code **and** free text; reviewer ≠ submitter |
| graduation submission | student, route candidate | engine must report `eligibility_met` or an explicit override with reason |
| risk_record | student, level, ≥1 reason | manual override requires reason + `review_due_at` |
| escalation | student, category, severity, description | routing tier resolvable; SLA computed from working calendar |
| task | type, owner, due_at | owner active; `dedup_key` unique among open |
| qa_audit | sample, auditor, auditee, scorecard version | SoD-3 |
| qa_finding closure | evidence \| waiver | waiver requires Quality Lead + reason |
| import row | per cohort mapping | schema then business validation; capacity violations reported, not silently accepted |

Validation is declared once (a shared schema module) and enforced on the API
boundary, in the service layer, and — for anything invariant-bearing — in the
database. The client uses the same declarations for inline validation, so the
UI cannot drift from the server rules.

## 6. PII classification

Every column carries a class: `public` · `internal` · `pii` · `sensitive_pii` ·
`message_content`. Masking rules are configuration by role (register item 13).
`message_content` is stored only where policy permits and consent is recorded on
the student.

**Data-subject deletion pseudonymises**: identity columns are replaced with a
stable surrogate, `document`/`gig_evidence` blobs are destroyed, and the event
chain is preserved intact — the audit trail must never develop a gap
(Invariant 7).

## 7. Retention

Retention periods per class are configuration (register item 13). Retention jobs
emit events, are audited, and never hard-delete from `events` or `audit_log`.
