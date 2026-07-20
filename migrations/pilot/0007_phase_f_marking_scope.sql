-- ---------------------------------------------------------------------
-- Migration 0007: Phase F human-marking scope.
--
-- A mark set must belong to the exact frozen current dataset it reviewed.
-- The original foundation keyed mark sets only by workspace + opaque row id
-- and the ranking view included every historical current dataset. That was
-- sufficient for repository prototyping, but unsafe for an organiser UI:
-- replacing the frozen cohort could mix old submissions into the new ranking.
--
-- Existing pre-Phase-F mark sets remain as unscoped legacy evidence (NULL
-- current_dataset_id) and are deliberately excluded. There is no honest way to
-- infer their dataset if more than one old cohort reused the same row id.
-- Every new API write is dataset-bound and the ranking reads only the single
-- active current dataset plus active reviewers.
-- ---------------------------------------------------------------------

ALTER TABLE netzero.reviewer_mark_sets
  ADD COLUMN IF NOT EXISTS current_dataset_id uuid
    REFERENCES netzero.current_datasets(id) ON DELETE CASCADE;

ALTER TABLE netzero.reviewer_mark_sets
  DROP CONSTRAINT IF EXISTS reviewer_mark_sets_workspace_id_application_row_id_reviewer_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS reviewer_mark_sets_dataset_reviewer_key
  ON netzero.reviewer_mark_sets
    (workspace_id, current_dataset_id, application_row_id, reviewer_id, guide_version_id)
  WHERE current_dataset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reviewer_mark_sets_active_dataset
  ON netzero.reviewer_mark_sets (workspace_id, current_dataset_id, status);

DROP VIEW netzero.final_ranking;

CREATE VIEW netzero.final_ranking AS
WITH roster AS (
  SELECT workspace_id, array_agg(id ORDER BY id) AS full_set
    FROM netzero.reviewers
   WHERE active
   GROUP BY workspace_id
),
active_guide AS (
  SELECT DISTINCT ON (workspace_id) workspace_id, id AS guide_version_id
    FROM netzero.guide_versions
   WHERE status = 'approved'
   ORDER BY workspace_id, version DESC
),
apps AS (
  SELECT cd.workspace_id, cd.id AS current_dataset_id, cc.row_id
    FROM netzero.current_cases cc
    JOIN netzero.current_datasets cd ON cd.id = cc.dataset_id
   WHERE cd.active
),
submitted AS (
  SELECT ms.workspace_id, ms.current_dataset_id,
         ms.application_row_id AS row_id, ms.reviewer_id, ms.weighted_score
    FROM netzero.reviewer_mark_sets ms
    JOIN netzero.reviewers reviewer
      ON reviewer.id = ms.reviewer_id
     AND reviewer.workspace_id = ms.workspace_id
     AND reviewer.active
    JOIN active_guide guide
      ON guide.workspace_id = ms.workspace_id
     AND guide.guide_version_id = ms.guide_version_id
   WHERE ms.status = 'submitted'
     AND ms.weighted_score IS NOT NULL
     AND ms.current_dataset_id IS NOT NULL
),
per_app AS (
  SELECT a.workspace_id, a.current_dataset_id, a.row_id,
         COALESCE(SUM(s.weighted_score), 0)::numeric(10,2) AS total_score,
         COUNT(s.reviewer_id) AS mark_count,
         COALESCE(array_agg(s.reviewer_id ORDER BY s.reviewer_id)
                    FILTER (WHERE s.reviewer_id IS NOT NULL), '{}') AS reviewer_set
    FROM apps a
    LEFT JOIN submitted s
      ON s.workspace_id = a.workspace_id
     AND s.current_dataset_id = a.current_dataset_id
     AND s.row_id = a.row_id
   GROUP BY a.workspace_id, a.current_dataset_id, a.row_id
)
SELECT
  p.workspace_id,
  p.current_dataset_id,
  p.row_id,
  p.total_score,
  p.mark_count,
  p.reviewer_set,
  r.full_set AS expected_reviewers,
  (p.reviewer_set = r.full_set) AS coverage_complete,
  bool_and(p.reviewer_set = r.full_set) OVER (PARTITION BY p.workspace_id, p.current_dataset_id)
    AS ranking_valid,
  rank() OVER (
    PARTITION BY p.workspace_id, p.current_dataset_id
    ORDER BY p.total_score DESC
  ) AS rank
FROM per_app p
JOIN roster r USING (workspace_id);

ALTER VIEW netzero.final_ranking OWNER TO netzero_ranking;
GRANT SELECT ON netzero.final_ranking TO netzero_app;
