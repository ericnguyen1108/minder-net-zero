// Integration test for the pilot import repository against real Postgres.
// Gated on TEST_PILOT_DATABASE_URL (provisioned by scripts/pilot-test-db.sh).

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("pilot import repository (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  const { createSealedHistoricalDataset, prepareHistoricalDataset } = await import("../app/historical-data.ts");
  const importRepo = await import("../db/pilot/import-repository.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  const columns = [
    { key: "id", label: "Application ID", index: 0 },
    { key: "team", label: "Team", index: 1 },
    { key: "problem", label: "Problem", index: 2 },
    { key: "solution", label: "Solution", index: 3 },
    { key: "outcome", label: "Final result", index: 4 },
    { key: "year", label: "Year", index: 5 },
  ];
  const mapping = {
    applicationId: "id", teamName: "team", responseColumns: ["problem", "solution"],
    outcome: "outcome", year: "year", track: "", judgeScore: "", reviewerNotes: "",
  };
  const outcomeMapping = { shortlisted: "progressed", "not selected": "not_progressed" };

  function makeRows(p = 30, n = 30) {
    return Array.from({ length: p + n }, (_, i) => ({
      id: `APP-${String(i + 1).padStart(4, "0")}`,
      team: `Team ${i + 1}`,
      problem: `Problem statement ${i + 1} explains the material climate challenge in sufficient detail.`,
      solution: `Solution ${i + 1} explains the intervention, evidence and delivery plan in sufficient detail.`,
      outcome: i < p ? "Shortlisted" : "Not selected",
      year: "2025",
    }));
  }
  const table = (rows) => ({ sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) });

  async function freshWorkspace() {
    const [ws] = await sql`INSERT INTO netzero.workspaces (name, expected_marks_per_application) VALUES ('W', 2) RETURNING id`;
    return ws.id;
  }

  test.after(async () => { await sql.end({ timeout: 5 }); });

  test("saves a server-sealed historical dataset and reloads teaching + blind rows", async () => {
    const wsId = await freshWorkspace();
    const rows = makeRows(30, 30);
    const t = table(rows);
    const prepared = prepareHistoricalDataset(t, mapping, outcomeMapping);
    const sealed = await createSealedHistoricalDataset({
      datasetId: "irrelevant", fileName: "history.csv", fileSize: 4096, table: t,
      guideVersion: 1, mapping, outcomeMapping, prepared,
    });

    const { datasetId, fingerprint } = await importRepo.saveHistoricalDataset(wsId, sealed);
    assert.match(fingerprint, /^[0-9a-f]{64}$/);

    const teaching = await importRepo.loadTeachingRows(datasetId);
    const blind = await importRepo.loadBlindCases(datasetId);
    assert.equal(teaching.length, sealed.teachingRows.length);
    assert.equal(blind.length, sealed.sealedRows.length);
    assert.equal(teaching.length + blind.length, 60);

    // Teaching rows carry outcomes; blind cases must NOT leak the outcome.
    assert.ok(teaching.every((r) => typeof r.outcome === "string" && r.outcome.length > 0));
    assert.ok(blind.every((r) => !("outcome" in r)), "blind cases must not expose the sealed outcome");
    assert.ok(blind.every((r) => Array.isArray(r.answers) && r.answers.length > 0));

    // The sealed answer key is available via the explicit (API-gated) call.
    const outcomes = await importRepo.loadSealedOutcomes(datasetId);
    assert.equal(outcomes.length, blind.length);
    assert.ok(outcomes.every((o) => typeof o.outcome === "string"));
  });

  test("the same file yields the same stored fingerprint (server-derived)", async () => {
    const rows = makeRows(30, 30);
    const t = table(rows);
    const prepared = prepareHistoricalDataset(t, mapping, outcomeMapping);
    const seal = () => createSealedHistoricalDataset({
      datasetId: "x", fileName: "h.csv", fileSize: 1, table: t, guideVersion: 1, mapping, outcomeMapping, prepared,
    });
    const a = await importRepo.saveHistoricalDataset(await freshWorkspace(), await seal());
    const b = await importRepo.saveHistoricalDataset(await freshWorkspace(), await seal());
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test("freezes current applications with identity kept separate from answers", async () => {
    const wsId = await freshWorkspace();
    const cases = [
      { rowId: "app1", answers: [{ heading: "Impact", value: "We avoid 10,000 tCO2e." }], identity: { team: "Acme Ltd", contact: "a@x.test" } },
      { rowId: "app2", answers: [{ heading: "Impact", value: "Vague claim." }], identity: { team: "Beta Ltd", contact: "b@x.test" } },
    ];
    const { datasetId } = await importRepo.freezeCurrentDataset(wsId, {
      name: "Round 1", fingerprint: "c".repeat(64), cases,
    });

    const aiCases = await importRepo.loadCurrentCasesForAi(datasetId);
    assert.equal(aiCases.length, 2);
    // The AI view exposes answers only - no identity fields anywhere in it.
    const serialized = JSON.stringify(aiCases);
    assert.ok(!serialized.includes("Acme Ltd") && !serialized.includes("a@x.test"),
      "identity must never appear in the AI-visible cases");

    const identity = await importRepo.loadCurrentIdentity(datasetId, "app1");
    assert.equal(identity.team, "Acme Ltd");
    assert.equal(identity.contact, "a@x.test");
  });
}
