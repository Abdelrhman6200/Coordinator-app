# 06 — Rules Engines

Five engines: **SLA/follow-up**, **task generation**, **risk**, **escalation
routing**, **graduation** — plus **QA sampling/scoring**. All share one
architecture.

## 0. Shared architecture

```
Rule = (rule_key, cohort_id, config_version_id, scope_predicate,
        condition_expression, action[], priority, enabled,
        effective_from, effective_to)
```

- Rules are **configuration rows**, evaluated by a shared, sandboxed evaluator
  over a typed fact object. No rule is a code branch.
- Evaluation is **pure**: `(facts, config_version) → decision`. Same inputs,
  same output, forever — which is what makes historical re-derivation possible.
- Every evaluation writes an **evaluation record**: `rule_key`,
  `config_version_id`, the facts used, the decision, and the resulting events.
  "Why is this student Red?" is answered by data, not by reading code.
- Rules never apply retroactively. A student evaluated under config v3 keeps
  the v3 evaluation; v4 applies from its `effective_from` forward.
- **No AI, no ML, no black-box scoring anywhere in v1** (Prohibition 7).

### Config-change safety

Changing SLA, risk or graduation rules requires a **preview**: the system dry-
runs the new version against the current population and reports how many
students would change status, broken down by from→to. The admin must supply an
audit reason to confirm. No cohort is ever silently reclassified (AC-10).

## 1. SLA / follow-up engine

**Purpose:** answer "when must this student next be contacted, and are we late?"

**Configuration** (`CONFIG-PENDING`, register item 3):

```
sla_rule: (stage, risk_level, track) → {
    contact_interval,          -- e.g. 3 working days
    approaching_threshold,     -- e.g. 1 working day before due
    first_contact_deadline,    -- from assignment
    response_wait_window       -- how long "waiting" is acceptable
}
```

Defaults ship conservative and badged `CONFIG-PENDING`.

**Facts:** `last_contact_at`, `stage`, `risk_level`, `track`, open follow-up
task, working calendar, student timezone.

**Computed:** `next_contact_due_at`, `days_since_contact`, `attempt_count`,
`sla_state ∈ {compliant, approaching, breached}`.

**Working-calendar arithmetic** is the core of this engine and the most common
place a naive implementation is wrong. Due dates advance in **working periods**,
not calendar days: weekends, configured public holidays and non-working hours
are excluded. A due date landing on a non-working period rolls to the next
working period. The sweeper therefore does not breach an SLA on a national
holiday (AC-04).

**On breach:** emit `SLA_BREACHED` with the owner **resolved from the
effective-dated assignment at the breach timestamp** — not today's owner. Create
or update the escalation-eligible task. Feed the coordinator scorecard.

## 2. Task-generation engine

Every generator is declared, never coded inline:

```
generator: {
  source, trigger_event | schedule,
  dedup_key_template,        -- e.g. "{student_id}:followup"
  owner_resolver,            -- current coordinator | TL | coach | fixed role
  due_date_rule,             -- working-calendar expression
  priority_rule,
  cancel_conditions[]
}
```

**Deduplication.** An unresolved auto-task matching `dedup_key` is **updated**
(due date, priority, originating event) rather than duplicated — enforced by the
partial unique index on `task.dedup_key` where status is open/in-progress.

**Auto-cancellation.** When the reason disappears, the task is cancelled with a
reason rather than left to rot: a "chase unresponsive student" task cancels on
`STUDENT_REPLIED`. Without this the queue accumulates stale work and staff learn
to ignore it.

**Reassignment.** Reassigning a student reassigns its open tasks and open
escalations, with an audit entry per moved item.

**Seed generators:**

| Source | Trigger | Owner | Due |
|---|---|---|---|
| workflow | `STUDENT_ASSIGNED` | coordinator | first-contact deadline |
| sla | follow-up due / sweeper | coordinator | `next_contact_due_at` |
| sla | `SLA_BREACHED` | team leader | immediate |
| risk | `RISK_CHANGED` → amber/red | coordinator (+TL on red) | per risk config |
| risk | `INTERVENTION_CREATED` action | named owner | action due date |
| workflow | `COACHING_SCHEDULED` | coach | session time |
| workflow | session `completed` without notes | coach | +1 working day |
| workflow | `COACH_ACTION_CREATED` | named assignee | action due date |
| gig | `GIG_SUBMITTED` | verification pool | verification SLA |
| gig | `GIG_EVIDENCE_REQUESTED` | submitter | evidence SLA |
| graduation | `GRADUATION_ELIGIBLE` | ops/verifier | review SLA |
| escalation | `ESCALATION_ASSIGNED` | assignee | escalation SLA |
| qa | `QA_AUDIT_ASSIGNED` | auditor | audit due |
| qa | `CORRECTIVE_ACTION_CREATED` | action owner | corrective due |
| workflow | required-evidence gap after interaction | coordinator | config |

## 3. Risk engine

**Rule-based only, fully transparent.** Every automated risk change records
**which rule fired, under which config version, on which evidence**.

```
risk_rule: {
  rule_key, condition, resulting_level, reason_code,
  evidence_selector, priority, cooldown, auto_close_condition
}
```

**Seed rules** (thresholds are `CONFIG-PENDING`, register items 4, 5, 6):

| Rule key | Condition | Level | Reason code |
|---|---|---|---|
| `no_contact_days` | days since contact > X | Amber | `unresponsive` |
| `repeated_failed_contact` | attempts ≥ N with no reply | Red | `unresponsive` |
| `missed_coaching` | missed sessions ≥ X in window | Amber | `missed_coaching` |
| `behind_milestone` | milestone deadline passed, not achieved | Amber | `behind_milestone` |
| `no_freelance_activity` | no activity X days after readiness milestone | Amber | `no_freelance_activity` |
| `no_gig_by_milestone` | no submitted gig by gig milestone | Red | `no_gig_progress` |
| `gig_verification_failure` | ≥N rejected gigs | Amber | `gig_verification_failure` |
| `documentation_gap` | required evidence task overdue | Amber | `documentation_issue` |
| `multi_signal_escalation` | ≥2 concurrent Amber reasons | Red | *(escalates level)* |

**Level resolution:** the highest level among firing rules wins; all firing
reasons are attached to the single open `risk_record` (Invariant 6 — one open
record, many reasons). Level changes emit `RISK_CHANGED` carrying before/after,
the firing rules and their evidence.

**Manual override** is permitted with a reason and a **mandatory review date**;
overridden records are exempt from automated downgrade until the review date and
are flagged as `origin = manual` so scorecards can separate judgement from
automation.

**Intervention plans** are mandatory on Amber and Red: risk · root cause ·
required actions · owners · deadlines · next review · notes · outcome. Actions
become tasks. A Red student with no intervention plan is a control-tower
exception.

## 4. Escalation routing engine

```
route: (category_key, severity) → [tier_1_resolver, tier_2, tier_3]
sla:   (category_key, severity, tier) → first_response, resolution   -- CONFIG-PENDING #9
```

Resolvers are **role + scope expressions** (e.g. "the student's team leader"),
resolved at routing time against the effective-dated hierarchy — so routing is
correct even after a reorganisation. On tier SLA breach the case auto-advances a
tier, notifies, and audits. `Awaiting Information` optionally pauses the clock,
which is configuration because pausing can be abused and some programmes forbid
it.

## 5. Graduation engine

**Multi-route, configurable, explainable.** Structure only — **no candidate
values are embedded anywhere in code** (`CONFIG-PENDING`, register item 1):

```
graduation_ruleset: {
  ruleset_key, cohort_id, config_version_id,
  routes: [
    { route_key, label_i18n,
      criteria: [
        { criterion_key, type, parameters, evidence_standard,
          explain_template_i18n }
      ]
    }
  ],
  route_logic: "ANY",              -- ANY route satisfies; configurable
  denominator_policy                -- register item 2
}
```

Criterion types (extensible): `verified_gig_count`, `verified_revenue_total`,
`per_gig_minimum_value`, `milestone_achieved`, `coaching_sessions_completed`,
`evidence_present`, `custom_expression`.

Illustrative shape only:
`Route A: verified_gig_count ≥ X AND per-gig criteria`
`Route B: verified_gig_count ≥ Y AND verified_revenue ≥ Z`.

**Evaluation output** — for every criterion of every route:

```
{ route_key, criterion_key, required, actual, met: bool,
  evidence_refs[], gap_explanation_i18n }
```

**The plain-language gap is a first-class output, not a UI string.** The engine
produces, in English and Arabic:

> "2 of 3 required verified gigs completed. Missing: 1 verified gig with
> payment evidence."

The best-progress route is highlighted, with the shortfall for every route
available, so a coordinator can see whether a different route is closer.

**Recomputation triggers:** gig approved/rejected/unlocked, freelance activity
logged, milestone state change, withdrawal/exclusion, stage change, config
publication (prospective only), nightly sweep.

**Never** does the engine grant graduation. It computes eligibility. Approval is
a human transition guarded by `graduation.approve` and SoD-2 (Prohibition 4).

## 6. QA sampling & scoring

**Sampling** stores everything needed to defend a sample to an external client
(AC-17): `method`, `population_definition`, `filter`, `seed`, `drawn_at`,
`drawn_by`, `size`. Re-running from the stored seed reproduces the identical
record set. Methods: random · targeted · risk-based · manual · re-audit.

**SoD-3** is applied at draw time and re-checked at audit start: an auditor is
never assigned their own work or a direct report's. Rejected assignments are
resampled from the same seeded stream so reproducibility survives.

**Scoring.** Scorecards are configurable and **versioned**; a completed audit
stores its `scorecard_version_id`. Per question: score · weight · comments ·
evidence · pass/fail, with **auto-fail** questions supported (any auto-fail ⇒
overall `Fail` regardless of weighted score). Output: numeric QA score plus
`Pass` / `Needs Improvement` / `Fail` from configurable bands
(`CONFIG-PENDING`, register item 8).

**Calibration.** Multiple auditors may score the same subject
(`calibration_group_id`); the system reports inter-auditor variance per question
and overall, which is how a Quality Lead detects an auditor drifting.

**Appeals.** An audited staff member may formally dispute a finding. The
dispute, the reviewer and the outcome (`upheld` / `overturned` / `amended`) are
recorded and feed back into the score and the performance scorecard.

## 7. Performance scoring

Configurable weights per role; **graduation outcome is never the sole measure**
(§7.17 of the build prompt).

| Role | Components |
|---|---|
| Coordinator | follow-up SLA · overdue actions · documentation completeness · risk handling · escalation compliance · QA score · student progress · graduation outcome |
| Team Leader | team SLA · risk intervention · escalation closure · coordinator compliance · QA performance · graduation trajectory |
| Coach | session completion · attendance · documentation · student action completion · QA · student progress |

**Normalisation is mandatory.** Raw counts punish whoever is handed the hardest
caseload. Each component is normalised for caseload size and student-mix
difficulty (a configurable index over track, intake risk and starting stage),
and the un-normalised value is shown alongside so the adjustment is visible
rather than magic. Every component drills down to the records behind it.
