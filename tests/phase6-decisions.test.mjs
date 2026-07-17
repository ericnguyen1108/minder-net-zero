import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import {
  RESULTS_CSV_HEADER,
  buildResultsCsv,
  clearFinalDecision,
  csvField,
  loadFinalDecisions,
  resultsFileName,
  saveFinalDecision,
  sortResultsForExport,
} from "../app/phase6-decisions.ts";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

function recommendation(overrides = {}) {
  return {
    rowId: "row-1",
    recommendation: "progressed",
    reason: "ranked_within_target",
    rank: 1,
    weightedScore: 84,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    datasetId: "dataset-1",
    rowId: "row-1",
    sourceRowNumber: 2,
    externalId: "APP-001",
    teamName: "Solar Collective",
    track: "Energy",
    warnings: [],
    ...overrides,
  };
}

test("final decisions round-trip per run and can be cleared", async () => {
  await saveFinalDecision({
    runId: "run-1",
    rowId: "row-1",
    decision: "shortlist",
    decidedBy: "Vy",
    decidedAt: "2026-07-16T10:00:00.000Z",
  });
  await saveFinalDecision({
    runId: "run-1",
    rowId: "row-2",
    decision: "reject",
    decidedBy: "Vy",
    decidedAt: "2026-07-16T10:01:00.000Z",
  });
  await saveFinalDecision({
    runId: "run-2",
    rowId: "row-1",
    decision: "waitlist",
    decidedBy: "Nam",
    decidedAt: "2026-07-16T10:02:00.000Z",
  });

  const runOne = await loadFinalDecisions("run-1");
  assert.equal(runOne.length, 2);
  assert.deepEqual(runOne.map((decision) => decision.decision).sort(), ["reject", "shortlist"]);

  // Overwriting a decision keeps one record per case.
  await saveFinalDecision({
    runId: "run-1",
    rowId: "row-1",
    decision: "waitlist",
    decidedBy: "Vy",
    decidedAt: "2026-07-16T11:00:00.000Z",
  });
  const updated = await loadFinalDecisions("run-1");
  assert.equal(updated.length, 2);
  assert.equal(updated.find((decision) => decision.rowId === "row-1")?.decision, "waitlist");

  await clearFinalDecision("run-1", "row-2");
  assert.equal((await loadFinalDecisions("run-1")).length, 1);
  assert.equal((await loadFinalDecisions("run-2")).length, 1);

  await assert.rejects(
    saveFinalDecision({
      runId: "run-1",
      rowId: "row-9",
      decision: "approve",
      decidedBy: "Vy",
      decidedAt: "2026-07-16T10:00:00.000Z",
    }),
    /Only shortlist, reject or waitlist/,
  );
  await assert.rejects(
    saveFinalDecision({
      runId: "run-1",
      rowId: "row-9",
      decision: "shortlist",
      decidedBy: "  ",
      decidedAt: "2026-07-16T10:00:00.000Z",
    }),
    /name the person/,
  );
});

test("CSV export escapes quotes, guards formula injection, and keeps table order", () => {
  assert.equal(csvField('He said "go"'), '"He said ""go"""');
  assert.equal(csvField("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvField("+441234"), "'+441234");
  assert.equal(csvField("@handle"), "'@handle");
  assert.equal(csvField("plain text"), "plain text");
  assert.equal(csvField(null), "");
  assert.equal(csvField("a,b"), '"a,b"');

  const rows = [
    {
      recommendation: recommendation({ rowId: "row-2", rank: null, weightedScore: null, recommendation: "human_review", reason: "requires_human_review" }),
      identity: identity({ rowId: "row-2", externalId: "APP-002", teamName: "=HYPERLINK(evil)" }),
      assessment: { humanReviewReasons: ["Unclear eligibility requires Human Review."] },
      decision: null,
    },
    {
      recommendation: recommendation(),
      identity: identity(),
      assessment: { humanReviewReasons: [] },
      decision: {
        runId: "run-1",
        rowId: "row-1",
        decision: "shortlist",
        decidedBy: "Vy",
        decidedAt: "2026-07-16T10:00:00.000Z",
      },
    },
    {
      recommendation: recommendation({ rowId: "row-3", rank: 2, weightedScore: 71 }),
      identity: identity({ rowId: "row-3", externalId: "APP-003", teamName: "Wind, Rain & Co" }),
      assessment: { humanReviewReasons: [] },
      decision: null,
    },
  ];

  const ordered = sortResultsForExport(rows);
  assert.deepEqual(
    ordered.map((row) => row.recommendation.rowId),
    ["row-1", "row-3", "row-2"],
  );

  const csv = buildResultsCsv(rows);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], RESULTS_CSV_HEADER);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^APP-001,Solar Collective,Energy,1,84,progressed/);
  assert.match(lines[2], /"Wind, Rain & Co"/);
  assert.match(lines[3], /'=HYPERLINK\(evil\)/);
  assert.match(lines[3], /human_review/);
  assert.match(lines[1], /shortlist,Vy,2026-07-16T10:00:00\.000Z$/);

  assert.equal(
    resultsFileName("Net Zero Challenge 2026!", "2026-07-16T10:00:00.000Z"),
    "net-zero-challenge-2026-results-2026-07-16.csv",
  );
});
