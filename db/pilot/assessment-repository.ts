/**
 * AI assessment (Phase 5) repository - REFERENCE ONLY output in schema
 * netzero_ai. Nothing here can influence the human ranking (enforced by the
 * schema's privilege boundary).
 *
 * Integrity contract:
 *   - A batch is claimed atomically with a lease (UPDATE ... WHERE pending
 *     RETURNING); two concurrent claims cannot both win.
 *   - Results are immutable per (run, row) and committed exactly once: a commit
 *     re-verifies the lease and no-ops if results already exist.
 */

import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";
import { contentHash } from "../../app/phase4-storage.ts";
import { createPhase4InputFingerprint } from "../../app/phase4-logic.ts";
import {
  contractCore,
  createReviewStateHash,
  phase5SafeguardApprovalMatchesSession,
  runIsCoherent,
  runReviewStateIsValid,
} from "../../app/phase5-storage.ts";
import type {
  Phase5Batch,
  Phase5CohortRecommendation,
  Phase5Run,
  Phase5SafeguardApproval,
  Phase5StoredAssessment,
} from "../../app/phase5-storage.ts";
import type { Phase4Session } from "../../app/phase4-storage.ts";

export type NewRun = {
  workspaceId: string;
  currentDatasetId: string;
  guideVersion: number;
  modelId: string;
  contractHash: string;
  protocolHash: string;
  batches: { index: number; inputHash: string }[];
};

export type ClaimedBatch = { batchId: string; batchIndex: number; leaseToken: string };

export type AssessmentResultInput = {
  rowId: string;
  assessment: unknown;
  weightedScore: number | null;
  recommendation: string;
  evidenceValid: boolean;
};

const LEASE_SECONDS = 120;

export async function createRun(input: NewRun): Promise<{ runId: string }> {
  return withPilotTransaction(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO netzero_ai.assessment_runs
        (workspace_id, current_dataset_id, guide_version, model_id, contract_hash, protocol_hash)
      VALUES (${input.workspaceId}, ${input.currentDatasetId}, ${input.guideVersion},
              ${input.modelId}, ${input.contractHash}, ${input.protocolHash})
      RETURNING id`;
    for (const batch of input.batches) {
      await tx`
        INSERT INTO netzero_ai.assessment_batches (run_id, batch_index, batch_input_hash)
        VALUES (${run.id}, ${batch.index}, ${batch.inputHash})`;
    }
    return { runId: run.id };
  });
}

/**
 * Atomically claims one pending (or lease-expired) batch and returns a lease
 * token. Returns null if the batch is already claimed by a live lease.
 */
export async function claimBatch(
  runId: string,
  batchIndex: number,
  nowMs: number = Date.now(),
  sql: Sql = pilotSql(),
): Promise<ClaimedBatch | null> {
  const leaseToken = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + LEASE_SECONDS * 1000).toISOString();
  const rows = await sql<{ batchId: string; batchIndex: number }[]>`
    UPDATE netzero_ai.assessment_batches
       SET status = 'in_flight', lease_token = ${leaseToken}, lease_expires_at = ${expires}
     WHERE run_id = ${runId} AND batch_index = ${batchIndex}
       AND (status = 'pending' OR status = 'failed'
            OR (status = 'in_flight' AND lease_expires_at < ${now}))
    RETURNING id AS "batchId", batch_index AS "batchIndex"`;
  if (rows.length === 0) return null;
  return { batchId: rows[0].batchId, batchIndex: rows[0].batchIndex, leaseToken };
}

/**
 * Commits a batch's results immutably, exactly once. Verifies the lease, writes
 * the results, and marks the batch complete - all atomically. If results for
 * the batch already exist (a retry after a successful commit), it is a no-op.
 */
export async function commitBatchResults(
  input: { runId: string; batchId: string; leaseToken: string; results: AssessmentResultInput[] },
): Promise<{ committed: boolean }> {
  return withPilotTransaction(async (tx) => {
    const [batch] = await tx<{ status: string; leaseToken: string | null }[]>`
      SELECT status, lease_token AS "leaseToken" FROM netzero_ai.assessment_batches
       WHERE id = ${input.batchId} AND run_id = ${input.runId} FOR UPDATE`;
    if (!batch) throw new Error("unknown_batch");
    if (batch.status === "complete") return { committed: false }; // already committed
    if (batch.status !== "in_flight" || batch.leaseToken !== input.leaseToken) {
      throw new Error("stale_lease");
    }
    for (const r of input.results) {
      await tx`
        INSERT INTO netzero_ai.assessment_results
          (run_id, row_id, assessment, weighted_score, recommendation, evidence_valid)
        VALUES (${input.runId}, ${r.rowId}, ${tx.json(JSON.parse(JSON.stringify(r.assessment)))},
                ${r.weightedScore}, ${r.recommendation}, ${r.evidenceValid})`;
    }
    await tx`
      UPDATE netzero_ai.assessment_batches
         SET status = 'complete', lease_token = NULL, lease_expires_at = NULL
       WHERE id = ${input.batchId}`;
    return { committed: true };
  });
}

/** Releases a failed batch so it can be re-claimed on resume. */
export async function failBatch(
  input: { batchId: string; leaseToken: string },
  sql: Sql = pilotSql(),
): Promise<void> {
  await sql`
    UPDATE netzero_ai.assessment_batches
       SET status = 'failed', lease_token = NULL, lease_expires_at = NULL
     WHERE id = ${input.batchId} AND lease_token = ${input.leaseToken}`;
}

export async function loadResults(
  runId: string,
  sql: Sql = pilotSql(),
): Promise<AssessmentResultInput[]> {
  const rows = await sql<
    { rowId: string; assessment: unknown; weightedScore: string | null; recommendation: string; evidenceValid: boolean }[]
  >`
    SELECT row_id AS "rowId", assessment, weighted_score AS "weightedScore",
           recommendation, evidence_valid AS "evidenceValid"
      FROM netzero_ai.assessment_results
     WHERE run_id = ${runId}
     ORDER BY row_id`;
  return rows.map((r) => ({
    rowId: r.rowId,
    assessment: r.assessment,
    weightedScore: r.weightedScore === null ? null : Number(r.weightedScore),
    recommendation: r.recommendation,
    evidenceValid: r.evidenceValid,
  }));
}

export async function runProgress(
  runId: string,
  sql: Sql = pilotSql(),
): Promise<{ total: number; complete: number }> {
  const [row] = await sql<{ total: string; complete: string }[]>`
    SELECT count(*) AS total, count(*) FILTER (WHERE status = 'complete') AS complete
      FROM netzero_ai.assessment_batches WHERE run_id = ${runId}`;
  return { total: Number(row.total), complete: Number(row.complete) };
}

// ------------------------------------------------------- rich Phase 5 flow ---

type RunDocumentRow = {
  revision: number;
  runDocument: Phase5Run | null;
};

async function assertRunDocument(run: Phase5Run): Promise<void> {
  if (
    !runIsCoherent(run) ||
    !(await runReviewStateIsValid(run)) ||
    (await createPhase4InputFingerprint(contractCore(run.contract))) !==
      run.contract.contractHash
  ) {
    throw new Error("The assessment run did not pass its integrity check.");
  }
}

async function runDocumentRow(
  workspaceId: string,
  runId: string,
  sql: Sql,
  lock = false,
): Promise<RunDocumentRow | null> {
  const rows = await sql<RunDocumentRow[]>`
    SELECT revision, run_document AS "runDocument"
      FROM netzero_ai.assessment_runs
     WHERE id = ${runId} AND workspace_id = ${workspaceId}
     ${lock ? sql`FOR UPDATE` : sql``}`;
  return rows[0] ?? null;
}

async function writeRunDocument(
  tx: Sql,
  workspaceId: string,
  expectedRevision: number,
  run: Phase5Run,
): Promise<void> {
  await assertRunDocument(run);
  const rows = await tx<{ revision: number }[]>`
    UPDATE netzero_ai.assessment_runs SET
      status = ${run.status},
      cohort_recommendations = ${run.cohortRecommendations.length ? tx.json(run.cohortRecommendations as never) : null},
      evidence_sample_ids = ${run.evidenceSampleIds.length ? tx.json(run.evidenceSampleIds as never) : null},
      review_state_hash = ${run.reviewStateHash},
      invalid_reason = ${run.invalidReason || null},
      revision = ${run.revision},
      run_document = ${tx.json(run as never)},
      updated_at = now()
    WHERE id = ${run.id} AND workspace_id = ${workspaceId}
      AND revision = ${expectedRevision}
    RETURNING revision`;
  if (rows.length === 0) throw new Error("revision_conflict");
}

export async function saveSafeguardApproval(
  workspaceId: string,
  approval: Phase5SafeguardApproval,
): Promise<Phase5SafeguardApproval> {
  return withPilotTransaction(async (tx) => {
    const [session] = await tx<{ dbId: string; sessionDocument: Phase4Session }[]>`
      SELECT id AS "dbId", session_document AS "sessionDocument"
        FROM netzero.calibration_sessions
       WHERE workspace_id = ${workspaceId}
         AND session_document ->> 'id' = ${approval.phase4SessionId}
         AND practice_status = 'passed'
       FOR UPDATE`;
    if (
      !session ||
      !(await phase5SafeguardApprovalMatchesSession(approval, session.sessionDocument))
    ) {
      throw new Error("A complete passed practice test is required before safeguards can be locked.");
    }
    const [existing] = await tx<{
      approvalHash: string;
      approvalDocument: Phase5SafeguardApproval;
    }[]>`
      SELECT approval_hash AS "approvalHash", detail AS "approvalDocument"
        FROM netzero.safeguard_approvals
       WHERE workspace_id = ${workspaceId} AND session_id = ${session.dbId}
       FOR UPDATE`;
    if (existing) {
      if (existing.approvalHash !== approval.approvalHash) {
        throw new Error("Safeguards are already locked for this passed practice test.");
      }
      return existing.approvalDocument;
    }
    const [reviewer] = await tx<{ id: string }[]>`
      INSERT INTO netzero.reviewers (workspace_id, display_name, active)
      VALUES (${workspaceId}, ${approval.approvedBy}, false)
      ON CONFLICT (workspace_id, display_name) DO UPDATE
        SET display_name = EXCLUDED.display_name
      RETURNING id`;
    await tx`
      INSERT INTO netzero.safeguard_approvals
        (workspace_id, session_id, protocol_hash, approved_by, approved_at,
         detail, client_approval_id, approval_hash)
      VALUES (${workspaceId}, ${session.dbId}, ${approval.assessmentProtocolHash},
              ${reviewer.id}, ${approval.approvedAt}, ${tx.json(approval as never)},
              ${approval.id}, ${approval.approvalHash})`;
    return approval;
  });
}

export async function loadSafeguardApproval(
  workspaceId: string,
  phase4SessionId: string,
  sql: Sql = pilotSql(),
): Promise<Phase5SafeguardApproval | null> {
  const [row] = await sql<{ approvalDocument: Phase5SafeguardApproval }[]>`
    SELECT sa.detail AS "approvalDocument"
      FROM netzero.safeguard_approvals sa
      JOIN netzero.calibration_sessions cs ON cs.id = sa.session_id
     WHERE sa.workspace_id = ${workspaceId}
       AND cs.session_document ->> 'id' = ${phase4SessionId}`;
  return row?.approvalDocument ?? null;
}

export async function createPhase5RunDocument(input: {
  workspaceId: string;
  run: Phase5Run;
  batches: Phase5Batch[];
}): Promise<Phase5Run> {
  await assertRunDocument(input.run);
  return withPilotTransaction(async (tx) => {
    const { run, batches } = input;
    const [dataset] = await tx<{
      fingerprint: string;
      integrityHash: string | null;
      caseCount: number;
    }[]>`
      SELECT fingerprint, integrity_hash AS "integrityHash", case_count AS "caseCount"
        FROM netzero.current_datasets
       WHERE id = ${run.datasetId} AND workspace_id = ${input.workspaceId}
       FOR UPDATE`;
    if (
      !dataset ||
      dataset.fingerprint !== run.contract.datasetFingerprint ||
      dataset.integrityHash !== run.contract.datasetIntegrityHash ||
      dataset.caseCount !== run.contract.datasetRowCount
    ) {
      throw new Error("The current applications changed before the assessment run was saved.");
    }
    const approval = await loadSafeguardApproval(
      input.workspaceId,
      run.contract.phase4SessionId,
      tx,
    );
    if (
      !approval ||
      approval.phase4MetricsHash !== run.contract.phase4MetricsHash ||
      approval.expectedModelId !== run.contract.expectedModelId ||
      approval.assessmentProtocolHash !== run.contract.assessmentProtocolHash ||
      approval.guideContentHash !== run.contract.guideContentHash ||
      approval.approvedPatternsHash !== run.contract.approvedPatternsHash
    ) {
      throw new Error("The Phase 5 safeguards no longer match the passed practice test.");
    }
    const rowIds = batches.flatMap((batch) => batch.rowIds).sort();
    const storedRows = await tx<{ rowId: string }[]>`
      SELECT row_id AS "rowId" FROM netzero.current_cases
       WHERE dataset_id = ${run.datasetId} ORDER BY row_id`;
    if (
      rowIds.length !== storedRows.length ||
      new Set(rowIds).size !== rowIds.length ||
      rowIds.some((rowId, index) => rowId !== storedRows[index].rowId) ||
      batches.length !== run.batchCount
    ) {
      throw new Error("The fixed batches do not account for every application exactly once.");
    }
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO netzero_ai.assessment_runs
        (id, workspace_id, current_dataset_id, guide_version, status, model_id,
         contract_hash, protocol_hash, revision, run_document)
      VALUES (${run.id}, ${input.workspaceId}, ${run.datasetId}, ${approval.guideVersion},
              ${run.status}, ${run.contract.expectedModelId}, ${run.contract.contractHash},
              ${run.contract.assessmentProtocolHash}, ${run.revision}, ${tx.json(run as never)})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (inserted.length === 0) throw new Error("This assessment run already exists.");
    for (const batch of batches) {
      await tx`
        INSERT INTO netzero_ai.assessment_batches
          (run_id, client_batch_id, batch_index, batch_input_hash, row_ids,
           status, attempts, last_error)
        VALUES (${run.id}, ${batch.batchId}, ${batch.batchIndex}, ${batch.batchInputHash},
                ${tx.json(batch.rowIds as never)}, 'pending', 0, '')`;
    }
    return run;
  });
}

export async function loadPhase5RunDocument(
  workspaceId: string,
  runId: string,
  sql: Sql = pilotSql(),
): Promise<Phase5Run | null> {
  const row = await runDocumentRow(workspaceId, runId, sql);
  if (!row?.runDocument) return null;
  await assertRunDocument(row.runDocument);
  return row.runDocument;
}

export async function loadLatestPhase5RunDocument(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<Phase5Run | null> {
  const [row] = await sql<{ runDocument: Phase5Run | null }[]>`
    SELECT run_document AS "runDocument"
      FROM netzero_ai.assessment_runs
     WHERE workspace_id = ${workspaceId} AND current_dataset_id = ${datasetId}
       AND run_document IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`;
  if (!row?.runDocument) return null;
  await assertRunDocument(row.runDocument);
  return row.runDocument;
}

export async function loadPhase5Batches(
  workspaceId: string,
  runId: string,
  sql: Sql = pilotSql(),
): Promise<Phase5Batch[]> {
  return sql<Phase5Batch[]>`
    SELECT ab.run_id AS "runId", ab.client_batch_id AS "batchId",
           ab.batch_index AS "batchIndex", ab.row_ids AS "rowIds",
           ab.batch_input_hash AS "batchInputHash", ab.status, ab.attempts,
           ab.lease_token AS "leaseToken", ab.lease_expires_at AS "leaseExpiresAt",
           ab.last_error AS "lastError", ab.completed_at AS "completedAt"
      FROM netzero_ai.assessment_batches ab
      JOIN netzero_ai.assessment_runs ar ON ar.id = ab.run_id
     WHERE ab.run_id = ${runId} AND ar.workspace_id = ${workspaceId}
     ORDER BY ab.batch_index`;
}

export async function loadPhase5AssessmentResults(
  workspaceId: string,
  runId: string,
  sql: Sql = pilotSql(),
): Promise<Phase5StoredAssessment[]> {
  const rows = await sql<{ assessment: Phase5StoredAssessment }[]>`
    SELECT res.assessment
      FROM netzero_ai.assessment_results res
      JOIN netzero_ai.assessment_runs ar ON ar.id = res.run_id
     WHERE res.run_id = ${runId} AND ar.workspace_id = ${workspaceId}
     ORDER BY res.row_id`;
  return rows.map((row) => row.assessment);
}

export async function claimNextPhase5Batch(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  leaseToken: string;
  leaseMilliseconds?: number;
}): Promise<{ run: Phase5Run; batch: Phase5Batch } | null> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (!row || !run || row.revision !== input.expectedRevision) {
      throw new Error("revision_conflict");
    }
    await assertRunDocument(run);
    if (["auditing", "ready_for_human_review", "invalid"].includes(run.status)) return null;
    const [batch] = await tx<{
      batchId: string;
      batchIndex: number;
      rowIds: string[];
      batchInputHash: string;
      attempts: number;
    }[]>`
      SELECT client_batch_id AS "batchId", batch_index AS "batchIndex",
             row_ids AS "rowIds", batch_input_hash AS "batchInputHash", attempts
        FROM netzero_ai.assessment_batches
       WHERE run_id = ${input.runId}
         AND (status IN ('pending', 'failed')
              OR (status = 'in_flight' AND lease_expires_at <= now()))
       ORDER BY batch_index
       FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!batch) return null;
    const now = new Date();
    const leaseExpiresAt = new Date(
      now.getTime() + (input.leaseMilliseconds ?? 5 * 60_000),
    ).toISOString();
    const claimed: Phase5Batch = {
      runId: run.id,
      ...batch,
      status: "in_flight",
      attempts: batch.attempts + 1,
      leaseToken: input.leaseToken,
      leaseExpiresAt,
      lastError: "",
      completedAt: null,
    };
    await tx`
      UPDATE netzero_ai.assessment_batches SET
        status = 'in_flight', attempts = ${claimed.attempts},
        lease_token = ${claimed.leaseToken}, lease_expires_at = ${leaseExpiresAt},
        last_error = ''
       WHERE run_id = ${run.id} AND client_batch_id = ${claimed.batchId}`;
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: "running",
      updatedAt: now.toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return { run: updated, batch: claimed };
  });
}

export async function commitPhase5Batch(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  assessments: Phase5StoredAssessment[];
}): Promise<Phase5Run> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (!row || !run || row.revision !== input.expectedRevision) {
      throw new Error("revision_conflict");
    }
    await assertRunDocument(run);
    const [batch] = await tx<{
      status: Phase5Batch["status"];
      leaseToken: string | null;
      rowIds: string[];
    }[]>`
      SELECT status, lease_token AS "leaseToken", row_ids AS "rowIds"
        FROM netzero_ai.assessment_batches
       WHERE run_id = ${run.id} AND client_batch_id = ${input.batchId}
       FOR UPDATE`;
    if (!batch) throw new Error("unknown_batch");
    if (batch.status !== "in_flight" || batch.leaseToken !== input.leaseToken) {
      throw new Error("stale_lease");
    }
    const expectedIds = [...batch.rowIds].sort();
    const incomingIds = input.assessments.map((item) => item.rowId).sort();
    if (
      incomingIds.length !== expectedIds.length ||
      new Set(incomingIds).size !== incomingIds.length ||
      incomingIds.some((id, index) => id !== expectedIds[index]) ||
      input.assessments.some((item) => item.runId !== run.id)
    ) {
      throw new Error("The AI batch does not account for the fixed applications exactly once.");
    }
    for (const assessment of input.assessments) {
      await tx`
        INSERT INTO netzero_ai.assessment_results
          (run_id, row_id, assessment, weighted_score, recommendation, evidence_valid)
        VALUES (${run.id}, ${assessment.rowId}, ${tx.json(assessment as never)},
                ${assessment.weightedScore}, ${assessment.baseRecommendation},
                ${assessment.evidenceValid})`;
    }
    const now = new Date().toISOString();
    await tx`
      UPDATE netzero_ai.assessment_batches SET
        status = 'complete', lease_token = NULL, lease_expires_at = NULL,
        last_error = '', completed_at = ${now}
       WHERE run_id = ${run.id} AND client_batch_id = ${input.batchId}`;
    const processedCases = run.processedCases + input.assessments.length;
    const completedBatches = run.completedBatches + 1;
    if (processedCases > run.caseCount || completedBatches > run.batchCount) {
      throw new Error("The assessment run exceeded its fixed case count.");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: processedCases === run.caseCount ? "complete" : "running",
      processedCases,
      completedBatches,
      updatedAt: now,
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}

export async function failPhase5BatchDocument(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  message: string;
}): Promise<Phase5Run> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (!row || !run || row.revision !== input.expectedRevision) {
      throw new Error("revision_conflict");
    }
    const [batch] = await tx<{ status: string; leaseToken: string | null }[]>`
      SELECT status, lease_token AS "leaseToken"
        FROM netzero_ai.assessment_batches
       WHERE run_id = ${run.id} AND client_batch_id = ${input.batchId}
       FOR UPDATE`;
    if (!batch) throw new Error("unknown_batch");
    if (batch.status !== "in_flight" || batch.leaseToken !== input.leaseToken) {
      throw new Error("stale_lease");
    }
    const message = input.message.trim().slice(0, 500) || "The AI batch stopped safely.";
    await tx`
      UPDATE netzero_ai.assessment_batches SET
        status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        last_error = ${message}
       WHERE run_id = ${run.id} AND client_batch_id = ${input.batchId}`;
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: "paused",
      updatedAt: new Date().toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}

export async function pausePhase5RunDocument(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
}): Promise<Phase5Run> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (!row || !run || row.revision !== input.expectedRevision) {
      throw new Error("revision_conflict");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: run.status === "complete" ? "complete" : "paused",
      updatedAt: new Date().toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}

export async function finalizePhase5RunDocument(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  recommendations: Phase5CohortRecommendation[];
  evidenceSampleIds: string[];
}): Promise<Phase5Run> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (
      !row ||
      !run ||
      row.revision !== input.expectedRevision ||
      run.status !== "complete" ||
      run.processedCases !== run.caseCount
    ) {
      throw new Error("Every fixed application must be safely assessed before cohort results are prepared.");
    }
    const assessments = await loadPhase5AssessmentResults(
      input.workspaceId,
      input.runId,
      tx,
    );
    const sortedAssessments = [...assessments].sort((a, b) => a.rowId.localeCompare(b.rowId));
    const recommendations = input.recommendations
      .map((item) => ({ ...item }))
      .sort((a, b) => a.rowId.localeCompare(b.rowId));
    const assessmentIds = sortedAssessments.map((item) => item.rowId);
    const recommendationIds = recommendations.map((item) => item.rowId);
    const evidenceSampleIds = [...new Set(input.evidenceSampleIds)].sort();
    if (
      assessmentIds.length !== run.caseCount ||
      recommendationIds.length !== run.caseCount ||
      assessmentIds.some((id, index) => id !== recommendationIds[index]) ||
      evidenceSampleIds.some((id) => !assessmentIds.includes(id))
    ) {
      throw new Error("The cohort result does not account for every fixed application.");
    }
    const status: Phase5Run["status"] = evidenceSampleIds.length
      ? "auditing"
      : "ready_for_human_review";
    const assessmentSetHash = await contentHash(sortedAssessments);
    const reviewState = {
      status,
      assessmentSetHash,
      cohortRecommendations: recommendations,
      evidenceSampleIds,
      reviewedEvidenceIds: [],
      invalidReason: "",
    };
    const updated: Phase5Run = {
      ...run,
      ...reviewState,
      revision: run.revision + 1,
      reviewStateHash: await createReviewStateHash(reviewState),
      updatedAt: new Date().toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}

export async function confirmPhase5EvidenceDocument(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  rowId: string;
}): Promise<Phase5Run> {
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (
      !row ||
      !run ||
      row.revision !== input.expectedRevision ||
      run.status !== "auditing" ||
      !run.evidenceSampleIds.includes(input.rowId) ||
      run.reviewedEvidenceIds.includes(input.rowId)
    ) {
      throw new Error("This evidence check is not part of the fixed audit sample.");
    }
    const reviewedEvidenceIds = [...run.reviewedEvidenceIds, input.rowId].sort();
    const status: Phase5Run["status"] =
      reviewedEvidenceIds.length === run.evidenceSampleIds.length
        ? "ready_for_human_review"
        : "auditing";
    const reviewState = {
      status,
      assessmentSetHash: run.assessmentSetHash,
      cohortRecommendations: run.cohortRecommendations,
      evidenceSampleIds: run.evidenceSampleIds,
      reviewedEvidenceIds,
      invalidReason: "",
    };
    const updated: Phase5Run = {
      ...run,
      ...reviewState,
      revision: run.revision + 1,
      reviewStateHash: await createReviewStateHash(reviewState),
      updatedAt: new Date().toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}

export async function invalidatePhase5RunDocument(input: {
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  reason: string;
}): Promise<Phase5Run> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Record why the evidence check failed.");
  return withPilotTransaction(async (tx) => {
    const row = await runDocumentRow(input.workspaceId, input.runId, tx, true);
    const run = row?.runDocument;
    if (
      !row ||
      !run ||
      row.revision !== input.expectedRevision ||
      run.status !== "auditing"
    ) {
      throw new Error("This evidence audit changed in another tab. Reload before continuing.");
    }
    const reviewState = {
      status: "invalid" as const,
      assessmentSetHash: run.assessmentSetHash,
      cohortRecommendations: run.cohortRecommendations,
      evidenceSampleIds: run.evidenceSampleIds,
      reviewedEvidenceIds: run.reviewedEvidenceIds,
      invalidReason: reason,
    };
    const updated: Phase5Run = {
      ...run,
      ...reviewState,
      revision: run.revision + 1,
      reviewStateHash: await createReviewStateHash(reviewState),
      updatedAt: new Date().toISOString(),
    };
    await writeRunDocument(tx, input.workspaceId, row.revision, updated);
    return updated;
  });
}
