/**
 * Calibration (Phase 4) repository: practice sessions, the one-use reveal seal,
 * and recalibration credits.
 *
 * Integrity contract:
 *   - Session writes use revision CAS: an update only lands if the caller's
 *     expected revision matches, so a stale tab/client cannot clobber newer
 *     state.
 *   - Revealing the sealed practice outcomes is ONE-USE, enforced by the DB:
 *     the reveal receipt's count is monotonic and bounded by reveals_allowed
 *     (= 1 + append-only credits). A restored backup cannot reopen it, and a
 *     second reveal without a credit is refused by the database.
 */

import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";

export type PracticeStatus =
  | "not_started"
  | "policy_locked"
  | "running"
  | "predictions_committed"
  | "revealed"
  | "passed"
  | "failed";

export type CalibrationSession = {
  id: string;
  workspaceId: string;
  datasetId: string;
  guideVersion: number;
  practiceStatus: PracticeStatus;
  revision: number;
  patterns: unknown;
  acceptancePolicy: unknown;
  assessments: unknown;
  outcomes: unknown;
  predictionHash: string | null;
  metrics: unknown;
  metricsHash: string | null;
  modelId: string | null;
  protocolHash: string | null;
  blindnessCompromised: boolean;
};

const SESSION_COLUMNS = `
  id, workspace_id AS "workspaceId", dataset_id AS "datasetId",
  guide_version AS "guideVersion", practice_status AS "practiceStatus",
  revision, patterns, acceptance_policy AS "acceptancePolicy",
  assessments, outcomes, prediction_hash AS "predictionHash",
  metrics, metrics_hash AS "metricsHash", model_id AS "modelId",
  protocol_hash AS "protocolHash", blindness_compromised AS "blindnessCompromised"`;

export async function getOrCreateSession(
  workspaceId: string,
  datasetId: string,
  guideVersion: number,
  sql: Sql = pilotSql(),
): Promise<CalibrationSession> {
  const [existing] = await sql<CalibrationSession[]>`
    SELECT ${sql.unsafe(SESSION_COLUMNS)} FROM netzero.calibration_sessions
     WHERE workspace_id = ${workspaceId} AND dataset_id = ${datasetId} AND guide_version = ${guideVersion}`;
  if (existing) return existing;
  const [created] = await sql<CalibrationSession[]>`
    INSERT INTO netzero.calibration_sessions (workspace_id, dataset_id, guide_version)
    VALUES (${workspaceId}, ${datasetId}, ${guideVersion})
    RETURNING ${sql.unsafe(SESSION_COLUMNS)}`;
  return created;
}

/**
 * Writes the mutable session state with revision CAS. Returns the new revision,
 * or throws "revision_conflict" if the expected revision no longer matches.
 */
export async function saveSession(
  input: {
    id: string;
    expectedRevision: number;
    practiceStatus: PracticeStatus;
    patterns?: unknown;
    acceptancePolicy?: unknown;
    assessments?: unknown;
    outcomes?: unknown;
    predictionHash?: string | null;
    metrics?: unknown;
    metricsHash?: string | null;
    modelId?: string | null;
    protocolHash?: string | null;
    blindnessCompromised?: boolean;
  },
  sql: Sql = pilotSql(),
): Promise<{ revision: number }> {
  const rows = await sql<{ revision: number }[]>`
    UPDATE netzero.calibration_sessions SET
      practice_status = ${input.practiceStatus},
      patterns = ${sql.json((input.patterns ?? []) as never)},
      acceptance_policy = ${input.acceptancePolicy === undefined ? sql`acceptance_policy` : sql.json(input.acceptancePolicy as never)},
      assessments = ${input.assessments === undefined ? sql`assessments` : sql.json(input.assessments as never)},
      outcomes = ${input.outcomes === undefined ? sql`outcomes` : sql.json(input.outcomes as never)},
      prediction_hash = ${input.predictionHash ?? null},
      metrics = ${input.metrics === undefined ? sql`metrics` : sql.json(input.metrics as never)},
      metrics_hash = ${input.metricsHash ?? null},
      model_id = ${input.modelId ?? null},
      protocol_hash = ${input.protocolHash ?? null},
      blindness_compromised = ${input.blindnessCompromised ?? false},
      revision = revision + 1,
      updated_at = now()
    WHERE id = ${input.id} AND revision = ${input.expectedRevision}
    RETURNING revision`;
  if (rows.length === 0) throw new Error("revision_conflict");
  return { revision: rows[0].revision };
}

/**
 * Reveals the sealed practice outcomes ONCE. Records/advances the reveal
 * receipt (monotonic, budget-bounded by the DB) and returns the answer key.
 * Throws "already_revealed" if no reveal budget remains.
 */
export async function revealOutcomes(
  input: { workspaceId: string; datasetId: string; datasetFingerprint: string; sessionId: string },
): Promise<{ outcomes: { rowId: string; outcome: string }[] }> {
  return withPilotTransaction(async (tx) => {
    try {
      await tx`
        INSERT INTO netzero.calibration_reveal_receipts
          (dataset_fingerprint, workspace_id, session_id)
        VALUES (${input.datasetFingerprint}, ${input.workspaceId}, ${input.sessionId})
        ON CONFLICT (dataset_fingerprint) DO UPDATE
          SET reveal_count = netzero.calibration_reveal_receipts.reveal_count + 1,
              session_id = EXCLUDED.session_id,
              last_revealed_at = now()`;
    } catch (error) {
      // The reveal_within_budget CHECK fires when no credit backs a re-reveal.
      const message = error instanceof Error ? error.message : String(error);
      if (/reveal_within_budget|reveal_count/i.test(message)) {
        throw new Error("already_revealed");
      }
      throw error;
    }
    const outcomes = await tx<{ rowId: string; outcome: string }[]>`
      SELECT row_id AS "rowId", outcome FROM netzero.historical_rows
       WHERE dataset_id = ${input.datasetId} AND partition = 'sealed_test'
       ORDER BY row_id`;
    return { outcomes };
  });
}

/** Grants one recalibration retry after a genuine Phase 5 audit failure. */
export async function grantRecalibrationCredit(
  input: { datasetFingerprint: string; sessionId: string; reason: string },
  sql: Sql = pilotSql(),
): Promise<void> {
  await sql`
    INSERT INTO netzero.recalibration_credits (dataset_fingerprint, session_id, reason)
    VALUES (${input.datasetFingerprint}, ${input.sessionId}, ${input.reason})`;
}

/** Remaining sanctioned reveals for a dataset (0 once the seal is spent). */
export async function revealHeadroom(datasetFingerprint: string, sql: Sql = pilotSql()): Promise<number> {
  const [row] = await sql<{ headroom: number }[]>`
    SELECT COALESCE(reveals_allowed - reveal_count, 0)::int AS headroom
      FROM netzero.calibration_reveal_receipts
     WHERE dataset_fingerprint = ${datasetFingerprint}`;
  return row ? row.headroom : 0;
}
