import {
  PHASE5_BATCHES_STORE,
  PHASE5_RESULTS_STORE,
  PHASE5_RUNS_STORE,
  PHASE5_SAFEGUARDS_STORE,
  openDatabase,
  transactionComplete,
} from "./historical-data.ts";
import { contentHash, grantPhase4RecalibrationCredit } from "./phase4-storage.ts";
import type { Phase4Session } from "./phase4-storage.ts";
import { createPhase4InputFingerprint, stableStringify } from "./phase4-logic.ts";
import { getPhase4AssessmentProtocolHash } from "./phase4-protocol.ts";

export const PHASE5_PROMPT_VERSION = "phase5-current-assessment-v1";
export const PHASE5_SCHEMA_VERSION = "phase5-assessment-v1";
export const PHASE5_BATCH_ALGORITHM = "opaque-row-order-byte-pack-v1";

export const PHASE5_SAFEGUARD_IDS = [
  "approved-guide-only",
  "no-guessing",
  "uncertainty-to-people",
  "evidence-required",
  "identity-minimised",
  "device-local-test-only",
  "people-decide",
] as const;

export type Phase5SafeguardId = (typeof PHASE5_SAFEGUARD_IDS)[number];

export type Phase5SafeguardApproval = {
  id: string;
  schemaVersion: 1;
  phase4SessionId: string;
  historicalDatasetFingerprint: string;
  phase4MetricsHash: string;
  guideVersion: number;
  guideContentHash: string;
  approvedPatternsHash: string;
  expectedModelId: string;
  assessmentProtocolHash: string;
  promptVersion: typeof PHASE5_PROMPT_VERSION;
  outputSchemaVersion: typeof PHASE5_SCHEMA_VERSION;
  batchAlgorithm: typeof PHASE5_BATCH_ALGORITHM;
  acknowledgements: Phase5SafeguardId[];
  approvedBy: string;
  approvedAt: string;
  approvalHash: string;
};

export type Phase5SelectionSnapshot = {
  mode: "top_n" | "minimum_score" | "both";
  shortlistTarget: string;
  minimumScore: string;
  tieBreakPriority: string[];
};

export type Phase5RunContract = {
  runId: string;
  datasetFingerprint: string;
  datasetIntegrityHash: string;
  datasetRowCount: number;
  phase4SessionId: string;
  phase4MetricsHash: string;
  expectedModelId: string;
  assessmentProtocolHash: string;
  promptVersion: typeof PHASE5_PROMPT_VERSION;
  outputSchemaVersion: typeof PHASE5_SCHEMA_VERSION;
  batchAlgorithm: typeof PHASE5_BATCH_ALGORITHM;
  approvedBy: string;
  approvedAt: string;
  guideContentHash: string;
  approvedPatternsHash: string;
  selection: Phase5SelectionSnapshot;
  contractHash: string;
};

export type Phase5Batch = {
  runId: string;
  batchId: string;
  batchIndex: number;
  rowIds: string[];
  batchInputHash: string;
  status: "pending" | "in_flight" | "complete" | "failed";
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string;
  completedAt: string | null;
};

export type Phase5FindingEvidence = {
  answerIndex: number;
  quote: string;
};

export type Phase5StoredAssessment = {
  runId: string;
  rowId: string;
  eligibility: Array<{
    ruleId: string;
    status: "pass" | "fail" | "unclear";
    evidence: Phase5FindingEvidence[];
  }>;
  elimination: Array<{
    ruleId: string;
    status: "triggered" | "not_triggered" | "unclear";
    evidence: Phase5FindingEvidence[];
  }>;
  criteria: Array<{
    criterionId: string;
    score: 1 | 2 | 3 | 4 | 5 | null;
    evidence: Phase5FindingEvidence[];
  }>;
  weightedScore: number | null;
  baseRecommendation: "progressed" | "not_progressed" | "ineligible" | "rank_only" | "human_review";
  evidenceValid: boolean;
  humanReviewReasons: string[];
};

export type Phase5CohortRecommendation = {
  rowId: string;
  recommendation: "progressed" | "not_progressed" | "ineligible" | "human_review";
  reason: string;
  rank: number | null;
  weightedScore: number | null;
};

export type Phase5Run = {
  id: string;
  schemaVersion: 1;
  revision: number;
  datasetId: string;
  status: "ready" | "running" | "paused" | "complete" | "auditing" | "ready_for_human_review" | "invalid";
  contract: Phase5RunContract;
  caseCount: number;
  batchCount: number;
  completedBatches: number;
  processedCases: number;
  assessmentSetHash: string | null;
  reviewStateHash: string | null;
  cohortRecommendations: Phase5CohortRecommendation[];
  evidenceSampleIds: string[];
  reviewedEvidenceIds: string[];
  invalidReason: string;
  createdAt: string;
  updatedAt: string;
};

type Phase5ReviewState = Pick<
  Phase5Run,
  | "status"
  | "assessmentSetHash"
  | "cohortRecommendations"
  | "evidenceSampleIds"
  | "reviewedEvidenceIds"
  | "invalidReason"
>;

const FINALIZED_RUN_STATUSES = new Set<Phase5Run["status"]>([
  "auditing",
  "ready_for_human_review",
  "invalid",
]);

function reviewStateCore(run: Phase5ReviewState): Phase5ReviewState {
  return {
    status: run.status,
    assessmentSetHash: run.assessmentSetHash,
    cohortRecommendations: run.cohortRecommendations,
    evidenceSampleIds: run.evidenceSampleIds,
    reviewedEvidenceIds: run.reviewedEvidenceIds,
    invalidReason: run.invalidReason,
  };
}

async function createReviewStateHash(run: Phase5ReviewState) {
  return contentHash(reviewStateCore(run));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function contractCore(contract: Phase5RunContract) {
  const core: Partial<Phase5RunContract> = { ...contract };
  delete core.contractHash;
  return core as Omit<Phase5RunContract, "contractHash">;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Private browser storage failed."));
  });
}

function secureToken(prefix: string) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure browser identifiers are unavailable.");
  }
  const bytes = new Uint32Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("")}`;
}

function approvalCore(approval: Omit<Phase5SafeguardApproval, "approvalHash"> | Phase5SafeguardApproval) {
  const core: Partial<Phase5SafeguardApproval> = { ...approval };
  delete core.approvalHash;
  return core as Omit<Phase5SafeguardApproval, "approvalHash">;
}

export function phase5SafeguardId(phase4SessionId: string) {
  return `phase5-safeguards:${phase4SessionId}`;
}

function approvedPatternSnapshot(session: Phase4Session) {
  return session.patterns
    .filter((pattern) => pattern.decision === "approved")
    .map((pattern) => ({
      id: pattern.id,
      targetRuleId: pattern.targetRuleId,
      proposedInterpretation: pattern.proposedInterpretation,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function createPhase5SafeguardApproval(args: {
  phase4: Phase4Session;
  approvedBy: string;
  acknowledgements: readonly Phase5SafeguardId[];
}) {
  const { phase4 } = args;
  if (
    phase4.practiceStatus !== "passed" ||
    !phase4.metricsHash ||
    !phase4.modelId ||
    !phase4.assessmentProtocolHash ||
    !phase4.finalDecisionAt ||
    !phase4.guideContentHash
  ) {
    throw new Error("A complete passed practice test is required before safeguards can be locked.");
  }
  const assessmentProtocolHash = await getPhase4AssessmentProtocolHash();
  if (phase4.assessmentProtocolHash !== assessmentProtocolHash) {
    throw new Error(
      "The assessment prompt or schema changed after the practice test. Run calibration again.",
    );
  }
  const acknowledgements = [...new Set(args.acknowledgements)].sort() as Phase5SafeguardId[];
  if (
    acknowledgements.length !== PHASE5_SAFEGUARD_IDS.length ||
    PHASE5_SAFEGUARD_IDS.some((id) => !acknowledgements.includes(id))
  ) {
    throw new Error("Confirm every safeguard before continuing.");
  }
  const approvedBy = args.approvedBy.trim();
  if (!approvedBy) throw new Error("The safeguard approval needs a named organiser.");
  const core: Omit<Phase5SafeguardApproval, "approvalHash"> = {
    id: phase5SafeguardId(phase4.id),
    schemaVersion: 1,
    phase4SessionId: phase4.id,
    historicalDatasetFingerprint: phase4.datasetFingerprint,
    phase4MetricsHash: phase4.metricsHash,
    guideVersion: phase4.guideVersion,
    guideContentHash: phase4.guideContentHash,
    approvedPatternsHash: await contentHash(approvedPatternSnapshot(phase4)),
    expectedModelId: phase4.modelId,
    assessmentProtocolHash,
    promptVersion: PHASE5_PROMPT_VERSION,
    outputSchemaVersion: PHASE5_SCHEMA_VERSION,
    batchAlgorithm: PHASE5_BATCH_ALGORITHM,
    acknowledgements,
    approvedBy,
    approvedAt: new Date().toISOString(),
  };
  return { ...core, approvalHash: await contentHash(approvalCore(core)) };
}

export async function savePhase5SafeguardApproval(approval: Phase5SafeguardApproval) {
  if ((await contentHash(approvalCore(approval))) !== approval.approvalHash) {
    throw new Error("The safeguard approval did not pass its integrity check.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PHASE5_SAFEGUARDS_STORE, "readwrite");
    const store = transaction.objectStore(PHASE5_SAFEGUARDS_STORE);
    const existing = await requestResult(
      store.get(approval.id) as IDBRequest<Phase5SafeguardApproval | undefined>,
    );
    if (existing && existing.approvalHash !== approval.approvalHash) {
      transaction.abort();
      throw new Error("Safeguards are already locked for this passed practice test.");
    }
    store.put(approval);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadPhase5SafeguardApproval(phase4: Phase4Session) {
  const database = await openDatabase();
  try {
    const approval = await requestResult(
      database
        .transaction(PHASE5_SAFEGUARDS_STORE, "readonly")
        .objectStore(PHASE5_SAFEGUARDS_STORE)
        .get(phase5SafeguardId(phase4.id)) as IDBRequest<Phase5SafeguardApproval | undefined>,
    );
    if (!approval) return null;
    const expectedPatternHash = await contentHash(approvedPatternSnapshot(phase4));
    const expectedProtocolHash = await getPhase4AssessmentProtocolHash();
    const coherent =
      approval.schemaVersion === 1 &&
      approval.phase4SessionId === phase4.id &&
      approval.historicalDatasetFingerprint === phase4.datasetFingerprint &&
      approval.phase4MetricsHash === phase4.metricsHash &&
      approval.guideVersion === phase4.guideVersion &&
      approval.guideContentHash === phase4.guideContentHash &&
      approval.approvedPatternsHash === expectedPatternHash &&
      approval.expectedModelId === phase4.modelId &&
      approval.assessmentProtocolHash === phase4.assessmentProtocolHash &&
      approval.assessmentProtocolHash === expectedProtocolHash &&
      approval.promptVersion === PHASE5_PROMPT_VERSION &&
      approval.outputSchemaVersion === PHASE5_SCHEMA_VERSION &&
      approval.batchAlgorithm === PHASE5_BATCH_ALGORITHM &&
      PHASE5_SAFEGUARD_IDS.every((id) => approval.acknowledgements.includes(id)) &&
      (await contentHash(approvalCore(approval))) === approval.approvalHash;
    return coherent ? approval : null;
  } finally {
    database.close();
  }
}

export function createPhase5RunId(datasetId: string) {
  return `phase5:${datasetId}:${secureToken("run")}`;
}

function runIsCoherent(run: Phase5Run) {
  if (!run || typeof run !== "object" || !run.contract || typeof run.contract !== "object") {
    return false;
  }
  const reviewStateHash = (run as Partial<Phase5Run>).reviewStateHash;
  const finalized = FINALIZED_RUN_STATUSES.has(run.status);
  const common =
    run.schemaVersion === 1 &&
    run.id === run.contract.runId &&
    Number.isInteger(run.revision) &&
    run.revision >= 0 &&
    Number.isInteger(run.caseCount) &&
    run.caseCount > 0 &&
    Number.isInteger(run.batchCount) &&
    run.batchCount > 0 &&
    Number.isInteger(run.completedBatches) &&
    run.completedBatches >= 0 &&
    run.completedBatches <= run.batchCount &&
    Number.isInteger(run.processedCases) &&
    run.processedCases >= 0 &&
    run.processedCases <= run.caseCount &&
    Array.isArray(run.cohortRecommendations) &&
    Array.isArray(run.evidenceSampleIds) &&
    Array.isArray(run.reviewedEvidenceIds) &&
    typeof run.invalidReason === "string" &&
    new Set(run.evidenceSampleIds).size === run.evidenceSampleIds.length &&
    new Set(run.reviewedEvidenceIds).size === run.reviewedEvidenceIds.length &&
    run.reviewedEvidenceIds.every((id) => run.evidenceSampleIds.includes(id)) &&
    ["ready", "running", "paused", "complete", "auditing", "ready_for_human_review", "invalid"].includes(run.status);
  if (!common) return false;
  const recommendationIds = run.cohortRecommendations.map((item) => item?.rowId);
  const recommendationIdSet = new Set(recommendationIds);

  if (!finalized) {
    return (
      run.assessmentSetHash === null &&
      reviewStateHash == null &&
      run.cohortRecommendations.length === 0 &&
      run.evidenceSampleIds.length === 0 &&
      run.reviewedEvidenceIds.length === 0 &&
      run.invalidReason === ""
    );
  }

  if (
    !isSha256(run.assessmentSetHash) ||
    !isSha256(reviewStateHash) ||
    run.cohortRecommendations.length !== run.caseCount ||
    recommendationIdSet.size !== run.caseCount ||
    run.evidenceSampleIds.some((id) => !recommendationIdSet.has(id)) ||
    run.cohortRecommendations.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.rowId !== "string" ||
        !item.rowId ||
        !["progressed", "not_progressed", "ineligible", "human_review"].includes(
          item.recommendation,
        ) ||
        typeof item.reason !== "string" ||
        (item.rank !== null && (!Number.isInteger(item.rank) || item.rank < 1)) ||
        (item.weightedScore !== null &&
          (typeof item.weightedScore !== "number" || !Number.isFinite(item.weightedScore))),
    )
  ) {
    return false;
  }
  if (run.status === "auditing") {
    return (
      run.invalidReason === "" &&
      run.evidenceSampleIds.length > 0 &&
      run.reviewedEvidenceIds.length < run.evidenceSampleIds.length
    );
  }
  if (run.status === "ready_for_human_review") {
    return (
      run.invalidReason === "" &&
      run.reviewedEvidenceIds.length === run.evidenceSampleIds.length
    );
  }
  return run.status === "invalid" && run.invalidReason.trim().length > 0;
}

async function runReviewStateIsValid(run: Phase5Run) {
  if (!runIsCoherent(run)) return false;
  if (!FINALIZED_RUN_STATUSES.has(run.status)) return true;
  return (await createReviewStateHash(run)) === run.reviewStateHash;
}

export async function createPhase5Run(args: {
  datasetId: string;
  contract: Phase5RunContract;
  batches: Array<Pick<Phase5Batch, "batchId" | "batchIndex" | "rowIds" | "batchInputHash">>;
}) {
  if (!args.datasetId || args.batches.length === 0) throw new Error("The assessment run is incomplete.");
  if (args.contract.assessmentProtocolHash !== (await getPhase4AssessmentProtocolHash())) {
    throw new Error("The assessment prompt or schema changed after safeguards were locked.");
  }
  if ((await createPhase4InputFingerprint(contractCore(args.contract))) !== args.contract.contractHash) {
    throw new Error("The assessment contract did not pass its integrity check.");
  }
  const rowIds = args.batches.flatMap((batch) => batch.rowIds);
  if (
    rowIds.length !== args.contract.datasetRowCount ||
    new Set(rowIds).size !== rowIds.length ||
    new Set(args.batches.map((batch) => batch.batchId)).size !== args.batches.length
  ) {
    throw new Error("The fixed batches do not account for every application exactly once.");
  }
  const now = new Date().toISOString();
  const run: Phase5Run = {
    id: args.contract.runId,
    schemaVersion: 1,
    revision: 0,
    datasetId: args.datasetId,
    status: "ready",
    contract: args.contract,
    caseCount: rowIds.length,
    batchCount: args.batches.length,
    completedBatches: 0,
    processedCases: 0,
    assessmentSetHash: null,
    reviewStateHash: null,
    cohortRecommendations: [],
    evidenceSampleIds: [],
    reviewedEvidenceIds: [],
    invalidReason: "",
    createdAt: now,
    updatedAt: now,
  };
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE5_RUNS_STORE, PHASE5_BATCHES_STORE],
      "readwrite",
    );
    const runs = transaction.objectStore(PHASE5_RUNS_STORE);
    const existing = await requestResult(runs.get(run.id) as IDBRequest<Phase5Run | undefined>);
    if (existing) {
      transaction.abort();
      throw new Error("This assessment run already exists.");
    }
    runs.add(run);
    const batchStore = transaction.objectStore(PHASE5_BATCHES_STORE);
    args.batches.forEach((batch) => {
      batchStore.add({
        ...batch,
        runId: run.id,
        status: "pending",
        attempts: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: "",
        completedAt: null,
      } satisfies Phase5Batch);
    });
    await transactionComplete(transaction);
    return run;
  } finally {
    database.close();
  }
}

export async function loadPhase5Run(runId: string) {
  const database = await openDatabase();
  try {
    const run = await requestResult(
      database
        .transaction(PHASE5_RUNS_STORE, "readonly")
        .objectStore(PHASE5_RUNS_STORE)
        .get(runId) as IDBRequest<Phase5Run | undefined>,
    );
    if (!run || !(await runReviewStateIsValid(run))) return null;
    if ((await createPhase4InputFingerprint(contractCore(run.contract))) !== run.contract.contractHash) {
      return null;
    }
    return run;
  } finally {
    database.close();
  }
}

export async function loadLatestPhase5Run(datasetId: string) {
  const database = await openDatabase();
  try {
    const runs = await requestResult(
      database
        .transaction(PHASE5_RUNS_STORE, "readonly")
        .objectStore(PHASE5_RUNS_STORE)
        .index("datasetId")
        .getAll(IDBKeyRange.only(datasetId)) as IDBRequest<Phase5Run[]>,
    );
    const latest = runs.sort((a, b) =>
      String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")),
    )[0];
    if (!latest) return null;
    if (!(await runReviewStateIsValid(latest))) {
      throw new Error("The latest assessment run did not pass its integrity check.");
    }
    if (
      (await createPhase4InputFingerprint(contractCore(latest.contract))) !==
      latest.contract.contractHash
    ) {
      throw new Error("The latest assessment contract did not pass its integrity check.");
    }
    return latest;
  } finally {
    database.close();
  }
}

export async function loadPhase5Results(runId: string) {
  const database = await openDatabase();
  try {
    return await requestResult(
      database
        .transaction(PHASE5_RESULTS_STORE, "readonly")
        .objectStore(PHASE5_RESULTS_STORE)
        .index("runId")
        .getAll(IDBKeyRange.only(runId)) as IDBRequest<Phase5StoredAssessment[]>,
    );
  } finally {
    database.close();
  }
}

export async function phase5AssessmentSetIsValid(
  run: Phase5Run,
  assessments: readonly Phase5StoredAssessment[],
) {
  if (!(await runReviewStateIsValid(run))) return false;
  if (!run.assessmentSetHash) {
    return (
      run.status === "ready" ||
      run.status === "running" ||
      run.status === "paused" ||
      run.status === "complete"
    );
  }
  if (
    assessments.length !== run.caseCount ||
    new Set(assessments.map((assessment) => assessment.rowId)).size !== run.caseCount ||
    assessments.some((assessment) => assessment.runId !== run.id)
  ) {
    return false;
  }
  const sorted = [...assessments].sort((a, b) => a.rowId.localeCompare(b.rowId));
  return (await contentHash(sorted)) === run.assessmentSetHash;
}

export async function loadPhase5Batches(runId: string) {
  const database = await openDatabase();
  try {
    const batches = await requestResult(
      database
        .transaction(PHASE5_BATCHES_STORE, "readonly")
        .objectStore(PHASE5_BATCHES_STORE)
        .index("runId")
        .getAll(IDBKeyRange.only(runId)) as IDBRequest<Phase5Batch[]>,
    );
    return batches.sort((a, b) => a.batchIndex - b.batchIndex);
  } finally {
    database.close();
  }
}

export async function claimNextPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  leaseToken: string;
  leaseMilliseconds?: number;
}) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE5_RUNS_STORE, PHASE5_BATCHES_STORE],
      "readwrite",
    );
    const runs = transaction.objectStore(PHASE5_RUNS_STORE);
    const batchesStore = transaction.objectStore(PHASE5_BATCHES_STORE);
    const run = await requestResult(runs.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    if (!run || !runIsCoherent(run) || run.revision !== args.expectedRevision) {
      transaction.abort();
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    if (["auditing", "ready_for_human_review", "invalid"].includes(run.status)) {
      transaction.abort();
      return null;
    }
    const batches = await requestResult(
      batchesStore.index("runId").getAll(IDBKeyRange.only(args.runId)) as IDBRequest<Phase5Batch[]>,
    );
    const now = new Date();
    const available = batches
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .find(
        (batch) =>
          batch.status === "pending" ||
          batch.status === "failed" ||
          (batch.status === "in_flight" &&
            Boolean(batch.leaseExpiresAt) &&
            new Date(batch.leaseExpiresAt as string).getTime() <= now.getTime()),
      );
    if (!available) {
      transaction.abort();
      return null;
    }
    const claimed: Phase5Batch = {
      ...available,
      status: "in_flight",
      attempts: available.attempts + 1,
      leaseToken: args.leaseToken,
      leaseExpiresAt: new Date(now.getTime() + (args.leaseMilliseconds ?? 5 * 60_000)).toISOString(),
      lastError: "",
    };
    batchesStore.put(claimed);
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: "running",
      updatedAt: now.toISOString(),
    };
    runs.put(updated);
    await transactionComplete(transaction);
    return { run: updated, batch: claimed };
  } finally {
    database.close();
  }
}

export async function commitPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  assessments: Phase5StoredAssessment[];
}) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE5_RUNS_STORE, PHASE5_BATCHES_STORE, PHASE5_RESULTS_STORE],
      "readwrite",
    );
    const runs = transaction.objectStore(PHASE5_RUNS_STORE);
    const batches = transaction.objectStore(PHASE5_BATCHES_STORE);
    const results = transaction.objectStore(PHASE5_RESULTS_STORE);
    const run = await requestResult(runs.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    const batch = await requestResult(
      batches.get([args.runId, args.batchId]) as IDBRequest<Phase5Batch | undefined>,
    );
    if (
      !run ||
      !batch ||
      run.revision !== args.expectedRevision ||
      batch.status !== "in_flight" ||
      batch.leaseToken !== args.leaseToken
    ) {
      transaction.abort();
      throw new Error("This batch changed in another tab. Its results were not overwritten.");
    }
    const incomingIds = args.assessments.map((assessment) => assessment.rowId).sort();
    const expectedIds = [...batch.rowIds].sort();
    if (
      incomingIds.length !== expectedIds.length ||
      new Set(incomingIds).size !== incomingIds.length ||
      incomingIds.some((rowId, index) => rowId !== expectedIds[index]) ||
      args.assessments.some((assessment) => assessment.runId !== run.id)
    ) {
      transaction.abort();
      throw new Error("The AI batch does not account for the fixed applications exactly once.");
    }
    const existing = await Promise.all(
      incomingIds.map((rowId) =>
        requestResult(results.get([run.id, rowId]) as IDBRequest<Phase5StoredAssessment | undefined>),
      ),
    );
    if (existing.some(Boolean)) {
      transaction.abort();
      throw new Error("Completed assessment results are immutable and cannot be replaced.");
    }
    args.assessments.forEach((assessment) => results.add(assessment));
    const now = new Date().toISOString();
    batches.put({
      ...batch,
      status: "complete",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: "",
      completedAt: now,
    } satisfies Phase5Batch);
    const processedCases = run.processedCases + args.assessments.length;
    const completedBatches = run.completedBatches + 1;
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: processedCases === run.caseCount ? "complete" : "running",
      processedCases,
      completedBatches,
      updatedAt: now,
    };
    if (processedCases > run.caseCount || completedBatches > run.batchCount) {
      transaction.abort();
      throw new Error("The assessment run exceeded its fixed case count.");
    }
    runs.put(updated);
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function failPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  message: string;
}) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE5_RUNS_STORE, PHASE5_BATCHES_STORE],
      "readwrite",
    );
    const runs = transaction.objectStore(PHASE5_RUNS_STORE);
    const batches = transaction.objectStore(PHASE5_BATCHES_STORE);
    const run = await requestResult(runs.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    const batch = await requestResult(
      batches.get([args.runId, args.batchId]) as IDBRequest<Phase5Batch | undefined>,
    );
    if (
      !run ||
      !batch ||
      run.revision !== args.expectedRevision ||
      batch.status !== "in_flight" ||
      batch.leaseToken !== args.leaseToken
    ) {
      transaction.abort();
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    const message = args.message.trim().slice(0, 500) || "The AI batch stopped safely.";
    batches.put({
      ...batch,
      status: "failed",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: message,
    } satisfies Phase5Batch);
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: "paused",
      updatedAt: new Date().toISOString(),
    };
    runs.put(updated);
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function pausePhase5Run(runId: string, expectedRevision: number) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PHASE5_RUNS_STORE, "readwrite");
    const store = transaction.objectStore(PHASE5_RUNS_STORE);
    const run = await requestResult(store.get(runId) as IDBRequest<Phase5Run | undefined>);
    if (!run || run.revision !== expectedRevision) {
      transaction.abort();
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: run.status === "complete" ? "complete" : "paused",
      updatedAt: new Date().toISOString(),
    };
    store.put(updated);
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function finalizePhase5Run(args: {
  runId: string;
  expectedRevision: number;
  recommendations: Phase5CohortRecommendation[];
  evidenceSampleIds: string[];
}) {
  const preloadedAssessments = (await loadPhase5Results(args.runId)).sort((a, b) =>
    a.rowId.localeCompare(b.rowId),
  );
  const assessmentSetHash = await contentHash(preloadedAssessments);
  const cohortRecommendations = args.recommendations
    .map((item) => ({ ...item }))
    .sort((a, b) => a.rowId.localeCompare(b.rowId));
  const evidenceSampleIds = [...new Set(args.evidenceSampleIds)].sort();
  const finalizedStatus: Phase5Run["status"] = evidenceSampleIds.length
    ? "auditing"
    : "ready_for_human_review";
  const finalizedReviewState: Phase5ReviewState = {
    status: finalizedStatus,
    assessmentSetHash,
    cohortRecommendations,
    evidenceSampleIds,
    reviewedEvidenceIds: [],
    invalidReason: "",
  };
  const reviewStateHash = await createReviewStateHash(finalizedReviewState);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE5_RUNS_STORE, PHASE5_RESULTS_STORE],
      "readwrite",
    );
    const store = transaction.objectStore(PHASE5_RUNS_STORE);
    const run = await requestResult(store.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    if (
      !run ||
      !runIsCoherent(run) ||
      run.revision !== args.expectedRevision ||
      run.status !== "complete" ||
      run.processedCases !== run.caseCount
    ) {
      transaction.abort();
      throw new Error("Every fixed application must be safely assessed before cohort results are prepared.");
    }
    const assessments = await requestResult(
      transaction
        .objectStore(PHASE5_RESULTS_STORE)
        .index("runId")
        .getAll(IDBKeyRange.only(run.id)) as IDBRequest<Phase5StoredAssessment[]>,
    );
    assessments.sort((a, b) => a.rowId.localeCompare(b.rowId));
    if (stableStringify(assessments) !== stableStringify(preloadedAssessments)) {
      transaction.abort();
      throw new Error("Assessment results changed while the cohort was being prepared.");
    }
    const assessmentIds = assessments.map((assessment) => assessment.rowId).sort();
    const recommendationIds = cohortRecommendations.map((item) => item.rowId).sort();
    if (
      assessmentIds.length !== run.caseCount ||
      recommendationIds.length !== run.caseCount ||
      assessmentIds.some((rowId, index) => rowId !== recommendationIds[index])
    ) {
      transaction.abort();
      throw new Error("The cohort result does not account for every fixed application.");
    }
    if (evidenceSampleIds.some((rowId) => !assessmentIds.includes(rowId))) {
      transaction.abort();
      throw new Error("The evidence sample contains an unknown application.");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: finalizedStatus,
      assessmentSetHash,
      reviewStateHash,
      cohortRecommendations,
      evidenceSampleIds,
      reviewedEvidenceIds: [],
      invalidReason: "",
      updatedAt: new Date().toISOString(),
    };
    if (!runIsCoherent(updated)) {
      transaction.abort();
      throw new Error("The cohort review state is incomplete or invalid.");
    }
    store.put(updated);
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function confirmPhase5Evidence(args: {
  runId: string;
  expectedRevision: number;
  rowId: string;
}) {
  const preloaded = await loadPhase5Run(args.runId);
  if (
    !preloaded ||
    preloaded.revision !== args.expectedRevision ||
    preloaded.status !== "auditing" ||
    !preloaded.evidenceSampleIds.includes(args.rowId) ||
    preloaded.reviewedEvidenceIds.includes(args.rowId)
  ) {
    throw new Error("This evidence check is not part of the fixed audit sample.");
  }
  const reviewedEvidenceIds = [
    ...new Set([...preloaded.reviewedEvidenceIds, args.rowId]),
  ].sort();
  const status: Phase5Run["status"] =
    reviewedEvidenceIds.length === preloaded.evidenceSampleIds.length
      ? "ready_for_human_review"
      : "auditing";
  const reviewStateHash = await createReviewStateHash({
    ...reviewStateCore(preloaded),
    status,
    reviewedEvidenceIds,
  });
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PHASE5_RUNS_STORE, "readwrite");
    const store = transaction.objectStore(PHASE5_RUNS_STORE);
    const run = await requestResult(store.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    if (
      !run ||
      run.revision !== args.expectedRevision ||
      stableStringify(run) !== stableStringify(preloaded)
    ) {
      transaction.abort();
      throw new Error("This evidence check is not part of the fixed audit sample.");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status,
      reviewedEvidenceIds,
      reviewStateHash,
      updatedAt: new Date().toISOString(),
    };
    if (!runIsCoherent(updated)) {
      transaction.abort();
      throw new Error("This evidence check could not be integrity-bound.");
    }
    store.put(updated);
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function invalidatePhase5Run(args: {
  runId: string;
  expectedRevision: number;
  reason: string;
}) {
  const reason = args.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Record why the evidence check failed.");
  const preloaded = await loadPhase5Run(args.runId);
  if (
    !preloaded ||
    preloaded.revision !== args.expectedRevision ||
    preloaded.status !== "auditing"
  ) {
    throw new Error("This evidence audit changed in another tab. Reload before continuing.");
  }
  const reviewStateHash = await createReviewStateHash({
    ...reviewStateCore(preloaded),
    status: "invalid",
    invalidReason: reason,
  });
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PHASE5_RUNS_STORE, "readwrite");
    const store = transaction.objectStore(PHASE5_RUNS_STORE);
    const run = await requestResult(store.get(args.runId) as IDBRequest<Phase5Run | undefined>);
    if (
      !run ||
      run.revision !== args.expectedRevision ||
      stableStringify(run) !== stableStringify(preloaded)
    ) {
      transaction.abort();
      throw new Error("This evidence audit changed in another tab. Reload before continuing.");
    }
    const updated: Phase5Run = {
      ...run,
      revision: run.revision + 1,
      status: "invalid",
      invalidReason: reason,
      reviewStateHash,
      updatedAt: new Date().toISOString(),
    };
    if (!runIsCoherent(updated)) {
      transaction.abort();
      throw new Error("This invalidation could not be integrity-bound.");
    }
    store.put(updated);
    await transactionComplete(transaction);
    // A failed human audit earns one recalibration credit so the organiser can
    // rerun the practice test on the same historical file. Non-fatal: the
    // invalidation above is already durable.
    try {
      await grantPhase4RecalibrationCredit(updated.contract.phase4SessionId);
    } catch {
      // The credit can be granted later by support; never mask the audit result.
    }
    return updated;
  } finally {
    database.close();
  }
}
