# 13 — Build Order (Phase D)

This is an **internal dependency sequence, not a phasing plan**. Every module
ships in the final release. No module may be deferred by relabelling it a
"future phase" (Phase D, build prompt).

Each increment lands with: migrations, RLS policies, API endpoints with
permission declarations, UI, unit tests, workflow tests, permission tests, and
its metric-registry entries. An increment is not "done" until its slice of the
Phase E suites is green.

| # | Increment | Depends on | Delivers | Done when |
|---|---|---|---|---|
| 1 | **Auth** | — | OIDC, sessions, MFA, step-up re-auth | Step-up enforced on the elevated-action list |
| 2 | **RBAC & record-level security** | 1 | Permission matrix as data, scope resolver, RLS policies, generated permission tests | Exhaustive role × endpoint suite green; RLS refuses when the service layer is bypassed |
| 3 | **Core database & event backbone** | 1 | `events`, audit log, version history, system log, outbox, idempotent handler base, hash chain | Append-only enforced at the grant level; replay-twice test green |
| 4 | **Organization & cohort configuration** | 2,3 | Config registry, versioning, effective dates, cohort states, **cohort clone**, impact preview | AC-24 clone test green; `CONFIG_CHANGED` on every change |
| 5 | **Student master** | 3,4 | Student entity, identity key, header, record shell, 13 tabs scaffolded | Invariant 1 enforced at the database |
| 6 | **Allocation** | 5 | Effective-dated assignment, capacity, bulk assign, unassigned queue | Invariants 3–4; AC-01 |
| 7 | **Lifecycle state machine** | 5,6 | Transitions as data, server guards, structured denials, stage history | Invariant 2; AC-08 |
| 8 | **Communications & follow-up/SLA** | 6,7 | Contact flow, call logging, attempt de-duplication, SLA engine, working calendar, sweeper | AC-02, AC-03, AC-04 |
| 9 | **Tasks** | 8 | Task engine, generators, dedup, auto-cancel, My Work | AC-05 for tasks; reassignment carries tasks |
| 10 | **Coaching** | 7,9 | Both types, sessions, notes, action items → tasks | W12–W14 green |
| 11 | **Freelancing** | 7,9 | Activity types, activity log, progress screen | W15–W16 green |
| 12 | **Gigs** | 11 | Submission, evidence hashing, FX, verification, duplicate detection, locking | SoD-1, AC-12, AC-13, AC-14 |
| 13 | **Graduation** | 12 | Rules engine, routes, gap explanation, review, approval, reversal, snapshots | SoD-2, AC-07, AC-09, AC-11 |
| 14 | **Risk** | 8,10,11,12 | Risk engine, reasons, evidence, overrides, interventions | Invariant 6; every change names its rule and config version |
| 15 | **Escalations** | 9,14 | Cases, routing matrix, tier advancement, SLA, resolution approval | SoD-4 |
| 16 | **Quality** | 5–15 | Cycles, reproducible sampling, versioned scorecards, audits, findings, corrective actions, re-audits, calibration, appeals | SoD-3, AC-16, AC-17 |
| 17 | **Performance** | 8–16 | Scorecards, normalisation, caseload difficulty, drill-downs | Every component drills to records |
| 18 | **Notifications** | 9 | In-app, provider layer, preferences, digests, rate limiting, dedup | AC-28 |
| 19 | **Dashboards & read models** | 3–18 | Metric registry, read models, seven role dashboards, control tower, forecast | AC-19; every tile has a registry entry and a drill-down |
| 20 | **Reporting** | 19 | Report set, filters, as-of, exports, watermarking, scheduling | AC-20 |
| 21 | **Audit & system logs** | 3 | Audit viewer, history viewer, job dashboard, DLQ replay console | Append-only proven; replay exercised |
| 22 | **Administration** | 4,19 | Every configuration area, impact previews, Open Decisions Register screen | AC-10; `CONFIG-PENDING` badges render |
| 23 | **Import/export** | 5,6,21 | Import wizard, validation preview, fuzzy dedup, batch rollback | AC-21, AC-22 |
| 24 | **End-to-end testing** | all | Full Phase E suite, load test, reconciliation, UAT execution | The release-readiness checklist in doc 11 |

## Sequencing notes

**Why RBAC before anything operational.** Retrofitting scope resolution and RLS
onto working modules means auditing every query written before them. Doing it
second means every subsequent increment inherits enforcement for free.

**Why the event backbone before the first feature.** The write-path contract —
state change and event in one transaction — has to exist before the first
command handler, or some handlers will not have it and Prohibition 9 becomes
untrue in exactly the places nobody remembers to check.

**Why dashboards at 19, not earlier.** Dashboards read from read models, which
read from events that only exist once the modules emit them. Building
dashboards early produces private metric definitions, which Prohibition 10
forbids.

**Why import at 23, not 1.** Import is the highest-risk write path (fuzzy
duplicate detection, batch rollback, capacity validation, provenance). It needs
the audit log, the event log and the assignment engine already correct
underneath it. A small seeded fixture set covers earlier increments.

**Cross-cutting work carried in every increment**, never scheduled separately:
i18n and RTL, empty/error/loading/permission-denied states, SOP links, metric
registry entries, drill-down endpoints, and observability instrumentation.
Deferring these produces the retrofit that this build order exists to avoid.
