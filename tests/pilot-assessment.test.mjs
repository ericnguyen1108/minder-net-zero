// Integration test for the pilot assessment repository against
// real Postgres. Gated on TEST_PILOT_DATABASE_URL (scripts/pilot-test-db.sh).

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("pilot assessment repository (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  const asm = await import("../db/pilot/assessment-repository.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  async function freshWorkspace() {
    const [ws] = await sql`INSERT INTO netzero.workspaces (name, expected_marks_per_application) VALUES ('W', 2) RETURNING id`;
    return ws.id;
  }
  test.after(async () => { await sql.end({ timeout: 5 }); });

  // Phase 4 document CAS and reveal semantics are covered by
  // pilot-historical-phase4 through the real route and database.

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
