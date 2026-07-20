import { contentHash } from "./phase4-storage.ts";
import type { Phase4Session } from "./phase4-storage.ts";
import { createPhase4InputFingerprint } from "./phase4-logic.ts";
import { getPhase4AssessmentProtocolHash } from "./phase4-protocol.ts";
import { pilot, PilotConflictError } from "./pilot-client.ts";

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

export async function createReviewStateHash(run: Phase5ReviewState) {
  return contentHash(reviewStateCore(run));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function contractCore(contract: Phase5RunContract) {
  const core: Partial<Phase5RunContract> = { ...contract };
  delete core.contractHash;
  return core as Omit<Phase5RunContract, "contractHash">;
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
  await pilot("assessment.safeguards.save", { approval });
}

export async function loadPhase5SafeguardApproval(phase4: Phase4Session) {
  const approval = await pilot<Phase5SafeguardApproval | null>(
    "assessment.safeguards.load",
    { phase4SessionId: phase4.id },
  );
    if (!approval) return null;
  return (await phase5SafeguardApprovalMatchesSession(approval, phase4)) ? approval : null;
}

export async function phase5SafeguardApprovalMatchesSession(
  approval: Phase5SafeguardApproval,
  phase4: Phase4Session,
) {
  const expectedPatternHash = await contentHash(approvedPatternSnapshot(phase4));
  const expectedProtocolHash = await getPhase4AssessmentProtocolHash();
  return (
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
      (await contentHash(approvalCore(approval))) === approval.approvalHash
  );
}

export function createPhase5RunId(datasetId: string) {
  void datasetId;
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure browser identifiers are unavailable.");
  }
  return globalThis.crypto.randomUUID();
}

export function runIsCoherent(run: Phase5Run) {
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

export async function runReviewStateIsValid(run: Phase5Run) {
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
  const batches = args.batches.map(
    (batch) =>
      ({
        ...batch,
        runId: run.id,
        status: "pending",
        attempts: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: "",
        completedAt: null,
      }) satisfies Phase5Batch,
  );
  return pilot<Phase5Run>("assessment.document.create", { run, batches });
}

export async function loadPhase5Run(runId: string) {
  const run = await pilot<Phase5Run | null>("assessment.document.load", { runId });
    if (!run || !(await runReviewStateIsValid(run))) return null;
    if ((await createPhase4InputFingerprint(contractCore(run.contract))) !== run.contract.contractHash) {
      return null;
    }
  return run;
}

export async function loadLatestPhase5Run(datasetId: string) {
  const latest = await pilot<Phase5Run | null>("assessment.document.latest", { datasetId });
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
}

export async function loadPhase5Results(runId: string) {
  // Assessment results are immutable in Postgres; this accessor can only read
  // the append-once rows accepted by a leased batch commit.
  return pilot<Phase5StoredAssessment[]>("assessment.document.results", { runId });
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
  return pilot<Phase5Batch[]>("assessment.document.batches", { runId });
}

export async function claimNextPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  leaseToken: string;
  leaseMilliseconds?: number;
}) {
  try {
    return await pilot<{ run: Phase5Run; batch: Phase5Batch } | null>(
      "assessment.document.claim",
      args,
    );
  } catch (error) {
    if (error instanceof PilotConflictError && error.code === "revision_conflict") {
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    throw error;
  }
}

export async function commitPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  assessments: Phase5StoredAssessment[];
}) {
  try {
    return await pilot<Phase5Run>("assessment.document.commit", args);
  } catch (error) {
    if (
      error instanceof PilotConflictError &&
      ["revision_conflict", "stale_lease", "unknown_batch"].includes(error.code)
    ) {
      throw new Error("This batch changed in another tab. Its results were not overwritten.");
    }
    throw error;
  }
}

export async function failPhase5Batch(args: {
  runId: string;
  expectedRevision: number;
  batchId: string;
  leaseToken: string;
  message: string;
}) {
  try {
    return await pilot<Phase5Run>("assessment.document.fail", args);
  } catch (error) {
    if (error instanceof PilotConflictError) {
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    throw error;
  }
}

export async function pausePhase5Run(runId: string, expectedRevision: number) {
  try {
    return await pilot<Phase5Run>("assessment.document.pause", { runId, expectedRevision });
  } catch (error) {
    if (error instanceof PilotConflictError) {
      throw new Error("This assessment changed in another tab. Reload before continuing.");
    }
    throw error;
  }
}

export async function finalizePhase5Run(args: {
  runId: string;
  expectedRevision: number;
  recommendations: Phase5CohortRecommendation[];
  evidenceSampleIds: string[];
}) {
  try {
    return await pilot<Phase5Run>("assessment.document.finalize", args);
  } catch (error) {
    if (error instanceof PilotConflictError) {
      throw new Error("Every fixed application must be safely assessed before cohort results are prepared.");
    }
    throw error;
  }
}

export async function confirmPhase5Evidence(args: {
  runId: string;
  expectedRevision: number;
  rowId: string;
}) {
  return pilot<Phase5Run>("assessment.document.confirmEvidence", args);
}

export async function invalidatePhase5Run(args: {
  runId: string;
  expectedRevision: number;
  reason: string;
}) {
  const reason = args.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Record why the evidence check failed.");
  try {
    return await pilot<Phase5Run>("assessment.document.invalidate", { ...args, reason });
  } catch (error) {
    if (error instanceof PilotConflictError) {
      throw new Error("This evidence audit changed in another tab. Reload before continuing.");
    }
    throw error;
  }
}
