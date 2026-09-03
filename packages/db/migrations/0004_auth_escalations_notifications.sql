-- ============================================================================
-- 0004 Remaining schema: authentication, escalations, interventions,
-- notifications, saved views, documents, import batches, the metric registry
-- and the read models.
--
-- This completes the entity list in requirements §6.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Authentication (§70)
-- ---------------------------------------------------------------------------

CREATE TABLE user_credential (
  user_id            uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  -- scrypt: N=16384, r=8, p=1. Stored as `scrypt$N$r$p$salt$hash`, so the
  -- parameters travel with the hash and can be raised without invalidating
  -- existing credentials.
  password_hash      text NOT NULL,
  must_change        boolean NOT NULL DEFAULT false,
  failed_attempts    int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- Only the hash of the token is stored: a database leak must not yield usable
  -- sessions.
  token_hash     bytea NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  ip             inet,
  user_agent     text,
  -- Step-up re-authentication for elevated actions (override_lock, impersonate).
  elevated_until timestamptz,
  -- Set while impersonating; both actors are recorded on every event.
  impersonating_user_id uuid REFERENCES app_user(id),
  CONSTRAINT session_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX user_session_active_idx ON user_session (user_id)
  WHERE revoked_at IS NULL;

-- A student account is bound to exactly one student record: the portal must not
-- be able to address anyone else's data even if a route forgets to scope.
CREATE TABLE student_account (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  student_id uuid NOT NULL UNIQUE REFERENCES student(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Escalations and interventions (§21, §22, §45, §46)
-- ---------------------------------------------------------------------------

CREATE TABLE escalation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text UNIQUE,
  cohort_id       uuid REFERENCES cohort(id),
  student_id      uuid REFERENCES student(id) ON DELETE CASCADE,
  cohort_group_id uuid REFERENCES cohort_group(id),
  staff_user_id   uuid REFERENCES app_user(id),
  issue_type      text NOT NULL,
  severity        int  NOT NULL CHECK (severity BETWEEN 1 AND 5),
  raised_by       uuid REFERENCES app_user(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  owner_user_id   uuid REFERENCES app_user(id),
  tier            int NOT NULL DEFAULT 1,
  sla_due_at      timestamptz,
  description     text NOT NULL,
  required_action text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','assigned','in_progress','awaiting_information',
                                      'resolved','closed','reopened')),
  resolution      text,
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES app_user(id),
  approved_by     uuid REFERENCES app_user(id),
  closed_at       timestamptz,
  reopened_count  int NOT NULL DEFAULT 0,
  -- An escalation cannot be closed without a resolution (§67).
  CONSTRAINT escalation_closure_requires_resolution CHECK (
    status NOT IN ('resolved','closed') OR btrim(coalesce(resolution, '')) <> ''
  )
);

CREATE INDEX escalation_open_idx ON escalation (status, sla_due_at)
  WHERE status NOT IN ('closed');

CREATE TABLE escalation_action (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_id uuid NOT NULL REFERENCES escalation(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_user(id),
  action        text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  notes         text
);

CREATE TABLE intervention (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_record_id uuid NOT NULL REFERENCES risk_record(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  root_cause     text NOT NULL,
  student_issue  text,
  next_review_at timestamptz NOT NULL,
  outcome_code   text,
  notes          text,
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);

CREATE TABLE intervention_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intervention_id uuid NOT NULL REFERENCES intervention(id) ON DELETE CASCADE,
  description     text NOT NULL,
  owner_user_id   uuid NOT NULL REFERENCES app_user(id),
  due_at          timestamptz NOT NULL,
  task_id         uuid REFERENCES task(id),
  status          text NOT NULL DEFAULT 'open',
  completed_at    timestamptz
);

-- A Critical risk requires an intervention plan (§67). Enforced as a deferred
-- check by the invariant sweeper rather than a constraint: the plan is written
-- after the risk opens, so a row-level constraint would make it impossible to
-- record the risk at all.
CREATE TABLE student_milestone_progress (
  student_id      uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  milestone_id    uuid NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  state           text NOT NULL DEFAULT 'not_started'
                    CHECK (state IN ('not_started','in_progress','achieved','blocked')),
  achieved_at     timestamptz,
  owner_user_id   uuid REFERENCES app_user(id),
  evidence_ref    text,
  deadline_at     timestamptz,
  blocking_reason text,
  PRIMARY KEY (student_id, milestone_id),
  CONSTRAINT achieved_has_timestamp CHECK ((state = 'achieved') = (achieved_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Notifications (§56): a notification informs, a task requires action.
-- ---------------------------------------------------------------------------

CREATE TABLE notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  trigger_key    text NOT NULL,
  subject_type   text,
  subject_id     uuid,
  title          text NOT NULL,
  body           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,
  dispatched_at  timestamptz,
  channel        text NOT NULL DEFAULT 'in_app',
  -- Deduplication window key: prevents training staff to ignore the system.
  rate_limit_key text,
  digest_batch_id uuid,
  status         text NOT NULL DEFAULT 'pending'
);

CREATE UNIQUE INDEX notification_dedup
  ON notification (user_id, rate_limit_key)
  WHERE rate_limit_key IS NOT NULL;

CREATE INDEX notification_inbox_idx ON notification (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE notification_preference (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  trigger_key text NOT NULL,
  channel     text NOT NULL DEFAULT 'in_app',
  enabled     boolean NOT NULL DEFAULT true,
  digest_mode boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, trigger_key, channel)
);

-- ---------------------------------------------------------------------------
-- Saved views, documents, imports (§65, §66)
-- ---------------------------------------------------------------------------

CREATE TABLE saved_view (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid REFERENCES app_user(id) ON DELETE CASCADE,
  name           text NOT NULL,
  module         text NOT NULL,
  filter         jsonb NOT NULL DEFAULT '{}'::jsonb,
  share_scope    text NOT NULL DEFAULT 'private'
                   CHECK (share_scope IN ('private','team','cohort')),
  is_system      boolean NOT NULL DEFAULT false
);

CREATE TABLE document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid REFERENCES student(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  file_ref     text NOT NULL,
  content_hash bytea NOT NULL,
  uploaded_by  uuid REFERENCES app_user(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  pii_class    text NOT NULL DEFAULT 'pii'
);

CREATE TABLE import_batch (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id              uuid REFERENCES cohort(id),
  kind                   text NOT NULL,
  filename               text,
  uploaded_by            uuid REFERENCES app_user(id),
  uploaded_at            timestamptz NOT NULL DEFAULT now(),
  mode                   text NOT NULL DEFAULT 'all_or_nothing'
                           CHECK (mode IN ('all_or_nothing','valid_rows_only')),
  status                 text NOT NULL DEFAULT 'validating'
                           CHECK (status IN ('validating','previewed','committed',
                                             'rolled_back','failed')),
  row_count              int NOT NULL DEFAULT 0,
  valid_count            int NOT NULL DEFAULT 0,
  error_count            int NOT NULL DEFAULT 0,
  committed_at           timestamptz,
  rolled_back_at         timestamptz,
  rollback_blocked_reason text
);

CREATE TABLE import_row_error (
  batch_id   uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_no     int NOT NULL,
  field      text,
  error_code text NOT NULL,
  detail     text,
  raw_row    jsonb
);

CREATE INDEX import_row_error_batch_idx ON import_row_error (batch_id, row_no);

-- ---------------------------------------------------------------------------
-- The metric registry (§69: one source of truth, one calculation layer)
-- ---------------------------------------------------------------------------

CREATE TABLE metric_definition (
  metric_key      text PRIMARY KEY,
  name_i18n       jsonb NOT NULL,
  definition_i18n jsonb NOT NULL,
  numerator       text,
  denominator     text,
  grain           text NOT NULL,
  owner_role      text,
  refresh_cadence text NOT NULL DEFAULT 'on_event',
  -- A metric without a drill-down path is a defect (§74): no dashboard tile may
  -- exist without one, and the consistency check refuses a null here.
  drilldown_query text NOT NULL,
  source_events   text[] NOT NULL DEFAULT '{}',
  version         int NOT NULL DEFAULT 1,
  CONSTRAINT drilldown_not_blank CHECK (btrim(drilldown_query) <> '')
);

-- ---------------------------------------------------------------------------
-- Read model: the student worklist, refreshed on event. Dashboards read from
-- here, never by aggregating OLTP (§72 latency targets).
-- ---------------------------------------------------------------------------

CREATE TABLE rm_student_current (
  student_id                uuid PRIMARY KEY REFERENCES student(id) ON DELETE CASCADE,
  cohort_id                 uuid NOT NULL,
  cohort_group_id           uuid,
  coordinator_user_id       uuid,
  supervisor_user_id        uuid,
  coach_user_id             uuid,
  full_name                 text NOT NULL,
  stage                     text NOT NULL,
  pathway                   text,
  risk_level                text NOT NULL,
  graduation_status         text NOT NULL,
  last_contact_at           timestamptz,
  last_successful_contact_at timestamptz,
  next_contact_due_at       timestamptz,
  sla_state                 text,
  contact_attempts          int NOT NULL DEFAULT 0,
  open_evidence_count       int NOT NULL DEFAULT 0,
  accepted_gig_count        int NOT NULL DEFAULT 0,
  accepted_gig_value        numeric(18,4) NOT NULL DEFAULT 0,
  accepted_service_count    int NOT NULL DEFAULT 0,
  attendance_percent        numeric(5,2),
  open_escalations          int NOT NULL DEFAULT 0,
  in_denominator            boolean NOT NULL DEFAULT true,
  refreshed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rm_student_queue_idx
  ON rm_student_current (coordinator_user_id, sla_state, risk_level, next_contact_due_at);
CREATE INDEX rm_student_group_idx ON rm_student_current (cohort_group_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO coordinator_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coordinator_app;
REVOKE UPDATE, DELETE ON events    FROM coordinator_app;
REVOKE UPDATE, DELETE ON audit_log FROM coordinator_app;
