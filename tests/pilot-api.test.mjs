// Integration test for the pilot API dispatch route, driving the real POST
// handler over the HTTP boundary against real Postgres. Gated on
// TEST_PILOT_DATABASE_URL (scripts/pilot-test-db.sh).

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("pilot API route (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  process.env.MINDER_COMPETITION_NAME = "API Test Competition"; // isolates this test's workspace
  const { POST } = await import("../app/api/pilot/route.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  async function call(action, payload, { host = "localhost", cookie = null } = {}) {
    const headers = { "content-type": "application/json", host };
    if (cookie) headers.cookie = cookie;
    const res = await POST(new Request("http://localhost/api/pilot", {
      method: "POST", headers, body: JSON.stringify({ action, payload }),
    }));
    return { status: res.status, body: await res.json() };
  }

  const columns = [
    { key: "id", label: "Application ID", index: 0 }, { key: "team", label: "Team", index: 1 },
    { key: "problem", label: "Problem", index: 2 }, { key: "solution", label: "Solution", index: 3 },
    { key: "outcome", label: "Final result", index: 4 }, { key: "year", label: "Year", index: 5 },
  ];
  const mapping = { applicationId: "id", teamName: "team", responseColumns: ["problem", "solution"], outcome: "outcome", year: "year", track: "", judgeScore: "", reviewerNotes: "" };
  const outcomeMapping = { shortlisted: "progressed", "not selected": "not_progressed" };
  // Content unique to this file so its content-based fingerprint never collides
  // with another pilot test's reveal receipt on the shared test database.
  const rows = Array.from({ length: 62 }, (_, i) => ({
    id: `APITEST-${String(i + 1).padStart(4, "0")}`, team: `API Team ${i + 1}`,
    problem: `API-flow problem ${i + 1} explains the material climate challenge in sufficient detail.`,
    solution: `API-flow solution ${i + 1} explains the intervention, evidence and delivery plan in detail.`,
    outcome: i < 32 ? "Shortlisted" : "Not selected", year: "2026",
  }));
  const table = { sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) };

  test.after(async () => { await sql.end({ timeout: 5 }); });

  test("rejects an unauthenticated request off localhost", async () => {
    const res = await call("reviewers.list", {}, { host: "minder.example" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "authentication_required");
  });

  test("rejects an unknown action", async () => {
    const res = await call("nope.nope", {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "unknown_action");
  });

  test("runs the full pilot flow through the API", async () => {
    // reviewers
    const eric = (await call("reviewers.add", { displayName: "Eric" })).body.data;
    const trang = (await call("reviewers.add", { displayName: "Trang" })).body.data;
    assert.ok(eric.id && trang.id);
    const roster = (await call("reviewers.list", {})).body.data;
    assert.equal(roster.length, 2);

    // guide: draft -> approve -> load
    const draft = (await call("guide.saveDraft", {
      rules: { rules: [] }, selectionMode: "both", shortlistTarget: 10, minimumScore: 70,
      contentHash: "a".repeat(64),
      criteria: [
        { ruleId: "impact", title: "Impact", weight: 60, position: 0 },
        { ruleId: "delivery", title: "Delivery", weight: 40, position: 1 },
      ],
    })).body.data;
    assert.ok(draft.guideVersionId);
    const approve = await call("guide.approve", { guideVersionId: draft.guideVersionId, reviewerId: eric.id });
    assert.equal(approve.status, 200);
    const guide = (await call("guide.load", {})).body.data;
    assert.equal(guide.criteria.length, 2);

    // historical import: fingerprint + split derived SERVER-SIDE
    const imported = (await call("historical.import", {
      table, mapping, outcomeMapping, fileName: "history.csv", fileSize: 4096, guideVersion: 1,
    })).body.data;
    assert.match(imported.fingerprint, /^[0-9a-f]{64}$/);
    const blind = (await call("historical.blind", { datasetId: imported.datasetId })).body.data;
    assert.ok(blind.length > 0 && blind.every((r) => !("outcome" in r)), "blind cases hide the outcome");

    // one-use reveal -> second reveal conflicts (409)
    const session = (await call("calibration.session", { datasetId: imported.datasetId, guideVersion: 1 })).body.data;
    const reveal1 = await call("calibration.reveal", { datasetId: imported.datasetId, datasetFingerprint: imported.fingerprint, sessionId: session.id });
    assert.equal(reveal1.status, 200);
    assert.ok(reveal1.body.data.outcomes.length > 0);
    const reveal2 = await call("calibration.reveal", { datasetId: imported.datasetId, datasetFingerprint: imported.fingerprint, sessionId: session.id });
    assert.equal(reveal2.status, 409);
    assert.equal(reveal2.body.error.code, "already_revealed");

    // current applications (identity separate) + marking + ranking
    const current = (await call("current.freeze", {
      name: "Round 1",
      cases: [
        { rowId: "c1", answers: [{ heading: "Impact", value: "We avoid 10,000 tCO2e." }], identity: { team: "Acme" } },
        { rowId: "c2", answers: [{ heading: "Impact", value: "Vague." }], identity: { team: "Beta" } },
      ],
    })).body.data;
    assert.ok(current.datasetId);
    const aiCases = (await call("current.aiCases", { datasetId: current.datasetId })).body.data;
    assert.ok(!JSON.stringify(aiCases).includes("Acme"), "identity never reaches the AI-visible cases");

    for (const reviewer of [eric, trang]) {
      await call("marks.upsert", { applicationRowId: "c1", reviewerId: reviewer.id, guideVersionId: guide.guideVersionId, ruleId: "impact", score: 5 });
      await call("marks.upsert", { applicationRowId: "c1", reviewerId: reviewer.id, guideVersionId: guide.guideVersionId, ruleId: "delivery", score: 3 });
      const submit = await call("marks.submit", { applicationRowId: "c1", reviewerId: reviewer.id });
      assert.equal(Number(submit.body.data.weightedScore), 84);
    }
    const ranking = (await call("ranking.load", {})).body.data;
    const c1 = ranking.find((r) => r.rowId === "c1");
    assert.equal(Number(c1.totalScore), 168);
    assert.equal(c1.coverageComplete, true);

    // AI reference is empty (no run) and structurally separate
    const reference = (await call("ai.reference", {})).body.data;
    assert.deepEqual(reference, []);
  });
}
