-- ---------------------------------------------------------------------
-- Migration 0005: Phase 4 session document + durable reveal lineage.
--
-- The browser Phase4Session is richer than the original scaffold columns.
-- Store that complete state machine as one JSON document while retaining the
-- scalar columns as server-controlled projections. The API writes the document
-- with revision CAS and never accepts revealed outcomes through a normal save.
--
-- Reveal receipts and recalibration credits must outlive a deleted/re-imported
-- historical dataset. Otherwise deleting the dataset would cascade through the
-- calibration session and silently reopen the one-use seal for the same file.
-- ---------------------------------------------------------------------

ALTER TABLE netzero.calibration_sessions
  ADD COLUMN IF NOT EXISTS session_document jsonb;

ALTER TABLE netzero.calibration_sessions
  DROP CONSTRAINT IF EXISTS calibration_sessions_document_object_ck;
ALTER TABLE netzero.calibration_sessions
  ADD CONSTRAINT calibration_sessions_document_object_ck
  CHECK (session_document IS NULL OR jsonb_typeof(session_document) = 'object');

ALTER TABLE netzero.calibration_reveal_receipts
  DROP CONSTRAINT IF EXISTS calibration_reveal_receipts_session_id_fkey;
ALTER TABLE netzero.calibration_reveal_receipts
  ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE netzero.calibration_reveal_receipts
  ADD CONSTRAINT calibration_reveal_receipts_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES netzero.calibration_sessions(id) ON DELETE SET NULL;

ALTER TABLE netzero.recalibration_credits
  DROP CONSTRAINT IF EXISTS recalibration_credits_session_id_fkey;
ALTER TABLE netzero.recalibration_credits
  ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE netzero.recalibration_credits
  ADD CONSTRAINT recalibration_credits_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES netzero.calibration_sessions(id) ON DELETE SET NULL;
