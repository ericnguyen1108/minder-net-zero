// Fast client-boundary tests; the real database suite lives in pilot-marking.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addPilotReviewer,
  humanRankingIsReady,
  listPilotReviewers,
  loadPilotMarkSets,
  savePilotMark,
  setPilotReviewerActive,
  submitPilotMarkSet,
  syncPilotApprovedGuide,
} from "../app/pilot-marking.ts";

const originalFetch = globalThis.fetch;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, ...request });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: handler(request) }),
    };
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reviewer roster actions use the central pilot boundary", async () => {
  const reviewer = { id: "reviewer-1", displayName: "Trang", active: true };
  const calls = stubFetch(({ action }) => (action === "reviewers.list" ? [reviewer, null] : reviewer));

  assert.deepEqual(await listPilotReviewers(), [reviewer]);
  assert.deepEqual(await addPilotReviewer("  Trang  "), reviewer);
  await setPilotReviewerActive(reviewer.id, false);

  assert.deepEqual(calls.map((call) => call.action), [
    "reviewers.list",
    "reviewers.add",
    "reviewers.setActive",
  ]);
  assert.deepEqual(calls[1].payload, { displayName: "Trang" });
  assert.deepEqual(calls[2].payload, { reviewerId: "reviewer-1", active: false });
});

test("guide sync and mark actions preserve server-owned identifiers", async () => {
  const calls = stubFetch(({ action }) => {
    if (action === "guide.syncApproved") {
      return { guideVersionId: "guide-1", version: 2, contentHash: "a".repeat(64), criteria: [] };
    }
    if (action === "marks.load") {
      return [{
        applicationRowId: "row-1",
        reviewerId: "reviewer-1",
        guideVersionId: "guide-1",
        status: "draft",
        weightedScore: 60,
        scores: { impact: 5 },
      }];
    }
    if (action === "marks.submit") return { weightedScore: 84 };
    return { ok: true };
  });

  await syncPilotApprovedGuide({ status: "approved" }, "a".repeat(64));
  await savePilotMark({
    applicationRowId: "row-1",
    reviewerId: "reviewer-1",
    guideVersionId: "guide-1",
    ruleId: "impact",
    score: 5,
  });
  assert.equal((await loadPilotMarkSets())[0].scores.impact, 5);
  assert.deepEqual(await submitPilotMarkSet("row-1", "reviewer-1", "guide-1"), { weightedScore: 84 });

  assert.deepEqual(calls.map((call) => call.action), [
    "guide.syncApproved",
    "marks.upsert",
    "marks.load",
    "marks.submit",
  ]);
  assert.equal(calls[1].payload.score, 5);
});

test("invalid names and scores fail before any network request", async () => {
  const calls = stubFetch(() => ({ ok: true }));
  await assert.rejects(addPilotReviewer("  "), /reviewer name/);
  await assert.rejects(
    savePilotMark({
      applicationRowId: "row-1",
      reviewerId: "reviewer-1",
      guideVersionId: "guide-1",
      ruleId: "impact",
      score: 0,
    }),
    /1 to 5/,
  );
  await assert.rejects(syncPilotApprovedGuide({}, "bad"), /receipt/);
  assert.equal(calls.length, 0);
});

test("human ranking is ready only for exact, fully covered cohort rows", () => {
  const complete = [
    { rowId: "a", totalScore: 170, markCount: 2, coverageComplete: true, rankingValid: true, rank: 1 },
    { rowId: "b", totalScore: 150, markCount: 2, coverageComplete: true, rankingValid: true, rank: 2 },
  ];
  assert.equal(humanRankingIsReady(complete, ["a", "b"]), true);
  assert.equal(humanRankingIsReady(complete, ["a"]), false);
  assert.equal(humanRankingIsReady([{ ...complete[0], rankingValid: false }, complete[1]], ["a", "b"]), false);
  assert.equal(humanRankingIsReady([], []), false);
});
