# 02 — Permission Matrix

## 1. Model

A permission is a tuple:

```
(role_id, module, verb, scope)
```

- **Verbs:** `view`, `create`, `edit`, `delete`, `assign`, `reassign`,
  `approve`, `reject`, `audit`, `export`, `configure`, `view_logs`,
  `override_lock`, `impersonate`.
- **Scopes:** `own` ⊂ `team` ⊂ `coaching_team` ⊂ `cohort` ⊂ `all`.
  Scope is resolved at request time against the **effective-dated** org
  structure and assignment tables, so a historical query resolves against the
  hierarchy as it was, not as it is.
- **Roles are data.** A role is a named set of permission tuples. Adding a role
  is an Admin operation and requires no code change. Role changes emit
  `PERMISSION_CHANGED`.
- A user may hold multiple roles; the effective permission set is the **union**,
  with the widest scope winning — except for the separation-of-duties rules in
  §4, which are subtractive and always win.

## 2. Enforcement layers

| Layer | Responsibility |
|---|---|
| Navigation | Renders modules where the user holds ≥1 `view` in scope. A user never sees a tab they cannot use. |
| API route guard | Every endpoint declares `(module, verb)`; missing declaration fails CI. |
| Service scope resolver | Converts scope into a predicate (`student_id IN …`) applied to the query, not to the result set. |
| PostgreSQL RLS | Final backstop: policies on every student-scoped table keyed by cohort and hierarchy. A bug in application code cannot leak across cohorts. |
| SoD checker | Subtractive rules evaluated at the point of decision (verify, approve, audit-assign, escalation-resolve). |

Denials are **structured**: `{ required: {module, verb, scope}, actor_scope,
reason_code }`. The UI renders the reason; the server logs it.

## 3. Matrix

Legend: `—` none · `O` own · `T` team · `C` coaching_team · `H` cohort ·
`A` all. A cell lists the verbs available at that scope.

### 3.1 Operational modules

| Module | System Admin | Project Manager | Ops Associate | Team Leader | Ops Coordinator | Coaching Mgr T1/T2 | Coach T1/T2 | Quality Lead | Quality Specialist | Reporting User | Client Viewer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard | view A | view A | view H | view T | view O | view C | view O | view H | view H | view H | view H (masked) |
| My Work | view/edit O | view O | view/edit O | view/edit T | view/edit O | view/edit C | view/edit O | view/edit O | view/edit O | — | — |
| Students | view/create/edit/delete A, export A | view H, export H | view/create/edit H, export H | view/edit T | view/edit O | view C | view O (coaching data only) | view H | view H | view H, export H | view H (masked, aggregate) |
| Communications | view/create/edit A | view H | view/create H | view/create/edit T | view/create/edit O | view C | view O | view H | view H | view H | — |
| Coaching | view/edit A | view H | view/edit H | view T | view O | view/create/edit/assign C | view/create/edit O | view H | view H | view H | — |
| Freelancing | view/edit A | view H | view/create/edit H | view/edit T | view/create/edit O | view C | view/create O | view H | view H | view H | — |
| Gigs | view/edit/approve/reject/override_lock A | view H | view/create/edit H | view/create/edit T | view/create/edit O | view C | view O | view H | view H | view H | — |
| Graduation | view/approve/reject/override_lock A | view/approve/reject H | view/create H (submit) | view/create T (submit) | view/create O (submit) | view C | view O | view H | view H | view H | view H (approved only) |
| Risks | view/create/edit A | view H | view/create/edit H | view/create/edit T | view/create/edit O | view/create C | view/create O (recommend) | view H | view H | view H | — |
| Escalations | view/create/edit/approve A | view/approve H | view/create/edit/approve H | view/create/edit/approve T | view/create O | view/create/edit/approve C | view/create O | view/create H | view/create H | view H | — |
| Quality | view/configure A | view H | view H | view T (own team results) | view O (own results, appeal) | view C | view O (own results, appeal) | **full QA write** H, configure H | **audit write** own audits | view H | — |
| Tasks | view/create/edit/assign A | view H | view/create/assign H | view/create/assign T | view/create/edit O | view/create/assign C | view/create/edit O | view/create O | view/create O | — | — |
| Teams | view/create/edit/assign/reassign A | view H | view/assign/reassign H | view/assign T | view O | view/assign C | view O | view H | view H | view H | — |
| Reports | view/export/configure A | view/export H | view/export H | view/export T | view O | view/export C | view O | view/export H | view H | view/export H | view/export H (approved, masked) |
| Notifications | view/edit/configure A | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O | view/edit O |
| Audit Logs | view_logs A, export A | view_logs H | view_logs H | view_logs T | — | view_logs C | — | view_logs H, export H | view_logs H | — | — |
| Admin | configure A, impersonate A | view H | view H | — | — | — | — | view H (QA config: configure) | — | — | — |

### 3.2 Notes that the table cannot express

- **Quality write isolation.** Quality roles hold broad `view` for auditability
  and **write only on QA objects** (audits, findings, corrective actions,
  scorecards, samples, appeals). No Quality role can `edit` a student,
  communication, gig, coaching session or graduation record — enforced by RLS
  policy on those tables, not only by route guards.
- **Coach data narrowing.** A coach's `view` on Students returns the coaching
  projection of the student record (identity, stage, risk, coaching, action
  items). Communications bodies, gig evidence, graduation review history and QA
  results of other staff are excluded by the projection, not hidden in the UI.
- **Client viewer.** Aggregates and approved reports only. PII masking is
  configuration-driven (register item 13). Row-level export is unavailable
  regardless of report filters.
- **Coordinator peer visibility** is `CONFIG-PENDING` (register item 14):
  default **off**. When enabled it grants `view` at `team` scope on Students
  and Communications only — never `edit`.
- **`impersonate`** is System Admin only, time-boxed, banner-visible, and emits
  an audit event on start and end. All actions taken while impersonating record
  both the real and effective actor.
- **`override_lock`** never grants data creation; it only unlocks an existing
  locked field, and always requires a reason plus a preserved pre-override
  snapshot.

## 4. Separation of duties (subtractive rules)

These are evaluated after the union of role permissions and always win.

| # | Rule | Evaluated at | On violation |
|---|---|---|---|
| SoD-1 | `submitter(gig) ≠ verifier(gig)` | Gig verification decision | Block, structured reason, log |
| SoD-2 | `verifier(any gig in route) ≠ graduation approver`, unless single-approver mode is explicitly enabled by an admin | Graduation approval | Block, structured reason, log |
| SoD-3 | `auditor ∉ {auditee} ∪ direct_reports(auditor)` | QA sampling **and** re-checked at audit start | Reject assignment, resample, log |
| SoD-4 | `escalation.resolver ≠ escalation.approver` when `severity ≥ threshold` (`CONFIG-PENDING`, item 9) | Escalation resolution approval | Block, structured reason, log |
| SoD-5 | Nobody approves a corrective action arising from their own finding against themselves | Corrective action closure | Block, log |

Single-approver mode (SoD-2 exception) is a cohort configuration flag, emits
`CONFIG_CHANGED`, and is **displayed on every graduation record approved under
it** so an external reviewer can see it.

## 5. Testing obligation

The permission matrix is executable. Phase E includes an **exhaustive**
generated test: for every role × every API endpoint, assert allow/deny against
this document. The test is generated from the same table that seeds the
database, so drift between documentation and behaviour is impossible — if a new
endpoint is added without a matrix entry, CI fails.
