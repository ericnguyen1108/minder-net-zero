// Integration test for the pilot calibration + assessment repositories against
// real Postgres. Gated on TEST_PILOT_DATABASE_URL (scripts/pilot-test-db.sh).

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("pilot assessment repository (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  const { createSealedHistoricalDataset, prepareHistoricalDataset } = await import("../app/historical-data.ts");
  const importRepo = await import("../db/pilot/import-repository.ts");
  const cal = await import("../db/pilot/calibration-repository.ts");
  const asm = await import("../db/pilot/assessment-repository.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  const columns = [
    { key: "id", label: "Application ID", index: 0 }, { key: "team", label: "Team", index: 1 },
    { key: "problem", label: "Problem", index: 2 }, { key: "solution", label: "Solution", index: 3 },
    { key: "outcome", label: "Final result", index: 4 }, { key: "year", label: "Year", index: 5 },
  ];
  const mapping = { applicationId: "id", teamName: "team", responseColumns: ["problem", "solution"], outcome: "outcome", year: "year", track: "", judgeScore: "", reviewerNotes: "" };
  const outcomeMapping = { shortlisted: "progressed", "not selected": "not_progressed" };
  function makeRows(p = 30, n = 30) {
    return Array.from({ length: p + n }, (_, i) => ({
      id: `APP-${String(i + 1).padStart(4, "0")}`, team: `Team ${i + 1}`,
      problem: `Problem ${i + 1} explains the material climate challenge in sufficient detail.`,
      solution: `Solution ${i + 1} explains the intervention, evidence and delivery plan in detail.`,
      outcome: i < p ? "Shortlisted" : "Not selected", year: "2025",
    }));
  }
  const table = (rows) => ({ sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) });

  async function freshWorkspace() {
    const [ws] = await sql`INSERT INTO netzero.workspaces (name, expected_marks_per_application) VALUES ('W', 2) RETURNING id`;
    return ws.id;
  }
  async function seedSealedDataset(wsId) {
    const t = table(makeRows(30, 30));
    const prepared = prepareHistoricalDataset(t, mapping, outcomeMapping);
    const sealed = await createSealedHistoricalDataset({ datasetId: "x", fileName: "h.csv", fileSize: 1, table: t, guideVersion: 1, mapping, outcomeMapping, prepared });
    return importRepo.saveHistoricalDataset(wsId, sealed);
  }

  test.after(async () => { await sql.end({ timeout: 5 }); });

  test("session save uses revision CAS (a stale write is refused)", async () => {
    const wsId = await freshWorkspace();
    const { datasetId } = await seedSealedDataset(wsId);
    const session = await cal.getOrCreateSession(wsId, datasetId, 1);
    assert.equal(session.revision, 0);
    const first = await cal.saveSession({ id: session.id, expectedRevision: 0, practiceStatus: "running" });
    assert.equal(first.revision, 1);
    await assert.rejects(
      cal.saveSession({ id: session.id, expectedRevision: 0, practiceStatus: "running" }),
      /revision_conflict/,
    );
    const second = await cal.saveSession({ id: session.id, expectedRevision: 1, practiceStatus: "predictions_committed" });
    assert.equal(second.revision, 2);
  });

  test("the sealed practice test can be revealed only once without a credit", async () => {
    const wsId = await freshWorkspace();
    const { datasetId, fingerprint } = await seedSealedDataset(wsId);
    const session = await cal.getOrCreateSession(wsId, datasetId, 1);

    const first = await cal.revealOutcomes({ workspaceId: wsId, datasetId, datasetFingerprint: fingerprint, sessionId: session.id });
    assert.ok(first.outcomes.length > 0, "first reveal returns the answer key");
    assert.equal(await cal.revealHeadroom(fingerprint), 0);

    await assert.rejects(
      cal.revealOutcomes({ workspaceId: wsId, datasetId, datasetFingerprint: fingerprint, sessionId: session.id }),
      /already_revealed/,
    );

    // A genuine audit-failure credit buys exactly one more reveal.
    await cal.grantRecalibrationCredit({ datasetFingerprint: fingerprint, sessionId: session.id, reason: "phase5_audit_failure" });
    assert.equal(await cal.revealHeadroom(fingerprint), 1);
    await cal.revealOutcomes({ workspaceId: wsId, datasetId, datasetFingerprint: fingerprint, sessionId: session.id });
    assert.equal(await cal.revealHeadroom(fingerprint), 0);
    await assert.rejects(
      cal.revealOutcomes({ workspaceId: wsId, datasetId, datasetFingerprint: fingerprint, sessionId: session.id }),
      /already_revealed/,
    );
  });

  async function seedRun(wsId) {
    const [cd] = await sql`INSERT INTO netzero.current_datasets (workspace_id, name, fingerprint, case_count) VALUES (${wsId}, 'R', ${"b".repeat(64)}, 2) RETURNING id`;
    return asm.createRun({
      workspaceId: wsId, currentDatasetId: cd.id, guideVersion: 1, modelId: "gpt-4o",
      contractHash: "a".repeat(64), protocolHash: "d".repeat(64),
      batches: [{ index: 0, inputHash: "e".repeat(64) }, { index: 1, inputHash: "f".repeat(64) }],
    });
  }

  test("a batch lease cannot be double-claimed", async () => {
    const wsId = await freshWorkspace();
    const { runId } = await seedRun(wsId);
    const claim = await asm.claimBatch(runId, 0);
    assert.ok(claim && claim.leaseToken, "first claim wins");
    const second = await asm.claimBatch(runId, 0);
    assert.equal(second, null, "a live lease blocks a second claim");
  });

  test("results commit exactly once and are immutable", async () => {
    const wsId = await freshWorkspace();
    const { runId } = await seedRun(wsId);
    const claim = await asm.claimBatch(runId, 0);
    const results = [
      { rowId: "app1", assessment: { note: "ok" }, weightedScore: 84, recommendation: "progressed", evidenceValid: true },
    ];
    const first = await asm.commitBatchResults({ runId, batchId: claim.batchId, leaseToken: claim.leaseToken, results });
    assert.equal(first.committed, true);
    const stored = await asm.loadResults(runId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].weightedScore, 84);

    // Re-commit (a retry after success) is a no-op, not a duplicate.
    const again = await asm.commitBatchResults({ runId, batchId: claim.batchId, leaseToken: claim.leaseToken, results });
    assert.equal(again.committed, false);
    assert.equal((await asm.loadResults(runId)).length, 1);

    // The stored result row is immutable at the DB level.
    await assert.rejects(
      sql`UPDATE netzero_ai.assessment_results SET weighted_score = 100 WHERE run_id = ${runId} AND row_id = 'app1'`,
      /immutable|permission denied/i,
    );
  });

  test("committing under a stale lease is refused", async () => {
    const wsId = await freshWorkspace();
    const { runId } = await seedRun(wsId);
    const claim = await asm.claimBatch(runId, 1);
    await assert.rejects(
      asm.commitBatchResults({ runId, batchId: claim.batchId, leaseToken: "00000000-0000-0000-0000-000000000000", results: [] }),
      /stale_lease/,
    );
    const progress = await asm.runProgress(runId);
    assert.equal(progress.total, 2);
  });
}
