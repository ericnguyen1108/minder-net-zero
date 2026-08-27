import assert from "node:assert/strict";
import test from "node:test";
import {
  createCurrentDataset,
  currentImportPilotRequestBytes,
  currentDatasetExists,
  deleteCurrentDataset,
  loadActiveCurrentSummary,
  loadCurrentCasesForAi,
  loadCurrentDatasetBinding,
  loadCurrentIdentitiesForReview,
  prepareCurrentDataset,
  prepareCurrentDatasetForPilot,
  sanitizeCurrentImportSummary,
  saveCurrentDataset,
} from "../app/current-data.ts";
import { MAX_PILOT_REQUEST_BYTES } from "../app/pilot-client.ts";

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

test("blocks a text-heavy cohort during review before the pilot request can overflow", () => {
  const rows = makeRows(700).map((row, index) => ({
    ...row,
    problem: `${index}: ${"P".repeat(5_700)}`,
  }));
  const input = {
    fileName: "large-current.csv",
    fileSize: 4_000_000,
    table: makeTable(rows),
    mapping,
  };
  assert.equal(prepareCurrentDataset(input.table, mapping).canSeal, true);
  assert.ok(currentImportPilotRequestBytes(input) > MAX_PILOT_REQUEST_BYTES);
  const prepared = prepareCurrentDatasetForPilot(input);
  assert.equal(prepared.canSeal, false);
  assert.match(prepared.sealBlockers.join(" "), /too large for this pilot/i);
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

test("current storage functions use the authenticated pilot transport", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const summary = {
    status: "ready", datasetId: "00000000-0000-4000-8000-000000000001",
    fileName: "current.csv", fileSize: 1000, sheetName: "Applications",
    importedAt: "2026-07-20T00:00:00.000Z", totalRows: 1, readyRows: 1,
    blockedRows: 0, warningRows: 0, identicalTextRows: 0, repeatedTeamRows: 0,
    datasetFingerprint: "a".repeat(64),
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const data = {
      "current.import": { datasetId: summary.datasetId, fingerprint: summary.datasetFingerprint, summary },
      "current.exists": { exists: true },
      "current.active": summary,
      "current.aiCases": [{ rowId: "case-1", answers: [{ heading: "Impact", value: "Evidence" }] }],
      "current.identities": [{ datasetId: summary.datasetId, rowId: "case-1", sourceRowNumber: 2, externalId: "APP-1", teamName: "Team", track: "Energy", warnings: [] }],
      "current.binding": { datasetId: summary.datasetId, datasetFingerprint: summary.datasetFingerprint, integrityHash: "b".repeat(64), totalRows: 1 },
      "current.delete": { ok: true },
    }[body.action];
    return Response.json({ ok: true, data });
  };
  try {
    const saved = await saveCurrentDataset({
      fileName: "current.csv",
      fileSize: 1000,
      table: makeTable([{ ...makeRows(1)[0], unselectedCanary: "must-not-leave-browser" }], [
        ...columns,
        { key: "unselectedCanary", label: "Internal notes", index: columns.length },
      ]),
      mapping,
    });
    assert.deepEqual(saved.summary, summary);
    assert.equal(await currentDatasetExists(summary.datasetId), true);
    assert.deepEqual(await loadActiveCurrentSummary(), summary);
    assert.equal((await loadCurrentCasesForAi(summary.datasetId))[0].rowId, "case-1");
    assert.equal((await loadCurrentIdentitiesForReview(summary.datasetId))[0].externalId, "APP-1");
    assert.equal((await loadCurrentDatasetBinding(summary.datasetId)).totalRows, 1);
    await deleteCurrentDataset(summary.datasetId);
    assert.deepEqual(calls.map((call) => call.action), [
      "current.import", "current.exists", "current.active", "current.aiCases",
      "current.identities", "current.binding", "current.delete",
    ]);
    assert.ok(
      !JSON.stringify(calls[0]).includes("must-not-leave-browser"),
      "current import sends only mapped columns",
    );
    assert.ok(!JSON.stringify(calls[3]).includes("Team"), "AI request contains only the dataset id");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
