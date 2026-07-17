import assert from "node:assert/strict";
import test from "node:test";
import * as historicalData from "../app/historical-data.ts";
import {
  createSealedHistoricalDataset,
  deleteHistoricalDataset,
  historicalDatasetExists,
  loadActiveHistoricalSummary,
  loadBlindPracticeRows,
  loadHistoricalDatasetBinding,
  loadTeachingRows,
  prepareHistoricalDataset,
  saveHistoricalDataset,
  sanitizeHistoricalImportSummary,
} from "../app/historical-data.ts";
import {
  createPhase4Session,
  contentHash,
  grantPhase4RecalibrationCredit,
  loadPhase4RecalibrationCredits,
  loadPhase4Session,
  resetPhase4SessionWithCredit,
  revealCommittedOutcomes,
  savePhase4Session,
} from "../app/phase4-storage.ts";
import { buildSourceTable, parseDelimitedText } from "../app/historical-parser.ts";
import { exportWorkspace, importWorkspace, parseWorkspaceBackup } from "../app/backup.ts";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const localStorageStore = new Map();
globalThis.localStorage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
  setItem: (key, value) => { localStorageStore.set(key, String(value)); },
  removeItem: (key) => { localStorageStore.delete(key); },
};

const columns = [
  { key: "id", label: "Application ID", index: 0 },
  { key: "team", label: "Team", index: 1 },
  { key: "problem", label: "Problem", index: 2 },
  { key: "solution", label: "Solution", index: 3 },
  { key: "outcome", label: "Final result", index: 4 },
  { key: "year", label: "Year", index: 5 },
];

const mapping = {
  applicationId: "id",
  teamName: "team",
  responseColumns: ["problem", "solution"],
  outcome: "outcome",
  year: "year",
  track: "",
  judgeScore: "",
  reviewerNotes: "",
};

const outcomeMapping = {
  shortlisted: "progressed",
  "not selected": "not_progressed",
  withdrawn: "ignore",
};

function makeRows(progressed = 30, notProgressed = 30) {
  return Array.from({ length: progressed + notProgressed }, (_, index) => ({
    id: `APP-${String(index + 1).padStart(4, "0")}`,
    team: `Team ${index + 1}`,
    problem: `Problem statement ${index + 1} explains the material climate challenge in sufficient detail.`,
    solution: `Solution ${index + 1} explains the proposed intervention, evidence and delivery plan in sufficient detail.`,
    outcome: index < progressed ? "Shortlisted" : "Not selected",
    year: "2025",
  }));
}

function makeTable(rows) {
  return {
    sheetName: "Applications",
    columns,
    rows,
    rowNumbers: rows.map((_, index) => index + 2),
  };
}

test("parses BOM, quoted commas, multiline CSV, TSV and preserves row numbers across blanks", () => {
  const csv =
    '\uFEFFID,Team,Answer,Outcome\r\n0012,"Team, One","Line one\nLine two",Shortlisted\r\n\r\n0013,Team Two,Answer two,Not selected\r\n';
  const csvTable = buildSourceTable("CSV", parseDelimitedText(csv));
  assert.equal(csvTable.rows.length, 2);
  assert.equal(csvTable.rows[0][csvTable.columns[0].key], "0012");
  assert.equal(csvTable.rows[0][csvTable.columns[2].key], "Line one\nLine two");
  assert.deepEqual(csvTable.rowNumbers, [2, 4]);

  const tsvTable = buildSourceTable(
    "TSV",
    parseDelimitedText("ID\tTeam\tAnswer\tOutcome\n0007\tTeam Seven\tAnswer\tShortlisted\n"),
  );
  assert.equal(tsvTable.rows[0][tsvTable.columns[0].key], "0007");
});

test("de-duplicates headers without colliding with a real pre-existing label", () => {
  const table = buildSourceTable("CSV", [
    ["Name", "Name", "Name (2)"],
    ["a", "b", "c"],
  ]);
  const labels = table.columns.map((column) => column.label);
  assert.equal(new Set(labels).size, labels.length, "every emitted header label must be unique");
  assert.deepEqual(labels, ["Name", "Name (2)", "Name (2) (2)"]);
});

test("rejects an oversized file with a clear error instead of crashing on a huge spread", () => {
  const header = [["ID", "Answer"]];
  const rows = Array.from({ length: 10_002 }, (_, index) => [`ID-${index}`, `Answer ${index}`]);
  assert.throws(() => buildSourceTable("CSV", [...header, ...rows]), /accepts up to 10,000 rows/);
});

test("accepts exactly 10,000 real rows even with a trailing blank line", () => {
  const header = [["ID", "Answer"]];
  const rows = Array.from({ length: 10_000 }, (_, index) => [`ID-${index}`, `Answer ${index}`]);
  const trailingBlank = [[""]]; // exporters commonly add a trailing newline
  const table = buildSourceTable("CSV", [...header, ...rows, ...trailingBlank]);
  assert.equal(table.rows.length, 10_000);
});

test("keeps question headings, preserves leading-zero IDs and never guesses outcomes", () => {
  const rows = makeRows(10, 10);
  rows[0].id = "0012";
  rows.push({
    id: "0099",
    team: "Unknown decision team",
    problem: "A sufficiently detailed problem statement that must remain intact for later evidence checking.",
    solution: "A sufficiently detailed solution statement that must remain intact for later evidence checking.",
    outcome: "Maybe",
    year: "2025",
  });
  const prepared = prepareHistoricalDataset(makeTable(rows), mapping, outcomeMapping);

  assert.equal(prepared.rows[0].externalId, "0012");
  assert.deepEqual(prepared.rows[0].answers.map((answer) => answer.heading), ["Problem", "Solution"]);
  assert.match(prepared.rows[0].applicationText, /^Problem\n/);
  assert.equal(prepared.rows.at(-1).outcome, null);
  assert.ok(prepared.rows.at(-1).issues.includes("unmapped-outcome"));
  assert.equal(prepared.totalRows, prepared.validRows.length + prepared.excludedRows);
});

test("shows missing, ignored, exact duplicate and conflicting records as excluded", () => {
  const rows = makeRows(12, 12);
  rows.push({ ...rows[0] });
  rows.push({ ...rows[1], id: "NEW-ID" });
  rows.push({ ...rows[2], solution: "Different text", outcome: "Not selected" });
  rows.push({ ...rows[3], id: "BLANK-TEXT", problem: "", solution: "" });
  rows.push({ ...rows[4], id: "WITHDRAWN", outcome: "Withdrawn" });
  const prepared = prepareHistoricalDataset(makeTable(rows), mapping, outcomeMapping);

  assert.equal(prepared.excludedRows, 6);
  assert.equal(prepared.duplicateRows, 4);
  assert.ok((prepared.issueCounts["conflicting-id"] ?? 0) >= 2);
  assert.ok((prepared.issueCounts["missing-text"] ?? 0) >= 1);
  assert.ok((prepared.issueCounts["ignored-outcome"] ?? 0) >= 1);
  assert.equal(prepared.totalRows, prepared.validRows.length + prepared.excludedRows);
});

test("creates one exact, deterministic and outcome-balanced 80/20 blind split", async () => {
  const table = makeTable(makeRows());
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  assert.equal(prepared.canSeal, true);

  const common = {
    fileName: "history.xlsx",
    fileSize: 12000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  };
  const first = await createSealedHistoricalDataset({ ...common, datasetId: "history-one" });
  const reversedTable = makeTable([...table.rows].reverse());
  const reversedPrepared = prepareHistoricalDataset(reversedTable, mapping, outcomeMapping);
  const second = await createSealedHistoricalDataset({
    ...common,
    datasetId: "history-two",
    table: reversedTable,
    prepared: reversedPrepared,
  });

  assert.equal(first.sealedRows.length, 12);
  assert.equal(first.teachingRows.length, 48);
  assert.ok(first.sealedRows.some((row) => row.outcome === "progressed"));
  assert.ok(first.sealedRows.some((row) => row.outcome === "not_progressed"));
  const assignments = (dataset) =>
    Object.fromEntries(
      [...dataset.teachingRows, ...dataset.sealedRows]
        .map((row) => [row.externalId, row.partition])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  assert.deepEqual(assignments(first), assignments(second));
  assert.equal(first.metadata.split.algorithm, "linked-outcome-sha256-v2");
  assert.equal(first.metadata.split.status, "sealed");
});

test("scopes reused IDs by year and keeps linked team-year applications in one partition", async () => {
  const rows = makeRows(15, 15);
  rows[1].id = rows[0].id;
  rows[1].year = "2024";
  rows[0].team = "Linked team";
  rows[1].team = "Linked team";
  rows[0].year = "2025";
  rows[2].team = "Same-year linked team";
  rows[3].team = "Same-year linked team";
  rows[2].year = "2025";
  rows[3].year = "2025";
  const table = makeTable(rows);
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  assert.equal(prepared.issueCounts["conflicting-id"] ?? 0, 0);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "linked-history",
    fileName: "linked.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  const partitions = Object.fromEntries(
    [...dataset.teachingRows, ...dataset.sealedRows].map((row) => [row.externalId, row.partition]),
  );
  assert.equal(partitions[rows[2].id], partitions[rows[3].id]);
});

test("splits 1,000 balanced examples into exactly 800 teaching and 200 sealed rows", async () => {
  const table = makeTable(makeRows(500, 500));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "history-1000",
    fileName: "history-1000.csv",
    fileSize: 250000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  assert.equal(dataset.teachingRows.length, 800);
  assert.equal(dataset.sealedRows.length, 200);
});

test("atomically stores an active pointer, verifies integrity and exposes teaching rows only", async () => {
  const table = makeTable(makeRows(15, 15));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "stored-history",
    fileName: "stored.xlsx",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  await saveHistoricalDataset(dataset);
  assert.equal(await historicalDatasetExists(dataset.metadata.id), true);
  assert.equal((await loadActiveHistoricalSummary()).datasetId, dataset.metadata.id);
  const teaching = await loadTeachingRows(dataset.metadata.id);
  assert.equal(teaching.length, dataset.teachingRows.length);
  assert.ok(teaching.every((row) => !("reviewerNotes" in row) && !("externalId" in row)));
  assert.ok(teaching.every((row) => !dataset.sealedRows.some((sealed) => sealed.rowId === row.rowId)));

  await deleteHistoricalDataset(dataset.metadata.id);
  assert.equal(await loadActiveHistoricalSummary(), null);
});

test("fails closed when stored assignments are changed without a new integrity seal", async () => {
  const table = makeTable(makeRows(15, 15));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "tampered-history",
    fileName: "tampered.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  await saveHistoricalDataset(dataset);
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("historical-teaching", "readwrite");
  const store = transaction.objectStore("historical-teaching");
  const row = dataset.teachingRows[0];
  store.put({ ...row, partition: "sealed_test" });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();

  assert.equal(await historicalDatasetExists(dataset.metadata.id), false);
  await assert.rejects(loadTeachingRows(dataset.metadata.id), /integrity check/i);
  await deleteHistoricalDataset(dataset.metadata.id);
});

test("keeps sealed outcomes hidden until a complete prediction set is committed", async () => {
  const table = makeTable(makeRows(15, 15));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "phase4-blind-history",
    fileName: "phase4.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  await saveHistoricalDataset(dataset);

  const blind = await loadBlindPracticeRows(dataset.metadata.id);
  assert.equal(blind.length, dataset.sealedRows.length);
  assert.ok(
    blind.every(
      (row) =>
        !Object.hasOwn(row, "outcome") &&
        !Object.hasOwn(row, "teamName") &&
        !Object.hasOwn(row, "reviewerNotes") &&
        !Object.hasOwn(row, "judgeScore"),
    ),
  );
  assert.equal("loadCompleteSealedOutcomeKey" in historicalData, false);

  const binding = await loadHistoricalDatasetBinding(dataset.metadata.id);
  let session = await createPhase4Session({ binding, guideContentHash: "guide-hash" });
  await assert.rejects(
    savePhase4Session({ ...session, patternStatus: "generating" }),
    /unsafe reversal/i,
  );
  session = await savePhase4Session(session);
  const assessments = blind.map((row) => ({
    rowId: row.rowId,
    eligibility: [],
    elimination: [],
    criteria: [],
    weightedScore: null,
    recommendation: "human_review",
    evidenceValid: false,
    humanReviewReasons: ["Explicit test abstention"],
  }));
  session = await savePhase4Session({
    ...session,
    modelId: "test-model",
    patternStatus: "generating",
    patternProcessedRows: binding.teachingRows,
    patternProgress: 100,
  });
  session = await savePhase4Session({ ...session, patternStatus: "reviewing" });
  session = await savePhase4Session({
    ...session,
    patternStatus: "approved",
    teachingApprovedAt: new Date().toISOString(),
    teachingApprovedBy: "Test organiser",
  });
  session = await savePhase4Session({
    ...session,
    practiceStatus: "policy_locked",
    acceptancePolicy: {
      evaluationMode: "binary_alignment",
      minimumHistoricalAlignment: 80,
      minimumProgressedCapture: 100,
      maximumHumanReviewRate: 30,
      waitlistPolicy: "exclude",
      tieBreakPriority: [],
      lockedAt: new Date().toISOString(),
      lockedBy: "Test organiser",
    },
  });
  session = await savePhase4Session({ ...session, practiceStatus: "running" });
  session = await savePhase4Session({
    ...session,
    assessmentProtocolHash: "1".repeat(64),
    assessments,
  });
  session = await savePhase4Session({
    ...session,
    practiceStatus: "predictions_committed",
    predictionHash: await contentHash(assessments),
  });
  assert.equal((await loadPhase4Session(dataset.metadata.id, 1)).outcomes, null);

  await assert.rejects(
    savePhase4Session({
      ...session,
      practiceStatus: "revealed",
      outcomes: dataset.sealedRows.map((row) => ({ rowId: row.rowId, outcome: row.outcome })),
      revealedAt: new Date().toISOString(),
    }),
    /one-use seal|unsafe reversal/i,
  );

  const revealed = await revealCommittedOutcomes(session);
  assert.equal(revealed.practiceStatus, "revealed");
  assert.equal(revealed.outcomes.length, blind.length);
  const receiptDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const consumedReceipt = await new Promise((resolve, reject) => {
    const request = receiptDatabase
      .transaction("phase4-consumed", "readonly")
      .objectStore("phase4-consumed")
      .get(dataset.metadata.datasetFingerprint);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  receiptDatabase.close();
  assert.deepEqual(Object.keys(consumedReceipt).sort(), [
    "datasetFingerprint",
    "revealCount",
    "revealedAt",
    "revealsAllowed",
    "sessionId",
  ]);
  assert.equal(consumedReceipt.revealsAllowed, 1);
  assert.equal(consumedReceipt.revealCount, 1);
  const revealedAgain = await revealCommittedOutcomes(revealed);
  assert.equal(revealedAgain.revealedAt, revealed.revealedAt);
  assert.deepEqual(revealedAgain.outcomes, revealed.outcomes);

  await assert.rejects(
    savePhase4Session({
      ...revealed,
      practiceStatus: "predictions_committed",
      outcomes: null,
      revealedAt: null,
    }),
    /unsafe reversal/i,
  );

  const tampered = {
    ...revealed,
    practiceStatus: "predictions_committed",
    outcomes: null,
    revealedAt: null,
    metrics: null,
    assessments: revealed.assessments.map((assessment, index) =>
      index === 0 ? { ...assessment, recommendation: "progressed" } : assessment,
    ),
  };
  await assert.rejects(savePhase4Session(tampered), /changed historical data/i);

  await deleteHistoricalDataset(dataset.metadata.id);
  await assert.rejects(loadPhase4Session(dataset.metadata.id, 1), /integrity check/i);

  const reimported = await createSealedHistoricalDataset({
    datasetId: "phase4-blind-reimport",
    fileName: "phase4-reimport.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  assert.equal(reimported.metadata.datasetFingerprint, dataset.metadata.datasetFingerprint);
  await saveHistoricalDataset(reimported);
  const reimportedBinding = await loadHistoricalDatasetBinding(reimported.metadata.id);
  await assert.rejects(
    createPhase4Session({
      binding: reimportedBinding,
      guideContentHash: "guide-hash",
    }),
    /already been used for a revealed blind test/i,
  );
  await deleteHistoricalDataset(reimported.metadata.id);
});

async function driveSessionToRevealed(binding, blind, startSession) {
  let session = startSession ?? (await createPhase4Session({ binding, guideContentHash: "guide-hash" }));
  const assessments = blind.map((row) => ({
    rowId: row.rowId,
    eligibility: [],
    elimination: [],
    criteria: [],
    weightedScore: null,
    recommendation: "human_review",
    evidenceValid: false,
    humanReviewReasons: ["Explicit test abstention"],
  }));
  session = await savePhase4Session(session);
  session = await savePhase4Session({
    ...session,
    modelId: "test-model",
    patternStatus: "generating",
    patternProcessedRows: binding.teachingRows,
    patternProgress: 100,
  });
  session = await savePhase4Session({ ...session, patternStatus: "reviewing" });
  session = await savePhase4Session({
    ...session,
    patternStatus: "approved",
    teachingApprovedAt: new Date().toISOString(),
    teachingApprovedBy: "Test organiser",
  });
  session = await savePhase4Session({
    ...session,
    practiceStatus: "policy_locked",
    acceptancePolicy: {
      evaluationMode: "binary_alignment",
      minimumHistoricalAlignment: 80,
      minimumProgressedCapture: 95,
      maximumHumanReviewRate: 100,
      waitlistPolicy: "exclude",
      tieBreakPriority: [],
      lockedAt: new Date().toISOString(),
      lockedBy: "Test organiser",
    },
  });
  session = await savePhase4Session({ ...session, practiceStatus: "running" });
  session = await savePhase4Session({
    ...session,
    assessmentProtocolHash: "2".repeat(64),
    assessments,
  });
  session = await savePhase4Session({
    ...session,
    practiceStatus: "predictions_committed",
    predictionHash: await contentHash(assessments),
  });
  return revealCommittedOutcomes(session);
}

test("a failed Phase 5 audit grants exactly one recalibration retry on the same file", async () => {
  const table = makeTable(makeRows(20, 20));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "phase4-recalibration",
    fileName: "recalibration.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  await saveHistoricalDataset(dataset);
  const binding = await loadHistoricalDatasetBinding(dataset.metadata.id);
  const blind = await loadBlindPracticeRows(dataset.metadata.id);

  const revealed = await driveSessionToRevealed(binding, blind);
  assert.equal(revealed.practiceStatus, "revealed");

  // Without a credit the file is consumed: no new session is allowed.
  await assert.rejects(
    createPhase4Session({ binding, guideContentHash: "guide-hash" }),
    /already been used for a revealed blind test/i,
  );

  // A failed audit grants one retry (reveal budget +1); a credited reset is permitted and flagged.
  assert.equal(await grantPhase4RecalibrationCredit(revealed.id), true);
  assert.equal(await loadPhase4RecalibrationCredits(dataset.metadata.datasetFingerprint), 1);
  const reset = await resetPhase4SessionWithCredit({ binding, guideContentHash: "guide-hash" });
  assert.equal(reset.blindnessCompromised, true);
  assert.equal(reset.practiceStatus, "not_started");
  // The reveal budget is spent on the retry's REVEAL, not on the reset itself.
  assert.equal(await loadPhase4RecalibrationCredits(dataset.metadata.datasetFingerprint), 1);

  const retried = await driveSessionToRevealed(binding, blind, reset);
  assert.equal(retried.practiceStatus, "revealed");
  assert.equal(retried.blindnessCompromised, true);
  assert.equal(await loadPhase4RecalibrationCredits(dataset.metadata.datasetFingerprint), 0);

  // The budget is single-use: another reset without a fresh credit is blocked.
  await assert.rejects(
    resetPhase4SessionWithCredit({ binding, guideContentHash: "guide-hash" }),
    /No recalibration retry is available/i,
  );

  // Granting a credit against a stale session id is a no-op.
  assert.equal(await grantPhase4RecalibrationCredit("phase4-nonexistent-1"), false);

  await deleteHistoricalDataset(dataset.metadata.id);
});

test("workspace restore cannot re-open a spent blind seal (reveal budget is durable)", async () => {
  // Distinct row content → distinct content-based fingerprint, so this does not
  // collide with the recalibration test's dataset in the shared fake-indexeddb.
  const table = makeTable(makeRows(24, 24));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "phase4-restore-exploit",
    fileName: "restore.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  await saveHistoricalDataset(dataset);
  const binding = await loadHistoricalDatasetBinding(dataset.metadata.id);
  const blind = await loadBlindPracticeRows(dataset.metadata.id);

  // Drive to committed-but-not-revealed, snapshot a backup here (receipt empty),
  // then reveal the answer key once.
  let session = await createPhase4Session({ binding, guideContentHash: "guide-hash" });
  const assessments = blind.map((row) => ({
    rowId: row.rowId, eligibility: [], elimination: [], criteria: [],
    weightedScore: null, recommendation: "human_review", evidenceValid: false,
    humanReviewReasons: ["Explicit test abstention"],
  }));
  session = await savePhase4Session(session);
  session = await savePhase4Session({ ...session, modelId: "m", patternStatus: "generating", patternProcessedRows: binding.teachingRows, patternProgress: 100 });
  session = await savePhase4Session({ ...session, patternStatus: "reviewing" });
  session = await savePhase4Session({ ...session, patternStatus: "approved", teachingApprovedAt: new Date().toISOString(), teachingApprovedBy: "T" });
  session = await savePhase4Session({ ...session, practiceStatus: "policy_locked", acceptancePolicy: { evaluationMode: "binary_alignment", minimumHistoricalAlignment: 80, minimumProgressedCapture: 95, maximumHumanReviewRate: 100, waitlistPolicy: "exclude", tieBreakPriority: [], lockedAt: new Date().toISOString(), lockedBy: "T" } });
  session = await savePhase4Session({ ...session, practiceStatus: "running" });
  session = await savePhase4Session({ ...session, assessmentProtocolHash: "3".repeat(64), assessments });
  session = await savePhase4Session({ ...session, practiceStatus: "predictions_committed", predictionHash: await contentHash(assessments) });

  const backupBeforeReveal = await exportWorkspace("2026-07-16T00:00:00.000Z");
  const revealed = await revealCommittedOutcomes(session);
  assert.equal(revealed.practiceStatus, "revealed");

  // Restore the pre-reveal backup: session rolls back to committed, but the
  // reveal receipt (union-merged, count preserved) must block a second reveal.
  await importWorkspace(parseWorkspaceBackup(JSON.stringify(backupBeforeReveal)));
  const rolledBack = await loadPhase4Session(dataset.metadata.id, 1);
  assert.equal(rolledBack.practiceStatus, "predictions_committed");
  await assert.rejects(revealCommittedOutcomes(rolledBack), /already revealed|changed/i);

  await deleteHistoricalDataset(dataset.metadata.id);
});

test("requires enough positive and negative examples and distrusts missing storage summaries", () => {
  const tooSmall = prepareHistoricalDataset(makeTable(makeRows(4, 16)), mapping, outcomeMapping);
  assert.equal(tooSmall.canSeal, false);
  assert.match(tooSmall.sealBlockers.join(" "), /5 progressed/i);

  const recovered = sanitizeHistoricalImportSummary({ status: "ready", datasetId: "" });
  assert.equal(recovered.status, "missing");
});
