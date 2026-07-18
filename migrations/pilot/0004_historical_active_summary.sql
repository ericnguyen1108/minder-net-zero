-- ---------------------------------------------------------------------
-- Migration 0004: historical dataset active-pointer + stored summary +
-- guide version.
--
-- Additive only. The Phase E historical-domain port moves final authority for
-- the calibration input onto the server: the client reads the active import
-- summary and the dataset binding straight from these columns instead of
-- recomputing them from browser storage. netzero_app already holds SELECT/
-- INSERT/UPDATE/DELETE on every netzero table (migration 0003), and new columns
-- inherit those grants, so no additional GRANT is required here.
-- ---------------------------------------------------------------------

ALTER TABLE netzero.historical_datasets
  ADD COLUMN IF NOT EXISTS summary       jsonb,
  ADD COLUMN IF NOT EXISTS guide_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS active        boolean NOT NULL DEFAULT true;

-- At most one active historical dataset per workspace — the "current" calibration
-- input the practice/assessment flow binds to. Demote any pre-existing duplicates
-- (keeping the newest per workspace) so the partial unique index can be built on
-- existing data.
UPDATE netzero.historical_datasets d SET active = false
 WHERE d.active
   AND EXISTS (
     SELECT 1 FROM netzero.historical_datasets d2
      WHERE d2.workspace_id = d.workspace_id
        AND (d2.created_at, d2.id) > (d.created_at, d.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS historical_active_per_workspace
  ON netzero.historical_datasets (workspace_id) WHERE active;
