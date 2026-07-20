/**
 * Human-side pilot repository: reviewers, the approved guide, per-criterion
 * marks, the SUM ranking with coverage flagging, and human final decisions.
 *
 * Design contract (owner decisions):
 *   - One shared login; reviewer identity is a dropdown roster, not auth.
 *   - Marks are per criterion (1-5), weighted by the SAME approved guide the AI
 *     reference uses. The weighted score is DERIVED by a DB trigger, never sent
 *     from the client, so a forged total is overwritten.
 *   - The final ranking is the SUM of reviewers' weighted scores. It is only
 *     valid when every application carries the full reviewer set, which the
 *     view reports as ranking_valid; a split workload flags false.
 *   - AI output is reference/filter only and is read from a physically separate
 *     view (netzero_ai.reference_marking); it can never enter the ranking.
 */

import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";

export type Reviewer = { id: string; displayName: string; active: boolean };

export type GuideCriterion = { ruleId: string; title: string; weight: number; position: number };

export type ApprovedGuide = {
  guideVersionId: string;
  version: number;
  contentHash: string;
  selectionMode: "top_n" | "minimum_score" | "both";
  shortlistTarget: number | null;
  minimumScore: number | null;
  criteria: GuideCriterion[];
};

export type MarkSetState = {
  applicationRowId: string;
  reviewerId: string;
  guideVersionId: string;
  status: "draft" | "submitted";
  weightedScore: number | null;
  scores: Record<string, number>;
};

export type RankingRow = {
  rowId: string;
  totalScore: number;
  markCount: number;
  coverageComplete: boolean;
  rankingValid: boolean;
  rank: number;
};

export type AiReference = {
  rowId: string;
  aiWeightedScore: number | null;
  aiRecommendation: string;
  evidenceValid: boolean;
};

// --------------------------------------------------------------- workspace ---

/** Gets the pilot workspace by name, creating it on first use. */
export async function ensureWorkspace(
  name: string,
  expectedMarksPerApplication: number,
  sql: Sql = pilotSql(),
): Promise<{ id: string; expectedMarksPerApplication: number }> {
  const [existing] = await sql<{ id: string; expected: number }[]>`
    SELECT id, expected_marks_per_application AS expected
      FROM netzero.workspaces WHERE name = ${name} ORDER BY created_at LIMIT 1`;
  if (existing) {
    return { id: existing.id, expectedMarksPerApplication: existing.expected };
  }
  const [created] = await sql<{ id: string; expected: number }[]>`
    INSERT INTO netzero.workspaces (name, expected_marks_per_application)
    VALUES (${name}, ${expectedMarksPerApplication})
    RETURNING id, expected_marks_per_application AS expected`;
  return { id: created.id, expectedMarksPerApplication: created.expected };
}

// --------------------------------------------------------------- reviewers ---

export async function listReviewers(workspaceId: string, sql: Sql = pilotSql()): Promise<Reviewer[]> {
  return sql<Reviewer[]>`
    SELECT id, display_name AS "displayName", active
      FROM netzero.reviewers
     WHERE workspace_id = ${workspaceId}
     ORDER BY active DESC, display_name`;
}

export async function addReviewer(
  workspaceId: string,
  displayName: string,
  sql: Sql = pilotSql(),
): Promise<Reviewer> {
  const name = displayName.trim();
  if (!name || name.length > 120) throw new Error("Enter a reviewer name between 1 and 120 characters.");
  const [row] = await sql<Reviewer[]>`
    INSERT INTO netzero.reviewers (workspace_id, display_name, active)
    VALUES (${workspaceId}, ${name}, true)
    ON CONFLICT (workspace_id, display_name)
      DO UPDATE SET active = true
    RETURNING id, display_name AS "displayName", active`;
  return row;
}

/**
 * Find-or-create a roster reviewer by display name, returning its row. Used to
 * attribute a final decision to a roster reviewer before the Phase F dropdown
 * exists: the organiser's typed name resolves to a reviewer in the SAME table
 * the dropdown will later read, so `final_decisions.decided_by` is always a real
 * reviewer FK. Idempotent (unique on workspace_id + display_name).
 *
 * A newly-seeded decider is created INACTIVE. `active` means "an expected marker"
 * — the final_ranking view builds its coverage roster from active reviewers only
 * — so a decision-only person (an organiser who decides but never marks) must not
 * enlarge that roster, or every application would read coverage_complete = false.
 * An existing reviewer's active flag is never changed (the ON CONFLICT is a
 * no-op), so a real marker who also decides stays active; an inactive decider can
 * be promoted later via setReviewerActive. listReviewers still returns inactive
 * rows, so the decider remains selectable in the Phase F dropdown.
 */
export async function ensureReviewerByName(
  workspaceId: string,
  displayName: string,
  sql: Sql = pilotSql(),
): Promise<Reviewer> {
  const name = displayName.trim();
  if (!name || name.length > 120) throw new Error("A reviewer name is required.");
  const [row] = await sql<Reviewer[]>`
    INSERT INTO netzero.reviewers (workspace_id, display_name, active)
    VALUES (${workspaceId}, ${name}, false)
    ON CONFLICT (workspace_id, display_name)
      DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id, display_name AS "displayName", active`;
  return row;
}

export async function setReviewerActive(
  workspaceId: string,
  reviewerId: string,
  active: boolean,
  sql: Sql = pilotSql(),
): Promise<void> {
  const rows = await sql`
    UPDATE netzero.reviewers SET active = ${active}
     WHERE id = ${reviewerId} AND workspace_id = ${workspaceId}
    RETURNING id`;
  if (rows.length === 0) throw new Error("That reviewer is not part of this competition.");
}

// ------------------------------------------------------------------- guide ---

export async function loadApprovedGuide(
  workspaceId: string,
  sql: Sql = pilotSql(),
): Promise<ApprovedGuide | null> {
  const [guide] = await sql<
    {
      guideVersionId: string;
      version: number;
      contentHash: string;
      selectionMode: ApprovedGuide["selectionMode"];
      shortlistTarget: number | null;
      minimumScore: number | null;
    }[]
  >`
    SELECT id AS "guideVersionId", version, content_hash AS "contentHash",
           selection_mode AS "selectionMode",
           shortlist_target AS "shortlistTarget", minimum_score AS "minimumScore"
      FROM netzero.guide_versions
     WHERE workspace_id = ${workspaceId} AND status = 'approved'
     ORDER BY version DESC LIMIT 1`;
  if (!guide) return null;
  const criteria = await sql<GuideCriterion[]>`
    SELECT rule_id AS "ruleId", title, weight, position
      FROM netzero.guide_criteria
     WHERE guide_version_id = ${guide.guideVersionId}
     ORDER BY position`;
  return { ...guide, criteria };
}

/**
 * Copies the browser-approved pilot guide into the human-marking schema.
 * Content hashes and version numbers are immutable: replaying the same guide is
 * idempotent, a higher version creates a new approved row, and drift at an
 * already-approved version fails closed.
 */
export async function syncApprovedGuide(
  workspaceId: string,
  input: {
    version: number;
    rules: unknown;
    selectionMode: ApprovedGuide["selectionMode"];
    shortlistTarget: number | null;
    minimumScore: number | null;
    contentHash: string;
    criteria: GuideCriterion[];
    approvedByName: string;
  },
): Promise<ApprovedGuide> {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error("The approved Decision Guide version is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new Error("The approved Decision Guide receipt is invalid.");
  }
  const approverName = input.approvedByName.trim();
  if (!approverName || approverName.length > 120) {
    throw new Error("The approved Decision Guide must name its approver.");
  }
  if (
    ((input.selectionMode === "top_n" || input.selectionMode === "both") &&
      (!Number.isInteger(input.shortlistTarget) || (input.shortlistTarget ?? 0) < 1)) ||
    ((input.selectionMode === "minimum_score" || input.selectionMode === "both") &&
      (!Number.isInteger(input.minimumScore) ||
        (input.minimumScore ?? 0) < 1 ||
        (input.minimumScore ?? 0) > 100))
  ) {
    throw new Error("The approved Decision Guide selection rule is invalid.");
  }
  if (
    input.criteria.length === 0 ||
    new Set(input.criteria.map((criterion) => criterion.ruleId)).size !== input.criteria.length ||
    input.criteria.some(
      (criterion, index) =>
        !criterion.ruleId.trim() ||
        !criterion.title.trim() ||
        !Number.isInteger(criterion.weight) ||
        criterion.weight < 1 ||
        criterion.weight > 100 ||
        criterion.position !== index,
    ) ||
    input.criteria.reduce((total, criterion) => total + criterion.weight, 0) !== 100
  ) {
    throw new Error("The approved Decision Guide criteria are incomplete or do not total 100%.");
  }

  return withPilotTransaction(async (tx) => {
    const [sameVersion] = await tx<
      { guideVersionId: string; status: "draft" | "approved"; contentHash: string }[]
    >`
      SELECT id AS "guideVersionId", status, content_hash AS "contentHash"
        FROM netzero.guide_versions
       WHERE workspace_id = ${workspaceId} AND version = ${input.version}
       FOR UPDATE`;

    if (sameVersion?.status === "approved") {
      if (sameVersion.contentHash !== input.contentHash) {
        throw new Error(
          "This guide version is already approved centrally with different content. Stop and reconcile the Decision Guide.",
        );
      }
      const guide = await loadApprovedGuide(workspaceId, tx);
      if (!guide || guide.guideVersionId !== sameVersion.guideVersionId) {
        throw new Error("A newer approved Decision Guide is already active centrally.");
      }
      return guide;
    }

    const [newer] = await tx<{ version: number }[]>`
      SELECT version FROM netzero.guide_versions
       WHERE workspace_id = ${workspaceId} AND status = 'approved' AND version > ${input.version}
       ORDER BY version DESC LIMIT 1`;
    if (newer) {
      throw new Error(
        `Decision Guide version ${newer.version} is already approved centrally; an older browser copy cannot replace it.`,
      );
    }

    const [approver] = await tx<Reviewer[]>`
      INSERT INTO netzero.reviewers (workspace_id, display_name, active)
      VALUES (${workspaceId}, ${approverName}, false)
      ON CONFLICT (workspace_id, display_name)
        DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING id, display_name AS "displayName", active`;

    let guideVersionId = sameVersion?.guideVersionId;
    if (guideVersionId) {
      await tx`
        UPDATE netzero.guide_versions SET
          rules = ${tx.json(JSON.parse(JSON.stringify(input.rules)))},
          selection_mode = ${input.selectionMode},
          shortlist_target = ${input.shortlistTarget},
          minimum_score = ${input.minimumScore},
          content_hash = ${input.contentHash}
        WHERE id = ${guideVersionId} AND status = 'draft'`;
      await tx`DELETE FROM netzero.guide_criteria WHERE guide_version_id = ${guideVersionId}`;
    } else {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO netzero.guide_versions
          (workspace_id, version, status, rules, selection_mode, shortlist_target,
           minimum_score, content_hash)
        VALUES (${workspaceId}, ${input.version}, 'draft',
                ${tx.json(JSON.parse(JSON.stringify(input.rules)))}, ${input.selectionMode},
                ${input.shortlistTarget}, ${input.minimumScore}, ${input.contentHash})
        RETURNING id`;
      guideVersionId = created.id;
    }
    for (const criterion of input.criteria) {
      await tx`
        INSERT INTO netzero.guide_criteria (guide_version_id, rule_id, title, weight, position)
        VALUES (${guideVersionId}, ${criterion.ruleId}, ${criterion.title},
                ${criterion.weight}, ${criterion.position})`;
    }
    await tx`
      UPDATE netzero.guide_versions
         SET status = 'approved', approved_by = ${approver.id}, approved_at = now()
       WHERE id = ${guideVersionId} AND status = 'draft'`;

    const guide = await loadApprovedGuide(workspaceId, tx);
    if (!guide || guide.guideVersionId !== guideVersionId) {
      throw new Error("The approved Decision Guide was not available after saving.");
    }
    return guide;
  });
}

/**
 * Saves the single editable draft guide for the workspace (creating it, or
 * replacing the existing draft's fields and criteria). Approved versions are
 * never touched. Returns the draft's id and version.
 */
export async function saveGuideDraft(
  workspaceId: string,
  input: {
    rules: unknown;
    selectionMode: "top_n" | "minimum_score" | "both";
    shortlistTarget: number | null;
    minimumScore: number | null;
    contentHash: string;
    criteria: GuideCriterion[];
  },
): Promise<{ guideVersionId: string; version: number }> {
  return withPilotTransaction(async (tx) => {
    const [draft] = await tx<{ id: string; version: number }[]>`
      SELECT id, version FROM netzero.guide_versions
       WHERE workspace_id = ${workspaceId} AND status = 'draft'
       ORDER BY version DESC LIMIT 1`;
    let guideVersionId: string;
    let version: number;
    if (draft) {
      guideVersionId = draft.id;
      version = draft.version;
      await tx`
        UPDATE netzero.guide_versions SET
          rules = ${tx.json(JSON.parse(JSON.stringify(input.rules)))},
          selection_mode = ${input.selectionMode},
          shortlist_target = ${input.shortlistTarget},
          minimum_score = ${input.minimumScore},
          content_hash = ${input.contentHash}
        WHERE id = ${guideVersionId}`;
      await tx`DELETE FROM netzero.guide_criteria WHERE guide_version_id = ${guideVersionId}`;
    } else {
      const [{ next }] = await tx<{ next: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next FROM netzero.guide_versions WHERE workspace_id = ${workspaceId}`;
      version = next;
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO netzero.guide_versions
          (workspace_id, version, status, rules, selection_mode, shortlist_target, minimum_score, content_hash)
        VALUES (${workspaceId}, ${version}, 'draft', ${tx.json(JSON.parse(JSON.stringify(input.rules)))},
                ${input.selectionMode}, ${input.shortlistTarget}, ${input.minimumScore}, ${input.contentHash})
        RETURNING id`;
      guideVersionId = created.id;
    }
    for (const c of input.criteria) {
      await tx`
        INSERT INTO netzero.guide_criteria (guide_version_id, rule_id, title, weight, position)
        VALUES (${guideVersionId}, ${c.ruleId}, ${c.title}, ${c.weight}, ${c.position})`;
    }
    return { guideVersionId, version };
  });
}

/** Approves (and freezes) the draft guide. Criterion weights must total 100. */
export async function approveGuide(
  guideVersionId: string,
  reviewerId: string,
  sql: Sql = pilotSql(),
): Promise<void> {
  const [sum] = await sql<{ total: number }[]>`
    SELECT COALESCE(SUM(weight), 0)::int AS total FROM netzero.guide_criteria
     WHERE guide_version_id = ${guideVersionId}`;
  if (sum.total !== 100) {
    throw new Error(`Criterion weights must total 100 before approval (currently ${sum.total}).`);
  }
  const rows = await sql`
    UPDATE netzero.guide_versions guide
       SET status = 'approved', approved_by = ${reviewerId}, approved_at = now()
      FROM netzero.reviewers reviewer
     WHERE guide.id = ${guideVersionId} AND guide.status = 'draft'
       AND reviewer.id = ${reviewerId}
       AND reviewer.workspace_id = guide.workspace_id
    RETURNING guide.id`;
  if (rows.length === 0) throw new Error("No draft guide to approve (already approved or missing).");
}

// ------------------------------------------------------------------- marks ---

/**
 * Records or updates one reviewer's score for one criterion on one application,
 * in a draft mark set. The DB trigger recomputes the weighted score. Throws if
 * the mark set has already been submitted.
 */
export async function upsertMark(
  input: {
    workspaceId: string;
    applicationRowId: string;
    reviewerId: string;
    guideVersionId: string;
    ruleId: string;
    score: number;
  },
): Promise<void> {
  await withPilotTransaction(async (tx) => {
    const [markSet] = await tx<{ id: string; status: string }[]>`
      INSERT INTO netzero.reviewer_mark_sets
        (workspace_id, current_dataset_id, application_row_id, reviewer_id, guide_version_id)
      SELECT ${input.workspaceId}, dataset.id, application.row_id, reviewer.id, guide.id
        FROM netzero.current_datasets dataset
        JOIN netzero.current_cases application ON application.dataset_id = dataset.id
        JOIN netzero.reviewers reviewer
          ON reviewer.id = ${input.reviewerId}
         AND reviewer.workspace_id = dataset.workspace_id
         AND reviewer.active
        JOIN netzero.guide_versions guide
          ON guide.id = ${input.guideVersionId}
         AND guide.workspace_id = dataset.workspace_id
         AND guide.status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM netzero.guide_versions newer
            WHERE newer.workspace_id = guide.workspace_id
              AND newer.status = 'approved'
              AND newer.version > guide.version
         )
        JOIN netzero.guide_criteria criterion
          ON criterion.guide_version_id = guide.id
         AND criterion.rule_id = ${input.ruleId}
       WHERE dataset.workspace_id = ${input.workspaceId}
         AND dataset.active
         AND application.row_id = ${input.applicationRowId}
      ON CONFLICT (workspace_id, current_dataset_id, application_row_id, reviewer_id, guide_version_id)
        WHERE current_dataset_id IS NOT NULL
        DO UPDATE SET updated_at = now()
      RETURNING id, status`;
    if (!markSet) {
      throw new Error("The active application, reviewer or approved guide is not available for marking.");
    }
    if (markSet.status === "submitted") {
      throw new Error("This reviewer has already submitted marks for this application.");
    }
    await tx`
      INSERT INTO netzero.reviewer_marks (mark_set_id, rule_id, score)
      VALUES (${markSet.id}, ${input.ruleId}, ${input.score})
      ON CONFLICT (mark_set_id, rule_id) DO UPDATE SET score = EXCLUDED.score`;
  });
}

/**
 * Submits (freezes) a reviewer's mark set for an application. The DB trigger
 * requires every criterion to be marked and derives the final weighted score;
 * this call surfaces those errors verbatim.
 */
export async function submitMarkSet(
  workspaceId: string,
  applicationRowId: string,
  reviewerId: string,
  guideVersionId: string,
  sql: Sql = pilotSql(),
): Promise<{ weightedScore: number }> {
  const [row] = await sql<{ weightedScore: string }[]>`
    UPDATE netzero.reviewer_mark_sets mark_set
       SET status = 'submitted'
      FROM netzero.current_datasets dataset, netzero.reviewers reviewer
     WHERE mark_set.workspace_id = ${workspaceId}
       AND mark_set.current_dataset_id = dataset.id
       AND dataset.workspace_id = ${workspaceId} AND dataset.active
       AND mark_set.application_row_id = ${applicationRowId}
       AND mark_set.reviewer_id = ${reviewerId}
       AND mark_set.guide_version_id = ${guideVersionId}
       AND NOT EXISTS (
         SELECT 1 FROM netzero.guide_versions newer
          JOIN netzero.guide_versions selected ON selected.id = mark_set.guide_version_id
         WHERE newer.workspace_id = selected.workspace_id
           AND newer.status = 'approved'
           AND newer.version > selected.version
       )
       AND reviewer.id = mark_set.reviewer_id
       AND reviewer.workspace_id = ${workspaceId} AND reviewer.active
       AND mark_set.status = 'draft'
    RETURNING mark_set.weighted_score AS "weightedScore"`;
  if (!row) {
    throw new Error("No draft marks to submit for this reviewer and application.");
  }
  return { weightedScore: Number(row.weightedScore) };
}

/** Draft and submitted marks for the single active current dataset. */
export async function loadMarkSets(
  workspaceId: string,
  sql: Sql = pilotSql(),
): Promise<MarkSetState[]> {
  const rows = await sql<
    (Omit<MarkSetState, "weightedScore"> & { weightedScore: string | null })[]
  >`
    SELECT mark_set.application_row_id AS "applicationRowId",
           mark_set.reviewer_id AS "reviewerId",
           mark_set.guide_version_id AS "guideVersionId",
           mark_set.status,
           mark_set.weighted_score AS "weightedScore",
           COALESCE(
             jsonb_object_agg(mark.rule_id, mark.score)
               FILTER (WHERE mark.rule_id IS NOT NULL),
             '{}'::jsonb
           ) AS scores
      FROM netzero.reviewer_mark_sets mark_set
      JOIN netzero.current_datasets dataset
        ON dataset.id = mark_set.current_dataset_id
       AND dataset.workspace_id = mark_set.workspace_id
       AND dataset.active
      JOIN netzero.guide_versions guide
        ON guide.id = mark_set.guide_version_id
       AND guide.workspace_id = mark_set.workspace_id
       AND guide.status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM netzero.guide_versions newer
          WHERE newer.workspace_id = guide.workspace_id
            AND newer.status = 'approved'
            AND newer.version > guide.version
       )
      LEFT JOIN netzero.reviewer_marks mark ON mark.mark_set_id = mark_set.id
     WHERE mark_set.workspace_id = ${workspaceId}
     GROUP BY mark_set.id
     ORDER BY mark_set.application_row_id, mark_set.reviewer_id`;
  return rows.map((row) => ({
    ...row,
    weightedScore: row.weightedScore === null ? null : Number(row.weightedScore),
  }));
}

// ----------------------------------------------------------------- ranking ---

/**
 * The combined ranking: SUM of reviewers' weighted scores per application, with
 * the coverage flag. `rankingValid` is false whenever any application is missing
 * a reviewer from the full active roster (e.g. a split workload), because SUM is
 * only comparable under equal coverage.
 */
export async function loadRanking(workspaceId: string, sql: Sql = pilotSql()): Promise<RankingRow[]> {
  const rows = await sql<
    {
      rowId: string;
      totalScore: string;
      markCount: string;
      coverageComplete: boolean;
      rankingValid: boolean;
      rank: string;
    }[]
  >`
    SELECT row_id AS "rowId", total_score AS "totalScore", mark_count AS "markCount",
           coverage_complete AS "coverageComplete", ranking_valid AS "rankingValid", rank
      FROM netzero.final_ranking
     WHERE workspace_id = ${workspaceId}
     ORDER BY rank, row_id`;
  // postgres-js returns numeric/bigint as strings; a repository returns numbers.
  return rows.map((r) => ({
    rowId: r.rowId,
    totalScore: Number(r.totalScore),
    markCount: Number(r.markCount),
    coverageComplete: r.coverageComplete,
    rankingValid: r.rankingValid,
    rank: Number(r.rank),
  }));
}

/** AI recommendations for the same applications - REFERENCE ONLY. */
export async function loadAiReference(workspaceId: string, sql: Sql = pilotSql()): Promise<AiReference[]> {
  const rows = await sql<
    { rowId: string; aiWeightedScore: string | null; aiRecommendation: string; evidenceValid: boolean }[]
  >`
    SELECT row_id AS "rowId", ai_weighted_score AS "aiWeightedScore",
           ai_recommendation AS "aiRecommendation", evidence_valid AS "evidenceValid"
      FROM netzero_ai.reference_marking
     WHERE workspace_id = ${workspaceId}
     ORDER BY row_id`;
  return rows.map((r) => ({
    rowId: r.rowId,
    aiWeightedScore: r.aiWeightedScore === null ? null : Number(r.aiWeightedScore),
    aiRecommendation: r.aiRecommendation,
    evidenceValid: r.evidenceValid,
  }));
}

// --------------------------------------------------------- final decisions ---

export type DecisionValue = "shortlisted" | "rejected" | "waitlisted" | "undecided";

export type StoredFinalDecision = {
  applicationRowId: string;
  decision: DecisionValue;
  decidedByName: string | null;
  decidedAt: Date;
  notes: string | null;
};

export async function recordFinalDecision(
  input: {
    workspaceId: string;
    applicationRowId: string;
    decision: DecisionValue;
    decidedBy: string | null;
    notes?: string | null;
  },
  sql: Sql = pilotSql(),
): Promise<void> {
  await sql`
    INSERT INTO netzero.final_decisions
      (workspace_id, application_row_id, decision, decided_by, notes)
    VALUES (${input.workspaceId}, ${input.applicationRowId}, ${input.decision},
            ${input.decidedBy}, ${input.notes ?? null})
    ON CONFLICT (workspace_id, application_row_id)
      DO UPDATE SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by,
                    notes = EXCLUDED.notes, decided_at = now()`;
}

/**
 * All final decisions for the workspace, one row per application (the unique
 * constraint keeps latest-write-wins), with the deciding reviewer's display name
 * resolved. Decisions are workspace + application scoped, NOT run scoped: a human
 * decision is about the application, and the AI run is reference only, so a
 * decision persists across re-runs of the reference assessment.
 */
export async function loadFinalDecisions(
  workspaceId: string,
  sql: Sql = pilotSql(),
): Promise<StoredFinalDecision[]> {
  return sql<StoredFinalDecision[]>`
    SELECT d.application_row_id AS "applicationRowId",
           d.decision,
           r.display_name AS "decidedByName",
           d.decided_at AS "decidedAt",
           d.notes
      FROM netzero.final_decisions d
      LEFT JOIN netzero.reviewers r ON r.id = d.decided_by
     WHERE d.workspace_id = ${workspaceId}
     ORDER BY d.application_row_id`;
}
