-- ============================================================================
-- 0002 DEPI Round 5: groups as first-class objects, sessions and attendance,
-- the internal-service pipeline, the four-stage evidence pipeline, immutable
-- Quality decisions, complaints, entrepreneurship, and the computed graduation
-- record.
--
-- As in 0001, the properties that matter are the ones enforced HERE: a coach
-- cannot be double-booked, a Quality decision cannot be edited, a rejection
-- cannot silently close, and graduation cannot be typed in.
-- ============================================================================

-- A CHECK constraint may not contain a subquery, so key counting needs an
-- IMMUTABLE helper. Pairing it with the `?&` operator makes the constraint
-- stricter than a count alone: it names the exact keys required.
CREATE OR REPLACE FUNCTION jsonb_key_count(doc jsonb) RETURNS int AS $$
  SELECT count(*)::int FROM jsonb_object_keys(doc);
$$ LANGUAGE sql IMMUTABLE STRICT;

-- ---------------------------------------------------------------------------
-- Provider and pathway (§6, §23)
-- ---------------------------------------------------------------------------

CREATE TABLE provider (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  code      text NOT NULL,          -- YAT / HRV / EUI
  name      text NOT NULL,
  UNIQUE (cohort_id, code)
);

-- ---------------------------------------------------------------------------
-- Groups: the main operational unit (§8), not an attribute of a student.
-- ---------------------------------------------------------------------------

CREATE TABLE cohort_group (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id              uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  code                   text NOT NULL,
  track_id               uuid REFERENCES track(id),
  provider_id            uuid REFERENCES provider(id),
  pathway                text CHECK (pathway IN ('outcome','support','entrepreneurship')),
  start_date             date,
  end_date               date,
  slot_key               text,
  -- The cohort is ROLLING, not a synchronised batch: progress is measured
  -- against the group's own journey position, never calendar elapsed time.
  current_session_number int  NOT NULL DEFAULT 0,
  planned_session_count  int  NOT NULL DEFAULT 8,
  coordinator_user_id    uuid REFERENCES app_user(id),
  supervisor_user_id     uuid REFERENCES app_user(id),
  coach_user_id          uuid REFERENCES app_user(id),
  risk_classification    text NOT NULL DEFAULT 'on_track'
                           CHECK (risk_classification IN ('on_track','delayed','critical')),
  UNIQUE (cohort_id, code),
  CONSTRAINT group_session_position CHECK (current_session_number BETWEEN 0 AND planned_session_count)
);

ALTER TABLE student
  ADD COLUMN cohort_group_id uuid REFERENCES cohort_group(id),
  ADD COLUMN provider_id     uuid REFERENCES provider(id),
  ADD COLUMN pathway         text CHECK (pathway IN ('outcome','support','entrepreneurship'));

CREATE INDEX student_group_idx ON student (cohort_group_id);

-- Pathway designation is a decision with an owner and a reason (§23), not a
-- field edit. The previous value is preserved so a change is always explicable.
CREATE TABLE pathway_designation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_group_id  uuid NOT NULL REFERENCES cohort_group(id) ON DELETE CASCADE,
  pathway          text NOT NULL CHECK (pathway IN ('outcome','support','entrepreneurship')),
  previous_pathway text,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid NOT NULL REFERENCES app_user(id),
  reason           text NOT NULL,
  input_data       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Coach specialisation, sessions, attendance (§16-§20)
-- ---------------------------------------------------------------------------

CREATE TABLE coach_specialisation (
  coach_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  track_id      uuid NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  PRIMARY KEY (coach_user_id, track_id)
);

CREATE TABLE session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_group_id   uuid NOT NULL REFERENCES cohort_group(id) ON DELETE CASCADE,
  track_id          uuid REFERENCES track(id),
  coach_user_id     uuid REFERENCES app_user(id),
  session_number    int  NOT NULL,
  scheduled_date    date NOT NULL,
  slot_key          text NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','delivered','not_delivered','cancelled',
                                        'replacement_needed','standby_activated')),
  coach_confirmed   text CHECK (coach_confirmed IN ('confirmed','not_confirmed','replacement_needed')),
  confirmed_at      timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  notes             text,
  UNIQUE (cohort_group_id, session_number)
);

-- A coach cannot deliver two groups on the same day: the three Ministry slots
-- (5-8, 6-9, 7-10 PM) overlap, so same-day is same-time in practice. Cancelled
-- sessions are excluded, otherwise a cancellation could not be replaced.
CREATE UNIQUE INDEX session_coach_one_per_day
  ON session (coach_user_id, scheduled_date)
  WHERE coach_user_id IS NOT NULL AND status <> 'cancelled';

-- Track specialisation: a coach may not be assigned outside their track (§17).
CREATE OR REPLACE FUNCTION session_coach_track_check() RETURNS trigger AS $$
BEGIN
  IF NEW.coach_user_id IS NULL OR NEW.track_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM coach_specialisation
    WHERE coach_user_id = NEW.coach_user_id AND track_id = NEW.track_id
  ) THEN
    RAISE EXCEPTION
      'coach % is not specialised in the track of this session', NEW.coach_user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER session_coach_track
  BEFORE INSERT OR UPDATE ON session
  FOR EACH ROW EXECUTE FUNCTION session_coach_track_check();

CREATE TABLE attendance (
  session_id uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  state      text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('attended','late','absent','excused','pending')),
  recorded_at timestamptz,
  recorded_by uuid REFERENCES app_user(id),
  PRIMARY KEY (session_id, student_id)
);

-- A session cannot be marked delivered without attendance recorded (§67).
CREATE OR REPLACE FUNCTION session_delivery_requires_attendance() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
    IF EXISTS (SELECT 1 FROM attendance WHERE session_id = NEW.id AND state = 'pending') THEN
      RAISE EXCEPTION
        'session % cannot be marked delivered while attendance is still pending', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER session_delivery_attendance
  BEFORE UPDATE ON session
  FOR EACH ROW EXECUTE FUNCTION session_delivery_requires_attendance();

-- ---------------------------------------------------------------------------
-- Contact attempts (§13-§15): multi-channel, and "not contacted" is a different
-- fact from "contacted, no response".
-- ---------------------------------------------------------------------------

CREATE TABLE interaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text UNIQUE,
  student_id      uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  staff_user_id   uuid NOT NULL REFERENCES app_user(id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  channel         text NOT NULL CHECK (channel IN ('whatsapp','phone','email','sms','other')),
  purpose         text NOT NULL,
  outcome         text NOT NULL
                    CHECK (outcome IN ('responded','no_response','waiting_for_response',
                                       'callback_required','issue_identified',
                                       'student_needs_support','incorrect_contact_data')),
  graduation_position text,
  blocking_factor     text,
  agreed_action       text,
  action_deadline     timestamptz,
  escalation_required boolean NOT NULL DEFAULT false,
  notes               text,
  client_dedup_key    text
);

CREATE INDEX interaction_student_time_idx ON interaction (student_id, occurred_at DESC);

CREATE TABLE contact_attempt (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  interaction_id uuid REFERENCES interaction(id) ON DELETE SET NULL,
  attempt_no     int  NOT NULL,
  channel        text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  -- De-duplication is per channel: five WhatsApp messages in a morning are one
  -- channel's worth of effort, not five attempts to reach a person.
  window_key     text NOT NULL,
  UNIQUE (student_id, channel, window_key)
);

ALTER TABLE student
  ADD COLUMN last_successful_contact_at timestamptz,
  ADD COLUMN unresponsive_set_at        timestamptz,
  ADD COLUMN unresponsive_set_by        uuid REFERENCES app_user(id),
  ADD COLUMN unresponsive_override_reason text;

-- ---------------------------------------------------------------------------
-- Withdrawal (§43): only the Ministry decides; the project records it.
-- ---------------------------------------------------------------------------

CREATE TABLE withdrawal (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         uuid NOT NULL UNIQUE REFERENCES student(id) ON DELETE CASCADE,
  withdrawn_on       date NOT NULL,
  reason             text NOT NULL,
  -- A withdrawal without a Ministry reference is not a withdrawal, it is an
  -- assumption. The record is never deleted; the student stays in the system.
  ministry_reference text NOT NULL,
  source_document    text,
  previous_status    text NOT NULL,
  recorded_by        uuid NOT NULL REFERENCES app_user(id),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ministry_reference_not_blank CHECK (btrim(ministry_reference) <> '')
);

-- ---------------------------------------------------------------------------
-- Freelancing gigs and internal services (§25-§29)
-- ---------------------------------------------------------------------------

CREATE TABLE gig (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  source                text NOT NULL,
  is_direct_client      boolean NOT NULL DEFAULT false,
  client_identifier     text,
  title                 text NOT NULL,
  description           text,
  track_id              uuid REFERENCES track(id),
  value_amount          numeric(18,4) NOT NULL CHECK (value_amount >= 0),
  currency              text NOT NULL DEFAULT 'USD',
  -- The amount shown in evidence counts; platform fees are not deducted (§28).
  value_toward_graduation numeric(18,4),
  started_on            date,
  delivered_on          date,
  paid_on               date,
  quality_accepted      boolean NOT NULL DEFAULT false,
  locked_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gig_dates_ordered CHECK (
    (delivered_on IS NULL OR started_on IS NULL OR delivered_on >= started_on) AND
    (paid_on IS NULL OR delivered_on IS NULL OR paid_on >= delivered_on)
  ),
  -- A gig counts only if delivered AND paid AND evidenced AND Quality-accepted
  -- (§30). The first three are asserted here; acceptance comes from Quality.
  CONSTRAINT gig_accepted_requires_delivery_and_payment CHECK (
    quality_accepted = false OR (delivered_on IS NOT NULL AND paid_on IS NOT NULL)
  )
);

CREATE INDEX gig_student_idx ON gig (student_id);

CREATE TABLE service (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  cohort_group_id    uuid REFERENCES cohort_group(id),
  support_coach_id   uuid REFERENCES app_user(id),
  service_index      int  NOT NULL CHECK (service_index BETWEEN 1 AND 3),
  description        text,
  skill_category     text,
  fixed_value        numeric(18,4) NOT NULL DEFAULT 5,
  expected_wave      int,
  started_on         date,
  due_on             date,
  delivered_on       date,
  state              text NOT NULL DEFAULT 'not_assigned'
                       CHECK (state IN ('not_assigned','selected','started','in_progress',
                                        'delivered','evidence_submitted','coach_approved',
                                        'l1_passed','quality_review','accepted',
                                        'rejected','correction','resubmitted')),
  rejection_code     text,
  rejected_at        timestamptz,
  correction_owner   uuid REFERENCES app_user(id),
  resubmitted_at     timestamptz,
  accepted_at        timestamptz,
  -- Three services per student (§25).
  UNIQUE (student_id, service_index),
  -- A rejected service is NOT closed by the rejection (§25): acceptance is the
  -- only terminal state, so a rejected row may never carry an acceptance date.
  CONSTRAINT rejected_service_not_accepted CHECK (
    state <> 'rejected' OR accepted_at IS NULL
  ),
  CONSTRAINT rejection_requires_code CHECK (
    state <> 'rejected' OR rejection_code IS NOT NULL
  ),
  CONSTRAINT accepted_requires_timestamp CHECK (
    state <> 'accepted' OR accepted_at IS NOT NULL
  )
);

-- ---------------------------------------------------------------------------
-- Evidence pipeline (§31): four stages, each with received, assignee, due,
-- completed, SLA state, decision and notes.
-- ---------------------------------------------------------------------------

CREATE TABLE evidence_submission (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text UNIQUE,
  student_id          uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  submitted_by        uuid NOT NULL REFERENCES app_user(id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  subject_type        text NOT NULL CHECK (subject_type IN ('gig','service','entrepreneurship')),
  gig_id              uuid REFERENCES gig(id),
  service_id          uuid REFERENCES service(id),
  current_stage       text NOT NULL DEFAULT 'coach'
                        CHECK (current_stage IN ('coach','l1','l2','l3','accepted','withdrawn')),
  -- An open submission has NOT left the pipeline. Rejection sets stage back to
  -- a correction loop; only acceptance closes it.
  is_open             boolean NOT NULL DEFAULT true,
  rejection_count     int  NOT NULL DEFAULT 0,
  accepted_at         timestamptz,
  CONSTRAINT evidence_subject_matches CHECK (
    (subject_type = 'gig'     AND gig_id IS NOT NULL     AND service_id IS NULL) OR
    (subject_type = 'service' AND service_id IS NOT NULL AND gig_id IS NULL) OR
    (subject_type = 'entrepreneurship' AND gig_id IS NULL AND service_id IS NULL)
  ),
  CONSTRAINT accepted_evidence_is_closed CHECK (
    (accepted_at IS NULL) = (current_stage <> 'accepted')
  ),
  CONSTRAINT closed_only_when_accepted_or_withdrawn CHECK (
    is_open = true OR current_stage IN ('accepted','withdrawn')
  )
);

CREATE INDEX evidence_open_stage_idx ON evidence_submission (current_stage, submitted_at)
  WHERE is_open;

CREATE TABLE evidence_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES evidence_submission(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  file_ref      text NOT NULL,
  -- Hash at upload so a silent replacement after review is detectable (§71).
  content_hash  bytea NOT NULL,
  file_name     text,
  size_bytes    bigint,
  uploaded_by   uuid NOT NULL REFERENCES app_user(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

CREATE INDEX evidence_file_hash_idx ON evidence_file (content_hash);

CREATE TABLE evidence_review (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES evidence_submission(id) ON DELETE CASCADE,
  stage          text NOT NULL CHECK (stage IN ('coach','l1')),
  reviewer_id    uuid NOT NULL REFERENCES app_user(id),
  received_at    timestamptz NOT NULL,
  due_at         timestamptz NOT NULL,
  completed_at   timestamptz,
  decision       text CHECK (decision IN ('passed','returned')),
  notes          text
);

-- ---------------------------------------------------------------------------
-- Quality decisions: immutable, and only Quality writes them (§36, §59).
-- ---------------------------------------------------------------------------

CREATE TABLE quality_decision (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     uuid NOT NULL REFERENCES evidence_submission(id) ON DELETE CASCADE,
  level             text NOT NULL CHECK (level IN ('l2','l3')),
  reviewer_id       uuid NOT NULL REFERENCES app_user(id),
  received_at       timestamptz NOT NULL,
  due_at            timestamptz NOT NULL,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  outcome           text NOT NULL CHECK (outcome IN ('accepted','rejected','escalated')),
  -- All seven binary checks, recorded individually so a decision is auditable
  -- rather than merely asserted.
  checks            jsonb NOT NULL,
  rejection_codes   text[] NOT NULL DEFAULT '{}',
  comments          text,
  config_version_id uuid REFERENCES cohort_config_version(id),
  CONSTRAINT rejection_requires_coded_reason CHECK (
    outcome = 'accepted' OR array_length(rejection_codes, 1) >= 1
  ),
  CONSTRAINT acceptance_carries_no_rejection_code CHECK (
    outcome <> 'accepted' OR coalesce(array_length(rejection_codes, 1), 0) = 0
  ),
  -- All seven binary checks, by name. A decision missing one is not a decision.
  CONSTRAINT all_seven_checks_recorded CHECK (
    jsonb_key_count(checks) = 7 AND checks ?& array[
      'evidence_completeness','identity_match','delivery_confirmed','payment_confirmed',
      'value_threshold','work_authenticity','no_duplication'
    ]
  )
);

CREATE INDEX quality_decision_submission_idx ON quality_decision (submission_id, decided_at);

-- A Quality decision is never updated or deleted. A changed mind is a NEW
-- decision at a higher level, which preserves the original for audit.
CREATE TRIGGER quality_decision_immutable
  BEFORE UPDATE OR DELETE ON quality_decision
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE quality_calibration (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      uuid NOT NULL REFERENCES evidence_submission(id) ON DELETE CASCADE,
  week_starting      date NOT NULL,
  first_decision_id  uuid NOT NULL REFERENCES quality_decision(id),
  second_decision_id uuid NOT NULL REFERENCES quality_decision(id),
  agreed             boolean NOT NULL,
  CONSTRAINT calibration_needs_two_reviews CHECK (first_decision_id <> second_decision_id)
);

-- ---------------------------------------------------------------------------
-- Entrepreneurship (§39)
-- ---------------------------------------------------------------------------

CREATE TABLE entrepreneurship_assessment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL UNIQUE REFERENCES student(id) ON DELETE CASCADE,
  assessor_id   uuid REFERENCES app_user(id),
  components    jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted      boolean NOT NULL DEFAULT false,
  accepted_at   timestamptz,
  audited       boolean NOT NULL DEFAULT false,
  audit_outcome text,
  CONSTRAINT all_seven_components_when_accepted CHECK (
    accepted = false OR (
      jsonb_key_count(components) = 7 AND components ?& array[
        'validated_problem_and_solution','business_model_canvas','marketing_and_sales_plan',
        'financial_plan','team_and_roles','pitch_delivered','final_project_presentation'
      ]
    )
  )
);

-- ---------------------------------------------------------------------------
-- Complaints (§44): independent of escalations, owned by Quality.
-- ---------------------------------------------------------------------------

CREATE TABLE complaint (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text UNIQUE,
  category          text NOT NULL
                      CHECK (category IN ('coach','operations','evidence_dispute',
                                          'misconduct','privacy','other')),
  student_id        uuid REFERENCES student(id),
  subject_user_id   uuid REFERENCES app_user(id),
  raised_by         uuid REFERENCES app_user(id),
  raised_at         timestamptz NOT NULL DEFAULT now(),
  -- Ownership is always Quality; the action may go to the subject function, but
  -- a complaint is never routed ONLY to the function it is about.
  owner_user_id     uuid NOT NULL REFERENCES app_user(id),
  action_function   text,
  sla_due_at        timestamptz,
  description       text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','assigned','in_progress','awaiting_information',
                                        'resolved','closed','reopened')),
  resolution        text,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  CONSTRAINT complaint_closure_requires_resolution CHECK (
    status NOT IN ('resolved','closed') OR btrim(coalesce(resolution, '')) <> ''
  ),
  -- The owner may never be the person the complaint is about.
  CONSTRAINT complaint_owner_not_subject CHECK (
    subject_user_id IS NULL OR owner_user_id <> subject_user_id
  )
);

-- ---------------------------------------------------------------------------
-- Graduation record: COMPUTED (§40). There is no manual "graduated" column.
-- ---------------------------------------------------------------------------

ALTER TABLE graduation_progress
  ADD COLUMN pathway            text CHECK (pathway IN ('outcome','support','entrepreneurship')),
  ADD COLUMN rule_version       text,
  ADD COLUMN evidence_ids       uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN calculated_at      timestamptz,
  ADD COLUMN effective_at       timestamptz,
  ADD COLUMN in_denominator     boolean NOT NULL DEFAULT true,
  ADD COLUMN pre_cohort_baseline boolean NOT NULL DEFAULT false,
  ADD COLUMN entitlement_amount numeric(18,4);

-- Graduation may only be written by the calculation service, which sets
-- `calculated_at`. A row claiming graduation without a calculation and a rule
-- version is a typed-in outcome, and is refused.
ALTER TABLE graduation_progress
  ADD CONSTRAINT graduation_must_be_computed CHECK (
    status <> 'graduated' OR (calculated_at IS NOT NULL AND rule_version IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Entitlement, decisions, report snapshots (§6, §63, §61)
-- ---------------------------------------------------------------------------

CREATE TABLE entitlement (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('student','staff')),
  subject_id   uuid NOT NULL,
  cohort_id    uuid NOT NULL REFERENCES cohort(id),
  kind         text NOT NULL,
  amount       numeric(18,4) NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',
  accrued_at   timestamptz NOT NULL DEFAULT now(),
  -- Tracked, never auto-applied: deductions need HR/legal sign-off (§53).
  applied      boolean NOT NULL DEFAULT false,
  applied_ref  text,
  CONSTRAINT application_requires_reference CHECK (applied = false OR applied_ref IS NOT NULL)
);

CREATE TABLE decision_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_on     date NOT NULL,
  meeting        text NOT NULL,
  issue          text NOT NULL,
  supporting_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision       text NOT NULL,
  owner_user_id  uuid REFERENCES app_user(id),
  due_on         date,
  status         text NOT NULL DEFAULT 'open',
  follow_up_on   date,
  related_risk_id uuid REFERENCES risk_record(id)
);

CREATE TABLE report_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_key    text NOT NULL,
  cohort_id     uuid REFERENCES cohort(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  uuid REFERENCES app_user(id),
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric_version text,
  payload       jsonb NOT NULL
);

CREATE TRIGGER report_snapshot_immutable
  BEFORE UPDATE OR DELETE ON report_snapshot
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE performance_record (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id  uuid NOT NULL REFERENCES app_user(id),
  cohort_id      uuid REFERENCES cohort(id),
  metric_key     text NOT NULL,
  metric_value   numeric(18,4),
  threshold_kind text NOT NULL CHECK (threshold_kind IN ('review','action','red_line')),
  stage          int CHECK (stage BETWEEN 1 AND 3),
  incident_kind  text,
  raised_at      timestamptz NOT NULL DEFAULT now(),
  raised_by      uuid REFERENCES app_user(id),
  correction_due timestamptz,
  outcome        text,
  closed_at      timestamptz,
  -- A red-line incident bypasses ordinary progression, so it carries no stage.
  CONSTRAINT red_line_has_no_stage CHECK (
    threshold_kind <> 'red_line' OR (stage IS NULL AND incident_kind IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO coordinator_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coordinator_app;
REVOKE UPDATE, DELETE ON quality_decision FROM coordinator_app;
REVOKE UPDATE, DELETE ON report_snapshot  FROM coordinator_app;
