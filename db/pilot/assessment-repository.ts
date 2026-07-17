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
