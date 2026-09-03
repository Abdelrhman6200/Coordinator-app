# 16 — DEPI Round 5 Reconciliation

The confirmed DEPI Round 5 requirements supersede assumptions made in Phase A.
This document records every delta: what is now **confirmed**, what **changed**,
what is **new scope**, and what is **still open**. Nothing here is inferred —
where the source marks something PROPOSED or unavailable, it stays configurable
and stays on the register.

## 1. Decisions now CONFIRMED (register items closed)

| Register # | Item | Confirmed value | Was |
|---|---|---|---|
| 1 | Graduation criteria | **Route A:** 3 gigs, each ≥ $5, total ≥ $15. **Route B:** 1 gig ≥ $300. No other route. | Unset skeleton |
| 3 | Contact cadence | **Every student contacted at least once every 7 days** | Seeded loosely per stage×risk |
| 4 | Unresponsive threshold | **5 attempts, across different channels, over two weeks**, then supervisor escalation; Project Operations may set `Unresponsive` | 3 attempts / 24h window |
| 8 | QA scoring model | **Seven binary checks, all must pass.** Not a weighted score | Weighted with bands |
| 9 | Escalation SLAs | Complaint 48h · operational blocker 24h · coach absence 24h · systemic issue immediate | Unset |
| 10 | Gig evidence standard | Platform: order page + earnings proof + delivered work + profile link. Direct: (contract \| transfer proof \| agreement conversation) + delivered work. Gig counts only if **delivered AND paid AND evidenced AND Quality-accepted** | Unset |
| 11 | Currency handling | **Amount shown in evidence is used; platform fees are not deducted** | Dated FX skeleton |
| 12 | Coaching frequency & capacity | 1 session per group per week · 8 sessions regular, 5 Industry · 3 hours · 43 primary coaches + standby | Unset |
| 7 | QA sampling | **100%** of freelancing evidence · **15%** audit of accepted entrepreneurship plans · **20 items double-reviewed weekly**, target **≥90% agreement** | 10% risk-weighted |

Two targets are now confirmed and must be displayed **separately everywhere**:
**70% contractual (Ministry) threshold** and **85% internal target**. These are
distinct metrics with distinct gaps, not one number with a caveat.

## 2. Decisions that CHANGED my Phase A assumptions

### 2.1 The denominator (register item 2) — partially resolved

Confirmed: an **unresponsive student remains in the denominator** unless a
Ministry withdrawal occurs. Only the Ministry decides withdrawal; the project
records it.

Still open: whether an approved withdrawal is removed from the denominator, and
the exact Ministry mechanism. So the denominator policy stays configurable, but
its default changes: `include_all` remains correct, and "exclude unresponsive"
is now known to be **wrong** and is removed as an option.

### 2.2 Rolling cohort, not a synchronised batch

This invalidates a Phase A assumption. Groups start and finish at different
times, so progress is measured against **each group's own session/journey
position**, not the calendar week. Every "behind schedule" metric, every risk
rule keyed to elapsed time, and the funnel's dwell computation must resolve
against `group.current_session_number`, not `now() - cohort.start_date`.

This is the single most structurally significant change in this document.

### 2.3 Groups are first-class objects

Phase A treated the group as an attribute of a student. It is the **main
operational unit**: 131 groups, each with its own header, twelve tabs, its own
schedule, coach, coordinator, supervisor, graduation percentage and risk
classification. Groups get their own master profile, dashboard and lifecycle.

### 2.4 The student is the evidence submitter

Phase A had staff submitting gigs on a student's behalf. Confirmed: **students
submit their own evidence** through a limited student portal. This adds an
authenticated external actor, a new permission scope, and a new attack surface —
and it changes SoD-1: the submitter is now the student, so the separation that
matters is student → coach → coordinator L1 → Quality L2 → Quality Lead L3.

### 2.5 Quality is binary, not scored

Seven binary checks, all of which must pass. There is no weighted score, no
"needs improvement" band for evidence. The weighted scorecard engine built in
increment 16 still applies to **staff performance auditing**, but it is the
wrong model for evidence review and is not used there.

### 2.6 Rejection is not a terminal state

Confirmed and emphatic: a rejected submission **stays open** until corrected. It
does not disappear from the pipeline, and a rejected service cannot be treated
as closed. My Phase A gig machine had `Rejected` as terminal; it is not.

### 2.7 Evidence SLAs are per-stage and short

Coach ≤24h → Coordinator L1 ≤24h → Quality L2 ≤48h → L3 on dispute or second
rejection. Each stage carries received time, assignee, due time, actual
completion, SLA state, decision, notes and audit. This is a four-stage pipeline,
not the single verification step Phase A modelled.

## 3. New scope not in Phase A

| Area | Summary |
|---|---|
| **Services** | Internal-service path: 3 services/student, $5 fixed value each, following the student's own skills. Full lifecycle to acceptance, owned by the Support Coach. ~600 students, 33 support groups |
| **Entrepreneurship** | A separate graduation pathway with 7 required components, coach-assessed, 15% Quality-audited. Needs its own assessment screen, not the gig interface |
| **Pathway designation** | End of Week 2, Project Operations assigns Outcome / Support / Entrepreneurship, with decision date, owner, reason and prior value |
| **Complaints** | Independent of escalations, owned by the Quality Lead, with enforced routing so a complaint is never routed **only** to the function it is about |
| **Sessions & attendance** | Scheduled sessions, fixed Ministry slots (5–8, 6–9, 7–10 PM), coach confirmation 24h ahead, standby pool, attendance per student × session |
| **Coach assignment validation** | Track specialisation **and** same-day conflict. The three slots overlap, so a coach cannot deliver two groups on one day |
| **Student portal** | My Progress · Sessions · Actions · Submit Evidence · My Submissions · Corrections · Support |
| **Staff performance module** | Role KPIs computed from the same database, 3-step performance process, and a separate **red-line incident** category that bypasses ordinary progression |
| **Entitlement** | Compensation/commission accrual tracked. Deliberately **tracked, not applied** — the source requires HR/legal review before any payroll deduction |
| **Decision log** | Leadership decisions from the four weekly meetings, with owner, due date and follow-up |
| **Duplicate detection** | File hashes, reused URLs, identical name+size, duplicate client/order IDs, proof previously used by another student. Flags automatically; **Quality still decides** |
| **Day-zero census** | Pre-launch capture of already-qualifying gigs through the normal evidence process, distinguishing pre-coaching from during-cohort graduation |
| **Provider** | YAT / HRV / EUI as a first-class dimension alongside track |
| **Report snapshots** | Historical report state, so a past report can be re-rendered as it was |

## 4. Role model replaced

The Phase A generic role set is replaced by the confirmed DEPI structure. This
is a substitution of **seed data**, not an architectural change — roles were
already data, and nothing in the codebase branches on a role key.

| DEPI role | Count | Nearest Phase A role | Note |
|---|---|---|---|
| Project Manager | 1 | Project Manager | — |
| Project Operations | 1 | Ops Associate | Wider: pathway designation, unresponsive status, rebalancing |
| Team Supervisor | 5 | Team Leader | Renamed |
| Operations Coordinator | 27 | Ops Coordinator | Gains L1 evidence screening |
| Coach Operations | 2 | *(none)* | New: coach capacity, standby, coverage |
| Outcome Coach | 31 | Coach T1 | Freelancing outcome path |
| Support Coach | 12 | Coach T2 | Also owns the service pipeline |
| Quality Lead | 1 | Quality Lead | Gains independent complaint ownership |
| Quality Member | 4 | Quality Specialist | Renamed |
| Operations Systems Specialist | 1 | Reporting/Data User | Gains data-integrity and dashboard ownership |
| Student | 2,948 | *(none)* | New: portal, own record only |
| System Admin | — | System Admin | Kept **technically separate from business authority** per §5 |

Navigation changes to the confirmed 19 tabs. `Coaching` becomes `Sessions`,
`Gigs` folds into `Freelancing` and `Evidence`, `Tasks` folds into `My Work`,
and `Groups`, `Services`, `Evidence` and `Performance` are new.

## 5. Still open — carried to the register

From §76 and §77 of the requirements, plus items this reconciliation raises.

| # | Item | Impact | Treatment |
|---|---|---|---|
| 23 | **Round 5 master cohort workbook** (roster, group codes, track, provider, schedule, dates, slot, status, unique student ID) | **Hard blocker** on production data import — named as the only one | Import pipeline built and tested against synthetic data; no production import until supplied |
| 24 | Ministry report format, frequency, recipient | Report definition | Configurable report definition, unset |
| 25 | Ministry withdrawal request/decision mechanism | Withdrawal workflow | Status + reference recorded; mechanism configurable |
| 26 | Whether approved withdrawals leave the denominator | **Headline KPI** | Configurable; default `include_all` |
| 27 | Previous-round gig/graduation/QA data | Forecast baselines | Forecast runs on this cohort's own observed rates until supplied |
| 28 | Day-zero graduation census | Baseline correctness | Import workflow built; census must be run before launch |
| 29 | 1:1 follow-up content standard (§12) | Required fields at contact | Fields configurable, not immutable — source marks PROPOSED |
| 30 | 75% (6/8) attendance operating standard | Risk thresholds | Configurable; attendance is **not** a graduation criterion |
| 31 | Systems/access: master file, Drive, forms, channels, LMS/CRM, automations, platform verification access | Integrations | Integration service behind an interface; manual operation always available |
| 32 | Entitlement/deduction contractual grounding | Payroll | **Tracked, never auto-applied** pending HR/legal sign-off |

## 6. What this means for work already built

| Built | Verdict |
|---|---|
| Event backbone, append-only, hash chain, outbox, idempotency | **Unchanged.** Requirement §57–58 matches it exactly, including the four separate histories |
| Invariants 1–4, 6–8 in the schema | **Unchanged and still correct** |
| Working-calendar engine | **Unchanged.** Now more important: evidence SLAs are 24/24/48h and must not breach overnight or on a holiday |
| Attempt de-duplication | **Retained, retuned.** 5 attempts over two weeks across channels. De-duplication must now be per channel, since the requirement is explicitly multi-channel |
| SLA engine | **Retained, extended.** Adds the flat 7-day contact rule and per-stage evidence SLAs |
| Risk engine | **Retained, rules replaced** with the confirmed attendance and progress triggers |
| Graduation engine | **Retained; criteria now supplied.** The engine already expresses Route A and Route B without modification — which is the reusability claim holding up under a real ruleset |
| QA weighted scorecard | **Retained for staff auditing; not used for evidence.** Evidence review is the new binary seven-check module |
| Permission matrix | **Roles replaced** with the DEPI set. Structure unchanged |
| Gig state machine | **Rejected is no longer terminal** — correction loop added |

The engines survived contact with the real requirements without structural
change. The one Phase A assumption that did not survive is the synchronised
cohort, and that is a metrics-layer change rather than a schema change: group
session position replaces calendar elapsed time as the progress baseline.
