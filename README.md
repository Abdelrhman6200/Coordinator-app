# Coordinator — Cohort Operations Platform

An operational **system of record** for multi-cohort, multi-program coaching and
graduation operations. First deployment: a DEPI/Digilians freelancing coaching
and graduation phase. Nothing in the system is program-specific by construction.

The platform exists to answer three questions at all times:

1. **For every student** — what is true about them right now, and what happens next?
2. **For every staff member** — what must I do now, and did I do it on time?
3. **For management** — are we on track for the graduation target, and exactly
   which records explain the number?

## Status

| Phase | Deliverable | State |
|---|---|---|
| A | PRD, data model, event model, state machines, permission matrix | **Complete — awaiting sign-off** |
| B | Per-screen specification | **Complete — awaiting sign-off** |
| C | Per-workflow specification | **Complete — awaiting sign-off** |
| D | Build (24 ordered increments) | **In progress** — see [build log](docs/15-build-log.md) |
| E | Testing & release | Planned (see `docs/11-testing-and-release-plan.md`) |

> **Hard gate.** No application code is written until Phase A is signed off.
> This is the operating contract for the project, not a formality: the schema,
> the event catalogue and the permission matrix are the things that are
> expensive to change after code exists.

## Documents

Start at [`docs/00-index.md`](docs/00-index.md). Build progress is tracked in
[`docs/15-build-log.md`](docs/15-build-log.md).

## Running it

```sh
pnpm install
pnpm db:start          # or: docker compose up -d db
pnpm db:migrate
pnpm test              # 195 tests
pnpm typecheck
```

`DATABASE_URL` defaults to `postgres://coordinator@127.0.0.1:5433/coordinator`.

## Unconfirmed requirements

Anything not confirmed by the programme owner is **not invented**. It ships as
versioned configuration with a conservative default and a visible
`CONFIG-PENDING` badge in the Admin panel, and is tracked in
[`docs/12-open-decisions-register.md`](docs/12-open-decisions-register.md).
