/**
 * Import repository: persists historical calibration data and current-round
 * applications into the pilot schema.
 *
 * Integrity contract:
 *   - Historical datasets are sealed by createSealedHistoricalDataset (run
 *     SERVER-SIDE in the API route), which derives the fingerprint and the
 *     teaching/sealed partition from the rows. This repository only persists
 *     that server-computed result; it never accepts a fingerprint or a partition
 *     chosen by the browser.
 *   - Sealed-test outcomes are never returned by loadBlindCases. Only
 *     loadSealedOutcomes exposes them, and the API gates that behind a revealed
 *     practice test.
 *   - Current applications keep answer text (AI-visible) separate from identity
 *     (PII) in two tables; loadCurrentCasesForAi returns answers only.
 */

import type { HistoricalImportSummary, SealedHistoricalDataset } from "../../app/historical-data.ts";
import type {
  CurrentDatasetBinding,
  CurrentImportSummary,
  SealedCurrentDataset,
  StoredCurrentIdentity,
} from "../../app/current-data.ts";
import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";

export type HistoricalBinding = {
  datasetId: string;
  datasetFingerprint: string;
  integrityHash: string;
  guideVersion: number;
  teachingRows: number;
  sealedRows: number;
};

export type TeachingRow = { rowId: string; answers: { heading: string; value: string }[]; outcome: string };
export type BlindCase = { rowId: string; answers: { heading: string; value: string }[] };
export type SealedOutcome = { rowId: string; outcome: string };

export type CurrentCaseInput = {
  rowId: string;
  answers: { heading: string; value: string }[];
  identity: Record<string, unknown>;
};

// Keep each statement comfortably below PostgreSQL's parameter limit while
// avoiding one network round trip per imported application.
const IMPORT_INSERT_BATCH_SIZE = 100;

export function importBatches<T>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += IMPORT_INSERT_BATCH_SIZE) {
    batches.push(rows.slice(offset, offset + IMPORT_INSERT_BATCH_SIZE));
  }
  return batches;
}

// ----------------------------------------------------------- historical ---

/**
 * Persists a server-sealed historical dataset (fingerprint + teaching/sealed
 * partition already derived) and makes it the single active dataset for the
 * workspace. `replaceDatasetId`, when given, deletes the prior dataset first
 * (cascading its rows) — the same replace-on-reimport the browser flow did.
 *
 * The stored summary's datasetId is rewritten to the DB id (the seal carries a
 * throwaway id), so `loadActiveHistoricalSummary` returns the id the rest of the
 * app keys on. Returns that reconciled summary alongside the id and fingerprint.
 */
export async function saveHistoricalDataset(
  workspaceId: string,
  sealed: SealedHistoricalDataset,
  replaceDatasetId?: string | null,
): Promise<{ datasetId: string; fingerprint: string; summary: HistoricalImportSummary }> {
  const md = sealed.metadata;
  const rows = [...sealed.teachingRows, ...sealed.sealedRows];
  return withPilotTransaction(async (tx) => {
    if (replaceDatasetId) {
      await tx`
        DELETE FROM netzero.historical_datasets
         WHERE id = ${replaceDatasetId} AND workspace_id = ${workspaceId}`;
    }

    // A browser retry can arrive after the first request committed but before
    // its response reached the page. The fingerprint is unique per workspace,
    // so inserting again would otherwise turn a successful first save into a
    // permanent 23505 loop. Reuse the complete, transactionally-created dataset
    // when the server-derived seal still matches.
    const [existing] = await tx<{
      id: string;
      integrityHash: string;
      teachingCount: number;
      sealedCount: number;
    }[]>`
      SELECT id, integrity_hash AS "integrityHash",
             teaching_count AS "teachingCount", sealed_count AS "sealedCount"
        FROM netzero.historical_datasets
       WHERE workspace_id = ${workspaceId} AND fingerprint = ${md.datasetFingerprint}`;
    if (existing) {
      if (
        existing.integrityHash !== md.split.integrityHash ||
        existing.teachingCount !== sealed.teachingRows.length ||
        existing.sealedCount !== sealed.sealedRows.length
      ) {
        throw new Error("This historical file conflicts with an earlier sealed import.");
      }
      const summary: HistoricalImportSummary = { ...md.summary, datasetId: existing.id };
      await tx`
        UPDATE netzero.historical_datasets SET active = false
         WHERE workspace_id = ${workspaceId} AND active AND id <> ${existing.id}`;
      await tx`
        UPDATE netzero.historical_datasets
           SET name = ${md.sourceName ?? "history"}, file_name = ${md.sourceName ?? null},
               summary = ${tx.json(summary)}, guide_version = ${md.guideVersion}, active = true
         WHERE id = ${existing.id}`;
      return { datasetId: existing.id, fingerprint: md.datasetFingerprint, summary };
    }

    // Only one active historical dataset per workspace.
    await tx`
      UPDATE netzero.historical_datasets SET active = false
       WHERE workspace_id = ${workspaceId} AND active`;
    const [dataset] = await tx<{ id: string }[]>`
      INSERT INTO netzero.historical_datasets
        (workspace_id, name, file_name, fingerprint, integrity_hash,
         teaching_count, sealed_count, guide_version, active)
      VALUES (${workspaceId}, ${md.sourceName ?? "history"}, ${md.sourceName ?? null},
              ${md.datasetFingerprint}, ${md.split.integrityHash},
              ${sealed.teachingRows.length}, ${sealed.sealedRows.length},
              ${md.guideVersion}, true)
      RETURNING id`;
    const summary: HistoricalImportSummary = { ...md.summary, datasetId: dataset.id };
    await tx`
      UPDATE netzero.historical_datasets SET summary = ${tx.json(summary)}
       WHERE id = ${dataset.id}`;
    for (const batch of importBatches(rows)) {
      await tx`
        INSERT INTO netzero.historical_rows
          (dataset_id, row_id, partition, answers, outcome, row_fingerprint)
        ${tx(
          batch.map((row) => ({
            dataset_id: dataset.id,
            row_id: row.rowId,
            partition: row.partition,
            answers: tx.json(row.answers),
            outcome: row.outcome,
            row_fingerprint: row.rowId,
          })),
          "dataset_id",
          "row_id",
          "partition",
          "answers",
          "outcome",
          "row_fingerprint",
        )}`;
    }
    return { datasetId: dataset.id, fingerprint: md.datasetFingerprint, summary };
  });
}

/** The active dataset's stored import summary (datasetId already the DB id). */
export async function loadActiveHistoricalSummary(
  workspaceId: string,
  sql: Sql = pilotSql(),
): Promise<HistoricalImportSummary | null> {
  const [row] = await sql<{ summary: HistoricalImportSummary | null }[]>`
    SELECT summary FROM netzero.historical_datasets
     WHERE workspace_id = ${workspaceId} AND active
     ORDER BY created_at DESC LIMIT 1`;
  return row?.summary ?? null;
}

/**
 * The binding the calibration/practice flow pins itself to: the server-authored
 * fingerprint, integrity hash, guide version and partition counts. Returned
 * straight from the stored columns — the seal is authoritative server-side, so
 * there is no browser recompute to fail closed on.
 */
export async function loadHistoricalDatasetBinding(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<HistoricalBinding | null> {
  const [row] = await sql<HistoricalBinding[]>`
    SELECT id AS "datasetId", fingerprint AS "datasetFingerprint",
           integrity_hash AS "integrityHash", guide_version AS "guideVersion",
           teaching_count AS "teachingRows", sealed_count AS "sealedRows"
      FROM netzero.historical_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}`;
  return row ?? null;
}

/** True if the dataset exists in this workspace. */
export async function historicalDatasetExists(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM netzero.historical_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}`;
  return Boolean(row);
}

/** Deletes a historical dataset and cascades its rows. */
export async function deleteHistoricalDataset(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<void> {
  await sql`
    DELETE FROM netzero.historical_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}`;
}

/** Teaching rows carry their outcome (they are the labelled examples). */
export async function loadTeachingRows(datasetId: string, sql: Sql = pilotSql()): Promise<TeachingRow[]> {
  return sql<TeachingRow[]>`
    SELECT row_id AS "rowId", answers, outcome
      FROM netzero.historical_rows
     WHERE dataset_id = ${datasetId} AND partition = 'teaching'
     ORDER BY row_id`;
}

/** Blind practice cases NEVER include the sealed outcome. */
export async function loadBlindCases(datasetId: string, sql: Sql = pilotSql()): Promise<BlindCase[]> {
  return sql<BlindCase[]>`
    SELECT row_id AS "rowId", answers
      FROM netzero.historical_rows
     WHERE dataset_id = ${datasetId} AND partition = 'sealed_test'
     ORDER BY row_id`;
}

/**
 * Sealed outcomes - the practice-test answer key. The API must only call this
 * after the practice test has been revealed for this dataset.
 */
export async function loadSealedOutcomes(datasetId: string, sql: Sql = pilotSql()): Promise<SealedOutcome[]> {
  return sql<SealedOutcome[]>`
    SELECT row_id AS "rowId", outcome
      FROM netzero.historical_rows
     WHERE dataset_id = ${datasetId} AND partition = 'sealed_test'
     ORDER BY row_id`;
}

// -------------------------------------------------------------- current ---

/**
 * Freezes a current-round dataset: stores answer text and identity in separate
 * tables. Fingerprint is derived server-side (in the API route) from the cases.
 */
export async function freezeCurrentDataset(
  workspaceId: string,
  input: { name: string; fingerprint: string; cases: CurrentCaseInput[] },
): Promise<{ datasetId: string }> {
  return withPilotTransaction(async (tx) => {
    const [dataset] = await tx<{ id: string }[]>`
      INSERT INTO netzero.current_datasets (workspace_id, name, fingerprint, case_count)
      VALUES (${workspaceId}, ${input.name}, ${input.fingerprint}, ${input.cases.length})
      RETURNING id`;
    for (const c of input.cases) {
      await tx`
        INSERT INTO netzero.current_cases (dataset_id, row_id, answers)
        VALUES (${dataset.id}, ${c.rowId}, ${tx.json(c.answers)})`;
      // identity is arbitrary JSON; round-trip to a plain JSON value (typed any)
      // so sql.json() encodes it once, matching how answers are stored.
      await tx`
        INSERT INTO netzero.current_identities (dataset_id, row_id, identity)
        VALUES (${dataset.id}, ${c.rowId}, ${tx.json(JSON.parse(JSON.stringify(c.identity)))})`;
    }
    return { datasetId: dataset.id };
  });
}

/**
 * Persists an API-sealed current dataset and makes it the active set. A replaced
 * dataset is deleted only when no Phase 5 run references it; otherwise it is
 * retained as an immutable audit input and merely superseded.
 */
export async function saveCurrentDataset(
  workspaceId: string,
  sealed: SealedCurrentDataset,
  replaceDatasetId?: string | null,
): Promise<{ datasetId: string; fingerprint: string; summary: CurrentImportSummary }> {
  return withPilotTransaction(async (tx) => {
    const md = sealed.metadata;
    if (replaceDatasetId) {
      const [owned] = await tx<{ one: number }[]>`
        SELECT 1 AS one FROM netzero.current_datasets
         WHERE id = ${replaceDatasetId} AND workspace_id = ${workspaceId}`;
      if (owned) {
        const [referenced] = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM netzero_ai.assessment_runs
           WHERE current_dataset_id = ${replaceDatasetId} LIMIT 1`;
        if (!referenced) {
          await tx`
            DELETE FROM netzero.current_datasets
             WHERE id = ${replaceDatasetId} AND workspace_id = ${workspaceId}`;
        }
      }
    }
    await tx`
      UPDATE netzero.current_datasets SET active = false
       WHERE workspace_id = ${workspaceId} AND active`;
    await tx`
      INSERT INTO netzero.current_datasets
        (id, workspace_id, name, fingerprint, integrity_hash, case_count,
         metadata, active, frozen_at)
      VALUES (${md.id}, ${workspaceId}, ${md.sourceName}, ${md.datasetFingerprint},
              ${md.integrityHash}, ${sealed.cases.length}, ${tx.json(md as never)},
              true, ${md.importedAt})`;
    for (const batch of importBatches(sealed.cases)) {
      await tx`
        INSERT INTO netzero.current_cases
          (dataset_id, row_id, answers, content_hash)
        ${tx(
          batch.map((currentCase) => ({
            dataset_id: md.id,
            row_id: currentCase.rowId,
            answers: tx.json(currentCase.answers as never),
            content_hash: currentCase.contentHash,
          })),
          "dataset_id",
          "row_id",
          "answers",
          "content_hash",
        )}`;
    }
    for (const batch of importBatches(sealed.identities)) {
      await tx`
        INSERT INTO netzero.current_identities (dataset_id, row_id, identity)
        ${tx(
          batch.map((identity) => ({
            dataset_id: md.id,
            row_id: identity.rowId,
            identity: tx.json(identity as never),
          })),
          "dataset_id",
          "row_id",
          "identity",
        )}`;
    }
    return {
      datasetId: md.id,
      fingerprint: md.datasetFingerprint,
      summary: md.summary,
    };
  });
}

export async function loadActiveCurrentSummary(
  workspaceId: string,
  sql: Sql = pilotSql(),
): Promise<CurrentImportSummary | null> {
  const [row] = await sql<{ summary: CurrentImportSummary | null }[]>`
    SELECT metadata -> 'summary' AS summary
      FROM netzero.current_datasets
     WHERE workspace_id = ${workspaceId} AND active
     ORDER BY frozen_at DESC LIMIT 1`;
  return row?.summary ?? null;
}

export async function currentDatasetExists(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM netzero.current_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}
       AND metadata IS NOT NULL AND integrity_hash IS NOT NULL`;
  return Boolean(row);
}

export async function loadCurrentDatasetBinding(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<CurrentDatasetBinding | null> {
  const [row] = await sql<CurrentDatasetBinding[]>`
    SELECT id AS "datasetId", fingerprint AS "datasetFingerprint",
           integrity_hash AS "integrityHash", case_count AS "totalRows"
      FROM netzero.current_datasets
     WHERE id = ${datasetId} AND workspace_id = ${workspaceId}
       AND metadata IS NOT NULL AND integrity_hash IS NOT NULL`;
  return row ?? null;
}

export async function loadCurrentIdentitiesForReview(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<StoredCurrentIdentity[]> {
  const rows = await sql<{ identity: StoredCurrentIdentity }[]>`
    SELECT ci.identity
      FROM netzero.current_identities ci
      JOIN netzero.current_datasets cd ON cd.id = ci.dataset_id
     WHERE ci.dataset_id = ${datasetId} AND cd.workspace_id = ${workspaceId}
     ORDER BY (ci.identity ->> 'sourceRowNumber')::integer, ci.row_id`;
  return rows.map((row) => row.identity);
}

export async function deleteCurrentDataset(
  workspaceId: string,
  datasetId: string,
): Promise<void> {
  await withPilotTransaction(async (tx) => {
    const [referenced] = await tx<{ one: number }[]>`
      SELECT 1 AS one FROM netzero_ai.assessment_runs ar
      JOIN netzero.current_datasets cd ON cd.id = ar.current_dataset_id
       WHERE ar.current_dataset_id = ${datasetId} AND cd.workspace_id = ${workspaceId}
       LIMIT 1`;
    if (referenced) {
      throw new Error("Applications referenced by an assessment run cannot be removed.");
    }
    await tx`
      DELETE FROM netzero.current_datasets
       WHERE id = ${datasetId} AND workspace_id = ${workspaceId}`;
  });
}

/** AI-visible: answer text only, never identity. */
export async function loadCurrentCasesForAi(datasetId: string, sql: Sql = pilotSql()): Promise<BlindCase[]> {
  return sql<BlindCase[]>`
    SELECT row_id AS "rowId", answers
      FROM netzero.current_cases
     WHERE dataset_id = ${datasetId}
     ORDER BY row_id`;
}

/** Workspace-scoped AI view used by the authenticated API boundary. */
export async function loadCurrentCasesForAiInWorkspace(
  workspaceId: string,
  datasetId: string,
  sql: Sql = pilotSql(),
): Promise<BlindCase[]> {
  return sql<BlindCase[]>`
    SELECT cc.row_id AS "rowId", cc.answers
      FROM netzero.current_cases cc
      JOIN netzero.current_datasets cd ON cd.id = cc.dataset_id
     WHERE cc.dataset_id = ${datasetId} AND cd.workspace_id = ${workspaceId}
     ORDER BY cc.row_id`;
}

/** Identity is read separately, only when a human needs to see who a row is. */
export async function loadCurrentIdentity(
  datasetId: string,
  rowId: string,
  sql: Sql = pilotSql(),
): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ identity: Record<string, unknown> }[]>`
    SELECT identity FROM netzero.current_identities
     WHERE dataset_id = ${datasetId} AND row_id = ${rowId}`;
  return row?.identity ?? null;
}
