import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import {
  CURRENT_CASES_STORE,
  createCurrentDataset,
  currentDatasetExists,
  deleteCurrentDataset,
  loadActiveCurrentSummary,
  loadCurrentCasesForAi,
  loadCurrentDatasetBinding,
  loadCurrentIdentitiesForReview,
  prepareCurrentDataset,
  sanitizeCurrentImportSummary,
  saveCurrentDataset,
} from "../app/current-data.ts";
import { PHASE5_RUNS_STORE } from "../app/historical-data.ts";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const columns = [
  { key: "id", label: "Application ID", index: 0 },
  { key: "team", label: "Team", index: 1 },
  { key: "track", label: "Challenge track", index: 2 },
  { key: "problem", label: "Problem", index: 3 },
  { key: "solution", label: "Solution", index: 4 },
  { key: "email", label: "Contact email", index: 5 },
];

const mapping = {
  applicationId: "id",
  teamName: "team",
  responseColumns: ["problem", "solution"],
  track: "track",
};

function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `APP-${String(index + 1).padStart(5, "0")}`,
    team: `Team ${index + 1}`,
    track: index % 2 ? "Buildings" : "Energy",
    problem: `Problem ${index + 1} explains the material net-zero challenge in specific terms.`,
    solution: `Solution ${index + 1} explains the intervention, evidence and delivery plan.`,
    email: `team${index + 1}@example.test`,
  }));
}

function makeTable(rows, customColumns = columns) {
  return {
    sheetName: "Applications",
    columns: customColumns,
    rows,
    rowNumbers: rows.map((_, index) => index + 2),
  };
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("failed"));
  });
}

test("prepares all 700 applications, preserves leading-zero IDs and keeps duplicate text/team as warnings", () => {
  const rows = makeRows(700);
  rows[0].id = "000012";
  rows[1].problem = rows[0].problem;
  rows[1].solution = rows[0].solution;
  rows[3].team = rows[2].team;
  const prepared = prepareCurrentDataset(makeTable(rows), mapping);

  assert.equal(prepared.totalRows, 700);
  assert.equal(prepared.readyRows.length + prepared.blockedRows, prepared.totalRows);
  assert.equal(prepared.readyRows.length, 700);
  assert.equal(prepared.blockedRows, 0);
  assert.equal(prepared.canSeal, true);
  assert.equal(prepared.rows[0].externalId, "000012");
  assert.deepEqual(
    prepared.rows[0].answers.map((answer) => answer.heading),
    ["Problem", "Solution"],
  );
  assert.equal(prepared.warningCounts["identical-text"], 2);
  assert.equal(prepared.warningCounts["repeated-team"], 2);
  assert.ok(prepared.rows[0].warnings.includes("identical-text"));
  assert.ok(prepared.rows[2].warnings.includes("repeated-team"));
});

test("blocks missing IDs/text and every duplicate ID without silently dropping a source row", () => {
  const rows = makeRows(8);
  rows[0].id = "";
  rows[1].problem = "";
  rows[1].solution = "";
  rows[3] = { ...rows[2] };
  rows[5].id = rows[4].id;
  rows[5].solution = "A different response under the same application identifier.";
  const prepared = prepareCurrentDataset(makeTable(rows), mapping);

  assert.equal(prepared.totalRows, rows.length);
  assert.equal(prepared.readyRows.length + prepared.blockedRows, prepared.totalRows);
  assert.equal(prepared.canSeal, false);
  assert.equal(prepared.issueCounts["missing-id"], 1);
  assert.equal(prepared.issueCounts["missing-text"], 1);
  assert.equal(prepared.issueCounts["duplicate-id"], 2);
  assert.equal(prepared.issueCounts["conflicting-id"], 2);
  assert.match(prepared.sealBlockers.at(-1), /no candidate will be silently excluded/i);
});

test("blocks sensitive answer headings, more than 40 answer columns and reused source columns", () => {
  const sensitive = prepareCurrentDataset(makeTable(makeRows(1)), {
    ...mapping,
    responseColumns: ["problem", "email"],
  });
  assert.equal(sensitive.canSeal, false);
  assert.match(sensitive.mappingProblems.join(" "), /identity, contact, outcome, reviewer or score columns/i);

  for (const heading of [
    "Team name",
    "Application ID",
    "Outcome",
    "Reviewer notes",
    "Judge score",
    "Total score",
    "Gender",
    "team_name",
    "application-id",
    "final_outcome",
    "reviewer.notes",
    "judge_score",
    "total-score",
    "challenge_track",
  ]) {
    const riskyColumns = [
      { key: "id", label: "Application ID", index: 0 },
      { key: "answer", label: heading, index: 1 },
    ];
    const risky = prepareCurrentDataset(
      makeTable([{ id: "APP-1", answer: "Sensitive value" }], riskyColumns),
      { applicationId: "id", teamName: "", track: "", responseColumns: ["answer"] },
    );
    assert.equal(risky.canSeal, false, heading);
    assert.match(risky.mappingProblems.join(" "), /identity, contact, outcome, reviewer or score columns/i, heading);
  }

  const legitimateTeamAnswer = prepareCurrentDataset(makeTable(makeRows(1)), {
    ...mapping,
    responseColumns: ["problem", "solution"],
  });
  assert.equal(legitimateTeamAnswer.mappingProblems.length, 0);

  const answerColumns = Array.from({ length: 41 }, (_, index) => ({
    key: `answer-${index}`,
    label: `Application answer ${index + 1}`,
    index: index + 1,
  }));
  const manyColumns = [{ key: "id", label: "Application ID", index: 0 }, ...answerColumns];
  const manyAnswers = Object.fromEntries([
    ["id", "APP-1"],
    ...answerColumns.map((column) => [column.key, `Response for ${column.label}`]),
  ]);
  const tooMany = prepareCurrentDataset(makeTable([manyAnswers], manyColumns), {
    applicationId: "id",
    teamName: "",
    track: "",
    responseColumns: answerColumns.map((column) => column.key),
  });
  assert.equal(tooMany.canSeal, false);
  assert.match(tooMany.mappingProblems.join(" "), /no more than 40/i);
  assert.equal(tooMany.rows[0].answers.length, 41, "no answer column is silently truncated");

  const reused = prepareCurrentDataset(makeTable(makeRows(1)), {
    ...mapping,
    teamName: "problem",
  });
  assert.equal(reused.canSeal, false);
  assert.match(reused.mappingProblems.join(" "), /only once/i);
});

test("blocks per-answer and whole-application limits without truncating text", () => {
  const longAnswerRows = makeRows(1);
  longAnswerRows[0].problem = "P".repeat(30_001);
  const longAnswer = prepareCurrentDataset(makeTable(longAnswerRows), mapping);
  assert.equal(longAnswer.canSeal, false);
  assert.equal(longAnswer.issueCounts["answer-too-long"], 1);
  assert.equal(longAnswer.rows[0].answers[0].value.length, 30_001);

  const totalColumns = [
    { key: "id", label: "Application ID", index: 0 },
    { key: "one", label: "Answer one", index: 1 },
    { key: "two", label: "Answer two", index: 2 },
    { key: "three", label: "Answer three", index: 3 },
  ];
  const totalTable = makeTable(
    [{ id: "APP-LONG", one: "A".repeat(24_000), two: "B".repeat(24_000), three: "C".repeat(24_000) }],
    totalColumns,
  );
  const overTotal = prepareCurrentDataset(totalTable, {
    applicationId: "id",
    teamName: "",
    track: "",
    responseColumns: ["one", "two", "three"],
  });
  assert.equal(overTotal.canSeal, false);
  assert.equal(overTotal.issueCounts["application-too-long"], 1);
  assert.equal(overTotal.rows[0].answers.reduce((sum, answer) => sum + answer.value.length, 0), 72_000);
});

test("creates deterministic fingerprints with random opaque row IDs and separated identities", async () => {
  const rows = makeRows(3);
  rows[0].id = "000012";
  const table = makeTable(rows);
  const first = await createCurrentDataset({
    datasetId: "current-create-one",
    fileName: "current.xlsx",
    fileSize: 12_000,
    table,
    mapping,
  });
  const second = await createCurrentDataset({
    datasetId: "current-create-two",
    fileName: "current.xlsx",
    fileSize: 12_000,
    table,
    mapping,
  });

  assert.equal(first.metadata.datasetFingerprint, second.metadata.datasetFingerprint);
  assert.equal(first.cases.length, 3);
  assert.equal(first.identities.length, 3);
  assert.equal(first.identities[0].externalId, "000012");
  assert.ok(first.cases.every((item) => /^case-[0-9a-f]{32}$/.test(item.rowId)));
  assert.ok(first.cases.every((item) => !("externalId" in item) && !("teamName" in item)));
  assert.notDeepEqual(
    first.cases.map((item) => item.rowId),
    second.cases.map((item) => item.rowId),
  );
  assert.ok(first.cases.every((item) => !rows.some((row) => row.id === item.rowId)));
});

test("atomically stores 700 cases and exposes identity-free AI rows", async () => {
  const dataset = await createCurrentDataset({
    datasetId: "current-stored-700",
    fileName: "current-700.csv",
    fileSize: 500_000,
    table: makeTable(makeRows(700)),
    mapping,
  });
  await saveCurrentDataset(dataset);

  assert.equal(await currentDatasetExists(dataset.metadata.id), true);
  const active = await loadActiveCurrentSummary();
  assert.equal(active.datasetId, dataset.metadata.id);
  assert.equal(active.totalRows, 700);
  const safeCases = await loadCurrentCasesForAi(dataset.metadata.id);
  assert.equal(safeCases.length, 700);
  assert.ok(
    safeCases.every(
      (item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["answers", "rowId"]),
    ),
  );
  assert.ok(
    safeCases.every(
      (item) =>
        !("externalId" in item) &&
        !("teamName" in item) &&
        !("track" in item) &&
        !("sourceRowNumber" in item) &&
        !("contentHash" in item),
    ),
  );
  const identities = await loadCurrentIdentitiesForReview(dataset.metadata.id);
  assert.equal(identities.length, 700);
  assert.equal(identities[0].externalId, "APP-00001");
  assert.ok(identities.every((item) => !("answers" in item)));
  const binding = await loadCurrentDatasetBinding(dataset.metadata.id);
  assert.deepEqual(binding, {
    datasetId: dataset.metadata.id,
    datasetFingerprint: dataset.metadata.datasetFingerprint,
    integrityHash: dataset.metadata.integrityHash,
    totalRows: 700,
  });

  await deleteCurrentDataset(dataset.metadata.id);
  assert.equal(await currentDatasetExists(dataset.metadata.id), false);
  assert.equal(await loadActiveCurrentSummary(), null);
});

test("replaces the active dataset atomically and refuses an in-place immutable overwrite", async () => {
  const original = await createCurrentDataset({
    datasetId: "current-replace-original",
    fileName: "original.csv",
    fileSize: 1_000,
    table: makeTable(makeRows(3)),
    mapping,
  });
  await saveCurrentDataset(original);

  const conflicting = await createCurrentDataset({
    datasetId: original.metadata.id,
    fileName: "conflicting.csv",
    fileSize: 1_100,
    table: makeTable(makeRows(4)),
    mapping,
  });
  await assert.rejects(() => saveCurrentDataset(conflicting), /constraint|cancelled|failed/i);
  assert.equal((await loadActiveCurrentSummary()).datasetId, original.metadata.id);

  const replacementRows = makeRows(4);
  replacementRows[0].solution = "A corrected replacement application response.";
  const replacement = await createCurrentDataset({
    datasetId: "current-replace-new",
    fileName: "replacement.csv",
    fileSize: 1_200,
    table: makeTable(replacementRows),
    mapping,
  });
  await saveCurrentDataset(replacement, original.metadata.id);
  assert.equal(await currentDatasetExists(original.metadata.id), false);
  assert.equal(await currentDatasetExists(replacement.metadata.id), true);
  assert.equal((await loadActiveCurrentSummary()).datasetId, replacement.metadata.id);
  await deleteCurrentDataset(replacement.metadata.id);
});

test("supersedes but never deletes applications once an assessment run references them", async () => {
  const original = await createCurrentDataset({
    datasetId: "current-run-locked",
    fileName: "locked.csv",
    fileSize: 1_000,
    table: makeTable(makeRows(3)),
    mapping,
  });
  await saveCurrentDataset(original);

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const addRun = database.transaction(PHASE5_RUNS_STORE, "readwrite");
  addRun.objectStore(PHASE5_RUNS_STORE).add({
    id: "phase5-current-run-locked-test",
    datasetId: original.metadata.id,
  });
  await transactionDone(addRun);
  database.close();

  const replacement = await createCurrentDataset({
    datasetId: "current-run-locked-replacement",
    fileName: "replacement.csv",
    fileSize: 1_100,
    table: makeTable(makeRows(4)),
    mapping,
  });
  await saveCurrentDataset(replacement, original.metadata.id);
  await assert.rejects(
    () => deleteCurrentDataset(original.metadata.id),
    /assessment run cannot be removed/i,
  );
  assert.equal(await currentDatasetExists(original.metadata.id), true);
  assert.equal(await currentDatasetExists(replacement.metadata.id), true);
  assert.equal((await loadActiveCurrentSummary()).datasetId, replacement.metadata.id);

  const cleanup = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const removeRun = cleanup.transaction(PHASE5_RUNS_STORE, "readwrite");
  removeRun.objectStore(PHASE5_RUNS_STORE).delete("phase5-current-run-locked-test");
  await transactionDone(removeRun);
  cleanup.close();
  await deleteCurrentDataset(original.metadata.id);
  await deleteCurrentDataset(replacement.metadata.id);
});

test("fails closed when stored answer text is changed after sealing", async () => {
  const dataset = await createCurrentDataset({
    datasetId: "current-tampered",
    fileName: "tampered.csv",
    fileSize: 1_000,
    table: makeTable(makeRows(3)),
    mapping,
  });
  await saveCurrentDataset(dataset);
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(CURRENT_CASES_STORE, "readwrite");
  const store = transaction.objectStore(CURRENT_CASES_STORE);
  const storedCase = await new Promise((resolve, reject) => {
    const request = store.get([dataset.metadata.id, dataset.cases[0].rowId]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  storedCase.answers[0].value = "Text changed after the dataset was sealed.";
  store.put(storedCase);
  await transactionDone(transaction);
  database.close();

  assert.equal(await currentDatasetExists(dataset.metadata.id), false);
  await assert.rejects(
    () => loadCurrentCasesForAi(dataset.metadata.id),
    /integrity check/i,
  );
  await deleteCurrentDataset(dataset.metadata.id);
});

test("sanitizes untrusted current-import summaries and never marks an unbound summary ready", () => {
  assert.deepEqual(sanitizeCurrentImportSummary(null), {
    status: "empty",
    datasetId: null,
    fileName: "",
    fileSize: 0,
    sheetName: "",
    importedAt: null,
    totalRows: 0,
    readyRows: 0,
    blockedRows: 0,
    warningRows: 0,
    identicalTextRows: 0,
    repeatedTeamRows: 0,
    datasetFingerprint: null,
  });
  const sanitized = sanitizeCurrentImportSummary({
    status: "ready",
    datasetId: "current-summary",
    datasetFingerprint: "",
    totalRows: -100,
    readyRows: "700",
    blockedRows: Number.NaN,
    fileSize: -1,
  });
  assert.equal(sanitized.status, "missing");
  assert.equal(sanitized.totalRows, 0);
  assert.equal(sanitized.readyRows, 700);
  assert.equal(sanitized.blockedRows, 0);
  assert.equal(sanitized.fileSize, 0);
});
