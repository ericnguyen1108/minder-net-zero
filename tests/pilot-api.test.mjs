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

    // The richer Phase 4 document is absent until the client saves its pristine
    // state. Its complete reveal flow is covered by pilot-historical-phase4.
    const phase4 = await call("calibration.load", { datasetId: imported.datasetId, guideVersion: 1 });
    assert.equal(phase4.status, 200);
    assert.equal(phase4.body.data, null);

    // current applications (identity separate) + marking + ranking
    const currentTable = {
      sheetName: "Current",
      columns: columns.slice(0, 4),
      rows: [
        { id: "c1", team: "Acme", problem: "We avoid 10,000 tCO2e.", solution: "Delivery evidence." },
        { id: "c2", team: "Beta", problem: "Vague claim.", solution: "Limited evidence." },
      ],
      rowNumbers: [2, 3],
    };
    const current = (await call("current.import", {
      fileName: "current.csv", fileSize: 1024, table: currentTable,
      mapping: { applicationId: "id", teamName: "team", track: "", responseColumns: ["problem", "solution"] },
    })).body.data;
    assert.ok(current.datasetId);
    const aiCases = (await call("current.aiCases", { datasetId: current.datasetId })).body.data;
    assert.ok(!JSON.stringify(aiCases).includes("Acme"), "identity never reaches the AI-visible cases");
    const markedRowId = aiCases[0].rowId;

    for (const reviewer of [eric, trang]) {
      await call("marks.upsert", { applicationRowId: markedRowId, reviewerId: reviewer.id, guideVersionId: guide.guideVersionId, ruleId: "impact", score: 5 });
      await call("marks.upsert", { applicationRowId: markedRowId, reviewerId: reviewer.id, guideVersionId: guide.guideVersionId, ruleId: "delivery", score: 3 });
      const submit = await call("marks.submit", { applicationRowId: markedRowId, reviewerId: reviewer.id });
      assert.equal(Number(submit.body.data.weightedScore), 84);
    }
    const ranking = (await call("ranking.load", {})).body.data;
    const c1 = ranking.find((r) => r.rowId === markedRowId);
    assert.equal(Number(c1.totalScore), 168);
    assert.equal(c1.coverageComplete, true);

    // AI reference is empty (no run) and structurally separate
    const reference = (await call("ai.reference", {})).body.data;
    assert.deepEqual(reference, []);
  });

  test("records, loads, and clears final decisions with roster attribution", async () => {
    const before = (await call("reviewers.list", {})).body.data.length;
    const [workspace] = await sql`
      SELECT id FROM netzero.workspaces WHERE name = ${process.env.MINDER_COMPETITION_NAME}`;
    const [{ n: activeBefore }] = await sql`
      SELECT count(*)::int AS n FROM netzero.reviewers
       WHERE active AND workspace_id = ${workspace.id}`;

    // A typed decider name seeds the roster and attributes the decision to a real
    // reviewer (the same roster the Phase F dropdown will read).
    const rec = await call("decisions.record", { applicationRowId: "dec-1", decision: "shortlist", decidedByName: "Reviewer One" });
    assert.equal(rec.status, 200);
    const seeded = (await call("reviewers.list", {})).body.data;
    assert.equal(seeded.length, before + 1, "a new decider name seeds exactly one roster reviewer");
    const reviewerOne = seeded.find((r) => r.displayName === "Reviewer One");
    assert.ok(reviewerOne, "the decider is now a roster reviewer");

    // A decision-only decider is seeded INACTIVE, so it cannot enlarge the
    // final_ranking coverage roster (which is built from active reviewers only).
    assert.equal(reviewerOne.active, false, "a decision-only decider is not an active marker");
    const [{ n: activeAfter }] = await sql`
      SELECT count(*)::int AS n FROM netzero.reviewers
       WHERE active AND workspace_id = ${workspace.id}`;
    assert.equal(activeAfter, activeBefore, "recording a decision does not grow the active marking roster");

    // Re-recording with the same name reuses the reviewer, not a duplicate.
    await call("decisions.record", { applicationRowId: "dec-1", decision: "shortlist", decidedByName: "Reviewer One" });
    assert.equal((await call("reviewers.list", {})).body.data.length, before + 1);

    // A second decision; the client value maps to the DB's -ed form.
    await call("decisions.record", { applicationRowId: "dec-2", decision: "reject", decidedByName: "Reviewer One" });
    const [stored] = await sql`
      SELECT decision, decided_by FROM netzero.final_decisions WHERE application_row_id = 'dec-2'`;
    assert.equal(stored.decision, "rejected");
    assert.equal(stored.decided_by, reviewerOne.id, "attribution is a real reviewer FK");

    // The third value (waitlist) maps in BOTH directions too.
    await call("decisions.record", { applicationRowId: "dec-4", decision: "waitlist", decidedByName: "Reviewer One" });
    const [wl] = await sql`
      SELECT decision FROM netzero.final_decisions WHERE application_row_id = 'dec-4'`;
    assert.equal(wl.decision, "waitlisted");

    // load returns client values + the reviewer's display name.
    let loaded = (await call("decisions.load", {})).body.data;
    const one = loaded.find((d) => d.rowId === "dec-1");
    assert.equal(one.decision, "shortlist");
    assert.equal(one.decidedBy, "Reviewer One");
    assert.match(one.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(loaded.find((d) => d.rowId === "dec-2").decision, "reject");
    assert.equal(loaded.find((d) => d.rowId === "dec-4").decision, "waitlist");

    // clear -> recorded as `undecided` (journal keeps it) and hidden from load.
    await call("decisions.clear", { applicationRowId: "dec-1" });
    loaded = (await call("decisions.load", {})).body.data;
    assert.equal(loaded.find((d) => d.rowId === "dec-1"), undefined, "a cleared decision reads as absent");
    assert.ok(loaded.find((d) => d.rowId === "dec-2"), "other decisions remain");
    const [{ decision: cleared }] = await sql`
      SELECT decision FROM netzero.final_decisions WHERE application_row_id = 'dec-1'`;
    assert.equal(cleared, "undecided");
    const events = await sql`
      SELECT decision FROM netzero.final_decision_events WHERE application_row_id = 'dec-1' ORDER BY at`;
    assert.ok(events.length >= 2, "the append-only journal captured every write, including the clear");
    assert.equal(events.at(-1).decision, "undecided");

    // an unknown decision value is rejected before it reaches the DB.
    const bad = await call("decisions.record", { applicationRowId: "dec-3", decision: "approve", decidedByName: "Reviewer One" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Only shortlist, reject or waitlist/);
  });

  test("historical: active summary, binding, exists, replace, and delete", async () => {
    const makeHistTable = (tag) => {
      const rows = Array.from({ length: 40 }, (_, i) => ({
        id: `HIST${tag}-${String(i + 1).padStart(4, "0")}`,
        team: `Hist ${tag} Team ${i + 1}`,
        problem: `Hist ${tag} problem ${i + 1} explains the material climate challenge in sufficient detail.`,
        solution: `Hist ${tag} solution ${i + 1} explains the intervention, evidence and delivery plan in detail.`,
        outcome: i < 20 ? "Shortlisted" : "Not selected", year: "2026",
      }));
      return { sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) };
    };
    const importHist = (tag, extra = {}) => call("historical.import", {
      table: makeHistTable(tag), mapping, outcomeMapping,
      fileName: `hist${tag}.csv`, fileSize: 4096, guideVersion: 1, ...extra,
    });

    // Import A; it becomes the single active dataset. The stored summary carries
    // the DB id, not the seal's throwaway id.
    const a = (await importHist("A")).body.data;
    assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(a.summary.datasetId, a.datasetId, "the stored summary carries the DB dataset id");
    assert.equal(a.summary.status, "ready");

    const active = (await call("historical.active", {})).body.data;
    assert.equal(active.datasetId, a.datasetId);
    assert.equal(active.teachingRows + active.sealedRows, active.validRows);

    // Binding returns the server-authored fingerprint / integrity / guide / counts.
    const binding = (await call("historical.binding", { datasetId: a.datasetId })).body.data;
    assert.equal(binding.datasetFingerprint, a.fingerprint);
    assert.equal(binding.guideVersion, 1);
    assert.equal(binding.teachingRows + binding.sealedRows, active.validRows);
    assert.match(binding.integrityHash, /^[0-9a-f]{64}$/);

    assert.equal((await call("historical.exists", { datasetId: a.datasetId })).body.data.exists, true);
    assert.equal(
      (await call("historical.exists", { datasetId: "00000000-0000-0000-0000-000000000000" })).body.data.exists,
      false,
    );

    // Import B replacing A: A is deleted and only B is active.
    const b = (await importHist("B", { guideVersion: 2, replaceDatasetId: a.datasetId })).body.data;
    assert.equal(
      (await call("historical.exists", { datasetId: a.datasetId })).body.data.exists,
      false,
      "the replaced dataset is deleted",
    );
    assert.equal((await call("historical.active", {})).body.data.datasetId, b.datasetId);
    const [{ n: activeCount }] = await sql`
      SELECT count(*)::int AS n FROM netzero.historical_datasets d
       JOIN netzero.workspaces w ON w.id = d.workspace_id
       WHERE d.active AND w.name = 'API Test Competition'`;
    assert.equal(activeCount, 1, "exactly one active historical dataset in this workspace");
    assert.equal((await call("historical.binding", { datasetId: b.datasetId })).body.data.guideVersion, 2);

    // Deleting the active dataset leaves none active and cascades its rows.
    await call("historical.delete", { datasetId: b.datasetId });
    assert.equal((await call("historical.active", {})).body.data, null);
    assert.equal((await call("historical.exists", { datasetId: b.datasetId })).body.data.exists, false);
    const [{ n: rowsLeft }] = await sql`
      SELECT count(*)::int AS n FROM netzero.historical_rows WHERE dataset_id = ${b.datasetId}`;
    assert.equal(rowsLeft, 0, "cascade removed the rows");
  });
}
