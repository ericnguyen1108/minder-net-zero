import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createPhase4InputFingerprint } from "../app/phase4-logic.ts";
import { getPhase4AssessmentProtocolHash } from "../app/phase4-protocol.ts";
import {
  PHASE5_BATCH_ALGORITHM,
  PHASE5_PROMPT_VERSION,
  PHASE5_SAFEGUARD_IDS,
  PHASE5_SCHEMA_VERSION,
  claimNextPhase5Batch,
  commitPhase5Batch,
  confirmPhase5Evidence,
  createPhase5Run,
  createPhase5SafeguardApproval,
  finalizePhase5Run,
  invalidatePhase5Run,
  loadLatestPhase5Run,
  loadPhase5Run,
  loadPhase5Results,
  loadPhase5SafeguardApproval,
  phase5AssessmentSetIsValid,
  savePhase5SafeguardApproval,
} from "../app/phase5-storage.ts";
import {
  PHASE5_RESULTS_STORE,
  PHASE5_RUNS_STORE,
} from "../app/historical-data.ts";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

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
    patterns: [
      {
        id: "pattern:impact:quantified",
        targetRuleId: "impact",
        proposedInterpretation: "Quantified impact clarifies the existing anchor.",
        decision: "approved",
      },
      {
        id: "pattern:rejected",
        targetRuleId: "impact",
        proposedInterpretation: "Rejected context.",
        decision: "rejected",
      },
    ],
  };
}

async function contract(runId, rowCount = 2) {
  const core = {
    runId,
    datasetFingerprint: "d".repeat(64),
    datasetIntegrityHash: "e".repeat(64),
    datasetRowCount: rowCount,
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
    selection: {
      mode: "minimum_score",
      shortlistTarget: "20",
      minimumScore: "70",
      tieBreakPriority: ["impact"],
    },
  };
  return { ...core, contractHash: await createPhase4InputFingerprint(core) };
}

function storedAssessment(runId, rowId, score) {
  return {
    runId,
    rowId,
    eligibility: [],
    elimination: [],
    criteria: [
      {
        criterionId: "impact",
        score,
        evidence: [{ answerIndex: 0, quote: `Evidence ${rowId}` }],
      },
    ],
    weightedScore: score * 20,
    baseRecommendation: score >= 4 ? "progressed" : "not_progressed",
    evidenceValid: true,
    humanReviewReasons: [],
  };
}

async function overwriteStoredRun(run) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(PHASE5_RUNS_STORE, "readwrite");
  transaction.objectStore(PHASE5_RUNS_STORE).put(structuredClone(run));
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

test("locks safeguard approval to the exact passed practice session", async () => {
  const phase4 = await phase4Session("phase4:storage-safeguard");
  const approval = await createPhase5SafeguardApproval({
    phase4,
    approvedBy: "Competition organiser",
    acknowledgements: PHASE5_SAFEGUARD_IDS,
  });
  await savePhase5SafeguardApproval(approval);
  assert.deepEqual(await loadPhase5SafeguardApproval(phase4), approval);

  const changed = { ...phase4, metricsHash: "9".repeat(64) };
  assert.equal(await loadPhase5SafeguardApproval(changed), null);
  await assert.rejects(
    () =>
      createPhase5SafeguardApproval({
        phase4: { ...phase4, assessmentProtocolHash: "9".repeat(64) },
        approvedBy: "Competition organiser",
        acknowledgements: PHASE5_SAFEGUARD_IDS,
      }),
    /prompt or schema changed/i,
  );
  await assert.rejects(
    () =>
      createPhase5SafeguardApproval({
        phase4,
        approvedBy: "Competition organiser",
        acknowledgements: PHASE5_SAFEGUARD_IDS.slice(0, -1),
      }),
    /every safeguard/i,
  );
});

test("claims batches with CAS, commits immutable results and finalises only a complete cohort", async () => {
  const runId = "phase5:storage-run:one";
  const run = await createPhase5Run({
    datasetId: "current-storage-run-one",
    contract: await contract(runId),
    batches: [
      { batchId: "batch-1", batchIndex: 0, rowIds: ["case-one"], batchInputHash: "1".repeat(64) },
      { batchId: "batch-2", batchIndex: 1, rowIds: ["case-two"], batchInputHash: "2".repeat(64) },
    ],
  });
  const first = await claimNextPhase5Batch({
    runId,
    expectedRevision: run.revision,
    leaseToken: "lease-first",
  });
  assert.equal(first.batch.batchId, "batch-1");
  await assert.rejects(
    () => claimNextPhase5Batch({ runId, expectedRevision: 0, leaseToken: "stale" }),
    /another tab/i,
  );
  let working = await commitPhase5Batch({
    runId,
    expectedRevision: first.run.revision,
    batchId: first.batch.batchId,
    leaseToken: "lease-first",
    assessments: [storedAssessment(runId, "case-one", 5)],
  });
  await assert.rejects(
    () =>
      finalizePhase5Run({
        runId,
        expectedRevision: working.revision,
        recommendations: [],
        evidenceSampleIds: [],
      }),
    /every fixed application/i,
  );

  const second = await claimNextPhase5Batch({
    runId,
    expectedRevision: working.revision,
    leaseToken: "lease-second",
  });
  working = await commitPhase5Batch({
    runId,
    expectedRevision: second.run.revision,
    batchId: second.batch.batchId,
    leaseToken: "lease-second",
    assessments: [storedAssessment(runId, "case-two", 3)],
  });
  assert.equal(working.status, "complete");
  assert.equal(working.processedCases, 2);
  assert.equal((await loadPhase5Results(runId)).length, 2);

  const finalised = await finalizePhase5Run({
    runId,
    expectedRevision: working.revision,
    recommendations: [
      { rowId: "case-one", recommendation: "progressed", reason: "minimum_score_result", rank: null, weightedScore: 100 },
      { rowId: "case-two", recommendation: "not_progressed", reason: "minimum_score_result", rank: null, weightedScore: 60 },
    ],
    evidenceSampleIds: ["case-one"],
  });
  assert.equal(finalised.status, "auditing");
  assert.match(finalised.reviewStateHash, /^[a-f0-9]{64}$/);
  assert.equal(
    await phase5AssessmentSetIsValid(finalised, await loadPhase5Results(runId)),
    true,
  );
  const reviewed = await confirmPhase5Evidence({
    runId,
    expectedRevision: finalised.revision,
    rowId: "case-one",
  });
  assert.equal(reviewed.status, "ready_for_human_review");
  assert.notEqual(reviewed.reviewStateHash, finalised.reviewStateHash);
  assert.deepEqual(await loadPhase5Run(runId), reviewed);
});

test("fails closed when final recommendations, status or evidence-review IDs are edited", async () => {
  const runId = "phase5:storage-run:review-state-tamper";
  const datasetId = "current-storage-run-review-state-tamper";
  let working = await createPhase5Run({
    datasetId,
    contract: await contract(runId, 1),
    batches: [
      {
        batchId: "batch-review-state-tamper",
        batchIndex: 0,
        rowIds: ["case-review-state"],
        batchInputHash: "4".repeat(64),
      },
    ],
  });
  const claim = await claimNextPhase5Batch({
    runId,
    expectedRevision: working.revision,
    leaseToken: "lease-review-state-tamper",
  });
  working = await commitPhase5Batch({
    runId,
    expectedRevision: claim.run.revision,
    batchId: claim.batch.batchId,
    leaseToken: "lease-review-state-tamper",
    assessments: [storedAssessment(runId, "case-review-state", 5)],
  });
  const finalised = await finalizePhase5Run({
    runId,
    expectedRevision: working.revision,
    recommendations: [
      {
        rowId: "case-review-state",
        recommendation: "progressed",
        reason: "minimum_score_result",
        rank: null,
        weightedScore: 100,
      },
    ],
    evidenceSampleIds: ["case-review-state"],
  });
  const assessments = await loadPhase5Results(runId);
  assert.deepEqual(await loadPhase5Run(runId), finalised);

  const tamperedRecommendation = structuredClone(finalised);
  tamperedRecommendation.cohortRecommendations[0].recommendation = "not_progressed";
  await overwriteStoredRun(tamperedRecommendation);
  assert.equal(await loadPhase5Run(runId), null);
  await assert.rejects(
    () => loadLatestPhase5Run(datasetId),
    /latest assessment run did not pass its integrity check/i,
  );
  assert.equal(await phase5AssessmentSetIsValid(tamperedRecommendation, assessments), false);

  await overwriteStoredRun(finalised);
  const tamperedStatus = structuredClone(finalised);
  tamperedStatus.status = "invalid";
  tamperedStatus.invalidReason = "Direct storage edit";
  await overwriteStoredRun(tamperedStatus);
  assert.equal(await loadPhase5Run(runId), null);
  assert.equal(await phase5AssessmentSetIsValid(tamperedStatus, assessments), false);

  await overwriteStoredRun(finalised);
  const tamperedReviewIds = structuredClone(finalised);
  tamperedReviewIds.reviewedEvidenceIds = ["case-review-state"];
  tamperedReviewIds.status = "ready_for_human_review";
  await overwriteStoredRun(tamperedReviewIds);
  assert.equal(await loadPhase5Run(runId), null);
  assert.equal(await phase5AssessmentSetIsValid(tamperedReviewIds, assessments), false);

  await overwriteStoredRun(finalised);
  const invalidated = await invalidatePhase5Run({
    runId,
    expectedRevision: finalised.revision,
    reason: "Human evidence relevance check failed.",
  });
  assert.equal(invalidated.status, "invalid");
  assert.notEqual(invalidated.reviewStateHash, finalised.reviewStateHash);
  assert.deepEqual(await loadPhase5Run(runId), invalidated);
});

test("detects result tampering after the assessment-set receipt is frozen", async () => {
  const runId = "phase5:storage-run:tamper";
  let working = await createPhase5Run({
    datasetId: "current-storage-run-tamper",
    contract: await contract(runId, 1),
    batches: [
      { batchId: "batch-tamper", batchIndex: 0, rowIds: ["case-tamper"], batchInputHash: "3".repeat(64) },
    ],
  });
  const claim = await claimNextPhase5Batch({
    runId,
    expectedRevision: working.revision,
    leaseToken: "lease-tamper",
  });
  working = await commitPhase5Batch({
    runId,
    expectedRevision: claim.run.revision,
    batchId: claim.batch.batchId,
    leaseToken: "lease-tamper",
    assessments: [storedAssessment(runId, "case-tamper", 5)],
  });
  const finalised = await finalizePhase5Run({
    runId,
    expectedRevision: working.revision,
    recommendations: [
      { rowId: "case-tamper", recommendation: "progressed", reason: "minimum_score_result", rank: null, weightedScore: 100 },
    ],
    evidenceSampleIds: [],
  });

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("minder-net-zero-private-v1", 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(PHASE5_RESULTS_STORE, "readwrite");
  const store = transaction.objectStore(PHASE5_RESULTS_STORE);
  const result = await new Promise((resolve, reject) => {
    const request = store.get([runId, "case-tamper"]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  result.weightedScore = 0;
  store.put(result);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();

  assert.equal(
    await phase5AssessmentSetIsValid(finalised, await loadPhase5Results(runId)),
    false,
  );
});
