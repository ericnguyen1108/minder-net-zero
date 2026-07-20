// End-to-end client -> /api/pilot -> repository -> Postgres coverage for the
// combined current-applications + Phase 5 flip. Gated on the throwaway DB.

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("current + Phase 5 Postgres flip (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  process.env.MINDER_COMPETITION_NAME = "Current Phase5 Client Test";

  const { POST } = await import("../app/api/pilot/route.ts");
  const {
    currentDatasetExists,
    deleteCurrentDataset,
    loadActiveCurrentSummary,
    loadCurrentCasesForAi,
    loadCurrentDatasetBinding,
    loadCurrentIdentitiesForReview,
    saveCurrentDataset,
  } = await import("../app/current-data.ts");
  const { createPhase4InputFingerprint } = await import("../app/phase4-logic.ts");
  const { getPhase4AssessmentProtocolHash } = await import("../app/phase4-protocol.ts");
  const {
    PHASE5_BATCH_ALGORITHM,
    PHASE5_PROMPT_VERSION,
    PHASE5_SAFEGUARD_IDS,
    PHASE5_SCHEMA_VERSION,
    claimNextPhase5Batch,
    commitPhase5Batch,
    confirmPhase5Evidence,
    createPhase5Run,
    createPhase5RunId,
    createPhase5SafeguardApproval,
    finalizePhase5Run,
    invalidatePhase5Run,
    loadLatestPhase5Run,
    loadPhase5Batches,
    loadPhase5Results,
    loadPhase5Run,
    phase5AssessmentSetIsValid,
    savePhase5SafeguardApproval,
  } = await import("../app/phase5-storage.ts");
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
    { key: "track", label: "Track", index: 2 },
    { key: "impact", label: "Impact", index: 3 },
  ];
  const mapping = {
    applicationId: "id", teamName: "team", track: "track", responseColumns: ["impact"],
  };

  function table(tag, count = 2) {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `${tag}-${index + 1}`,
      team: `${tag} Team ${index + 1}`,
      track: "Energy",
      impact: `${tag} evidence ${index + 1} with quantified climate impact.`,
    }));
    return { sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, index) => index + 2) };
  }

  function assessment(runId, rowId, score) {
    return {
      runId, rowId, eligibility: [], elimination: [],
      criteria: [{ criterionId: "impact", score, evidence: [{ answerIndex: 0, quote: "quantified climate impact" }] }],
      weightedScore: score * 20,
      baseRecommendation: score >= 4 ? "progressed" : "not_progressed",
      evidenceValid: true,
      humanReviewReasons: [],
    };
  }

  async function createContract(runId, binding, phase4, approval) {
    const core = {
      runId,
      datasetFingerprint: binding.datasetFingerprint,
      datasetIntegrityHash: binding.integrityHash,
      datasetRowCount: binding.totalRows,
      phase4SessionId: phase4.id,
      phase4MetricsHash: phase4.metricsHash,
      expectedModelId: phase4.modelId,
      assessmentProtocolHash: phase4.assessmentProtocolHash,
      promptVersion: PHASE5_PROMPT_VERSION,
      outputSchemaVersion: PHASE5_SCHEMA_VERSION,
      batchAlgorithm: PHASE5_BATCH_ALGORITHM,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      guideContentHash: phase4.guideContentHash,
      approvedPatternsHash: approval.approvedPatternsHash,
      selection: { mode: "minimum_score", shortlistTarget: "2", minimumScore: "70", tieBreakPriority: ["impact"] },
    };
    return { ...core, contractHash: await createPhase4InputFingerprint(core) };
  }

  test("flips current applications and the complete Phase 5 audit flow together", async () => {
    const imported = await saveCurrentDataset({
      fileName: "current.csv", fileSize: 4096, table: table("CURRENT"), mapping,
    });
    assert.match(imported.datasetId, /^[0-9a-f-]{36}$/);
    assert.equal(imported.summary.datasetId, imported.datasetId);
    assert.equal((await loadActiveCurrentSummary()).datasetId, imported.datasetId);
    assert.equal(await currentDatasetExists(imported.datasetId), true);

    const cases = await loadCurrentCasesForAi(imported.datasetId);
    const identities = await loadCurrentIdentitiesForReview(imported.datasetId);
    const binding = await loadCurrentDatasetBinding(imported.datasetId);
    assert.equal(cases.length, 2);
    assert.equal(identities.length, 2);
    assert.ok(cases.every((item) => !JSON.stringify(item).includes("CURRENT Team")));
    assert.ok(identities.every((item) => !("answers" in item)));

    const [workspace] = await sql`
      SELECT id FROM netzero.workspaces WHERE name = ${process.env.MINDER_COMPETITION_NAME}`;
    const [history] = await sql`
      INSERT INTO netzero.historical_datasets
        (workspace_id, name, fingerprint, integrity_hash, teaching_count, sealed_count, guide_version)
      VALUES (${workspace.id}, 'History', ${"1".repeat(64)}, ${"2".repeat(64)}, 1, 1, 1)
      RETURNING id`;
    const phase4 = {
      id: "phase4:current-phase5", datasetFingerprint: "1".repeat(64), guideVersion: 1,
      guideContentHash: "3".repeat(64), metricsHash: "4".repeat(64), modelId: "test-model",
      assessmentProtocolHash: await getPhase4AssessmentProtocolHash(), practiceStatus: "passed",
      finalDecisionAt: "2026-07-20T00:00:00.000Z",
      patterns: [{ id: "pattern-impact", targetRuleId: "impact", proposedInterpretation: "Use quantified evidence.", decision: "approved" }],
    };
    await sql`
      INSERT INTO netzero.calibration_sessions
        (workspace_id, dataset_id, guide_version, practice_status, revision, patterns,
         metrics_hash, model_id, protocol_hash, session_document)
      VALUES (${workspace.id}, ${history.id}, 1, 'passed', 0, ${sql.json(phase4.patterns)},
              ${phase4.metricsHash}, ${phase4.modelId}, ${phase4.assessmentProtocolHash},
              ${sql.json(phase4)})`;

    const approval = await createPhase5SafeguardApproval({
      phase4, approvedBy: "Test organiser", acknowledgements: PHASE5_SAFEGUARD_IDS,
    });
    await savePhase5SafeguardApproval(approval);
    const [storedApproval] = await sql`
      SELECT sa.approved_by, r.display_name, r.active, sa.detail ->> 'approvalHash' AS approval_hash
        FROM netzero.safeguard_approvals sa
        JOIN netzero.reviewers r ON r.id = sa.approved_by
       WHERE sa.workspace_id = ${workspace.id}`;
    assert.equal(storedApproval.display_name, "Test organiser");
    assert.equal(storedApproval.active, false, "approving safeguards does not enlarge the marking roster");
    assert.equal(storedApproval.approval_hash, approval.approvalHash);

    const runId = createPhase5RunId(imported.datasetId);
    const contract = await createContract(runId, binding, phase4, approval);
    const batch = {
      batchId: "batch-current-phase5", batchIndex: 0,
      rowIds: cases.map((item) => item.rowId), batchInputHash: "5".repeat(64),
    };
    let run = await createPhase5Run({ datasetId: imported.datasetId, contract, batches: [batch] });
    assert.deepEqual(await loadPhase5Run(run.id), run);
    assert.equal((await loadLatestPhase5Run(imported.datasetId)).id, run.id);
    assert.equal((await loadPhase5Batches(run.id))[0].status, "pending");

    const claimed = await claimNextPhase5Batch({
      runId: run.id, expectedRevision: run.revision, leaseToken: "lease-current-phase5",
    });
    await assert.rejects(
      claimNextPhase5Batch({ runId: run.id, expectedRevision: 0, leaseToken: "stale" }),
      /another tab/i,
    );
    run = await commitPhase5Batch({
      runId: run.id,
      expectedRevision: claimed.run.revision,
      batchId: claimed.batch.batchId,
      leaseToken: claimed.batch.leaseToken,
      assessments: cases.map((item, index) => assessment(run.id, item.rowId, index ? 3 : 5)),
    });
    assert.equal(run.status, "complete");
    const results = await loadPhase5Results(run.id);
    assert.equal(results.length, 2);
    run = await finalizePhase5Run({
      runId: run.id,
      expectedRevision: run.revision,
      recommendations: results.map((item) => ({
        rowId: item.rowId,
        recommendation: item.weightedScore >= 70 ? "progressed" : "not_progressed",
        reason: "minimum_score_result",
        rank: null,
        weightedScore: item.weightedScore,
      })),
      evidenceSampleIds: [results[0].rowId],
    });
    assert.equal(run.status, "auditing");
    assert.equal(await phase5AssessmentSetIsValid(run, results), true);
    run = await confirmPhase5Evidence({
      runId: run.id, expectedRevision: run.revision, rowId: run.evidenceSampleIds[0],
    });
    assert.equal(run.status, "ready_for_human_review");

    await assert.rejects(
      sql`UPDATE netzero_ai.assessment_results SET weighted_score = 0 WHERE run_id = ${run.id}`,
      /immutable|permission denied/i,
    );

    const secondRunId = createPhase5RunId(imported.datasetId);
    const secondContract = await createContract(secondRunId, binding, phase4, approval);
    let failedAuditRun = await createPhase5Run({
      datasetId: imported.datasetId,
      contract: secondContract,
      batches: [{ ...batch, batchId: "batch-current-phase5-audit", batchInputHash: "6".repeat(64) }],
    });
    const secondClaim = await claimNextPhase5Batch({
      runId: failedAuditRun.id, expectedRevision: failedAuditRun.revision, leaseToken: "lease-current-phase5-audit",
    });
    failedAuditRun = await commitPhase5Batch({
      runId: failedAuditRun.id, expectedRevision: secondClaim.run.revision,
      batchId: secondClaim.batch.batchId, leaseToken: secondClaim.batch.leaseToken,
      assessments: cases.map((item) => assessment(failedAuditRun.id, item.rowId, 4)),
    });
    const secondResults = await loadPhase5Results(failedAuditRun.id);
    failedAuditRun = await finalizePhase5Run({
      runId: failedAuditRun.id, expectedRevision: failedAuditRun.revision,
      recommendations: secondResults.map((item) => ({ rowId: item.rowId, recommendation: "progressed", reason: "minimum_score_result", rank: null, weightedScore: item.weightedScore })),
      evidenceSampleIds: [secondResults[0].rowId],
    });
    failedAuditRun = await invalidatePhase5Run({
      runId: failedAuditRun.id, expectedRevision: failedAuditRun.revision,
      reason: "The cited evidence did not support the finding.",
    });
    assert.equal(failedAuditRun.status, "invalid");

    const replacement = await saveCurrentDataset({
      fileName: "replacement.csv", fileSize: 5000, table: table("REPLACEMENT", 1), mapping,
      replaceDatasetId: imported.datasetId,
    });
    assert.equal(await currentDatasetExists(imported.datasetId), true, "referenced input is retained");
    assert.equal((await loadActiveCurrentSummary()).datasetId, replacement.datasetId);
    await assert.rejects(deleteCurrentDataset(imported.datasetId), /assessment run cannot be removed/i);
    await deleteCurrentDataset(replacement.datasetId);
  });
}
