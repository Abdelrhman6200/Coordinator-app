# 07 — Metric Registry (Semantic Layer)

## 1. The rule

**One canonical definition per metric.** No component computes a KPI with its
own private definition (Prohibition 10). No metric appears on a dashboard
without a registry entry and a drill-down path to records (Prohibition 6).

Enforcement is mechanical, not cultural: dashboard tiles reference a
`metric_key`; a build-time check fails if a tile references a key absent from
the registry, or if a registry entry has no `drilldown_query`. This is part of
the consistency gate (`14-consistency-gate.md`).

## 2. Registry schema

`metric_definition` —

| Column | Purpose |
|---|---|
| `metric_key` | Stable identifier used by every consumer |
| `name_i18n`, `definition_i18n` | Human definition in English and Arabic, shown in tooltips and on reports |
| `numerator`, `denominator` | Declarative specs (entity, filter, aggregation) |
| `filters` | Permitted segmentation dimensions |
| `grain` | `student` / `staff` / `team` / `cohort` / `gig` / `audit` / `session` |
| `owner_role` | Who owns the definition |
| `refresh_cadence` | `on_event` / `hourly` / `nightly` |
| `drilldown_query` | Returns the exact record list behind the number |
| `as_of_supported` | Always true; every metric is computable at an arbitrary date |
| `version` | Reports record the metric-definitions version used |
| `source_events` | Event types the metric derives from — the reconciliation contract |

**As-of semantics.** Every metric resolves dimensions against the
**effective-dated** assignment, org and stage tables at the as-of timestamp.
"Team A's SLA compliance last month" uses last month's team membership (AC-18).
A metric that cannot honour this is not accepted into the registry.

## 3. Core registry

### 3.1 Programme outcome

| `metric_key` | Definition | Numerator | Denominator |
|---|---|---|---|
| `graduation_rate` | Approved graduates as a share of the eligible population | students with `graduation_status = approved_graduate` | cohort students, **less withdrawn/excluded per the cohort's denominator policy** (register item 2) |
| `graduation_target` | Configured target | — | — (config) |
| `graduation_gap` | Target minus current rate, expressed in students | `ceil(target × denominator) − numerator` | — |
| `graduation_forecast` | Deterministic projection (§4) | — | — |
| `eligible_count` | Students at `Eligibility Met` or beyond, not yet approved | — | — |
| `pending_verification_count` | At `Pending Verification` | — | — |

### 3.2 Funnel

| `metric_key` | Definition |
|---|---|
| `funnel_stage_count` | Students currently at each lifecycle stage |
| `funnel_stage_entered` | Students who ever entered a stage (from `student_stage_history`) |
| `funnel_conversion_rate` | Entered next stage ÷ entered this stage |
| `funnel_dwell_time_avg` / `_p50` / `_p90` | Time between stage entry and exit — exact, from history ranges |
| `funnel_leakage` | Entered this stage and terminated (withdrawn/excluded/stalled) without progressing |

### 3.3 Contact & SLA

| `metric_key` | Definition |
|---|---|
| `followup_compliance_rate` | Follow-ups completed within SLA ÷ follow-ups due |
| `sla_breach_count` | `SLA_BREACHED` events, attributed to the owner at breach time |
| `overdue_followup_count` | Open follow-up tasks past due (working-calendar aware) |
| `days_since_contact_avg` | Working days since last contact |
| `never_contacted_count` | Assigned students with zero outbound interactions |
| `awaiting_response_count` | Last outcome `waiting`, within the response window |
| `unresponsive_count` | Students carrying the `Unresponsive` status |
| `contact_attempts_avg` | De-duplicated attempts per student |

### 3.4 Risk

`risk_level_count` · `risk_amber_count` · `risk_red_count` ·
`risk_reason_distribution` · `risk_open_without_intervention` (control-tower
exception) · `risk_time_to_intervention_avg` · `risk_resolution_rate` ·
`risk_manual_override_share`.

### 3.5 Coaching

`sessions_planned` · `sessions_completed` · `session_completion_rate` ·
`attendance_rate` · `missed_by_student_count` · `missed_by_coach_count` ·
`missing_session_notes_count` · `students_without_coaching_count` ·
`coach_utilization` (sessions ÷ configured capacity) ·
`coach_action_completion_rate`.

### 3.6 Freelancing & gigs

`freelance_activity_count` · `profile_completion_rate` ·
`readiness_rate` · `proposals_submitted` · `proposal_response_rate` ·
`interviews_count` · `offers_count` · `gigs_submitted` · `gigs_approved` ·
`gigs_rejected` · `gig_approval_rate` · `gig_verification_cycle_time` ·
`gigs_pending_verification` · `verified_revenue_total` (base currency, using
each gig's **stored dated FX rate**) · `duplicate_gig_flag_count`.

### 3.7 Escalations

`escalations_open` · `escalations_overdue` · `escalation_first_response_time` ·
`escalation_resolution_time` · `escalation_reopen_rate` ·
`escalations_by_category` · `escalation_tier_advancement_count`.

### 3.8 Quality

`qa_coverage_rate` (audited ÷ coverage target) · `qa_score_avg` ·
`qa_failure_rate` · `qa_findings_by_category` · `qa_repeat_failure_rate` ·
`corrective_actions_open` · `corrective_actions_overdue` ·
`re_audit_pass_rate` · `qa_calibration_variance` · `qa_appeal_rate` ·
`qa_appeal_overturn_rate`.

### 3.9 Workforce

`students_per_coordinator` · `coordinator_over_capacity_count` ·
`unassigned_students_count` · `staff_absent_with_unowned_students` ·
`coordinator_performance_score` · `tl_performance_score` ·
`coach_performance_score` · `caseload_difficulty_index`.

### 3.10 Data quality & system

`required_field_completeness` · `invariant_violation_count` (per invariant
1–8) · `orphaned_record_count` · `stale_record_count` ·
`contradictory_state_count` · `failed_import_count` ·
`failed_integration_count` · `dlq_depth` · `job_failure_count` ·
`reconciliation_drift_count`.

## 4. The PM forecast — deterministic and explainable

**Non-negotiable:** no machine learning, no black-box prediction in v1
(Prohibition 7). The forecast is arithmetic the PM can check by hand.

```
For each stage s in the funnel:
  observed_conversion[s] = entered(s+1) / entered(s)      -- over a configurable
                                                          -- observation window
  observed_dwell[s]      = median dwell in s

projected_graduates =
    already_graduated
  + Σ over stages s:  pipeline_count[s]
                      × Π conversion from s to Graduated
                      × feasibility[s]

feasibility[s] = 1 if Σ remaining dwell ≤ cohort_time_remaining, else a
                 configurable partial factor (default 0, i.e. conservative)

forecast_rate = projected_graduates / denominator
```

Rendered **on the same screen as the number**:

1. **Assumptions** — observation window, conversion rates used per stage, dwell
   medians, cohort time remaining, denominator policy, feasibility treatment.
2. **Sensitivity band** — recomputed at the configured percentile range of
   observed conversion (default p25/p75), shown as a low/high band.
3. **Gap breakdown — "what must change to hit 85%"** — the additional students
   required, and for each stage, how many additional conversions at current
   rates would close the gap, ranked by the smallest achievable change.

Every forecast input is itself a registry metric with a drill-down, so a PM can
click from "we assume 62% conversion from Gig Progress" to the students behind
that 62%.

## 5. Read models

| Read model | Grain | Refresh | Feeds |
|---|---|---|---|
| `rm_student_current` | student | on event | student lists, work queue, control tower |
| `rm_work_queue` | task | on event | My Work, coordinator dashboard |
| `rm_stage_history_daily` | student × day | nightly | funnel, dwell, as-of |
| `rm_sla_daily` | student × day | hourly | SLA compliance, scorecards |
| `rm_risk_daily` | student × day | hourly | risk trend |
| `rm_coaching_rollup` | coach × week | hourly | coaching dashboards |
| `rm_gig_rollup` | cohort × day | on event | gig & revenue metrics |
| `rm_graduation_progress` | student | on event | graduation, PM funnel, forecast |
| `rm_qa_rollup` | auditor / auditee × cycle | nightly | QA dashboards |
| `rm_staff_performance` | staff × period | nightly | scorecards |
| `rm_exceptions` | exception × subject | on event + hourly | control tower |

Dashboards read **only** from read models (NFR: p95 < 3s). Operational screens
read OLTP for the record being worked on and read models for lists.

## 6. Reconciliation

Nightly, every registry metric is recomputed **from raw events** and compared to
its read model. Divergence raises a system alert, records a
`reconciliation_drift_count`, and suppresses the "verified" badge on affected
reports until resolved (AC-23). This is the mechanical guarantee behind
"every number in every report can be reconstructed from the immutable event
log".
