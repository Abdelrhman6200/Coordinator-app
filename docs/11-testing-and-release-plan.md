# 11 — Testing & Release Plan (PRD §39–40, Phase E)

## 1. Test strategy

The system's correctness claims are specific, so the tests are specific. Each
test class below exists because a named guarantee would otherwise be
unverifiable.

| Class | Guarantee it protects |
|---|---|
| Rule-engine unit tests | Engines are deterministic and configuration-driven |
| Golden-path integration tests | Every Phase C workflow completes end to end |
| Permission matrix tests | No role can reach what the matrix denies |
| Separation-of-duties tests | Submit/verify/approve cannot collapse into one person |
| Idempotency tests | Replay never double-counts |
| Data-integrity tests | The eight invariants survive every workflow |
| Reconciliation tests | Every number is reconstructible from events |
| Load tests | The stated scale and latency targets hold |
| i18n/RTL tests | Arabic is a first-class layout |
| Offline/conflict tests | Frontline capture survives bad connectivity |
| Migration/rollback tests | A bad deploy is recoverable |

## 2. Unit tests — rule engines

All of `packages/rules` is pure, so it is tested against a **fixture library of
edge cases** with no database.

**Required fixtures per engine:**

- **SLA:** due date landing on a weekend; on a configured public holiday; on the
  boundary of working hours; across a DST shift; across a cohort timezone
  different from the user's; a student whose risk level changes mid-window
  (interval changes); a breach whose owner changed between due and breach (the
  event must name the owner **at breach time**).
- **Attempts:** three calls inside the de-duplication window count as one;
  the first call after the window counts as two; a reply resets per config.
- **Task generation:** duplicate trigger produces one task; a second trigger
  updates due date and priority; cancel-condition fires and cancels with a
  reason; reassignment moves the open task rather than recreating it.
- **Risk:** each seed rule fires and clears at its boundary; two Amber reasons
  escalate to Red; manual override survives an automated downgrade until the
  review date; every change records rule key, config version and evidence.
- **Escalation:** tier advancement on breach; `Awaiting Information` pausing and
  resuming the clock; reopen inside and outside the window; SoD-4 at and below
  the severity threshold.
- **Graduation:** zero criteria met; partial; exactly met; met via route B while
  route A is closer; a criterion satisfied by a gig that is later unlocked
  (status must regress); evaluation under an old config version reproduces the
  historical result exactly; **the plain-language gap string is asserted in
  English and Arabic**.
- **QA scoring:** weighted score; auto-fail overriding a high weighted score;
  band boundaries; calibration variance across auditors.
- **FX:** historical value unchanged after a later rate is published.

## 3. Golden-path integration tests

One per Phase C workflow, W01–W33, each asserting the **entire chain**: database
change **and** event emitted **and** audit row written **and** task created
**and** notification queued **and** KPI moved **and** risk re-evaluated **and**
next state correct **and** next responsible user resolved.

A workflow test that asserts only the database change does not pass review — the
chain is the specification.

## 4. Permission matrix tests — exhaustive and generated

For **every role × every API endpoint**, assert allow/deny.

- The test source is generated from the same table that seeds `role_permission`,
  so documentation and behaviour cannot drift.
- An endpoint without a `@RequiresPermission` declaration **fails the build**.
- A matrix entry referencing an endpoint that no longer exists **fails the
  build**.
- Scope tests go further than allow/deny: for `own` / `team` / `coaching_team` /
  `cohort`, assert that a record **outside** scope is invisible in list results,
  in counts, in search, and on direct fetch — a leak in a count is still a leak.
- RLS is tested independently by executing queries as the database role with
  application context set, bypassing the service layer entirely. If the service
  layer were removed, the database must still refuse.

**Separation-of-duties tests** (each asserting *blocked* **and** *logged*):
submitter attempts to verify their own gig; gig verifier attempts to approve the
dependent graduation; single-approver mode enabled makes it allowed and stamps
the record; auditor sampled onto their own record; auditor sampled onto a direct
report; escalation resolver approves their own resolution at and below the
severity threshold.

## 5. Idempotency tests

**Replay every event type twice** and assert: no duplicate task, no duplicate
notification, no double-counted KPI, no duplicate read-model row, no second
audit entry for the same `event_id`.

Also tested: out-of-order delivery; a handler crashing after a partial write
(the transaction rolls back and the retry succeeds); DLQ replay after a
deliberate poison message; the offline outbox submitting the same
`client_dedup_key` twice.

## 6. Data-integrity tests

After **every** workflow in Phase C, assert all eight invariants hold. Run as a
shared assertion helper invoked at the end of every integration test, plus a
standalone property test that generates random workflow sequences and asserts
the invariants after each step.

Additionally: attempt each invariant violation **directly against the database**
(bypassing the application) and assert the constraint refuses it.

## 7. Reconciliation test

Recompute every registry metric from the raw event log and assert equality with
the read models, at multiple as-of timestamps — including one **before** a
reassignment and one **after**, to prove effective-dated attribution (AC-18).

Any divergence fails the build and, in production, raises an alert and
suppresses the report's "verified" badge.

## 8. Load and performance tests

Seeded at target scale: **10,000 students, 500 staff, 5,000,000 events** in one
cohort, with several cohorts concurrent.

| Path | Target |
|---|---|
| Coordinator work queue | p95 < 1.5s |
| Student record load | p95 < 1.5s |
| Contact flow save (full atomic chain) | p95 < 1.5s |
| Dashboards | p95 < 3s |
| Nightly reconciliation | completes inside the maintenance window |
| Sweepers | complete inside their cadence with headroom |

Soak test: sustained event ingestion for 24 hours with queue depth and DLQ depth
flat. Failure to stay flat means the sweeper cadence or projection cost is
wrong, and it is better to learn that here.

## 9. i18n / RTL tests

Every screen rendered in Arabic: direction, mirrored iconography, numerals, date
and currency formatting, and **no clipped or overlapping text** at every
breakpoint. Snapshot tests for both locales. Arabic name normalisation is tested
in the deduplication fixtures — alef variants, ta marbuta, tatweel, diacritics
and Arabic-Indic digits must not produce silent duplicates.

## 10. Offline and conflict tests

Log an interaction offline; reconnect; assert exactly one record. Log offline on
two devices for the same student; assert conflict detection and a resolvable
prompt rather than data loss. Log offline, then have the record change
server-side; assert the conflict diff is shown.

## 11. Security tests

Authentication and session handling; step-up re-auth enforced for
`override_lock`, `impersonate`, graduation approval and reversal; impersonation
records both real and effective actor on every action; PII masking asserted at
the **query** layer (a masked field must never be fetched); signed-URL expiry;
evidence hash mismatch detection; append-only enforcement (attempt `UPDATE` and
`DELETE` on `events` and `audit_log` as the application role and assert refusal);
export watermarking and `EXPORT_PERFORMED` logging; permission-denial and
failed-login alerting thresholds.

## 12. Migration and rollback

Expand/contract migrations only. Every migration is tested forward on a
production-shaped dataset and rolled back on staging. A rollback must never
require a data down-migration. Long-running backfills run as idempotent jobs
with progress and resumability, never inline in a deploy.

## 13. UAT plan

**Written per role, executed by real staff before go-live** — coordinators, team
leaders, coaches, quality specialists and lead, operations, and the PM. Not by
the build team.

| Script | Role | Passes when |
|---|---|---|
| COORD-01 | Coordinator | Completes a full simulated working day **from one screen**, without opening another module |
| COORD-02 | Coordinator | Logs a call on a phone, offline, in under 30 seconds; it appears after reconnect |
| TL-01 | Team Leader | Identifies the worst SLA performer and drills to the specific breaching students |
| TL-02 | Team Leader | Reassigns a departing coordinator's caseload; open tasks and escalations carry over |
| COACH-01 | Coach | Runs a session, records notes and action items; the action items appear as tasks for their owners |
| CM-01 | Coaching Manager | Finds every student with no coaching and assigns coaches |
| QA-01 | Quality Specialist | Completes an assigned audit and raises a finding with evidence |
| QA-02 | Quality Lead | **Defends a sample and a score to an external reviewer** — reproduces the sample from its seed |
| QA-03 | Audited staff | Files an appeal; sees the dispute, reviewer and outcome recorded |
| OPS-01 | Operations | Identifies every unowned, uncontacted or stalled student **in under thirty seconds** |
| OPS-02 | Operations | Rolls back a bad import batch; a batch with downstream events is correctly refused |
| PM-01 | PM | Goes from the headline rate to a named student's individual event history **in five clicks** |
| PM-02 | PM | Explains the forecast to a stakeholder using only what is on the screen |
| ADM-01 | Admin | **Launches a new cohort with different graduation rules by configuration alone** |
| ADM-02 | Admin | Changes an SLA rule, sees the impact preview, and confirms with a reason |

UAT defects are triaged as blocking / non-blocking against these criteria, not
against the build team's judgement.

## 14. Release readiness

Go-live requires all of:

- [ ] All Phase C workflows have passing golden-path tests.
- [ ] Permission matrix test suite exhaustive and green; no undeclared endpoint.
- [ ] SoD tests green, including the negative cases.
- [ ] Idempotency and invariant suites green.
- [ ] Reconciliation green at multiple as-of dates.
- [ ] Load targets met at stated scale.
- [ ] Arabic/RTL pass on every screen.
- [ ] Backup restore executed and documented.
- [ ] DLQ replay console exercised.
- [ ] Seeded demo cohort available for training.
- [ ] **Admin runbook** complete: configuration areas, impact previews, cohort
      clone, import rollback, DLQ replay, restore procedure, incident paths.
- [ ] Open Decisions Register reviewed; every `CONFIG-PENDING` item has a named
      owner, a default, and a date needed.
- [ ] UAT scripts executed and signed off **by real staff in each role**.

## 15. Migration & training

- **Data migration:** existing student data enters through the same import
  pipeline as production intake — no side-door loading, so migrated records
  carry batch provenance and pass the same validation.
- **Training:** the seeded demo cohort mirrors production configuration and is
  reset nightly, so staff can practise destructive actions safely.
- **Cutover:** a rehearsed dry run on staging, a freeze window, the production
  import, a validation checklist against the data-quality dashboard, then
  release. Rollback is the documented restore procedure, tested, not theoretical.
