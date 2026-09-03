-- ============================================================================
-- 0001 foundation: identity, organisation, cohort configuration, the student
-- master, and the event backbone.
--
-- Covers build-order increments 2-7 (docs/13). The properties that matter are
-- the ones enforced HERE rather than in application code: if the service layer
-- were removed entirely, the database must still refuse to violate the eight
-- system invariants (docs/01 §1.1, docs/10 §37).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- exclusion constraints on uuid + range
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy search and dedup
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------------------
-- Roles: the application connects as `app`, which deliberately lacks UPDATE and
-- DELETE on the immutable tables. Migrations run as the owner.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coordinator_app') THEN
    CREATE ROLE coordinator_app NOLOGIN;
  END IF;
END $$;

-- ===========================================================================
-- Identity and access
-- ===========================================================================

CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  full_name       text   NOT NULL,
  phone_e164      text,
  locale          text   NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  timezone        text   NOT NULL DEFAULT 'Africa/Cairo',
  status          text   NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deactivated')),
  mfa_enabled     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);

CREATE TABLE role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name_i18n  jsonb NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The permission matrix as data (docs/02). Seeded from packages/permissions, so
-- the documentation, the seed and the generated tests cannot drift apart.
CREATE TABLE role_permission (
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  module  text NOT NULL,
  verb    text NOT NULL,
  scope   text NOT NULL CHECK (scope IN ('own','team','coaching_team','cohort','all')),
  PRIMARY KEY (role_id, module, verb)
);

CREATE TABLE program (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Cohort and configuration
--
-- Every operational rule lives here as versioned configuration with effective
-- dates. A rule evaluation stores the config_version_id it used, so changing a
-- rule never rewrites history (AC-09).
-- ===========================================================================

CREATE TABLE working_calendar (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL,
  working_days  int[] NOT NULL,           -- 0 = Sunday .. 6 = Saturday
  start_minute  int NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),
  end_minute    int NOT NULL CHECK (end_minute BETWEEN 0 AND 1440),
  CONSTRAINT working_window_ordered CHECK (end_minute > start_minute)
);

CREATE TABLE holiday (
  calendar_id uuid NOT NULL REFERENCES working_calendar(id) ON DELETE CASCADE,
  local_date  date NOT NULL,
  name_i18n   jsonb NOT NULL,
  PRIMARY KEY (calendar_id, local_date)
);

CREATE TABLE cohort (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id            uuid NOT NULL REFERENCES program(id),
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  state                 text NOT NULL DEFAULT 'draft'
                          CHECK (state IN ('draft','active','closed','archived')),
  start_date            date,
  end_date              date,
  timezone              text NOT NULL DEFAULT 'Africa/Cairo',
  working_calendar_id   uuid REFERENCES working_calendar(id),
  -- CONFIG-PENDING register item 2. Default 'include_all' is the conservative
  -- choice: the headline rate cannot be flattered by excluding exits.
  denominator_policy    text NOT NULL DEFAULT 'include_all'
                          CHECK (denominator_policy IN
                            ('include_all','exclude_withdrawn','exclude_withdrawn_and_excluded')),
  -- CONFIG-PENDING register item 16. Weakens SoD-2; off by default and stamped
  -- on every record approved under it.
  single_approver_mode  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cohort_config_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id      uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  version_no     int  NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_by     uuid REFERENCES app_user(id),
  reason         text,
  published_at   timestamptz,
  UNIQUE (cohort_id, version_no),
  CONSTRAINT config_version_range CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- No two published config versions may be in force at once, or a rule
-- evaluation would have no single answer to "which version applied?".
ALTER TABLE cohort_config_version
  ADD CONSTRAINT config_version_no_overlap
  EXCLUDE USING gist (
    cohort_id WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  ) WHERE (published_at IS NOT NULL);

CREATE TABLE config_item (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_version_id     uuid NOT NULL REFERENCES cohort_config_version(id) ON DELETE CASCADE,
  area                  text NOT NULL,
  key                   text NOT NULL,
  value                 jsonb NOT NULL,
  -- Renders the visible CONFIG-PENDING badge wherever the value is used.
  is_config_pending     boolean NOT NULL DEFAULT false,
  decision_register_ref text,
  UNIQUE (config_version_id, area, key)
);

CREATE TABLE track (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name_i18n jsonb NOT NULL,
  UNIQUE (cohort_id, code)
);

CREATE TABLE student_group (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name_i18n jsonb NOT NULL,
  UNIQUE (cohort_id, code)
);

CREATE TABLE milestone (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id           uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  track_id            uuid REFERENCES track(id),   -- NULL = applies to all tracks
  key                 text NOT NULL,
  name_i18n           jsonb NOT NULL,
  sequence            int  NOT NULL,
  target_offset_days  int,                          -- CONFIG-PENDING item 6
  target_date         date,
  required_evidence   jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_role          text,
  UNIQUE (cohort_id, key)
);

-- ===========================================================================
-- Organisation (effective-dated) -- Invariant 4
-- ===========================================================================

CREATE TABLE team (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  name            text NOT NULL,
  team_type       text NOT NULL
                    CHECK (team_type IN ('operations','coaching_t1','coaching_t2','quality')),
  parent_team_id  uuid REFERENCES team(id),
  manager_user_id uuid REFERENCES app_user(id),
  UNIQUE (cohort_id, name)
);

CREATE TABLE org_membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app_user(id),
  team_id         uuid NOT NULL REFERENCES team(id),
  role_in_team    text,
  manager_user_id uuid REFERENCES app_user(id),
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  CONSTRAINT org_membership_range CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Invariant 4: exactly one hierarchy resolution at any timestamp. A user may
-- belong to an operations team and a coaching team at once, but not to two
-- teams of the same type in overlapping periods.
ALTER TABLE org_membership
  ADD COLUMN team_type text;

CREATE OR REPLACE FUNCTION org_membership_denormalise_type() RETURNS trigger AS $$
BEGIN
  SELECT team_type INTO NEW.team_type FROM team WHERE id = NEW.team_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER org_membership_type
  BEFORE INSERT OR UPDATE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION org_membership_denormalise_type();

ALTER TABLE org_membership
  ADD CONSTRAINT org_membership_one_per_type
  EXCLUDE USING gist (
    user_id WITH =,
    team_type WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  );

CREATE TABLE user_role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user(id),
  role_id        uuid NOT NULL REFERENCES role(id),
  cohort_id      uuid REFERENCES cohort(id),   -- NULL = every cohort
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  CONSTRAINT user_role_range CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE staff_capacity (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES app_user(id),
  cohort_id             uuid NOT NULL REFERENCES cohort(id),
  max_students          int,                    -- NULL = no cap (register item 12)
  max_sessions_per_week int,
  effective_from        timestamptz NOT NULL,
  effective_to          timestamptz
);

CREATE TABLE staff_absence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  reason_code text NOT NULL,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT absence_range CHECK (to_date >= from_date)
);

CREATE TABLE delegation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES app_user(id),
  to_user_id   uuid NOT NULL REFERENCES app_user(id),
  scope        text NOT NULL,
  from_date    timestamptz NOT NULL,
  -- An end date is mandatory: an open-ended delegation is an ownership leak.
  to_date      timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  reason       text NOT NULL,
  CONSTRAINT delegation_range CHECK (to_date > from_date),
  CONSTRAINT delegation_not_self CHECK (from_user_id <> to_user_id)
);

-- ===========================================================================
-- Student master
-- ===========================================================================

CREATE TABLE student (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id                uuid NOT NULL REFERENCES cohort(id),
  external_student_id      text,
  -- Deterministic dedup key (docs/03 §4). Normalised for Arabic orthography
  -- before hashing, or Arabic intake produces silent duplicates.
  identity_key             text NOT NULL,
  full_name                text NOT NULL,
  phone_e164               text,
  email                    citext,
  track_id                 uuid REFERENCES track(id),
  group_id                 uuid REFERENCES student_group(id),

  -- Denormalised read fields, maintained by handlers inside the same
  -- transaction as the write. The authority is the history tables and the event
  -- log; the nightly reconciliation asserts these agree.
  current_stage            text NOT NULL DEFAULT 'imported',
  current_statuses         jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_risk_level       text NOT NULL DEFAULT 'green'
                             CHECK (current_risk_level IN ('green','amber','red')),
  graduation_status        text NOT NULL DEFAULT 'not_eligible',
  last_contact_at          timestamptz,
  next_action_at           timestamptz,

  consent_message_storage  boolean NOT NULL DEFAULT false,
  source_batch_id          uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Invariant 1: exactly one master record per student.
  CONSTRAINT student_identity_unique UNIQUE (cohort_id, identity_key),
  CONSTRAINT student_contactable CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX student_external_id_unique
  ON student (cohort_id, external_student_id)
  WHERE external_student_id IS NOT NULL;

CREATE INDEX student_worklist_idx
  ON student (cohort_id, current_stage, current_risk_level, last_contact_at);
CREATE INDEX student_name_trgm ON student USING gin (full_name gin_trgm_ops);

-- Invariant 3: exactly one responsible coordinator, or an explicit UNASSIGNED.
-- A NULL coordinator_user_id is the explicit exception -- an open row with no
-- owner -- never an absent row, so "unassigned" is queryable and has an age
-- clock rather than being an invisible gap.
CREATE TABLE student_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  coordinator_user_id uuid REFERENCES app_user(id),
  reason_code         text,
  effective_from      timestamptz NOT NULL,
  effective_to        timestamptz,
  created_by          uuid REFERENCES app_user(id),
  CONSTRAINT assignment_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT assignment_no_overlap
    EXCLUDE USING gist (
      student_id WITH =,
      tstzrange(effective_from, effective_to) WITH &&
    )
);

CREATE INDEX student_assignment_open_idx
  ON student_assignment (coordinator_user_id)
  WHERE effective_to IS NULL;

CREATE TABLE student_coach_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  coach_user_id  uuid REFERENCES app_user(id),
  coaching_type  text NOT NULL CHECK (coaching_type IN ('t1','t2')),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_by     uuid REFERENCES app_user(id),
  CONSTRAINT coach_assignment_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT coach_assignment_no_overlap
    EXCLUDE USING gist (
      student_id WITH =,
      coaching_type WITH =,
      tstzrange(effective_from, effective_to) WITH &&
    )
);

-- Invariant 2: exactly one current lifecycle stage. Dwell time per stage comes
-- from these ranges, which is why funnel metrics are exact rather than estimated.
CREATE TABLE student_stage_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  stage             text NOT NULL,
  entered_at        timestamptz NOT NULL,
  exited_at         timestamptz,
  entered_by        uuid REFERENCES app_user(id),
  reason_code       text,
  causing_event_id  uuid,
  config_version_id uuid REFERENCES cohort_config_version(id),
  CONSTRAINT stage_range CHECK (exited_at IS NULL OR exited_at > entered_at),
  CONSTRAINT stage_no_overlap
    EXCLUDE USING gist (
      student_id WITH =,
      tstzrange(entered_at, exited_at) WITH &&
    )
);

-- ===========================================================================
-- The event backbone -- Invariant 7
-- ===========================================================================

CREATE TABLE events (
  event_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                      bigserial NOT NULL,
  event_type               text NOT NULL,
  event_version            int  NOT NULL DEFAULT 1,
  occurred_at              timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  actor_user_id            uuid REFERENCES app_user(id),
  actor_role               text,
  -- Set when impersonating: both the real and the effective actor are recorded.
  effective_actor_user_id  uuid REFERENCES app_user(id),
  subject_type             text NOT NULL,
  subject_id               uuid NOT NULL,
  cohort_id                uuid REFERENCES cohort(id),
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id           uuid NOT NULL,
  causation_id             uuid,
  source                   text NOT NULL CHECK (source IN ('UI','API','IMPORT','SYSTEM_JOB')),
  prev_hash                bytea,
  hash                     bytea
);

CREATE INDEX events_subject_idx     ON events (subject_type, subject_id, occurred_at);
CREATE INDEX events_cohort_time_idx ON events (cohort_id, occurred_at);
CREATE INDEX events_correlation_idx ON events (correlation_id);
CREATE INDEX events_type_idx        ON events (event_type, occurred_at);

-- Events are never updated or deleted. Corrections are new compensating events
-- referencing the original; a "delete" is a soft-delete event. This is enforced
-- by a trigger AND by withholding the grants, because either alone is a single
-- point of failure.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Corrections are new compensating rows.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Hash chain: each row commits to its predecessor, so a row silently altered by
-- a superuser or a restore is detectable.
CREATE OR REPLACE FUNCTION events_hash_chain() RETURNS trigger AS $$
DECLARE
  last_hash bytea;
BEGIN
  SELECT hash INTO last_hash FROM events ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := last_hash;
  NEW.hash := digest(
    coalesce(encode(last_hash, 'hex'), '') ||
    NEW.event_id::text || NEW.event_type || NEW.occurred_at::text ||
    NEW.subject_type || NEW.subject_id::text || NEW.payload::text,
    'sha256'
  );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER events_hash BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_hash_chain();

-- Idempotency: a handler records the events it has processed, inside its own
-- transaction. Replay of the same event_id is a no-op (AC-05).
CREATE TABLE handler_offsets (
  handler_key  text NOT NULL,
  event_id     uuid NOT NULL REFERENCES events(event_id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handler_key, event_id)
);

-- Transactional outbox: async handlers read committed rows only, so an event is
-- never published for a transaction that rolled back, nor lost for one that
-- committed.
CREATE TABLE event_outbox (
  event_id     uuid PRIMARY KEY REFERENCES events(event_id),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  dispatched_at timestamptz
);

CREATE INDEX event_outbox_pending_idx
  ON event_outbox (available_at) WHERE dispatched_at IS NULL;

-- ===========================================================================
-- Audit log, version history, system log (docs/04 §1: four distinct artefacts)
-- ===========================================================================

CREATE TABLE audit_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  user_id           uuid REFERENCES app_user(id),
  effective_user_id uuid REFERENCES app_user(id),
  role              text,
  -- Not merely who, but under what authority -- the question an external
  -- reviewer actually asks.
  permission_used   text,
  module            text NOT NULL,
  record_type       text NOT NULL,
  record_id         uuid,
  action            text NOT NULL,
  old_value         jsonb,
  new_value         jsonb,
  reason            text,
  source            text,
  related_object    text,
  correlation_id    uuid,
  event_id          uuid REFERENCES events(event_id),
  ip                inet,
  user_agent        text,
  session_id        text
);

CREATE INDEX audit_log_record_idx ON audit_log (record_type, record_id, occurred_at);
CREATE INDEX audit_log_user_idx   ON audit_log (user_id, occurred_at);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE entity_version_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  field          text NOT NULL,
  old_value      jsonb,
  new_value      jsonb,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid REFERENCES app_user(id),
  event_id       uuid REFERENCES events(event_id),
  correlation_id uuid
);

CREATE INDEX entity_version_history_idx
  ON entity_version_history (entity_type, entity_id, changed_at);

CREATE TABLE system_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  level          text NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  component      text NOT NULL,
  code           text,
  message        text NOT NULL,
  context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid,
  trace_id       text
);

CREATE INDEX system_log_time_idx ON system_log (occurred_at DESC);
CREATE INDEX system_log_level_idx ON system_log (level, occurred_at DESC);

-- ===========================================================================
-- Risk and tasks (the invariant-bearing parts; full modules follow in 0002+)
-- ===========================================================================

CREATE TABLE risk_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  level             text NOT NULL CHECK (level IN ('green','amber','red')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  owner_user_id     uuid REFERENCES app_user(id),
  origin            text NOT NULL DEFAULT 'rule' CHECK (origin IN ('rule','manual')),
  fired_rule_key    text,
  config_version_id uuid REFERENCES cohort_config_version(id),
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_due_at     timestamptz,
  resolution_code   text,
  override_reason   text,
  -- A manual override without a review date is an unexamined judgement that
  -- persists forever; the engine will not accept one, and neither will the table.
  CONSTRAINT manual_override_needs_review
    CHECK (origin <> 'manual' OR (override_reason IS NOT NULL AND review_due_at IS NOT NULL))
);

-- Invariant 6: exactly one current risk status.
CREATE UNIQUE INDEX risk_record_one_open
  ON risk_record (student_id) WHERE closed_at IS NULL;

CREATE TABLE risk_reason (
  risk_record_id uuid NOT NULL REFERENCES risk_record(id) ON DELETE CASCADE,
  reason_code    text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (risk_record_id, reason_code)
);

CREATE TABLE task (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id           uuid REFERENCES student(id) ON DELETE CASCADE,
  cohort_id            uuid REFERENCES cohort(id),
  task_type            text NOT NULL,
  owner_user_id        uuid NOT NULL REFERENCES app_user(id),
  created_by           uuid REFERENCES app_user(id),
  priority             int  NOT NULL DEFAULT 100,
  created_at           timestamptz NOT NULL DEFAULT now(),
  due_at               timestamptz,
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','in_progress','completed','overdue','cancelled')),
  completed_at         timestamptz,
  completion_notes     text,
  source               text NOT NULL
                         CHECK (source IN ('manual','workflow','risk','sla','qa','gig',
                                           'graduation','escalation')),
  originating_event_id uuid REFERENCES events(event_id),
  dedup_key            text,
  cancel_reason        text,
  CONSTRAINT cancel_needs_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);

-- An unresolved auto-task of the same type for the same student is UPDATED, not
-- duplicated. Even a handler bug cannot produce a duplicate open task.
CREATE UNIQUE INDEX task_dedup_open
  ON task (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('open','in_progress');

CREATE INDEX task_queue_idx ON task (owner_user_id, status, due_at);

CREATE TABLE graduation_progress (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Invariant 8: one graduation progress record per student.
  student_id                  uuid NOT NULL UNIQUE REFERENCES student(id) ON DELETE CASCADE,
  cohort_id                   uuid NOT NULL REFERENCES cohort(id),
  status                      text NOT NULL DEFAULT 'not_eligible',
  matched_route_key           text,
  evaluation                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  gap_explanation_i18n        jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version_id           uuid REFERENCES cohort_config_version(id),
  evaluated_at                timestamptz NOT NULL DEFAULT now(),
  -- The denominator policy in force when this was evaluated, stored so the
  -- headline KPI is always explainable.
  denominator_policy_applied  text NOT NULL
);

-- ===========================================================================
-- Grants: the application role may append to the immutable tables, never mutate
-- them. This is the backstop that makes Invariant 7 true even if application
-- code is wrong.
-- ===========================================================================

GRANT USAGE ON SCHEMA public TO coordinator_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO coordinator_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coordinator_app;

REVOKE UPDATE, DELETE ON events    FROM coordinator_app;
REVOKE UPDATE, DELETE ON audit_log FROM coordinator_app;
REVOKE DELETE            ON entity_version_history FROM coordinator_app;
