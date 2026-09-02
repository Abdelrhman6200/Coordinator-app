# 12 — Open Decisions Register

**Nothing here is invented.** Every item ships as versioned configuration with a
conservative default and a visible `CONFIG-PENDING` badge in the Admin panel and
everywhere its value is used. This register is a living document **and** a
first-class Admin screen, so the programme owner sees the same list the
engineering team does.

**Conservative default** means: the default that produces the least irreversible
action and the most visibility. Where a choice affects the headline KPI, the
default surfaces the choice rather than hiding it.

| # | Item | Why it matters | Options | Default implemented | Owner | Status | Date needed |
|---|---|---|---|---|---|---|---|
| 1 | **Exact graduation criteria** — gig count, per-gig value floor, revenue threshold, evidence standard, route logic | Defines the primary KPI. Every graduation number in the system is meaningless until this is set | Single route on gig count · dual route (count OR count+revenue) · count + revenue + evidence grade | Two-route skeleton with thresholds **unset**; engine reports `Not Eligible` and states "graduation criteria not yet configured" rather than guessing | Programme owner | **Open** | Before first student reaches `Gig Progress` |
| 2 | **Withdrawn/excluded in the 85% denominator?** | Moves the headline rate by several points without any operational change | Include all · exclude withdrawn · exclude withdrawn and excluded · exclude only pre-onboarding exits | **Include all** (most conservative — the rate cannot be flattered), with the applied policy stamped on every graduation record and shown beside the KPI | PM | **Open** | Before the first PM review |
| 3 | **SLA follow-up frequency** per stage and per risk level | Drives every coordinator's workload and every compliance number | Uniform · per stage · per stage × risk × track | Per stage × risk, seeded loosely (Green 7 working days, Amber 3, Red 1) and badged pending | Operations | **Open** | Before coordinator go-live |
| 4 | **Unresponsive attempt threshold and cool-down window** | Determines when a student is declared unresponsive and de-dupes attempt inflation | 3 attempts / 5 / configurable per stage; window 4h / 24h / per channel | 3 attempts, 24-hour de-duplication window, 48-hour cool-down | Operations | **Open** | Before coordinator go-live |
| 5 | **Missed-coaching thresholds for Amber/Red** | Drives coaching risk and intervention load | 1/2 · 2/3 · rolling window variants | 2 missed → Amber, 3 → Red, 30-day rolling window | Coaching Manager | **Open** | Before coaching starts |
| 6 | **Milestone dates per track and per cohort** | Every "behind milestone" risk and the forecast's feasibility factor depend on these | Absolute dates · offsets from cohort start · offsets from stage entry | Offsets from cohort start, seeded empty; no milestone risk fires until set | Programme owner | **Open** | Before cohort activation |
| 7 | **QA sampling coverage target and audit frequency per role** | Determines QA staffing and whether coverage claims are defensible | % of interactions · fixed count per staff per period · risk-weighted | 10% risk-weighted per cycle, monthly cycles | Quality Lead | **Open** | Before the first QA cycle |
| 8 | **QA pass / needs-improvement / fail score bands** | Determines failure rate, corrective-action volume, and performance scores | 90/75 · 85/70 · per-scorecard bands | 85 / 70, per scorecard version, with auto-fail questions overriding | Quality Lead | **Open** | Before the first QA cycle |
| 9 | **Escalation SLA per severity and per category**, and the **SoD-4 severity threshold** | Determines tier advancement and who may approve a resolution | Uniform · per severity · per category × severity | Per severity (S1 4h / S2 1 working day / S3 3 working days); SoD-4 applies at S1–S2 | Operations | **Open** | Before escalations go live |
| 10 | **Accepted evidence standard for gigs and for payment** | Determines what a verifier may approve, and therefore what a graduation means | Screenshot · platform export · bank/payment record · client confirmation · combinations | Work evidence **and** payment evidence both required, type unconstrained pending decision; verifier reason codes capture what was accepted | Quality Lead + PM | **Open** | Before the first verification |
| 11 | **Currency handling and FX source** | Determines verified-revenue figures and their auditability | Fixed programme rate · daily rate at gig date · daily rate at payment date; source: central bank / commercial feed | Rate **dated at payment date**, stored per gig with its `fx_rate_id`; source configured, seeded manual | Finance / PM | **Open** | Before the first non-base-currency gig |
| 12 | **Coach capacity, coordinator caseload cap, coaching frequency per type** | Drives allocation, over-capacity exceptions and utilization metrics | Hard cap · soft cap with override · no cap | Soft cap with a mandatory override reason; caps seeded empty (no cap enforced until set) | Operations + Coaching Managers | **Open** | Before allocation |
| 13 | **Data retention period and PII masking policy for client-facing reports** | Legal exposure and what a client viewer can see | Mask all PII · mask contact details only · pseudonymised IDs · full | **Mask all PII** for client viewers; retention seeded to the maximum pending legal input | Programme owner + Legal | **Open** | Before any client report is shared |
| 14 | **May coordinators see peers' students (read-only)?** | Affects privacy posture and cover during absence | Off · read-only within team · read-only within cohort | **Off**; temporary delegation covers absence instead | Operations | **Open** | Before coordinator go-live |

## Additional items raised by this design

These emerged from specification work and need the same treatment.

| # | Item | Why it matters | Default implemented | Owner |
|---|---|---|---|---|
| 15 | Message-body storage and student consent | Determines whether WhatsApp/email bodies may be stored at all | Bodies **not stored** unless policy permits and per-student consent is recorded | Legal + Programme owner |
| 16 | Single-approver mode for graduation | Weakens SoD-2; may be operationally necessary at small scale | **Disabled**; if enabled, stamped visibly on every record approved under it | PM |
| 17 | Does `Awaiting Information` pause the escalation SLA? | Pausing can be abused to hide slow cases | **Does not pause** | Operations |
| 18 | Backwards lifecycle transitions permitted? | Affects funnel integrity and dwell metrics | Ops/Admin only, mandatory reason | Operations |
| 19 | Working calendar: weekends, hours, holiday list per cohort | Every SLA computation depends on it | Fri–Sat weekend, 09:00–17:00 cohort timezone, holiday list **empty pending input** | Operations |
| 20 | Caseload difficulty index definition | Performance scores are unfair without it, and arbitrary with a bad one | Track + intake risk + starting stage, equal weights; un-normalised score always shown alongside | PM + Operations |
| 21 | Notification rate limits and digest defaults | Determines whether staff trust notifications or ignore them | Max 1 per `(user, trigger, student)` per hour; daily digest for non-urgent | Operations |
| 22 | Forecast observation window and feasibility factor | Changes the forecast materially | 30-day rolling window; feasibility factor **0** for stages that cannot complete in the remaining time (conservative) | PM |

## Working rule

An item on this register is never resolved by an engineering assumption. If a
decision is needed to unblock work, the default is implemented, badged, and the
item is escalated with a date needed — it is not quietly closed.
