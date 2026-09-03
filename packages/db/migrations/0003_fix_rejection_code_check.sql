-- ============================================================================
-- 0003 Fix: a rejection with no structured code was accepted by the database.
--
-- `array_length(x, 1)` returns NULL for an empty array, and a CHECK constraint
-- treats NULL as PASSING (SQL three-valued logic). So
--
--     outcome = 'accepted' OR array_length(rejection_codes, 1) >= 1
--
-- evaluated to NULL -- and therefore passed -- for exactly the case it was
-- written to catch: a rejection recorded with an empty code array. Requirement
-- §34 is explicit that reason analytics use the coded field, which is worth
-- nothing if an uncoded rejection can be stored.
--
-- `cardinality()` returns 0 rather than NULL for an empty array, so the
-- comparison is two-valued and the constraint bites.
--
-- ADDED **NOT VALID** ON PURPOSE. A Quality decision is immutable (§59) and
-- append-only: this migration must not rewrite or delete rows that were stored
-- while the constraint was broken. NOT VALID enforces the rule on every new and
-- updated row while leaving existing rows to be remediated deliberately, by
-- Quality, through a new decision at a higher level -- which is the only route
-- the requirements permit.
--
-- Remediation query for an operator (do NOT run automatically):
--   SELECT id, submission_id, decided_at FROM quality_decision
--   WHERE outcome <> 'accepted' AND cardinality(rejection_codes) = 0;
-- Once Quality has re-decided each, run:
--   ALTER TABLE quality_decision VALIDATE CONSTRAINT rejection_requires_coded_reason;
-- ============================================================================

ALTER TABLE quality_decision
  DROP CONSTRAINT rejection_requires_coded_reason,
  DROP CONSTRAINT acceptance_carries_no_rejection_code;

ALTER TABLE quality_decision
  ADD CONSTRAINT rejection_requires_coded_reason CHECK (
    outcome = 'accepted' OR cardinality(rejection_codes) >= 1
  ) NOT VALID;

ALTER TABLE quality_decision
  ADD CONSTRAINT acceptance_carries_no_rejection_code CHECK (
    outcome <> 'accepted' OR cardinality(rejection_codes) = 0
  ) NOT VALID;

ALTER TABLE evidence_submission
  ADD CONSTRAINT rejection_count_non_negative CHECK (rejection_count >= 0);
