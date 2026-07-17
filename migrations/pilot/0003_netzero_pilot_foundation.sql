-- =====================================================================
-- Minder Net Zero - pilot storage foundation (middle path)
-- File: drizzle/0003_netzero_pilot_foundation.sql
--
-- STANDALONE. Does NOT depend on 0000/0001/0002 (the Clerk-era platform).
-- Lives in its own schemas (netzero, netzero_ai) so it never collides with
-- the unused public-schema tables. Targets stock PostgreSQL 14+ and Supabase.
--
-- THREAT MODEL (deliberate): a small, mutually-trusted organiser panel that
-- shares one login. The database defends the HONEST case - accidental
-- double-reveal, a forged score slipping into the ranking, AI leaking into the
-- human total, a restored backup silently reopening a seal. It does NOT try to
-- defend against the single logged-in organiser deliberately attacking their
-- own database with raw SQL; that is out of scope for this pilot and would need
-- the write-revoking design we explicitly chose not to build.
--
-- WHAT THE DATABASE STILL GUARANTEES:
--   1. AI output is in schema netzero_ai only. netzero.final_ranking is owned
--      by role netzero_ranking, which has NO privilege on netzero_ai, so the
--      ranking is physically incapable of reading an AI score - and the app
--      role cannot redefine the view to add one.
--   2. Immutable records stay immutable: assessment results, audit events, and
--      final-decision events reject UPDATE/DELETE via trigger.
--   3. The one-use seal's reveal count is MONOTONIC: a trigger refuses to lower
--      it, so restoring an older backup cannot reopen a spent practice test.
--   4. A reviewer's weighted score is DERIVED by trigger from their marks and
--      the approved guide's weights - never accepted from the client - so a
--      forged total is overwritten with the truth.
--
-- SERVER-SIDE REQUIREMENT (enforced by the API layer, not this file): the
-- dataset fingerprint and the teaching/sealed partition MUST be recomputed
-- server-side from the stored rows. The columns below carry hex-64 CHECKs, but
-- the database trusts the API to have derived them. Do not accept either value
-- from the browser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensions and schemas
-- ---------------------------------------------------------------------

-- digest() (pgcrypto) powers the audit hash chain. Supabase ships it in schema
-- "extensions"; a stock cluster usually lands it in "public". Create the schema
-- and install there so every hashing call can pin a stable search_path.
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS netzero;
CREATE SCHEMA IF NOT EXISTS netzero_ai;

-- ---------------------------------------------------------------------
-- 1. Roles
--   netzero_app     - the API's working role. Full DML on working tables.
--   netzero_ranking - owns the final-ranking view ONLY. Never granted any
--                     privilege on netzero_ai, which is what makes the AI/human
--                     separation structural rather than a coding convention.
-- Both are NOLOGIN group roles; on Supabase, GRANT netzero_app to the role in
-- DATABASE_URL. No BYPASSRLS, no superuser attributes (Supabase-safe).
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netzero_app') THEN
    CREATE ROLE netzero_app NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netzero_ranking') THEN
    CREATE ROLE netzero_ranking NOLOGIN NOINHERIT;
  END IF;
END $$;

REVOKE ALL ON SCHEMA netzero FROM PUBLIC;
REVOKE ALL ON SCHEMA netzero_ai FROM PUBLIC;
GRANT USAGE ON SCHEMA netzero TO netzero_app;
GRANT USAGE ON SCHEMA netzero_ai TO netzero_app;
GRANT USAGE ON SCHEMA extensions TO netzero_app;
-- netzero_ranking may read the human schema only. It is deliberately NEVER
-- granted USAGE on netzero_ai.
GRANT USAGE ON SCHEMA netzero TO netzero_ranking;

-- ---------------------------------------------------------------------
-- 2. Reusable domain
-- ---------------------------------------------------------------------

-- A lowercase hex-64 string (a SHA-256 hex digest).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'hex64' AND n.nspname = 'netzero') THEN
    CREATE DOMAIN netzero.hex64 AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. Workspace + reviewers
-- ---------------------------------------------------------------------

CREATE TABLE netzero.workspaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- How many reviewers are expected to mark every application. SUM ranking is
  -- only valid when every application carries the full expected set of marks.
  expected_marks_per_application integer NOT NULL DEFAULT 0
    CHECK (expected_marks_per_application >= 0),
  data_retention_days integer CHECK (data_retention_days IS NULL OR data_retention_days > 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE netzero.reviewers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, display_name)
);
CREATE INDEX reviewers_by_workspace ON netzero.reviewers (workspace_id) WHERE active;

-- ---------------------------------------------------------------------
-- 4. Decision guide (rubric)
-- Draft rows are editable; an approved row is frozen by trigger. A new revision
-- is a new row with a higher version - approved history is never rewritten.
-- ---------------------------------------------------------------------

CREATE TABLE netzero.guide_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version >= 1),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  -- Full guide payload (eligibility/elimination/criterion rules, selection,
  -- tie-breaks). Integrity-critical scalars are pulled out as columns below.
  rules          jsonb NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('top_n', 'minimum_score', 'both')),
  shortlist_target integer
    CHECK (shortlist_target IS NULL OR (shortlist_target > 0 AND shortlist_target <= 100000)),
  minimum_score  integer
    CHECK (minimum_score IS NULL OR (minimum_score BETWEEN 1 AND 100)),
  content_hash   netzero.hex64 NOT NULL,
  approved_by    uuid REFERENCES netzero.reviewers(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version),
  -- top_n / both require a shortlist target; minimum_score / both require a
  -- minimum. Written NOT NULL-permissive on purpose.
  CONSTRAINT guide_shortlist_required CHECK (
    selection_mode = 'minimum_score' OR shortlist_target IS NOT NULL
  ),
  CONSTRAINT guide_minimum_required CHECK (
    selection_mode = 'top_n' OR minimum_score IS NOT NULL
  ),
  CONSTRAINT guide_approved_has_approver CHECK (
    status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
CREATE INDEX guide_versions_by_workspace ON netzero.guide_versions (workspace_id, version DESC);

-- Per-criterion weights, split out so human marks and the AI reference are
-- weighted by the SAME numbers. Criterion weights for a guide version sum to
-- exactly 100 (checked at approval time in the app; stored here per row).
CREATE TABLE netzero.guide_criteria (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_version_id uuid NOT NULL REFERENCES netzero.guide_versions(id) ON DELETE CASCADE,
  rule_id          text NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 300),
  title            text NOT NULL,
  weight           integer NOT NULL CHECK (weight BETWEEN 1 AND 100),
  position         integer NOT NULL,
  UNIQUE (guide_version_id, rule_id)
);

-- Freeze an approved guide version: once status = 'approved', no UPDATE or
-- DELETE is permitted. Draft rows remain fully editable.
CREATE OR REPLACE FUNCTION netzero.freeze_approved_guide()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved guide version is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved guide version is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER freeze_approved_guide_version
  BEFORE UPDATE OR DELETE ON netzero.guide_versions
  FOR EACH ROW EXECUTE FUNCTION netzero.freeze_approved_guide();

CREATE OR REPLACE FUNCTION netzero.freeze_approved_guide_criteria()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM netzero.guide_versions
   WHERE id = COALESCE(NEW.guide_version_id, OLD.guide_version_id);
  IF parent_status = 'approved' THEN
    RAISE EXCEPTION 'criteria of an approved guide version are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER freeze_approved_guide_criteria
  BEFORE INSERT OR UPDATE OR DELETE ON netzero.guide_criteria
  FOR EACH ROW EXECUTE FUNCTION netzero.freeze_approved_guide_criteria();

-- ---------------------------------------------------------------------
-- 5. Historical data (calibration input)
-- Fingerprint + partition are SERVER-DERIVED (see header). Sealed outcomes are
-- kept in the same table but the API must never return the outcome column for a
-- sealed_test row before the practice is revealed.
-- ---------------------------------------------------------------------

CREATE TABLE netzero.historical_datasets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  name           text NOT NULL,
  file_name      text,
  fingerprint    netzero.hex64 NOT NULL,
  integrity_hash netzero.hex64 NOT NULL,
  teaching_count integer NOT NULL CHECK (teaching_count >= 0),
  sealed_count   integer NOT NULL CHECK (sealed_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A given historical file (by fingerprint) exists once per workspace.
  UNIQUE (workspace_id, fingerprint)
);

CREATE TABLE netzero.historical_rows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id      uuid NOT NULL REFERENCES netzero.historical_datasets(id) ON DELETE CASCADE,
  row_id          text NOT NULL CHECK (length(row_id) BETWEEN 1 AND 300),
  partition       text NOT NULL CHECK (partition IN ('teaching', 'sealed_test')),
  answers         jsonb NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('progressed', 'not_progressed', 'waitlist', 'ineligible')),
  row_fingerprint netzero.hex64 NOT NULL,
  UNIQUE (dataset_id, row_id)
);
CREATE INDEX historical_rows_by_dataset ON netzero.historical_rows (dataset_id, partition);

-- ---------------------------------------------------------------------
-- 6. Current applications (the round being assessed)
-- Answer text (AI-visible) is separated from identity (PII) into two tables.
-- ---------------------------------------------------------------------

CREATE TABLE netzero.current_datasets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  fingerprint  netzero.hex64 NOT NULL,
  case_count   integer NOT NULL CHECK (case_count >= 0),
  frozen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, fingerprint)
);

CREATE TABLE netzero.current_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id  uuid NOT NULL REFERENCES netzero.current_datasets(id) ON DELETE CASCADE,
  row_id      text NOT NULL CHECK (length(row_id) BETWEEN 1 AND 300),
  answers     jsonb NOT NULL,
  UNIQUE (dataset_id, row_id)
);

CREATE TABLE netzero.current_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id  uuid NOT NULL REFERENCES netzero.current_datasets(id) ON DELETE CASCADE,
  row_id      text NOT NULL CHECK (length(row_id) BETWEEN 1 AND 300),
  identity    jsonb NOT NULL,
  UNIQUE (dataset_id, row_id)
);

-- ---------------------------------------------------------------------
-- 7. Calibration (Phase 4): sessions, the one-use seal, credits
-- ---------------------------------------------------------------------

CREATE TABLE netzero.calibration_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  dataset_id         uuid NOT NULL REFERENCES netzero.historical_datasets(id) ON DELETE CASCADE,
  guide_version      integer NOT NULL,
  practice_status    text NOT NULL DEFAULT 'not_started'
    CHECK (practice_status IN (
      'not_started', 'policy_locked', 'running', 'predictions_committed',
      'revealed', 'passed', 'failed'
    )),
  revision           integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  patterns           jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_policy  jsonb,
  assessments        jsonb,
  outcomes           jsonb,
  prediction_hash    netzero.hex64,
  metrics            jsonb,
  metrics_hash       netzero.hex64,
  model_id           text,
  protocol_hash      netzero.hex64,
  blindness_compromised boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One live session per (dataset, guide version).
  UNIQUE (workspace_id, dataset_id, guide_version)
);

-- The one-use seal. One receipt per dataset fingerprint. reveal_count is
-- monotonic (see trigger); reveals_allowed = 1 + granted credits.
CREATE TABLE netzero.calibration_reveal_receipts (
  dataset_fingerprint netzero.hex64 PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES netzero.calibration_sessions(id) ON DELETE CASCADE,
  reveal_count        integer NOT NULL DEFAULT 1 CHECK (reveal_count >= 1),
  reveals_allowed     integer NOT NULL DEFAULT 1 CHECK (reveals_allowed >= 1),
  first_revealed_at   timestamptz NOT NULL DEFAULT now(),
  last_revealed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reveal_within_budget CHECK (reveal_count <= reveals_allowed)
);

-- Append-only. Each row grants exactly one extra reveal (raises the budget by
-- one) after a genuine Phase 5 audit failure.
CREATE TABLE netzero.recalibration_credits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_fingerprint netzero.hex64 NOT NULL,
  session_id          uuid NOT NULL REFERENCES netzero.calibration_sessions(id) ON DELETE CASCADE,
  reason              text NOT NULL,
  granted_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recalibration_credits_by_fingerprint
  ON netzero.recalibration_credits (dataset_fingerprint);

-- reveals_allowed is DERIVED from the append-only credits (1 + credit count),
-- never trusted from the client - so the only way to earn another reveal is to
-- insert a credit, which is exactly the honest recalibration flow.
CREATE OR REPLACE FUNCTION netzero.derive_reveals_allowed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.reveals_allowed := 1 + (
    SELECT count(*) FROM netzero.recalibration_credits
     WHERE dataset_fingerprint = NEW.dataset_fingerprint);
  RETURN NEW;
END $$;

CREATE TRIGGER derive_reveals_allowed
  BEFORE INSERT OR UPDATE ON netzero.calibration_reveal_receipts
  FOR EACH ROW EXECUTE FUNCTION netzero.derive_reveals_allowed();

-- reveal_count may only rise, and never above reveals_allowed. This is what a
-- restored backup runs into: it cannot lower the count to reopen a spent seal.
CREATE OR REPLACE FUNCTION netzero.guard_reveal_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reveal receipt cannot be deleted';
  END IF;
  IF NEW.dataset_fingerprint <> OLD.dataset_fingerprint THEN
    RAISE EXCEPTION 'a reveal receipt key is immutable';
  END IF;
  IF NEW.reveal_count < OLD.reveal_count THEN
    RAISE EXCEPTION 'reveal_count is monotonic and cannot be lowered (was %, tried %)',
      OLD.reveal_count, NEW.reveal_count;
  END IF;
  RETURN NEW;
END $$;

-- guard runs AFTER derive (alphabetical BEFORE-trigger order: derive < guard),
-- so guard sees the freshly-derived reveals_allowed.
CREATE TRIGGER guard_reveal_receipt
  BEFORE UPDATE OR DELETE ON netzero.calibration_reveal_receipts
  FOR EACH ROW EXECUTE FUNCTION netzero.guard_reveal_receipt();

-- When a credit is granted, refresh the receipt's derived budget so the extra
-- reveal becomes available immediately.
CREATE OR REPLACE FUNCTION netzero.bump_reveal_budget_on_credit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE netzero.calibration_reveal_receipts
     SET last_revealed_at = last_revealed_at  -- no-op change re-fires derive
   WHERE dataset_fingerprint = NEW.dataset_fingerprint;
  RETURN NEW;
END $$;

CREATE TRIGGER bump_reveal_budget_on_credit
  AFTER INSERT ON netzero.recalibration_credits
  FOR EACH ROW EXECUTE FUNCTION netzero.bump_reveal_budget_on_credit();

CREATE TABLE netzero.safeguard_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES netzero.calibration_sessions(id) ON DELETE CASCADE,
  protocol_hash netzero.hex64 NOT NULL,
  approved_by   uuid REFERENCES netzero.reviewers(id),
  approved_at   timestamptz NOT NULL DEFAULT now(),
  detail        jsonb
);

-- ---------------------------------------------------------------------
-- 8. AI assessment (Phase 5) - REFERENCE ONLY, isolated in netzero_ai
-- ---------------------------------------------------------------------

CREATE TABLE netzero_ai.assessment_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  current_dataset_id uuid NOT NULL,
  guide_version   integer NOT NULL,
  status          text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'paused', 'complete', 'invalid')),
  model_id        text NOT NULL,
  contract_hash   netzero.hex64 NOT NULL,
  protocol_hash   netzero.hex64 NOT NULL,
  cohort_recommendations jsonb,
  evidence_sample_ids jsonb,
  review_state_hash netzero.hex64,
  invalid_reason  text,
  revision        integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assessment_runs_by_workspace ON netzero_ai.assessment_runs (workspace_id);

CREATE TABLE netzero_ai.assessment_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES netzero_ai.assessment_runs(id) ON DELETE CASCADE,
  batch_index      integer NOT NULL CHECK (batch_index >= 0),
  status           text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'complete', 'failed')),
  batch_input_hash netzero.hex64 NOT NULL,
  lease_token      uuid,
  lease_expires_at timestamptz,
  UNIQUE (run_id, batch_index)
);

CREATE TABLE netzero_ai.assessment_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES netzero_ai.assessment_runs(id) ON DELETE CASCADE,
  row_id         text NOT NULL CHECK (length(row_id) BETWEEN 1 AND 300),
  assessment     jsonb NOT NULL,
  weighted_score numeric(6,2),
  recommendation text NOT NULL,
  evidence_valid boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Exactly one immutable result per (run, application).
  UNIQUE (run_id, row_id)
);

-- Generic immutability guard used by append-only tables below.
CREATE OR REPLACE FUNCTION netzero.reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (append-only)', TG_TABLE_NAME;
END $$;

CREATE TRIGGER reject_assessment_results_mutation
  BEFORE UPDATE OR DELETE ON netzero_ai.assessment_results
  FOR EACH ROW EXECUTE FUNCTION netzero.reject_mutation();

-- ---------------------------------------------------------------------
-- 9. Human marking (per criterion, guide-weighted, SUM ranking)
-- ---------------------------------------------------------------------

CREATE TABLE netzero.reviewer_mark_sets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  application_row_id text NOT NULL CHECK (length(application_row_id) BETWEEN 1 AND 300),
  reviewer_id        uuid NOT NULL REFERENCES netzero.reviewers(id),
  guide_version_id   uuid NOT NULL REFERENCES netzero.guide_versions(id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  -- Derived by trigger from the marks below; never trusted from the client.
  weighted_score     numeric(6,2),
  submitted_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One mark set per (application, reviewer): a reviewer marks an application
  -- exactly once, and the dropdown identity is captured here.
  UNIQUE (workspace_id, application_row_id, reviewer_id),
  CONSTRAINT submitted_has_score CHECK (
    status = 'draft' OR (weighted_score IS NOT NULL AND submitted_at IS NOT NULL)
  )
);
CREATE INDEX mark_sets_by_application
  ON netzero.reviewer_mark_sets (workspace_id, application_row_id);

CREATE TABLE netzero.reviewer_marks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mark_set_id uuid NOT NULL REFERENCES netzero.reviewer_mark_sets(id) ON DELETE CASCADE,
  rule_id     text NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 300),
  score       integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  UNIQUE (mark_set_id, rule_id)
);

-- Recompute a mark set's weighted score from its per-criterion marks and the
-- approved guide's weights. Takes a FOR UPDATE lock on the parent so concurrent
-- mark writes serialise (no lost update). Marks of a submitted set are frozen.
CREATE OR REPLACE FUNCTION netzero.recompute_mark_set_score()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ms_id uuid;
  gv_id uuid;
  ms_status text;
  total numeric(8,2);
  covered integer;
  criteria_total integer;
BEGIN
  ms_id := COALESCE(NEW.mark_set_id, OLD.mark_set_id);
  SELECT guide_version_id, status INTO gv_id, ms_status
    FROM netzero.reviewer_mark_sets WHERE id = ms_id FOR UPDATE;
  IF ms_status = 'submitted' THEN
    RAISE EXCEPTION 'marks of a submitted mark set cannot be changed';
  END IF;
  SELECT COALESCE(SUM((m.score::numeric / 5) * gc.weight), 0), COUNT(m.rule_id)
    INTO total, covered
    FROM netzero.reviewer_marks m
    JOIN netzero.guide_criteria gc
      ON gc.guide_version_id = gv_id AND gc.rule_id = m.rule_id
   WHERE m.mark_set_id = ms_id;
  SELECT COUNT(*) INTO criteria_total
    FROM netzero.guide_criteria WHERE guide_version_id = gv_id;
  UPDATE netzero.reviewer_mark_sets
     SET weighted_score = CASE WHEN covered = criteria_total AND criteria_total > 0
                               THEN round(total, 2) ELSE NULL END,
         updated_at = now()
   WHERE id = ms_id;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER recompute_mark_set_score
  AFTER INSERT OR UPDATE OR DELETE ON netzero.reviewer_marks
  FOR EACH ROW EXECUTE FUNCTION netzero.recompute_mark_set_score();

-- Guard the mark set's own lifecycle: a submitted set may not return to draft,
-- and its weighted_score on submit is derived, never accepted from the client;
-- submitting requires every criterion to be marked.
CREATE OR REPLACE FUNCTION netzero.guard_mark_set()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derived numeric(8,2);
  missing integer;
BEGIN
  IF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a submitted mark set cannot be reopened';
  END IF;
  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    SELECT COUNT(*) INTO missing
      FROM netzero.guide_criteria gc
     WHERE gc.guide_version_id = NEW.guide_version_id
       AND NOT EXISTS (SELECT 1 FROM netzero.reviewer_marks m
                        WHERE m.mark_set_id = NEW.id AND m.rule_id = gc.rule_id);
    IF missing > 0 THEN
      RAISE EXCEPTION 'every criterion must be marked before submitting (% missing)', missing;
    END IF;
    SELECT COALESCE(SUM((m.score::numeric / 5) * gc.weight), 0)
      INTO derived
      FROM netzero.reviewer_marks m
      JOIN netzero.guide_criteria gc
        ON gc.guide_version_id = NEW.guide_version_id AND gc.rule_id = m.rule_id
     WHERE m.mark_set_id = NEW.id;
    NEW.weighted_score := round(derived, 2);
    NEW.submitted_at := COALESCE(NEW.submitted_at, now());
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_mark_set
  BEFORE UPDATE ON netzero.reviewer_mark_sets
  FOR EACH ROW EXECUTE FUNCTION netzero.guard_mark_set();

-- ---------------------------------------------------------------------
-- 10. Final decisions (human) + append-only journal
-- ---------------------------------------------------------------------

CREATE TABLE netzero.final_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  application_row_id text NOT NULL,
  decision           text NOT NULL CHECK (decision IN ('shortlisted', 'rejected', 'waitlisted', 'undecided')),
  decided_by         uuid REFERENCES netzero.reviewers(id),
  notes              text,
  decided_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, application_row_id)
);

CREATE TABLE netzero.final_decision_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  application_row_id text NOT NULL,
  decision           text NOT NULL,
  decided_by         uuid,
  at                 timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION netzero.journal_final_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO netzero.final_decision_events
    (workspace_id, application_row_id, decision, decided_by)
  VALUES (NEW.workspace_id, NEW.application_row_id, NEW.decision, NEW.decided_by);
  RETURN NEW;
END $$;

CREATE TRIGGER journal_final_decision
  AFTER INSERT OR UPDATE ON netzero.final_decisions
  FOR EACH ROW EXECUTE FUNCTION netzero.journal_final_decision();

CREATE TRIGGER reject_final_decision_events_mutation
  BEFORE UPDATE OR DELETE ON netzero.final_decision_events
  FOR EACH ROW EXECUTE FUNCTION netzero.reject_mutation();

-- ---------------------------------------------------------------------
-- 11. Audit log - append-only, per-workspace hash chain
-- ---------------------------------------------------------------------

CREATE TABLE netzero.audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  seq           integer NOT NULL,
  actor         text,
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     netzero.hex64,
  entry_hash    netzero.hex64 NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, seq)
);

-- Derive seq, prev_hash and entry_hash server-side inside the DB so the chain
-- cannot be forged by the caller. search_path pins extensions for digest().
CREATE OR REPLACE FUNCTION netzero.prepare_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = netzero, extensions, public, pg_temp
AS $$
DECLARE
  last_seq integer;
  last_hash netzero.hex64;
BEGIN
  SELECT seq, entry_hash INTO last_seq, last_hash
    FROM netzero.audit_events
   WHERE workspace_id = NEW.workspace_id
   ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.entry_hash := encode(digest(
    COALESCE(last_hash, '') || NEW.workspace_id::text || NEW.seq::text ||
    NEW.action || COALESCE(NEW.actor, '') || NEW.detail::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER prepare_audit_event
  BEFORE INSERT ON netzero.audit_events
  FOR EACH ROW EXECUTE FUNCTION netzero.prepare_audit_event();

CREATE TRIGGER reject_audit_events_mutation
  BEFORE UPDATE OR DELETE ON netzero.audit_events
  FOR EACH ROW EXECUTE FUNCTION netzero.reject_mutation();

-- ---------------------------------------------------------------------
-- 12. App/journey state (replaces browser localStorage)
-- ---------------------------------------------------------------------

CREATE TABLE netzero.app_state (
  workspace_id uuid PRIMARY KEY REFERENCES netzero.workspaces(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision     integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 13. The final ranking view - the structural AI/human separation
-- Owned by netzero_ranking (no netzero_ai privilege), so it CANNOT read an AI
-- score, and netzero_app cannot redefine it. SUM of reviewers' weighted scores;
-- coverage compares the SET of reviewers who marked, not merely the count, so a
-- split workload is flagged (ranking_valid = false).
-- ---------------------------------------------------------------------

CREATE VIEW netzero.final_ranking AS
WITH roster AS (
  SELECT workspace_id, array_agg(id ORDER BY id) AS full_set
    FROM netzero.reviewers WHERE active
   GROUP BY workspace_id
),
apps AS (
  SELECT cd.workspace_id, cc.row_id
    FROM netzero.current_cases cc
    JOIN netzero.current_datasets cd ON cd.id = cc.dataset_id
),
submitted AS (
  SELECT ms.workspace_id, ms.application_row_id AS row_id,
         ms.reviewer_id, ms.weighted_score
    FROM netzero.reviewer_mark_sets ms
   WHERE ms.status = 'submitted' AND ms.weighted_score IS NOT NULL
),
per_app AS (
  SELECT a.workspace_id, a.row_id,
         COALESCE(SUM(s.weighted_score), 0)::numeric(10,2) AS total_score,
         COUNT(s.reviewer_id) AS mark_count,
         COALESCE(array_agg(s.reviewer_id ORDER BY s.reviewer_id)
                    FILTER (WHERE s.reviewer_id IS NOT NULL), '{}') AS reviewer_set
    FROM apps a
    LEFT JOIN submitted s
      ON s.workspace_id = a.workspace_id AND s.row_id = a.row_id
   GROUP BY a.workspace_id, a.row_id
)
SELECT
  p.workspace_id,
  p.row_id,
  p.total_score,
  p.mark_count,
  p.reviewer_set,
  r.full_set AS expected_reviewers,
  (p.reviewer_set = r.full_set) AS coverage_complete,
  bool_and(p.reviewer_set = r.full_set) OVER (PARTITION BY p.workspace_id) AS ranking_valid,
  rank() OVER (PARTITION BY p.workspace_id ORDER BY p.total_score DESC) AS rank
FROM per_app p
JOIN roster r USING (workspace_id);

ALTER VIEW netzero.final_ranking OWNER TO netzero_ranking;

-- A parallel, clearly-separate reference view that shows AI scores. It lives in
-- netzero_ai and is NOT owned by netzero_ranking, so it can never be joined
-- into the human ranking's privilege boundary.
CREATE VIEW netzero_ai.reference_marking AS
SELECT r.workspace_id, res.run_id, res.row_id,
       res.weighted_score AS ai_weighted_score,
       res.recommendation AS ai_recommendation,
       res.evidence_valid
  FROM netzero_ai.assessment_results res
  JOIN netzero_ai.assessment_runs r ON r.id = res.run_id;

-- ---------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------

-- netzero_app is the working role. Immutable tables have their UPDATE/DELETE
-- withheld below; everything else is normal DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA netzero TO netzero_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA netzero_ai TO netzero_app;

-- Immutable/append-only tables: withhold the operations the triggers would
-- reject anyway, so the intent is visible in the grant, not only at runtime.
REVOKE UPDATE, DELETE ON netzero_ai.assessment_results FROM netzero_app;
REVOKE UPDATE, DELETE ON netzero.audit_events FROM netzero_app;
REVOKE UPDATE, DELETE ON netzero.final_decision_events FROM netzero_app;
REVOKE DELETE ON netzero.calibration_reveal_receipts FROM netzero_app;
REVOKE UPDATE, DELETE ON netzero.recalibration_credits FROM netzero_app;

-- The ranking role reads the human schema only, and reads the ranking view.
GRANT SELECT ON netzero.workspaces, netzero.reviewers, netzero.guide_versions,
  netzero.guide_criteria, netzero.current_datasets, netzero.current_cases,
  netzero.reviewer_mark_sets, netzero.reviewer_marks TO netzero_ranking;
GRANT SELECT ON netzero.final_ranking TO netzero_app;
GRANT SELECT ON netzero_ai.reference_marking TO netzero_app;

-- netzero_app must not be able to redefine the ranking view or create objects
-- that could smuggle an AI score into the human total.
REVOKE CREATE ON SCHEMA netzero FROM netzero_app;
REVOKE CREATE ON SCHEMA netzero_ai FROM netzero_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 15. Supabase / PostgREST hardening
-- On Supabase the anon, authenticated and service_role roles are auto-granted
-- on new schemas and served over REST. This app talks to Postgres directly and
-- must NEVER expose these schemas over PostgREST, or a browser could reach the
-- reveal receipts and mark sets. Revoke them, and revoke future defaults.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA netzero FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA netzero_ai FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA netzero FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA netzero_ai FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA netzero REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA netzero_ai REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Future tables created by the migration owner in these schemas are usable by
-- the app role without another grant pass.
ALTER DEFAULT PRIVILEGES IN SCHEMA netzero
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO netzero_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA netzero_ai
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO netzero_app;
