import assert from "node:assert/strict";
import test from "node:test";
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

// The storage trio now talks to POST /api/pilot via the pilot() transport, which
// uses global fetch. Mock it so this stays a fast unit test (no server/DB); the
// real round-trip is covered against Postgres in tests/pilot-api.test.mjs.
const originalFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = JSON.parse(init.body);
    calls.push({ url, method: init.method, ...parsed });
    const { status = 200, body = { ok: true, data: [] } } = handler(parsed) ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = originalFetch; });

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

function humanRanking(overrides = {}) {
  return {
    rank: 1,
    totalScore: 168,
    markCount: 2,
    coverageComplete: true,
    rankingValid: true,
    ...overrides,
  };
}

test("saveFinalDecision posts the record action with the client decision value and decider name", async () => {
  const calls = stubFetch(() => ({ body: { ok: true, data: { ok: true } } }));
  await saveFinalDecision({
    runId: "run-1",
    rowId: "row-1",
    decision: "shortlist",
    decidedBy: "Vy",
    decidedAt: "2026-07-16T10:00:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/pilot");
  assert.equal(calls[0].action, "decisions.record");
  assert.deepEqual(calls[0].payload, {
    applicationRowId: "row-1",
    decision: "shortlist",
    decidedByName: "Vy",
  });
});

test("saveFinalDecision validates before touching the network", async () => {
  const calls = stubFetch(() => ({ body: { ok: true, data: { ok: true } } }));
  await assert.rejects(
    saveFinalDecision({ runId: "run-1", rowId: "row-9", decision: "approve", decidedBy: "Vy", decidedAt: "x" }),
    /Only shortlist, reject or waitlist/,
  );
  await assert.rejects(
    saveFinalDecision({ runId: "run-1", rowId: "row-9", decision: "shortlist", decidedBy: "  ", decidedAt: "x" }),
    /name the person/,
  );
  await assert.rejects(
    saveFinalDecision({ runId: " ", rowId: "row-9", decision: "shortlist", decidedBy: "Vy", decidedAt: "x" }),
    /needs its run and application/,
  );
  assert.equal(calls.length, 0, "no request is sent for an invalid decision");
});

test("clearFinalDecision posts the clear action keyed by application row", async () => {
  const calls = stubFetch(() => ({ body: { ok: true, data: { ok: true } } }));
  await clearFinalDecision("run-1", "row-2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "decisions.clear");
  assert.deepEqual(calls[0].payload, { applicationRowId: "row-2" });

  await clearFinalDecision("run-1", "row-3", " Vy ");
  assert.deepEqual(calls[1].payload, { applicationRowId: "row-3", decidedByName: "Vy" });
});

test("loadFinalDecisions stamps the run id, keeps only valid values, and tolerates a bad body", async () => {
  stubFetch(() => ({
    body: {
      ok: true,
      data: [
        { rowId: "row-1", decision: "shortlist", decidedBy: "Vy", decidedAt: "2026-07-16T10:00:00.000Z" },
        { rowId: "row-2", decision: "reject", decidedBy: "Nam", decidedAt: "2026-07-16T10:01:00.000Z" },
        { rowId: "row-3", decision: "garbage", decidedBy: "Nam", decidedAt: "2026-07-16T10:02:00.000Z" },
      ],
    },
  }));
  const decisions = await loadFinalDecisions("run-77");
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((d) => d.runId === "run-77"));
  assert.deepEqual(decisions.map((d) => d.decision).sort(), ["reject", "shortlist"]);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: null }) });
  assert.deepEqual(await loadFinalDecisions("run-1"), []);
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
      humanRanking: humanRanking({ rank: 3, totalScore: 110 }),
    },
    {
      recommendation: recommendation(),
      identity: identity(),
      assessment: { humanReviewReasons: [] },
      humanRanking: humanRanking(),
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
      humanRanking: humanRanking({ rank: 2, totalScore: 142 }),
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
  assert.match(lines[1], /^APP-001,Solar Collective,Energy,1,168,2,yes,1,84,progressed/);
  assert.match(lines[2], /"Wind, Rain & Co"/);
  assert.match(lines[3], /'=HYPERLINK\(evil\)/);
  assert.match(lines[3], /human_review/);
  assert.match(lines[1], /shortlist,Vy,2026-07-16T10:00:00\.000Z$/);

  assert.equal(
    resultsFileName("Net Zero Challenge 2026!", "2026-07-16T10:00:00.000Z"),
    "net-zero-challenge-2026-results-2026-07-16.csv",
  );
});
