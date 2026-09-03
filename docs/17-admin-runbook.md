# 17 — Admin Runbook

Operational procedures for running the platform. Written for the person on call,
not for the person who built it.

## 1. Running it

```sh
pnpm install
pnpm db:start          # docker compose up -d db, or scripts/pg-local.sh
pnpm db:migrate
pnpm seed:demo         # optional: a training cohort
pnpm api               # :4000
pnpm web               # :3000
pnpm test              # the full suite
pnpm typecheck
```

`DATABASE_URL` defaults to `postgres://coordinator@127.0.0.1:5433/coordinator`.

## 2. Migrations

Applied in order and recorded with a checksum. **An applied migration is never
edited** — the runner refuses a changed file and tells you to add a new one.
Rollback is a new migration, never a down-migration on data.

```sh
pnpm db:migrate        # idempotent; prints what it applied
```

### The one migration that needs a human follow-up

`0003_fix_rejection_code_check.sql` adds its constraints **NOT VALID** on
purpose. A Quality decision is immutable, so the migration must not rewrite rows
stored while the constraint was broken. To finish the job:

```sql
-- 1. Find the affected decisions.
SELECT id, submission_id, decided_at FROM quality_decision
WHERE outcome <> 'accepted' AND cardinality(rejection_codes) = 0;

-- 2. Have Quality re-decide each at a higher level. Do NOT edit the rows.

-- 3. Then, and only then:
ALTER TABLE quality_decision VALIDATE CONSTRAINT rejection_requires_coded_reason;
ALTER TABLE quality_decision VALIDATE CONSTRAINT acceptance_carries_no_rejection_code;
```

## 3. The demo cohort

`pnpm seed:demo` creates a **new** demo cohort each run; it never deletes an
existing one. That is deliberate: once training has produced a Quality decision,
the cohort's students cannot be deleted — the database refuses, correctly.
Retire an old demo cohort by closing it, exactly as you would a real one.

The seed refuses to run against a database holding students outside a demo
cohort unless `SEED_DEMO_FORCE=1` is set, so it cannot be pointed at production
by accident.

## 4. Background jobs

| Job | Cadence | What it catches |
|---|---|---|
| `contactSlaSweep` | hourly | Students with no contact in 7 days (§14) |
| `evidenceSlaSweep` | hourly | Stage SLAs: coach 24h, L1 24h, L2 48h |
| `qualityQueueWatch` | hourly | Queue over 1,000 (Lead) or 1,400 (PM) |
| `sessionConfirmationSweep` | hourly | Sessions unconfirmed 24h out |
| `taskOverdueSweep` | hourly | Marks tasks overdue |
| `riskSweep` | nightly | Time-based risk rules and re-projection |
| `invariantSweep` | nightly | Students with no open next action (Invariant 5) |
| `interventionGapSweep` | nightly | Critical risk with no intervention plan |

`runAllSweeps(pool, cohortId, calendar)` runs the set. Every job is idempotent:
re-running produces no duplicate task, event or notification.

**Sweepers are not optional.** The signals that matter most are *absences* —
nothing emits an event when a contact fails to happen — so a system running on
handlers alone silently stops noticing students going quiet.

## 5. The dead-letter queue

```ts
await deadLetters(pool);              // list stuck events with their last error
await replayDeadLetter(pool, eventId); // re-arm one
```

Replay is safe because every handler is idempotent, keyed on `event_id`. Check
`system_log` for `HANDLER_FAILED` to see what happened.

## 6. Reconciliation

```ts
await reconcileGraduation(pool, cohortId);
// { fromReadModel, fromEvents, matches, divergentStudentIds }
```

Recomputes the headline from the raw event log and compares it to the read
model. **A `matches: false` is an incident, not a rounding note** — it means a
projection has drifted from the events, and the reported number can no longer be
defended. Investigate the named students before publishing any report.

## 7. Common questions

**"The graduation rate looks wrong."** Check three things in order:
1. `graduationSummary` counts *students*, not graduation records — a student who
   never submitted anything is still in the denominator.
2. The cohort's `denominator_policy` (register item 26). `include_all` is the
   default and cannot flatter the rate. The applied policy is stamped on every
   graduation record.
3. Run the reconciliation.

**"A rejected item disappeared."** It did not. A rejection returns an item to the
correction loop with `is_open = true`; only acceptance closes it. Look for it at
its current stage.

**"A coordinator can't see the PM dashboard."** Correct. They hold
`graduation.view` at *own* scope, which shows a student's graduation position on
the student record. Programme analytics are deliberately not on the frontline.

**"An account is locked out."**
```sql
UPDATE user_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1;
```
Five failures locks an account for 15 minutes. Check `system_log` for
`LOGIN_FAILED` first — a burst is a security signal, not a forgetful user.

**"An import won't roll back."** It will not once the operation has acted on the
students. `rollbackBlockers(pool, batchId)` names the activity. Withdraw or
exclude the students individually instead.

## 8. Backup and recovery

Targets: **RPO ≤ 5 minutes, RTO ≤ 1 hour**, PITR enabled.

```sh
pg_basebackup -D /backup/base -Fp -Xs -P     # base backup
# WAL archiving configured in postgresql.conf
```

**A backup that has never been restored is not a backup.** Test the restore
quarterly, against a production-shaped dataset, and record the date and the
elapsed time. The restore is the rollback plan; there is no other one.

## 9. Configuration changes

Changes to graduation rules, SLA rules or risk rules must go through the impact
preview: how many current students would change status, by from→to, before
publishing. Publishing sets `effective_from`; historical evaluations keep their
own `config_version_id` and are never rewritten.

Every rule evaluation in the system stores the config version it used, so a past
decision can always be re-derived under the rules that actually applied.

## 10. What is NOT automated, on purpose

- **Graduation** is computed, never granted. There is no endpoint that writes it.
- **Entitlement deductions** are tracked, never applied — HR and legal sign-off
  is required first (§53).
- **Duplicate evidence** is flagged, never auto-rejected. Quality decides.
- **Fuzzy-duplicate students** are surfaced at import, never auto-merged.
  Merging two real people is unrecoverable.
- **Withdrawal** is the Ministry's decision. The system records it and requires
  the Ministry reference.
