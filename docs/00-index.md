# Document Index

Read in this order. Later documents assume the vocabulary of earlier ones.

| # | Document | Covers PRD sections (of the 40 required) |
|---|---|---|
| 01 | [Product Requirements](01-prd.md) | 1–12, 19–20, 26–34 |
| 02 | [Permission Matrix](02-permission-matrix.md) | 3, 4, 29 |
| 03 | [Data Model](03-data-model.md) | 13–16, 37 |
| 04 | [Event & Audit Model](04-event-and-audit-model.md) | 17, 18 |
| 05 | [State Machines](05-state-machines.md) | 8, 9 |
| 06 | [Rules Engines](06-rules-engines.md) | 21–24 |
| 07 | [Metric Registry](07-metric-registry.md) | 25 |
| 08 | [Screen Specifications](08-screen-specifications.md) | Phase B; 6, 30–33 |
| 09 | [Workflow Specifications](09-workflow-specifications.md) | Phase C |
| 10 | [Technical Architecture](10-technical-architecture.md) | 35–38 |
| 11 | [Testing & Release Plan](11-testing-and-release-plan.md) | 39, 40; Phase E |
| 12 | [Open Decisions Register](12-open-decisions-register.md) | — |
| 13 | [Build Order](13-build-order.md) | Phase D |
| 14 | [Consistency Gate](14-consistency-gate.md) | Traceability proof |
| 15 | [Build Log](15-build-log.md) | Phase D progress and decisions taken during the build |

## Conventions used throughout

- **`CONFIG-PENDING`** — a business rule that is not confirmed. Implemented as
  configuration with a safe default; never hard-coded; surfaced in Admin.
- **Effective-dated** — the row carries `effective_from` / `effective_to`
  (SCD-2). Historical questions resolve against the row valid at the asked-for
  timestamp, never against today's row.
- **Configurable** — stored as data in the configuration registry, versioned,
  with `effective_from` / `effective_to`, changed only through Admin, and every
  change emits `CONFIG_CHANGED`.
- **Drillable** — the number on screen has a stored query that returns the exact
  record list behind it, and each record links to its own event history.
