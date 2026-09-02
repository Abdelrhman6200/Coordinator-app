# 09 — Workflow Specifications (Phase C)

Each workflow is specified as the full chain:

**Trigger → User → Screen → Action → Validation → Database change → Audit event
→ Task creation → Notification → KPI update → Risk evaluation → Next state →
Next responsible user.**

Every workflow terminates in a defined state (consistency gate requirement).
Every workflow below has a corresponding golden-path integration test in
Phase E.

---

## W01 — Student import

- **Trigger:** operator uploads an intake file.
- **User:** Project Operations Associate / Admin.
- **Screen:** Admin → Import wizard.
- **Action:** Upload → schema validation → business validation preview → error
  report → confirm mode (all-or-nothing | valid rows only) → commit.
- **Validation:** required fields; E.164 phone; email format; track ∈ cohort
  tracks; duplicate `identity_key` (hard); fuzzy duplicate persons (surfaced,
  never auto-merged); invalid assignments; capacity violations.
- **DB:** `import_batch`, `import_row_error`, `student` rows with
  `source_batch_id`; `student_stage_history` at `Imported`.
- **Audit:** `IMPORT_BATCH_COMMITTED`; `STUDENT_IMPORTED` per row.
- **Tasks:** assignment task to Ops per unassigned batch.
- **Notification:** batch complete to uploader; failures to Ops.
- **KPI:** `funnel_stage_count`, `unassigned_students_count`,
  `required_field_completeness`.
- **Risk:** none yet (no contact clock until assignment).
- **Next state:** `Imported`; students appear in the control tower's
  *unassigned* queue.
- **Next user:** Ops Associate (assignment).
- **Reversal:** batch rollback while no downstream events reference its records;
  otherwise refused naming the blocking events.

## W02 — Assignment

- **Trigger:** unassigned students exist.
- **User:** Ops Associate / Team Leader.
- **Screen:** Control tower → unassigned queue, or Students → bulk assign.
- **Action:** assign individually, in bulk, by track, or by capacity.
- **Validation:** coordinator active, in cohort, within `staff_capacity` — over
  capacity requires an explicit override reason.
- **DB:** close prior `student_assignment` row (if any), open a new one;
  update `student.current_stage → Assigned`, `student_stage_history`.
- **Audit:** `STUDENT_ASSIGNED` (+ audit row with `permission_used`).
- **Tasks:** first-contact task to the coordinator, due at the configured
  first-contact deadline.
- **Notification:** "new student assigned" to the coordinator (rate-limited,
  digest-aware).
- **KPI:** `unassigned_students_count`, `students_per_coordinator`,
  `coordinator_over_capacity_count`.
- **Risk:** none.
- **Next state:** `Assigned`.
- **Next user:** Operations Coordinator.

## W03 — Onboarding

- **Trigger:** student responds to first contact.
- **User:** Coordinator. **Screen:** student record → Overview / Journey.
- **Action:** complete the configured onboarding checklist; advance stage.
- **Validation:** checklist complete (configurable); transition guard.
- **DB:** `student_milestone_progress`, stage history → `Onboarded`.
- **Audit:** `STUDENT_STAGE_CHANGED`.
- **Tasks:** coaching-scheduling task to the coaching manager.
- **Notification:** coaching manager.
- **KPI:** funnel counts, conversion, dwell.
- **Risk:** re-evaluate (`behind_milestone` may clear).
- **Next state:** `Onboarded`. **Next user:** Coaching Manager.

## W04 — Coordinator follow-up

- **Trigger:** follow-up task due (SLA engine or sweeper).
- **User:** Coordinator. **Screen:** My Work / Coordinator dashboard queue.
- **Action:** open the row → contact flow.
- **Validation:** task open and owned; student in scope.
- **DB:** (see W05/W07 — the follow-up is completed by the interaction record).
- **Audit:** `FOLLOWUP_COMPLETED`.
- **Tasks:** the next follow-up task is created from the recorded next date.
- **Notification:** none on completion.
- **KPI:** `followup_compliance_rate`, `overdue_followup_count`,
  coordinator scorecard.
- **Risk:** re-evaluate contact-based rules.
- **Next state:** unchanged stage; SLA `compliant`.
- **Next user:** Coordinator (next queue item).

## W05 — Sending a message

- **Trigger:** coordinator initiates contact.
- **User:** Coordinator. **Screen:** contact flow.
- **Action:** channel → purpose → template → send/open → **Record Interaction**.
- **Validation:** outcome, next action, next follow-up date required; follow-up
  snapped to a working period; body stored only with policy + consent.
- **DB (one transaction):** `communication`; `communication_attempt` (window-
  deduplicated); `student.last_contact_at`, `next_action_at`; SLA recomputed;
  follow-up task created/updated.
- **Audit:** `MESSAGE_SENT`, `INTERACTION_RECORDED`, `FOLLOWUP_SCHEDULED`.
- **Tasks:** follow-up; evidence-gap task where configured.
- **Notification:** none to the actor; TL notified only on breach or escalation.
- **KPI:** `days_since_contact_avg`, `contact_attempts_avg`,
  `followup_compliance_rate`, coordinator activity.
- **Risk:** rules re-evaluated; `RISK_CHANGED` if level moves.
- **Next state:** stage → `Contacted` if it was `Assigned`.
- **Next user:** Coordinator, or the student (awaiting reply).
- **Atomicity:** all of the above, or none (AC-02).

## W06 — Receiving a reply

- **Trigger:** integration inbound message, or the coordinator records a reply.
- **User:** system or Coordinator. **Screen:** contact flow / inbox.
- **Action:** record inbound interaction.
- **Validation:** student resolvable from the channel identifier; duplicate
  inbound suppressed by provider message id.
- **DB:** `communication` (inbound); attempt counter reset per config;
  `last_contact_at`.
- **Audit:** `STUDENT_REPLIED`, `INTERACTION_RECORDED`.
- **Tasks:** **auto-cancel** the open "chase unresponsive" task with reason
  `student_replied`; create a response task for the coordinator.
- **Notification:** "student replied" to the coordinator.
- **KPI:** `awaiting_response_count`, `unresponsive_count`.
- **Risk:** unresponsive rules re-evaluated; likely downgrade.
- **Next state:** `Unresponsive` status cleared where applicable.
- **Next user:** Coordinator.

## W07 — Calling a student

As W05 with channel = phone, plus: connect result, duration (required when
connected), topics, challenges. Emits `CALL_LOGGED`. Attempts within the
configured window collapse to a single attempt (AC-03). A `no_answer` outcome
increments the attempt counter and feeds W08.

## W08 — No-response process

- **Trigger:** attempt count reaches a configured threshold (register item 4).
- **User:** system, then Team Leader.
- **Screen:** control tower / TL dashboard.
- **Action:** system flags; TL reviews and decides.
- **Validation:** attempts de-duplicated by window; cool-down respected.
- **DB:** `student.current_status += Unresponsive`; `risk_record` opened or
  raised.
- **Audit:** `RISK_CHANGED` with firing rule and evidence; status change event.
- **Tasks:** TL action task; escalation-recommendation task.
- **Notification:** coordinator and TL.
- **KPI:** `unresponsive_count`, `risk_amber_count` / `risk_red_count`.
- **Risk:** Amber at attempt threshold, Red on repeated failed contact.
- **Next state:** `Unresponsive`; control-tower exception opened.
- **Next user:** Team Leader → Operations (per escalation matrix).

## W09 — Risk identification

- **Trigger:** any student-affecting event, or the hourly risk sweeper.
- **User:** system (or a coordinator recommending manually).
- **Screen:** none (background) / risk record.
- **Action:** evaluate configured risk rules.
- **Validation:** rule enabled and in effect; cooldown respected.
- **DB:** single open `risk_record` updated with level and reasons; evidence,
  `fired_rule_key`, `config_version_id` recorded (Invariant 6).
- **Audit:** `RISK_CHANGED` (before/after, rule, config version, evidence).
- **Tasks:** coordinator task; TL task on Red; intervention-plan task on
  Amber/Red.
- **Notification:** coordinator; TL on Red.
- **KPI:** risk metrics; `risk_time_to_intervention_avg`.
- **Next state:** risk level. **Next user:** Coordinator (+ TL on Red).

## W10 — Risk intervention

- **Trigger:** risk at Amber or Red. **User:** Coordinator / TL.
- **Screen:** risk record → intervention plan.
- **Action:** record risk, root cause, required actions with owners and
  deadlines, next review date, notes.
- **Validation:** ≥1 action with an owner and a due date; review date mandatory.
- **DB:** `intervention`, `intervention_action`; tasks linked.
- **Audit:** `INTERVENTION_CREATED`.
- **Tasks:** one per action, owned and dated.
- **Notification:** each action owner.
- **KPI:** `risk_open_without_intervention` (clears),
  `risk_time_to_intervention_avg`.
- **Next state:** risk `in_intervention`, review scheduled.
- **Next user:** named action owners.

## W11 — Escalation

- **Trigger:** manual raise, or auto on SLA breach at a tier.
- **User:** any operational role with `escalations.create`.
- **Screen:** escalation form (inline from the contact flow, or standalone).
- **Action:** category, severity, description, attachments.
- **Validation:** category and severity valid; routing resolvable; SLA computed
  from the working calendar.
- **DB:** `escalation` (`Open` → `Assigned`), `escalation_action`.
- **Audit:** `ESCALATION_RAISED`, `ESCALATION_ASSIGNED`.
- **Tasks:** to the assignee at the resolved tier.
- **Notification:** assignee and raiser; tier escalation notifies upward.
- **KPI:** `escalations_open`, `escalation_first_response_time`.
- **Risk:** `Escalated` status applied.
- **Next state:** `Assigned`. **Next user:** tier-1 resolver.
- **Resolution:** resolve with reason + notes → closure approval, where
  **SoD-4** requires a different approver at severity ≥ threshold →
  `ESCALATION_RESOLVED`, status `Closed`, risk re-evaluated.

## W12 — Coaching scheduling

- **Trigger:** student enters `Coaching`, or a session cadence falls due.
- **User:** Coach / Coaching Manager. **Screen:** coaching calendar.
- **Action:** schedule a session.
- **Validation:** coach assigned to the student for that type; no double
  booking; within `max_sessions_per_week`.
- **DB:** `coaching_session` (`Scheduled`).
- **Audit:** `COACHING_SCHEDULED`. **Tasks:** session task to the coach.
- **Notification:** coach, student (where a channel is configured), coordinator.
- **KPI:** `sessions_planned`, `students_without_coaching_count` (clears).
- **Next state:** `Scheduled`. **Next user:** Coach.

## W13 — Coaching completion

- **Trigger:** session time passes. **User:** Coach.
- **Screen:** session detail.
- **Action:** record attendance, objective, topics, challenges, notes, action
  items, next session, risk/escalation recommendations, attachments.
- **Validation:** **notes required to reach `Completed`**; action items require
  assignee and due date.
- **DB:** `coaching_session` → `Completed`; `coaching_action_item`.
- **Audit:** `COACHING_COMPLETED`, `COACH_ACTION_CREATED`.
- **Tasks:** one per staff-assigned action item; a documentation task if notes
  are deferred.
- **Notification:** action owners; coordinator on a risk recommendation.
- **KPI:** `session_completion_rate`, `attendance_rate`,
  `missing_session_notes_count`, `coach_action_completion_rate`.
- **Risk:** re-evaluated on the recommendation signal.
- **Next state:** `Completed`. **Next user:** action owners.

## W14 — Missed coaching

- **Trigger:** session not completed by its window, or marked missed.
- **User:** Coach (or the sweeper). **Screen:** session detail / missed queue.
- **Action:** mark `Missed by student` / `Missed by coach` / `No-show` /
  `Cancelled` / `Rescheduled` with a reason code.
- **Validation:** reason code mandatory; reschedule requires a new date.
- **DB:** session status; `rescheduled_from_id` on a reschedule.
- **Audit:** `COACHING_MISSED`.
- **Tasks:** re-schedule task; coordinator outreach task on student-missed.
- **Notification:** coaching manager; coordinator.
- **KPI:** `missed_by_student_count`, `missed_by_coach_count`,
  `coach_utilization`.
- **Risk:** `missed_coaching` rule evaluated → Amber at threshold
  (register item 5).
- **Next state:** `Missed*` / `Rescheduled`. **Next user:** Coach or
  Coordinator.

## W15 — Freelance readiness

- **Trigger:** readiness milestone criteria met.
- **User:** Coordinator / Coach. **Screen:** Journey / Freelancing progress.
- **Action:** mark the readiness milestone achieved with evidence.
- **Validation:** required evidence present per milestone config.
- **DB:** `student_milestone_progress`; stage → `Freelance Ready`.
- **Audit:** milestone + `STUDENT_STAGE_CHANGED`.
- **Tasks:** first-activity tasks (profile, portfolio, proposals).
- **Notification:** coordinator, coach.
- **KPI:** `readiness_rate`, funnel conversion and dwell.
- **Risk:** `no_freelance_activity` clock starts.
- **Next state:** `Freelance Ready`. **Next user:** Coordinator.

## W16 — Freelancing activity

- **Trigger:** the student does something on a platform.
- **User:** Coordinator / Coach / Ops. **Screen:** activity log.
- **Action:** log activity: type, date, platform, result, evidence, notes.
- **Validation:** type ∈ cohort activity types; evidence where the type requires
  it.
- **DB:** `freelance_activity`.
- **Audit:** `FREELANCE_ACTIVITY_LOGGED`.
- **Tasks:** next-step task per the configured progression.
- **KPI:** activity, proposal, response, interview, offer metrics.
- **Risk:** `no_freelance_activity` re-evaluated (likely clears).
- **Graduation:** progress recomputed.
- **Next state:** `Active Freelancing` on the first qualifying activity.
- **Next user:** Coordinator.

## W17 — Gig submission

- **Trigger:** the student wins/completes a gig.
- **User:** Coordinator / Coach. **Screen:** gig submission.
- **Action:** enter gig details and attach work and payment evidence; submit.
- **Validation:** amount > 0; date ordering; FX rate resolvable for the
  reference date; ≥1 work evidence; files hashed at upload.
- **DB:** `gig` (`Submitted`), `gig_evidence` with `content_hash`,
  `fx_rate_id`, `amount_base`.
- **Audit:** `GIG_SUBMITTED`.
- **Tasks:** verification task to the verification pool with its SLA.
- **Notification:** verification pool.
- **KPI:** `gigs_submitted`, `gigs_pending_verification`.
- **Graduation:** recomputed (submitted gigs do not count as verified).
- **Next state:** stage → `Gig Progress`; gig `Submitted`.
- **Next user:** Verifier (**never the submitter** — SoD-1).

## W18 — Gig verification

- **Trigger:** gig in `Submitted`. **User:** Verifier / Ops.
- **Screen:** gig verification.
- **Action:** review identity, gig details, work evidence, payment evidence,
  value, dates, graduation relevance, duplicate warning; decide.
- **Validation:** **SoD-1** reviewer ≠ submitter (UI absent, server blocks,
  attempt logged); evidence hashes re-verified; duplicate warning must be
  acknowledged.
- **DB:** `gig.verification_status` → `Approved`; `gig_review`; critical fields
  **locked**.
- **Audit:** `GIG_APPROVED` with reason code.
- **Tasks:** verification task completed; graduation review task if the approval
  makes the student eligible.
- **Notification:** submitter, coordinator; ops on eligibility.
- **KPI:** `gigs_approved`, `gig_approval_rate`,
  `gig_verification_cycle_time`, `verified_revenue_total`.
- **Risk:** `gig_verification_failure` re-evaluated.
- **Graduation:** recomputed; may emit `GRADUATION_ELIGIBLE`.
- **Next state:** `Approved` (locked). **Next user:** Coordinator or Verifier.

## W19 — Gig rejection / more evidence

- **Action:** `Reject` or `Request Additional Evidence`, each requiring a
  **structured reason code plus free text**.
- **DB:** status → `Rejected` | `More Evidence Required`; `gig_review`.
- **Audit:** `GIG_REJECTED` | `GIG_EVIDENCE_REQUESTED`.
- **Tasks:** remediation/evidence task to the submitter with an SLA.
- **Notification:** submitter and coordinator.
- **KPI:** `gigs_rejected`, `gig_approval_rate`.
- **Risk:** `gig_verification_failure` may fire at the configured count.
- **Graduation:** recomputed downward.
- **Next state:** `Rejected` (terminal) or back to `Submitted` on resubmission.
- **Next user:** Submitter.

## W20 — Graduation eligibility

- **Trigger:** gig approval, activity, milestone change, config publication, or
  the nightly sweep.
- **User:** system. **Screen:** none (background).
- **Action:** evaluate every route's criteria.
- **Validation:** pure evaluation against the in-force `config_version_id`.
- **DB:** `graduation_progress` (status, matched route, per-criterion
  evaluation, **plain-language gap**, config version).
- **Audit:** `GRADUATION_ELIGIBLE` on reaching `Eligibility Met`.
- **Tasks:** submission task to the coordinator; review task to ops.
- **Notification:** coordinator, ops, PM digest.
- **KPI:** `eligible_count`, funnel, forecast inputs.
- **Next state:** `Eligibility Met`. **Next user:** Coordinator (submission).

## W21 — Graduation review (submission → verification)

- **User:** Coordinator submits; Verifier reviews.
- **Screen:** graduation tab → review queue.
- **Action:** submit evidence package; verifier checks each criterion against
  its evidence.
- **Validation:** engine reports `eligibility_met` (or an explicit override with
  a reason); required evidence attached.
- **DB:** status → `Pending Verification`; `graduation_review` rows.
- **Audit:** `GRADUATION_SUBMITTED`.
- **Tasks:** approval task to an authorised approver.
- **Notification:** approver.
- **KPI:** `pending_verification_count`.
- **Next state:** `Pending Verification`. **Next user:** Approver.

## W22 — Graduation approval

- **User:** authorised approver (`graduation.approve`).
- **Screen:** graduation approval.
- **Action:** approve with a mandatory reason code.
- **Validation:** engine **re-confirms** at approval time; **SoD-2** approver ≠
  verifier of the backing gigs unless documented single-approver mode is on;
  re-authentication required.
- **DB:** status → `Approved Graduate`; **record locked**;
  `graduation_snapshot` written; stage → `Graduated`.
- **Audit:** `GRADUATION_APPROVED` with config version and the SoD result.
- **Tasks:** close open student tasks with reason `graduated`.
- **Notification:** coordinator, TL, PM.
- **KPI:** `graduation_rate`, funnel, forecast.
- **Next state:** `Graduated` (terminal). **Next user:** none (PM reporting).

## W23 — Graduation reversal

- **Trigger:** an error or a fraud finding is discovered.
- **User:** elevated role (`graduation.override_lock` + `graduation.approve@all`).
- **Screen:** graduation record → Reverse.
- **Action:** reverse with a mandatory reason code and free text; re-auth.
- **Validation:** elevated permission; reason mandatory.
- **DB:** **immutable snapshot of the pre-reversal state preserved**; status →
  `Returned for Review`; record unlocked; stage regressed.
- **Audit:** `GRADUATION_REVERSED`.
- **Tasks:** review task to ops; QA audit task.
- **Notification:** PM, ops, coordinator, QA.
- **KPI:** `graduation_rate` recomputed; historical as-of figures unchanged.
- **Next state:** `Returned for Review`. **Next user:** Ops.

## W24 — QA sampling

- **Trigger:** a QA cycle opens, or a targeted request.
- **User:** Quality Lead. **Screen:** Quality → sampling.
- **Action:** choose method, define the population and filter, set size, draw.
- **Validation:** **SoD-3** at draw; rejections resampled from the same seeded
  stream.
- **DB:** `qa_sample` storing method, population definition, filter, **seed**,
  timestamp and drawer; `qa_audit` rows assigned.
- **Audit:** `QA_SAMPLE_DRAWN`, `QA_AUDIT_ASSIGNED`.
- **Tasks:** audit tasks to auditors with due dates.
- **Notification:** auditors.
- **KPI:** `qa_coverage_rate`.
- **Next state:** audits `assigned`. **Next user:** Quality Specialists.
- **Defensibility:** the sample is reproducible from its stored seed (AC-17).

## W25 — QA audit

- **User:** Quality Specialist. **Screen:** audit execution.
- **Action:** score each question with comments and evidence; submit.
- **Validation:** SoD-3 re-checked at start; all questions answered; auto-fail
  questions force an overall `Fail`.
- **DB:** `qa_audit` (score, result, `scorecard_version_id`),
  `qa_audit_answer`.
- **Audit:** `QA_AUDIT_COMPLETED`.
- **Tasks:** finding tasks where raised.
- **Notification:** auditee and their manager.
- **KPI:** `qa_score_avg`, `qa_failure_rate`, `qa_coverage_rate`,
  performance scorecards.
- **Next state:** `completed`. **Next user:** auditee / Quality Lead.

## W26 — QA failure & finding

- **Trigger:** an audit produces a failing question or an overall `Fail`.
- **User:** Quality Specialist raises; Quality Lead oversees.
- **Action:** raise a finding with category, severity, description, evidence.
- **DB:** `qa_finding` (`Open`).
- **Audit:** `QA_FINDING_RAISED`.
- **Tasks:** corrective-action creation task to the auditee's manager.
- **Notification:** auditee, manager, Quality Lead.
- **KPI:** `qa_findings_by_category`, `qa_repeat_failure_rate`.
- **Next state:** `Open`. **Next user:** manager.
- **Appeal path:** the auditee may raise `qa_appeal`; the dispute, reviewer and
  outcome are recorded and feed back into the score.

## W27 — Corrective action

- **User:** manager / action owner. **Screen:** corrective action.
- **Action:** record root cause, required action, owner, manager, due date;
  progress to `Implemented` with evidence.
- **Validation:** evidence required to mark implemented.
- **DB:** `corrective_action`.
- **Audit:** `CORRECTIVE_ACTION_CREATED`, then status changes.
- **Tasks:** action task; re-audit task where required.
- **Notification:** owner, manager, Quality Lead.
- **KPI:** `corrective_actions_open`, `corrective_actions_overdue`.
- **Next state:** `Implemented` → `Re-audit Required` or `Closed`.
- **Closure rule:** the underlying finding cannot close without evidence, or an
  explicit Quality Lead waiver with a reason (AC-16).

## W28 — Re-audit

- **Trigger:** a corrective action requires re-audit.
- **User:** Quality Specialist (SoD-3 applies). **Screen:** audit execution.
- **Action:** re-audit the same subject against the same scorecard version.
- **DB:** `re_audit` linked to the corrective action and the new audit.
- **Audit:** `RE_AUDIT_COMPLETED`, `CORRECTIVE_ACTION_CLOSED` on pass.
- **KPI:** `re_audit_pass_rate`, `qa_repeat_failure_rate`.
- **Next state:** corrective action `Closed`, or reopened.
- **Next user:** Quality Lead.

## W29 — Staff reassignment

- **Trigger:** rebalancing, departure, performance, or absence.
- **User:** TL / Ops. **Screen:** Teams → allocation.
- **Action:** reassign one or many students.
- **Validation:** target active and within capacity, or an override reason.
- **DB:** close and open `student_assignment` rows; **open tasks and open
  escalations carried over**, each with its own audit row.
- **Audit:** `STUDENT_REASSIGNED` plus a per-item audit entry.
- **Tasks:** reassigned, not recreated (no duplicate work, no lost work).
- **Notification:** both coordinators and the TL.
- **KPI:** workload, capacity, and — via effective dating — historical
  attribution stays with the previous owner (AC-18).
- **Next state:** unchanged stage. **Next user:** new coordinator.

## W30 — Staff absence & delegation

- **Trigger:** absence recorded. **User:** TL / Ops.
- **Screen:** Teams → capacity & absence.
- **Action:** record absence dates and reason; optionally delegate with an
  **end date**.
- **Validation:** delegate active and within capacity; end date required.
- **DB:** `staff_absence`, `delegation`.
- **Audit:** `STAFF_ABSENCE_RECORDED`, `DELEGATION_STARTED`.
- **Tasks:** delegated tasks surface in the delegate's queue, marked as
  delegated.
- **Notification:** delegate, TL.
- **KPI:** `staff_absent_with_unowned_students` — an exception queue on the
  control tower where there is no delegation.
- **Next state:** absence active. **Next user:** delegate.
- **Expiry:** `DELEGATION_ENDED` returns ownership automatically.

## W31 — Student withdrawal / exclusion

- **Trigger:** student withdraws, or is excluded.
- **User:** Coordinator (withdrawal, `team` scope) / Ops (exclusion, `cohort`).
- **Screen:** student record → change stage.
- **Action:** withdraw or exclude with a **mandatory reason code**.
- **Validation:** reason code from the configured list; exclusion requires free
  text as well.
- **DB:** terminal state; open tasks closed with reason; open escalations
  reviewed; `graduation_progress` recomputed under the cohort's
  **denominator policy**, and the policy applied is stored on the record.
- **Audit:** `STUDENT_WITHDRAWN` | `STUDENT_EXCLUDED`.
- **Notification:** TL, Ops, PM digest.
- **KPI:** `graduation_rate` denominator changes **visibly and explainably** —
  register item 2 governs whether it changes at all.
- **Next state:** `Withdrawn` / `Excluded` (terminal). **Next user:** none.

## W32 — Cohort closure

- **Trigger:** cohort end date reached, or a PM decision.
- **User:** PM / Admin. **Screen:** Admin → cohorts.
- **Action:** close the cohort.
- **Validation:** open escalations, pending verifications and eligible-unapproved
  students are listed and must be resolved or explicitly waived with a reason.
- **DB:** cohort → `Closed`; core operational records **read-only**.
- **Audit:** `COHORT_CLOSED`.
- **Tasks:** all open tasks closed with reason `cohort_closed`.
- **Notification:** all cohort staff.
- **KPI:** final `graduation_rate` snapshot taken and stored.
- **Next state:** `Closed` → `Archived`. **Next user:** Admin.
- **Override:** editing a closed cohort requires elevated permission, a reason,
  an audit event and a preserved snapshot.

## W33 — Cohort configuration clone

- **Trigger:** a new cohort is being launched.
- **User:** Admin. **Screen:** Admin → cohorts → clone.
- **Action:** one click: clone every configuration area from a source cohort.
- **Validation:** target code unique; the clone is created in `Draft`.
- **DB:** new `cohort`, new `cohort_config_version` with copied `config_item`
  rows across every area, zero students.
- **Audit:** `COHORT_CONFIG_CLONED`, `CONFIG_CHANGED`.
- **KPI:** none.
- **Next state:** `Draft`. **Next user:** Admin (adjust rules, then activate).
- **This is the reusability test (AC-24):** a new cohort with different
  graduation rules must launch **by configuration alone**, with no code change.
