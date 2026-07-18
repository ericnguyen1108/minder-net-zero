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
    for (const row of rows) {
      await tx`
        INSERT INTO netzero.historical_rows
          (dataset_id, row_id, partition, answers, outcome, row_fingerprint)
        VALUES (${dataset.id}, ${row.rowId}, ${row.partition},
                ${tx.json(row.answers)}, ${row.outcome}, ${row.rowId})`;
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

/** AI-visible: answer text only, never identity. */
export async function loadCurrentCasesForAi(datasetId: string, sql: Sql = pilotSql()): Promise<BlindCase[]> {
  return sql<BlindCase[]>`
    SELECT row_id AS "rowId", answers
      FROM netzero.current_cases
     WHERE dataset_id = ${datasetId}
     ORDER BY row_id`;
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
