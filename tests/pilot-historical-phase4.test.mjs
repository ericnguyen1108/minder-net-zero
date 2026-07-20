// End-to-end client -> /api/pilot -> repository -> Postgres coverage for the
// combined historical + Phase 4 flip. Gated on the throwaway pilot database.

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("historical + Phase 4 Postgres flip (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  process.env.MINDER_COMPETITION_NAME = "Historical Phase4 Client Test";

  const { POST } = await import("../app/api/pilot/route.ts");
  const {
    deleteHistoricalDataset,
    historicalDatasetExists,
    loadActiveHistoricalSummary,
    loadBlindPracticeRows,
    loadHistoricalDatasetBinding,
    loadTeachingRows,
    saveHistoricalDataset,
  } = await import("../app/historical-data.ts");
  const {
    buildPristinePhase4Session,
    contentHash,
    createPhase4Session,
    grantPhase4RecalibrationCredit,
    loadPhase4RecalibrationCredits,
    loadPhase4Session,
    resetPhase4SessionWithCredit,
    revealCommittedOutcomes,
    savePhase4Session,
  } = await import("../app/phase4-storage.ts");
  const { pilot, PilotConflictError } = await import("../app/pilot-client.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (requestUrl, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost");
    return POST(new Request(new URL(String(requestUrl), "http://localhost"), {
      method: init.method,
      headers,
      body: init.body,
    }));
  };

  test.after(async () => {
    globalThis.fetch = originalFetch;
    await sql.end({ timeout: 5 });
  });

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

  function sourceTable(tag) {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `${tag}-${String(index + 1).padStart(4, "0")}`,
      team: `${tag} Team ${index + 1}`,
      problem: `${tag} problem ${index + 1} explains the material climate challenge in sufficient detail.`,
      solution: `${tag} solution ${index + 1} explains the intervention, evidence and delivery plan in detail.`,
      outcome: index < 20 ? "Shortlisted" : "Not selected",
      year: "2026",
    }));
    return { sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) };
  }

  async function importHistory(table) {
    return saveHistoricalDataset({
      table,
      mapping,
      outcomeMapping,
      fileName: "phase4-history.csv",
      fileSize: 4096,
      guideVersion: 1,
    });
  }

  function assessmentsFor(blind) {
    return blind.map((row) => ({
      rowId: row.rowId,
      eligibility: [],
      elimination: [],
      criteria: [],
      weightedScore: null,
      recommendation: "human_review",
      evidenceValid: false,
      humanReviewReasons: ["Explicit test abstention"],
    }));
  }

  async function driveToCommitted(binding, blind, startSession) {
    let session = startSession ?? (await createPhase4Session({
      binding,
      guideContentHash: "guide-hash",
    }));
    session = await savePhase4Session(session);
    session = await savePhase4Session({
      ...session,
      modelId: "test-model",
      patternStatus: "generating",
      patternProcessedRows: binding.teachingRows,
      patternProgress: 100,
    });
    session = await savePhase4Session({ ...session, patternStatus: "reviewing" });
    session = await savePhase4Session({
      ...session,
      patternStatus: "approved",
      teachingApprovedAt: new Date().toISOString(),
      teachingApprovedBy: "Test organiser",
    });
    session = await savePhase4Session({
      ...session,
      practiceStatus: "policy_locked",
      acceptancePolicy: {
        evaluationMode: "binary_alignment",
        minimumHistoricalAlignment: 80,
        minimumProgressedCapture: 95,
        maximumHumanReviewRate: 100,
        waitlistPolicy: "exclude",
        tieBreakPriority: [],
        lockedAt: new Date().toISOString(),
        lockedBy: "Test organiser",
      },
    });
    session = await savePhase4Session({ ...session, practiceStatus: "running" });
    const assessments = assessmentsFor(blind);
    session = await savePhase4Session({
      ...session,
      assessmentProtocolHash: "4".repeat(64),
      assessments,
    });
    return savePhase4Session({
      ...session,
      practiceStatus: "predictions_committed",
      predictionHash: await contentHash(assessments),
    });
  }

  test("flips historical + Phase 4 together without reopening the reveal seal", async () => {
    const table = sourceTable("COMBINED");
    const imported = await importHistory(table);
    assert.match(imported.datasetId, /^[0-9a-f-]{36}$/);
    assert.equal(imported.summary.datasetId, imported.datasetId);
    assert.equal((await loadActiveHistoricalSummary()).datasetId, imported.datasetId);
    assert.equal(await historicalDatasetExists(imported.datasetId), true);

    const teaching = await loadTeachingRows(imported.datasetId);
    const blind = await loadBlindPracticeRows(imported.datasetId);
    assert.equal(teaching.length + blind.length, 40);
    assert.ok(teaching.every((row) => typeof row.outcome === "string"));
    assert.ok(blind.every((row) => !Object.hasOwn(row, "outcome")), "blind rows never expose outcomes");

    const binding = await loadHistoricalDatasetBinding(imported.datasetId);
    let committed = await driveToCommitted(binding, blind);
    assert.equal((await loadPhase4Session(imported.datasetId, 1)).outcomes, null);

    // A raw API caller can include a forged answer key, but normal save strips
    // it and keeps the server-owned value null before reveal.
    committed = await pilot("calibration.save", {
      session: {
        ...committed,
        outcomes: blind.map((row) => ({ rowId: row.rowId, outcome: "progressed" })),
      },
    });
    assert.equal(committed.outcomes, null);

    // The same revision can win once only; a stale second write is a 409 CAS conflict.
    const once = await pilot("calibration.save", { session: committed });
    await assert.rejects(
      pilot("calibration.save", { session: committed }),
      (error) => error instanceof PilotConflictError && error.code === "revision_conflict",
    );
    committed = once;

    await assert.rejects(
      savePhase4Session({
        ...committed,
        practiceStatus: "revealed",
        outcomes: blind.map((row) => ({ rowId: row.rowId, outcome: "progressed" })),
        revealedAt: new Date().toISOString(),
      }),
      /unsafe reversal/i,
    );

    const revealed = await revealCommittedOutcomes(committed);
    assert.equal(revealed.practiceStatus, "revealed");
    assert.equal(revealed.outcomes.length, blind.length);
    assert.notDeepEqual(
      revealed.outcomes,
      blind.map((row) => ({ rowId: row.rowId, outcome: "progressed" })),
      "the answer key came from Postgres, not the forged client payload",
    );
    const sameReveal = await revealCommittedOutcomes(revealed);
    assert.equal(sameReveal.revealedAt, revealed.revealedAt, "repeat reads do not spend the seal twice");

    let [receipt] = await sql`
      SELECT reveal_count, reveals_allowed, session_id
        FROM netzero.calibration_reveal_receipts
       WHERE dataset_fingerprint = ${binding.datasetFingerprint}`;
    assert.equal(receipt.reveal_count, 1);
    assert.equal(receipt.reveals_allowed, 1);

    assert.equal(await grantPhase4RecalibrationCredit(revealed.id), true);
    assert.equal(await loadPhase4RecalibrationCredits(binding.datasetFingerprint), 1);
    const reset = await resetPhase4SessionWithCredit({ binding, guideContentHash: "guide-hash" });
    assert.equal(reset.blindnessCompromised, true);
    assert.equal(reset.practiceStatus, "not_started");
    const retried = await revealCommittedOutcomes(await driveToCommitted(binding, blind, reset));
    assert.equal(retried.practiceStatus, "revealed");
    assert.equal(await loadPhase4RecalibrationCredits(binding.datasetFingerprint), 0);

    // Delete and re-import byte-for-byte-equivalent source data. The session is
    // gone, but its receipt and credit journal survive with a null FK, so the
    // same file cannot become a fresh blind test again.
    await deleteHistoricalDataset(imported.datasetId);
    assert.equal(await historicalDatasetExists(imported.datasetId), false);
    const reimported = await importHistory(table);
    const rebound = await loadHistoricalDatasetBinding(reimported.datasetId);
    assert.equal(rebound.datasetFingerprint, binding.datasetFingerprint);
    await assert.rejects(
      createPhase4Session({ binding: rebound, guideContentHash: "guide-hash" }),
      /already been used for a revealed blind test/i,
    );
    const bypass = buildPristinePhase4Session(
      rebound,
      "guide-hash",
      new Date().toISOString(),
      false,
    );
    await assert.rejects(
      pilot("calibration.save", { session: bypass }),
      (error) => error instanceof PilotConflictError && error.code === "already_revealed",
      "the API itself blocks a client that bypasses createPhase4Session",
    );

    [receipt] = await sql`
      SELECT reveal_count, reveals_allowed, session_id
        FROM netzero.calibration_reveal_receipts
       WHERE dataset_fingerprint = ${binding.datasetFingerprint}`;
    assert.equal(receipt.reveal_count, 2);
    assert.equal(receipt.reveals_allowed, 2);
    assert.equal(receipt.session_id, null, "dataset deletion cannot delete the permanent receipt");
    const [{ credits }] = await sql`
      SELECT count(*)::int AS credits FROM netzero.recalibration_credits
       WHERE dataset_fingerprint = ${binding.datasetFingerprint}`;
    assert.equal(credits, 1, "the append-only credit journal also survives deletion");
  });
}
