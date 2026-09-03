# 15 — Build Log (Phase D progress)

Progress against the 24 increments in [`13-build-order.md`](13-build-order.md).
An increment is "done" only when its slice of the Phase E suites is green, so
this log records tests, not files written.

## Status

| # | Increment | State |
|---|---|---|
| 1 | Auth | **Complete** — scrypt, sessions, lockout, step-up, impersonation |
| 2 | RBAC & record-level security | **Complete** — matrix as data, scope predicates, generated tests |
| 3 | Core database & event backbone | **Complete** — append-only, hash chain, outbox, idempotent handlers |
| 4 | Organization & cohort configuration | **Schema complete**; cohort clone not built |
| 5 | Student master | **Complete** |
| 6 | Allocation | **Complete** — effective-dated, carries tasks and escalations |
| 7 | Lifecycle state machine | **Schema complete**; transitions as data not built |
| 8 | Communications & follow-up/SLA | **Complete** — atomic contact flow, per-channel attempts, sweeper |
| 9 | Tasks | **Complete** — dedup, auto-cancel, reassignment |
| 10 | Coaching | **Schema complete**; session service not built |
| 11 | Freelancing | **Schema complete** |
| 12 | Gigs | **Complete** via the evidence pipeline |
| 13 | Graduation | **Complete** — the single calculation service |
| 14 | Risk | **Complete** — DEPI triggers against group session position |
| 15 | Escalations | **Schema complete**; service not built |
| 16 | Quality | **Complete** — binary seven checks, R01–R12, immutable decisions |
| 17 | Performance | **Schema complete**; scorecards not built |
| 18 | Notifications | **Complete** — in-app, rate-limited, deduplicated |
| 19 | Dashboards & read models | **Complete** for the seven screens built |
| 20 | Reporting | **Complete** — daily, weekly, snapshots, reconciliation |
| 21 | Audit & system logs | **Complete** — append-only, DLQ console functions |
| 22 | Administration | **Partial** — config schema exists; Admin UI not built |
| 23 | Import/export | **Import complete**; export not built |
| 24 | End-to-end testing | **Substantial** — see below |

**674 tests passing** across six packages. `pnpm typecheck` clean.

### What is NOT built

Stated plainly so the gap is not mistaken for completeness:

- **Screens**: Sessions, Freelancing, Services, Escalations, Risks, Team,
  Performance, Reports and the full Admin panel have schema and (mostly)
  services, but no UI. Seven screens are built: coordinator day, students,
  student record, contact flow, Quality queue, Quality review, PM command
  centre, control tower, student portal.
- **Cohort configuration cloning** (the one-click reusability test, AC-24).
- **Lifecycle transitions as configuration data** — the state machine is
  specified in docs/05 but enforced ad hoc in services.
- **Export** (Excel/CSV/PDF with watermarking).
- **Escalation routing engine** — the matrix is configuration in `depi-r5.ts`
  but no service consumes it yet.
- **Load testing** at the stated scale (2,948 students, 5M events).
- **RLS policies** — scope is enforced by query predicate in the service layer;
  the database backstop is specified but not yet applied.
- **UAT** — scripts are written in docs/11; none have been executed by real
  staff.
## What exists

```
packages/permissions/  the matrix as data, scope resolution, the five SoD rules
packages/rules/        pure engines: working calendar, SLA, attempts, risk,
                       graduation, QA scoring & seeded sampling
packages/db/           foundation migration, migration runner, role seeding
```

`packages/rules` is pure — `(facts, config) → decision`, no I/O, no clock reads.
That is what makes the fixture library possible and what makes a historical
evaluation re-derivable years later under the config version that actually
applied.

## Design decisions taken during the build

**Working-minute arithmetic rather than calendar-day arithmetic.** Deadlines
advance in working periods. The subtle case, which has its own test: a deadline
that exactly consumes the remaining window lands at close of business, not at
the next morning's opening — rolling forward there would silently hand the owner
an extra day.

**`UNASSIGNED` is an open row with a null coordinator, not a missing row.** This
is what gives an unowned student an age clock on the control tower instead of
making them an invisible gap. The exclusion constraint permits exactly one open
row either way.

**Append-only enforced twice.** A trigger raises on `UPDATE`/`DELETE` against
`events` and `audit_log`, *and* the application role is denied those grants.
Either alone is a single point of failure. A hash chain makes an out-of-band
alteration detectable.

**Role seeding is reconciling, not additive.** A grant withdrawn from the code
matrix is actively deleted from the database. A permission that outlives its
removal is a security defect, so "stop adding it" is not sufficient.

**An unconfigured graduation ruleset reports `not_configured`.** It does not
report `not_eligible`, because those mean different things and only one of them
is true. This keeps register item 1 visible rather than letting a missing
decision masquerade as a student's shortfall.

## Four defects the tests caught

Two from the first build, two from the DEPI alignment. All four before anything
reached a screen.

### From the DEPI alignment

3. **An uncoded rejection was accepted by the database.** The constraint read
   `outcome = 'accepted' OR array_length(rejection_codes, 1) >= 1`. On an empty
   array `array_length` returns NULL, and a CHECK treats NULL as **passing** —
   so the constraint let through exactly the case it was written to catch.
   Requirement §34 is explicit that reason analytics use the coded field, which
   is worth nothing if an uncoded rejection can be stored. Fixed in migration
   0003 with `cardinality()`, which returns 0 rather than NULL.

   The fix is added **NOT VALID** on purpose. A Quality decision is immutable and
   append-only, so the migration must not rewrite or delete rows stored while the
   constraint was broken. New and updated rows are enforced; existing bad rows
   are left for Quality to re-decide at a higher level, which is the only
   remediation route the requirements permit. The migration carries the operator
   query and the `VALIDATE CONSTRAINT` step to run afterwards.

4. **A role withdrawn from the matrix kept its grants.** The seed reconciled
   permissions within a role but never removed a role that had left the code
   entirely — so the old generic roles survived the switch to the DEPI set, still
   granting. Now a withdrawn system role is deleted, or, where it is still
   assigned to a user, stripped of every grant and kept inert so the assignment
   history stays explicable.

## Two engine bugs the fixture library caught

Both were found by tests, before any of this reached a screen.

1. **Route status derived from a single tie-broken route.** When two graduation
   routes each needed one more criterion, the tie-break ran before progress was
   considered, so a student with real progress on route B was reported
   `not_eligible` because route A sorted first. Status now reflects progress
   across all routes, and the tie-break prefers the route with more criteria
   already met — the one the coordinator should actually be pointed at.

2. **A first-contact SLA reading as `approaching` from the moment of
   assignment.** This one turned out to be correct behaviour rather than a bug:
   with a one-working-day deadline and a one-day warning window, a first contact
   due today belongs in today's queue. The test now asserts it deliberately,
   with a second case covering a wider window.

## Invariant 5 is not a database constraint

Invariants 1, 2, 3, 4, 6, 7 and 8 are enforced by the schema and proved by tests
that attack the database directly, bypassing all application code.

Invariant 5 — *at least one open next action, or an explicit justified
`NO_ACTION_REQUIRED`* — cannot be a constraint: it is a statement about the
relationship between a student and the task table that must hold *between*
transactions, not within one. It is enforced by the task-engine check on every
student-affecting event plus the nightly sweeper, and violations surface as
data-quality exceptions rather than as write failures. That is a deliberate
choice: blocking a write because a downstream task has not yet been created
would make the system fragile in exactly the moments it matters most.

## Environment note

`docker-compose.yml` is the intended way to run Postgres. In this build
environment the container registry is unreachable through the proxy, so
`scripts/pg-local.sh` starts an equivalent local cluster on the same port. Both
produce the same database; nothing in the code depends on which is used.

## Next

Increment 1 (Auth), then the command-handler write path that increment 3 needs:
state change, event append and audit row in one transaction, with the
transactional outbox and idempotent handlers. That contract has to exist before
the first module command, or some handlers will not have it.
