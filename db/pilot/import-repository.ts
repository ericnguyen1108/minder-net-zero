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

import type { SealedHistoricalDataset } from "../../app/historical-data.ts";
import type { Sql } from "./client.ts";
import { pilotSql, withPilotTransaction } from "./client.ts";

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
 * partition already derived). Returns the new dataset id and fingerprint.
 */
export async function saveHistoricalDataset(
  workspaceId: string,
  sealed: SealedHistoricalDataset,
): Promise<{ datasetId: string; fingerprint: string }> {
  const md = sealed.metadata;
  const rows = [...sealed.teachingRows, ...sealed.sealedRows];
  return withPilotTransaction(async (tx) => {
    const [dataset] = await tx<{ id: string }[]>`
      INSERT INTO netzero.historical_datasets
        (workspace_id, name, file_name, fingerprint, integrity_hash, teaching_count, sealed_count)
      VALUES (${workspaceId}, ${md.sourceName ?? "history"}, ${md.sourceName ?? null},
              ${md.datasetFingerprint}, ${md.split.integrityHash},
              ${sealed.teachingRows.length}, ${sealed.sealedRows.length})
      RETURNING id`;
    for (const row of rows) {
      await tx`
        INSERT INTO netzero.historical_rows
          (dataset_id, row_id, partition, answers, outcome, row_fingerprint)
        VALUES (${dataset.id}, ${row.rowId}, ${row.partition},
                ${tx.json(row.answers)}, ${row.outcome}, ${row.rowId})`;
    }
    return { datasetId: dataset.id, fingerprint: md.datasetFingerprint };
  });
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
