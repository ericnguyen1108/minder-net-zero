-- ---------------------------------------------------------------------
-- Migration 0006: current-application seal + complete Phase 5 documents.
--
-- Current imports are re-sealed by the API from the raw spreadsheet.  The
-- complete metadata receipt is retained while AI-visible answers and organiser
-- identity stay physically separated.
--
-- Phase 5 keeps its complete, revisioned workflow document beside the existing
-- normalised batches and immutable assessment results.  Scalar columns remain
-- server-owned projections for querying and the human/AI schema boundary.
-- ---------------------------------------------------------------------

ALTER TABLE netzero.current_datasets
  ADD COLUMN IF NOT EXISTS integrity_hash netzero.hex64,
  ADD COLUMN IF NOT EXISTS metadata jsonb,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;

ALTER TABLE netzero.current_datasets
  DROP CONSTRAINT IF EXISTS current_datasets_metadata_object_ck;
ALTER TABLE netzero.current_datasets
  ADD CONSTRAINT current_datasets_metadata_object_ck
  CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS current_datasets_one_active_per_workspace
  ON netzero.current_datasets (workspace_id) WHERE active;

ALTER TABLE netzero.current_cases
  ADD COLUMN IF NOT EXISTS content_hash netzero.hex64;

ALTER TABLE netzero.safeguard_approvals
  ADD COLUMN IF NOT EXISTS client_approval_id text,
  ADD COLUMN IF NOT EXISTS approval_hash netzero.hex64;

CREATE UNIQUE INDEX IF NOT EXISTS safeguard_approvals_one_per_session
  ON netzero.safeguard_approvals (workspace_id, session_id);

CREATE UNIQUE INDEX IF NOT EXISTS safeguard_approvals_client_id
  ON netzero.safeguard_approvals (client_approval_id)
  WHERE client_approval_id IS NOT NULL;

ALTER TABLE netzero_ai.assessment_runs
  ADD COLUMN IF NOT EXISTS run_document jsonb;

ALTER TABLE netzero_ai.assessment_runs
  DROP CONSTRAINT IF EXISTS assessment_runs_status_check;
ALTER TABLE netzero_ai.assessment_runs
  ADD CONSTRAINT assessment_runs_status_check
  CHECK (status IN (
    'ready', 'running', 'paused', 'complete', 'auditing',
    'ready_for_human_review', 'invalid'
  ));

ALTER TABLE netzero_ai.assessment_runs
  DROP CONSTRAINT IF EXISTS assessment_runs_document_object_ck;
ALTER TABLE netzero_ai.assessment_runs
  ADD CONSTRAINT assessment_runs_document_object_ck
  CHECK (run_document IS NULL OR jsonb_typeof(run_document) = 'object');

ALTER TABLE netzero_ai.assessment_batches
  ADD COLUMN IF NOT EXISTS client_batch_id text,
  ADD COLUMN IF NOT EXISTS row_ids jsonb,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE netzero_ai.assessment_batches
  ALTER COLUMN lease_token TYPE text USING lease_token::text;

CREATE UNIQUE INDEX IF NOT EXISTS assessment_batches_client_id
  ON netzero_ai.assessment_batches (run_id, client_batch_id)
  WHERE client_batch_id IS NOT NULL;

ALTER TABLE netzero_ai.assessment_batches
  DROP CONSTRAINT IF EXISTS assessment_batches_row_ids_array_ck;
ALTER TABLE netzero_ai.assessment_batches
  ADD CONSTRAINT assessment_batches_row_ids_array_ck
  CHECK (row_ids IS NULL OR jsonb_typeof(row_ids) = 'array');
