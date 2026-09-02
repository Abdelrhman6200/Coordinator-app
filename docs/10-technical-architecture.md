# 10 — Technical Architecture (PRD §35–38)

## 35. Technical architecture proposal

### 35.1 Stack

| Layer | Choice | Why this, here |
|---|---|---|
| Database | **PostgreSQL 16** | JSONB for event payloads and config, `tstzrange` + GiST exclusion constraints for effective dating, native RLS for cohort/hierarchy isolation, materialized views for read models, partitioning for 5M events/cohort, PITR. Every hard requirement in this build lands on a Postgres feature. |
| Backend | **TypeScript / NestJS** | Module boundaries map to the module list; DI makes the command-handler + event-emission contract enforceable in one base class; decorators carry the `(module, verb)` declaration the permission test generates from. |
| Data access | **Drizzle ORM + raw SQL escape hatch** | Schema-as-code with migrations, without hiding the SQL that RLS policies, exclusion constraints and recursive hierarchy queries require. |
| Jobs | **BullMQ on Redis** | Sweepers, projections, notifications, exports. Native retry/backoff and a **dead-letter queue with replay** (an explicit NFR). |
| Frontend | **Next.js (App Router) + React + TanStack Query + Tailwind + Radix** | Server components for list-heavy screens (p95 < 1.5s at 10k students), Radix primitives are RTL-correct and accessible by default. |
| i18n | **next-intl + ICU messages**, logical CSS properties | Arabic/RTL as a first-class layout, not a mirrored afterthought. Arabic-Indic numeral and Hijri-aware date formatting per locale. |
| Offline | **IndexedDB outbox + service worker** | The interaction-logging path queues and retries with `client_dedup_key` idempotency. |
| Files | **S3-compatible object storage** | Private buckets, short-lived signed URLs, sha-256 hash stored at upload. |
| Observability | **OpenTelemetry → traces/metrics/logs**, structured JSON logs | `correlation_id` propagates from the HTTP request into every event, job and log line. |
| Auth | **OIDC provider** (organisation IdP), MFA, short sessions | Step-up re-authentication for `override_lock`, `impersonate`, graduation approval and reversal. |

Deliberately **not** chosen: a separate event-store product (Postgres carries
the append-only table and keeps events in the same transaction as state — the
single most important correctness property here); a BI tool as the metric layer
(the registry must be in-app and drillable); an ML service (Prohibition 7).

### 35.2 Module structure

```
apps/
  api/          NestJS: modules mirroring §5 information architecture
  web/          Next.js: role-adaptive shell + module routes
  worker/       BullMQ processors: sweepers, projections, notifications, exports
packages/
  contracts/    zod schemas: API DTOs, event payloads (versioned), config schemas
  rules/        the shared rule evaluator + engines (SLA, task, risk, escalation,
                graduation, QA scoring) — pure functions, no I/O
  permissions/  the matrix as data + the scope resolver + the generated test source
  db/           schema, migrations, RLS policies, read-model definitions
  i18n/         message catalogues (en, ar), formatters
  ui/           design system, RTL-safe primitives, empty/error/loading states
```

`packages/rules` is **pure**: `(facts, config) → decision`. It has no database
access, which is what makes the engines unit-testable against a fixture library
of edge cases and makes historical re-derivation possible.

### 35.3 The write path (the architectural keystone)

Every state mutation goes through one path:

```
Command → permission guard (module, verb)
        → scope resolver (predicate, not post-filter)
        → SoD checker (subtractive)
        → state-machine guard (server-side; structured denial)
        → BEGIN
            state change
            event append (same transaction)
            audit row (same transaction)
            outbox row for async handlers
          COMMIT
        → handlers (idempotent, keyed on event_id)
```

There is no second path. A UI action cannot mutate state without emitting an
event (Prohibition 9) because the only way to mutate state is through a command
handler that writes both, and the `events` table has no `UPDATE`/`DELETE` grant.

**Transactional outbox**, not dual writes: async handlers read committed outbox
rows, so an event is never published for a transaction that rolled back, and
never lost for one that committed.

### 35.4 Read path

- **Operational screens:** OLTP for the record being worked, read models for
  lists.
- **Dashboards and reports:** read models only.
- **Refresh:** `on_event` (incremental, set-to-value), `hourly`, or `nightly`
  per the metric registry, plus the nightly full reconciliation.

## 36. API architecture

**Style:** REST over HTTP/JSON, resource-oriented, with a small command
sub-resource pattern for transitions (`POST /gigs/{id}/decisions`), because
transitions are not field edits and must not be expressible as a `PATCH`.

**Conventions:**
- `GET /v1/{module}` — list, cursor-paginated, filter DSL shared with saved views.
- `POST /v1/{module}` — create.
- `PATCH /v1/{module}/{id}` — field edits only; never a state transition.
- `POST /v1/{module}/{id}/{transition}` — guarded transition; returns the new
  state or a **structured denial**.
- `GET /v1/metrics/{metric_key}` — value + as-of + filters.
- `GET /v1/metrics/{metric_key}/records` — **the drill-down**, returning the
  exact record list behind the number. Every registry entry must expose this;
  a missing drill-down fails CI.

**Cross-cutting:**
- Every endpoint declares `@RequiresPermission(module, verb)`. An endpoint
  without a declaration **fails the build**.
- `Idempotency-Key` header honoured on every mutating endpoint (the offline
  outbox depends on it).
- `X-Correlation-Id` accepted or generated, propagated into events, jobs, logs
  and traces.
- Denials return `{ code, required: {module, verb, scope}, actor_scope, reason }`
  — the UI renders `reason` verbatim.
- Errors are RFC 9457 problem+json with a machine-readable `code`, plus
  field-level violations naming the rule that failed.
- Versioned at `/v1`; event payload schemas versioned independently.

## 37. Database schema

Full entity detail is in [`03-data-model.md`](03-data-model.md). The
implementation properties that matter:

**Isolation.** RLS on every student-scoped table. Policies key on
`current_setting('app.user_id')` and `app.cohort_ids`, resolving through the
effective-dated hierarchy. RLS is the **backstop**, not the primary mechanism —
an application bug must not leak across cohorts.

**Invariant enforcement in the database, not only in services:**

| Invariant | Mechanism |
|---|---|
| 1 one master record | `UNIQUE (cohort_id, identity_key)` |
| 2 one current stage | `EXCLUDE USING gist` on overlapping validity ranges |
| 3 one coordinator | `EXCLUDE USING gist` per student; NULL coordinator is an explicit row |
| 4 one hierarchy resolution | Non-overlapping `org_membership`; acyclicity checked on write |
| 5 an open next action | Task-engine check on every student-affecting event + nightly sweep |
| 6 one current risk | Partial `UNIQUE (student_id) WHERE closed_at IS NULL` |
| 7 gapless history | No `UPDATE`/`DELETE` grant on `events`; trigger raises; hash chain |
| 8 one graduation record | `UNIQUE (student_id)` on `graduation_progress` |

**Performance.**
- `events` partitioned by `cohort_id`, sub-partitioned by `occurred_at` range.
- Covering indexes for the work queue: `(coordinator, status, due_at)` on tasks;
  `(cohort, stage, risk, last_contact_at)` on `rm_student_current`.
- Trigram indexes for fuzzy search on normalised name/email/phone.
- Read models are materialized views or physical tables refreshed
  incrementally; dashboards never aggregate OLTP.
- Connection pooling via PgBouncer in transaction mode; long report queries run
  on a **read replica** so reporting cannot degrade coordinator screens.

**Money and time.** `numeric(18,4)` plus ISO-4217 code, never floats. All
timestamps `timestamptz` in UTC, rendered in the cohort/user timezone. SLA
arithmetic runs in working periods against the cohort's calendar.

## 38. Deployment architecture

```
        ┌───────── CDN / WAF ─────────┐
        │                             │
   [ web (Next.js) ]           [ api (NestJS) ] ──┬── Postgres primary
        │                             │           ├── Postgres read replica
        └────────── OIDC IdP ─────────┘           └── Redis (BullMQ)
                                  [ worker (BullMQ) ] ── S3-compatible storage
                                          │
                              OTel collector → logs / metrics / traces
```

**Environments:** dev · staging (production-shaped, anonymised data) ·
production. Staging carries the seeded demo cohort used for training and UAT.

**Delivery:** containerised; migrations run as a gated pre-deploy step;
expand/contract migration discipline so a rollback never needs a down-migration
on data.

**Backup & recovery:**

| Property | Target |
|---|---|
| RPO | ≤ 5 minutes (continuous WAL archiving) |
| RTO | ≤ 1 hour |
| PITR | Enabled, retention per policy |
| Restore test | **Executed and documented quarterly** — a backup that has never been restored is not a backup |
| Object storage | Versioned, lifecycle-managed, cross-region replication |

**Observability:** structured logs with `correlation_id`; RED metrics per
endpoint; traces spanning HTTP → command → event → handler; a **background-job
dashboard** showing queue depth, failure rate and DLQ depth; a **DLQ replay
console** — safe because every handler is idempotent.

**Alerting thresholds:** SLA sweeper failure, reconciliation drift, DLQ depth,
integration failure rate, permission-denial spikes, failed-login spikes,
p95 latency regressions on the coordinator work path.

**Security posture:** TLS everywhere; secrets in a managed store (never in
config rows); least-privilege database roles (the application role has no
`UPDATE`/`DELETE` on `events` or `audit_log`); signed short-lived URLs for
evidence; step-up auth for elevated actions; PII masking applied in the query
layer so a masked field is never fetched, not merely hidden.

**Scale headroom:** the stated ceiling — 10,000 students, 500 staff, 5M events
per cohort — is met by partitioning plus read models on a single primary with
one replica. The next step, if exceeded, is per-cohort partition pruning and
additional replicas: no redesign, which is the requirement.
