import assert from "node:assert/strict";
import test from "node:test";
import { createPhase4InputFingerprint } from "../app/phase4-logic.ts";
import { getPhase4AssessmentProtocolHash } from "../app/phase4-protocol.ts";
import {
  PHASE5_BATCH_ALGORITHM,
  PHASE5_PROMPT_VERSION,
  PHASE5_SAFEGUARD_IDS,
  PHASE5_SCHEMA_VERSION,
  createPhase5Run,
  createPhase5RunId,
  createPhase5SafeguardApproval,
  loadPhase5Run,
  runReviewStateIsValid,
  savePhase5SafeguardApproval,
} from "../app/phase5-storage.ts";

async function phase4Session(id) {
  return {
    id,
    datasetFingerprint: "a".repeat(64),
    guideVersion: 2,
    guideContentHash: "b".repeat(64),
    metricsHash: "c".repeat(64),
    modelId: "gpt-5.6-terra",
    assessmentProtocolHash: await getPhase4AssessmentProtocolHash(),
    practiceStatus: "passed",
    finalDecisionAt: "2026-07-15T09:00:00.000Z",
    patterns: [{
      id: "pattern:impact", targetRuleId: "impact",
      proposedInterpretation: "Quantified impact clarifies the anchor.", decision: "approved",
    }],
  };
}

async function contract(runId) {
  const core = {
    runId,
    datasetFingerprint: "d".repeat(64),
    datasetIntegrityHash: "e".repeat(64),
    datasetRowCount: 1,
    phase4SessionId: "phase4:storage-test",
    phase4MetricsHash: "c".repeat(64),
    expectedModelId: "gpt-5.6-terra",
    assessmentProtocolHash: await getPhase4AssessmentProtocolHash(),
    promptVersion: PHASE5_PROMPT_VERSION,
    outputSchemaVersion: PHASE5_SCHEMA_VERSION,
    batchAlgorithm: PHASE5_BATCH_ALGORITHM,
    approvedBy: "Competition organiser",
    approvedAt: "2026-07-15T10:00:00.000Z",
    guideContentHash: "b".repeat(64),
    approvedPatternsHash: "f".repeat(64),
    selection: { mode: "minimum_score", shortlistTarget: "20", minimumScore: "70", tieBreakPriority: ["impact"] },
  };
  return { ...core, contractHash: await createPhase4InputFingerprint(core) };
}

test("creates an integrity-bound safeguard approval for the exact passed session", async () => {
  const phase4 = await phase4Session("phase4:storage-safeguard");
  const approval = await createPhase5SafeguardApproval({
    phase4,
    approvedBy: "Competition organiser",
    acknowledgements: PHASE5_SAFEGUARD_IDS,
  });
  assert.match(approval.approvalHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    createPhase5SafeguardApproval({
      phase4,
      approvedBy: "Competition organiser",
      acknowledgements: PHASE5_SAFEGUARD_IDS.slice(0, -1),
    }),
    /every safeguard/i,
  );
});

test("Phase 5 storage posts complete documents through the pilot transport", async () => {
  const originalFetch = globalThis.fetch;
  const actions = [];
  let storedRun = null;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    actions.push(body.action);
    if (body.action === "assessment.safeguards.save") {
      return Response.json({ ok: true, data: body.payload.approval });
    }
    if (body.action === "assessment.document.create") {
      storedRun = body.payload.run;
      return Response.json({ ok: true, data: storedRun });
    }
    if (body.action === "assessment.document.load") {
      return Response.json({ ok: true, data: storedRun });
    }
    return Response.json({ ok: true, data: null });
  };
  try {
    const phase4 = await phase4Session("phase4:transport");
    const approval = await createPhase5SafeguardApproval({
      phase4, approvedBy: "Competition organiser", acknowledgements: PHASE5_SAFEGUARD_IDS,
    });
    await savePhase5SafeguardApproval(approval);
    const runId = createPhase5RunId("00000000-0000-4000-8000-000000000001");
    assert.match(runId, /^[0-9a-f-]{36}$/);
    const run = await createPhase5Run({
      datasetId: "00000000-0000-4000-8000-000000000001",
      contract: await contract(runId),
      batches: [{ batchId: "batch-1", batchIndex: 0, rowIds: ["case-1"], batchInputHash: "1".repeat(64) }],
    });
    assert.equal(await runReviewStateIsValid(run), true);
    assert.deepEqual(await loadPhase5Run(runId), run);
    assert.deepEqual(actions, [
      "assessment.safeguards.save",
      "assessment.document.create",
      "assessment.document.load",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
