/**
 * Phase 4 repository: the rich calibration session document, revision CAS,
 * and the database-owned one-use reveal seal.
 *
 * The client owns the workflow document and its detailed transition checks,
 * but it never owns the answer key. Normal saves replace incoming outcomes and
 * reveal timestamps with the values already held by the server. Only
 * revealSession can add them, in the same transaction that advances the
 * monotonic reveal receipt.
 */

import type { HistoricalDatasetBinding } from "../../app/historical-data.ts";
import {
  initialPhase4SessionIsPristine,
  phase4DerivedHashesAreValid,
  phase4SessionIsCoherent,
  phase4SessionMatchesBinding,
  phase4SessionTransitionAllowed,
} from "../../app/phase4-storage.ts";
import type { Phase4Session } from "../../app/phase4-storage.ts";
import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";

type SessionRow = {
  dbId: string;
  revision: number;
  sessionDocument: Phase4Session | null;
  datasetFingerprint: string;
  integrityHash: string;
  guideVersion: number;
  teachingRows: number;
  sealedRows: number;
};

export type ConsumedState = {
  consumed: boolean;
  headroom: number;
};

function bindingFromRow(row: SessionRow): HistoricalDatasetBinding {
  return {
    datasetId: row.sessionDocument?.datasetId ?? "",
    datasetFingerprint: row.datasetFingerprint,
    integrityHash: row.integrityHash,
    guideVersion: row.guideVersion,
    teachingRows: row.teachingRows,
    sealedRows: row.sealedRows,
  };
}

async function sessionRow(
  workspaceId: string,
  datasetId: string,
  guideVersion: number,
  sql: Sql,
  lock = false,
): Promise<SessionRow | null> {
  const rows = await sql<SessionRow[]>`
    SELECT cs.id AS "dbId", cs.revision,
           cs.session_document AS "sessionDocument",
           hd.fingerprint AS "datasetFingerprint",
           hd.integrity_hash AS "integrityHash",
           hd.guide_version AS "guideVersion",
           hd.teaching_count AS "teachingRows",
           hd.sealed_count AS "sealedRows"
      FROM netzero.calibration_sessions cs
      JOIN netzero.historical_datasets hd ON hd.id = cs.dataset_id
     WHERE cs.workspace_id = ${workspaceId}
       AND cs.dataset_id = ${datasetId}
       AND cs.guide_version = ${guideVersion}
       ${lock ? sql`FOR UPDATE OF cs` : sql``}`;
  return rows[0] ?? null;
}

async function datasetBinding(
  workspaceId: string,
  datasetId: string,
  sql: Sql,
): Promise<HistoricalDatasetBinding | null> {
  const [row] = await sql<HistoricalDatasetBinding[]>`
    SELECT id AS "datasetId", fingerprint AS "datasetFingerprint",
           integrity_hash AS "integrityHash", guide_version AS "guideVersion",
           teaching_count AS "teachingRows", sealed_count AS "sealedRows"
      FROM netzero.historical_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}`;
  return row ?? null;
}

function withServerOwnedReveal(
  incoming: Phase4Session,
  current: Phase4Session | null,
): Phase4Session {
  return {
    ...incoming,
    outcomes: current?.outcomes ?? null,
    revealedAt: current?.revealedAt ?? null,
    blindnessCompromised: Boolean(current?.blindnessCompromised),
  };
}

async function assertValidDocument(
  session: Phase4Session,
  binding: HistoricalDatasetBinding,
): Promise<void> {
  if (
    !phase4SessionMatchesBinding(session, binding) ||
    !phase4SessionIsCoherent(session) ||
    !(await phase4DerivedHashesAreValid(session))
  ) {
    throw new Error("Phase 4 cannot save against changed historical data.");
  }
}

async function writeDocument(
  tx: Sql,
  dbId: string,
  expectedRevision: number,
  session: Phase4Session,
): Promise<void> {
  const rows = await tx<{ revision: number }[]>`
    UPDATE netzero.calibration_sessions SET
      practice_status = ${session.practiceStatus},
      patterns = ${tx.json(session.patterns as never)},
      acceptance_policy = ${session.acceptancePolicy === null ? null : tx.json(session.acceptancePolicy as never)},
      assessments = ${tx.json(session.assessments as never)},
      outcomes = ${session.outcomes === null ? null : tx.json(session.outcomes as never)},
      prediction_hash = ${session.predictionHash},
      metrics = ${session.metrics === null ? null : tx.json(session.metrics as never)},
      metrics_hash = ${session.metricsHash},
      model_id = ${session.modelId},
      protocol_hash = ${session.assessmentProtocolHash},
      blindness_compromised = ${Boolean(session.blindnessCompromised)},
      session_document = ${tx.json(session as never)},
      revision = ${session.revision},
      updated_at = now()
    WHERE id = ${dbId} AND revision = ${expectedRevision}
    RETURNING revision`;
  if (rows.length === 0) throw new Error("revision_conflict");
}

/** Returns the persisted client document, or null before its first save. */
export async function loadSessionDocument(
  workspaceId: string,
  datasetId: string,
  guideVersion: number,
  sql: Sql = pilotSql(),
): Promise<Phase4Session | null> {
  const row = await sessionRow(workspaceId, datasetId, guideVersion, sql);
  return row?.sessionDocument ?? null;
}

/**
 * Saves a client document with revision CAS. A reset is the one sanctioned
 * reversal: it requires an already-revealed session and unspent credit, keeps
 * the receipt intact, and marks the replacement practice as non-blind.
 */
export async function saveSessionDocument(input: {
  workspaceId: string;
  session: Phase4Session;
  resetWithCredit?: boolean;
}): Promise<Phase4Session> {
  return withPilotTransaction(async (tx) => {
    const requested = structuredClone(input.session);
    const binding = await datasetBinding(input.workspaceId, requested.datasetId, tx);
    if (!binding || binding.guideVersion !== requested.guideVersion) {
      throw new Error("Phase 4 cannot save against changed historical data.");
    }

    const row = await sessionRow(
      input.workspaceId,
      requested.datasetId,
      requested.guideVersion,
      tx,
      true,
    );
    const current = row?.sessionDocument ?? null;
    const now = new Date().toISOString();

    if (row && requested.revision !== row.revision) throw new Error("revision_conflict");

    if (input.resetWithCredit) {
      if (
        !row ||
        !current ||
        !["revealed", "passed", "failed"].includes(current.practiceStatus)
      ) {
        throw new Error("No recalibration retry is available for this historical set.");
      }
      const [receipt] = await tx<{ headroom: number }[]>`
        SELECT GREATEST(reveals_allowed - reveal_count, 0)::int AS headroom
          FROM netzero.calibration_reveal_receipts
         WHERE dataset_fingerprint = ${binding.datasetFingerprint}
           AND workspace_id = ${input.workspaceId}
           AND session_id = ${row.dbId}`;
      if (!receipt || receipt.headroom < 1) {
        throw new Error("No recalibration retry is available for this historical set.");
      }
      const reset: Phase4Session = {
        ...requested,
        outcomes: null,
        revealedAt: null,
        blindnessCompromised: true,
        revision: row.revision + 1,
        updatedAt: now,
      };
      if (
        !initialPhase4SessionIsPristine({ ...reset, revision: 0 }) ||
        !phase4SessionMatchesBinding(reset, binding) ||
        !phase4SessionIsCoherent(reset) ||
        !(await phase4DerivedHashesAreValid(reset))
      ) {
        throw new Error("The recalibration reset failed its integrity checks.");
      }
      await writeDocument(tx, row.dbId, row.revision, reset);
      return reset;
    }

    if (!current) {
      const [consumed] = await tx<{ one: number }[]>`
        SELECT 1 AS one FROM netzero.calibration_reveal_receipts
         WHERE dataset_fingerprint = ${binding.datasetFingerprint}
           AND workspace_id = ${input.workspaceId}`;
      if (consumed) throw new Error("already_revealed");
    }

    if (!row) {
      const initial: Phase4Session = {
        ...withServerOwnedReveal(requested, null),
        blindnessCompromised: false,
        revision: 0,
        updatedAt: now,
      };
      if (!initialPhase4SessionIsPristine(initial)) {
        throw new Error("Phase 4 changed in another tab or attempted an unsafe reversal.");
      }
      await assertValidDocument(initial, binding);
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO netzero.calibration_sessions
          (workspace_id, dataset_id, guide_version, practice_status, patterns,
           acceptance_policy, assessments, outcomes, prediction_hash, metrics,
           metrics_hash, model_id, protocol_hash, blindness_compromised,
           session_document, revision)
        VALUES (${input.workspaceId}, ${initial.datasetId}, ${initial.guideVersion},
                ${initial.practiceStatus}, ${tx.json(initial.patterns as never)},
                NULL, ${tx.json(initial.assessments as never)}, NULL, NULL, NULL,
                NULL, NULL, NULL, false, ${tx.json(initial as never)}, 0)
        ON CONFLICT (workspace_id, dataset_id, guide_version) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) throw new Error("revision_conflict");
      return initial;
    }

    if (!current) {
      const initial: Phase4Session = {
        ...withServerOwnedReveal(requested, null),
        blindnessCompromised: false,
        revision: row.revision + 1,
        updatedAt: now,
      };
      if (!initialPhase4SessionIsPristine({ ...initial, revision: 0 })) {
        throw new Error("Phase 4 changed in another tab or attempted an unsafe reversal.");
      }
      await assertValidDocument(initial, binding);
      await writeDocument(tx, row.dbId, row.revision, initial);
      return initial;
    }

    const candidateAtCurrentRevision: Phase4Session = {
      ...withServerOwnedReveal(requested, current),
      revision: current.revision,
    };
    if (!phase4SessionTransitionAllowed(current, candidateAtCurrentRevision)) {
      throw new Error("Phase 4 changed in another tab or attempted an unsafe reversal.");
    }
    const saved: Phase4Session = {
      ...candidateAtCurrentRevision,
      revision: row.revision + 1,
      updatedAt: now,
    };
    await assertValidDocument(saved, binding);
    await writeDocument(tx, row.dbId, row.revision, saved);
    return saved;
  });
}

/** Reveals the server-held answer key and consumes the seal atomically. */
export async function revealSession(input: {
  workspaceId: string;
  datasetId: string;
  guideVersion: number;
  expectedRevision: number;
}): Promise<Phase4Session> {
  return withPilotTransaction(async (tx) => {
    const row = await sessionRow(
      input.workspaceId,
      input.datasetId,
      input.guideVersion,
      tx,
      true,
    );
    const current = row?.sessionDocument ?? null;
    if (!row || !current) throw new Error("The committed practice test could not be found.");
    const binding = { ...bindingFromRow(row), datasetId: input.datasetId };
    await assertValidDocument(current, binding);

    if (["revealed", "passed", "failed"].includes(current.practiceStatus)) return current;
    if (row.revision !== input.expectedRevision) throw new Error("revision_conflict");
    if (
      current.practiceStatus !== "predictions_committed" ||
      !current.predictionHash ||
      current.assessments.length !== current.sealedRows
    ) {
      throw new Error("All blind predictions must be committed before outcomes can be revealed.");
    }

    const outcomes = await tx<{ rowId: string; outcome: string }[]>`
      SELECT row_id AS "rowId", outcome
        FROM netzero.historical_rows
       WHERE dataset_id = ${input.datasetId} AND partition = 'sealed_test'
       ORDER BY row_id`;
    const predictedIds = current.assessments.map((item) => item.rowId).sort();
    const outcomeIds = outcomes.map((item) => item.rowId).sort();
    if (
      outcomes.length === 0 ||
      outcomes.length !== current.sealedRows ||
      predictedIds.length !== outcomeIds.length ||
      predictedIds.some((id, index) => id !== outcomeIds[index])
    ) {
      throw new Error("Every sealed prediction must be committed before outcomes can be revealed.");
    }

    try {
      await tx`
        INSERT INTO netzero.calibration_reveal_receipts
          (dataset_fingerprint, workspace_id, session_id)
        VALUES (${binding.datasetFingerprint}, ${input.workspaceId}, ${row.dbId})
        ON CONFLICT (dataset_fingerprint) DO UPDATE
          SET reveal_count = netzero.calibration_reveal_receipts.reveal_count + 1,
              session_id = EXCLUDED.session_id,
              last_revealed_at = now()`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/reveal_within_budget|reveal_count/i.test(message)) throw new Error("already_revealed");
      throw error;
    }

    const revealedAt = new Date().toISOString();
    const revealed: Phase4Session = {
      ...current,
      practiceStatus: "revealed",
      outcomes: outcomes as Phase4Session["outcomes"],
      revealedAt,
      revision: row.revision + 1,
      updatedAt: revealedAt,
    };
    await assertValidDocument(revealed, binding);
    await writeDocument(tx, row.dbId, row.revision, revealed);
    return revealed;
  });
}

/** Whether this fingerprint has ever spent its seal, plus credited headroom. */
export async function consumedState(
  workspaceId: string,
  datasetFingerprint: string,
  sql: Sql = pilotSql(),
): Promise<ConsumedState> {
  const [row] = await sql<{ headroom: number }[]>`
    SELECT GREATEST(reveals_allowed - reveal_count, 0)::int AS headroom
      FROM netzero.calibration_reveal_receipts
     WHERE workspace_id = ${workspaceId}
       AND dataset_fingerprint = ${datasetFingerprint}`;
  return row ? { consumed: true, headroom: row.headroom } : { consumed: false, headroom: 0 };
}

/** Grants one retry only when the named client session owns the receipt. */
export async function grantRecalibrationCreditForSession(
  workspaceId: string,
  clientSessionId: string,
  reason: string,
): Promise<boolean> {
  return withPilotTransaction(async (tx) => {
    const [row] = await tx<{ dbId: string; datasetFingerprint: string }[]>`
      SELECT cs.id AS "dbId", hd.fingerprint AS "datasetFingerprint"
        FROM netzero.calibration_sessions cs
        JOIN netzero.historical_datasets hd ON hd.id = cs.dataset_id
        JOIN netzero.calibration_reveal_receipts rr
          ON rr.dataset_fingerprint = hd.fingerprint
         AND rr.workspace_id = cs.workspace_id
         AND rr.session_id = cs.id
       WHERE cs.workspace_id = ${workspaceId}
         AND cs.session_document ->> 'id' = ${clientSessionId}
       FOR UPDATE OF cs`;
    if (!row) return false;
    await tx`
      INSERT INTO netzero.recalibration_credits (dataset_fingerprint, session_id, reason)
      VALUES (${row.datasetFingerprint}, ${row.dbId}, ${reason})`;
    return true;
  });
}
