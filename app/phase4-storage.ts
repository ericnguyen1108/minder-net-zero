import {
  PHASE4_CONSUMED_STORE,
  PHASE4_STORE,
  SEALED_STORE,
  loadHistoricalDatasetBinding,
  openDatabase,
} from "./historical-data.ts";
import type {
  CanonicalOutcome,
  HistoricalDatasetBinding,
  StoredHistoricalRow,
} from "./historical-data.ts";
import { practiceMetricsMatchLockedInputs } from "./phase4-logic.ts";
import type { PracticeMetrics } from "./phase4-logic.ts";

type Phase4ConsumedFingerprint = {
  datasetFingerprint: string;
  sessionId: string;
  revealedAt: string;
};

export const PHASE4_PROMPT_VERSION = "phase4-calibration-v1";
export const PHASE4_SCHEMA_VERSION = "phase4-output-v1";

export type EvidenceReference = {
  rowId?: string;
  answerIndex: number;
  quote: string;
};

export type PatternDecision = "pending" | "approved" | "rejected";

export type Phase4Pattern = {
  id: string;
  patternKey: string;
  kind:
    | "criterion_anchor_example"
    | "eligibility_example"
    | "elimination_example"
    | "ambiguity"
    | "historical_conflict"
    | "possible_policy_gap";
  targetRuleId: string;
  title: string;
  proposedInterpretation: string;
  evidence: EvidenceReference[];
  supportingRowIds: string[];
  contradictingRowIds: string[];
  risk: "guide_aligned" | "possible_bias" | "inconsistent_history" | "conflicts_with_guide";
  decision: PatternDecision;
  rejectionReason: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

export type PracticeAcceptancePolicy = {
  evaluationMode: "binary_alignment" | "ranking_alignment";
  minimumHistoricalAlignment: number;
  minimumProgressedCapture: number;
  maximumHumanReviewRate: number;
  waitlistPolicy: "exclude" | "not_progressed";
  tieBreakPriority: string[];
  lockedAt: string;
  lockedBy: string;
};

export type RuleFinding = {
  ruleId: string;
  status: "pass" | "fail" | "triggered" | "not_triggered" | "unclear";
  evidence: EvidenceReference[];
};

export type CriterionFinding = {
  criterionId: string;
  score: 1 | 2 | 3 | 4 | 5 | null;
  evidence: EvidenceReference[];
};

export type StoredBlindAssessment = {
  rowId: string;
  eligibility: RuleFinding[];
  elimination: RuleFinding[];
  criteria: CriterionFinding[];
  weightedScore: number | null;
  recommendation: "progressed" | "not_progressed" | "ineligible" | "rank_only" | "human_review";
  evidenceValid: boolean;
  humanReviewReasons: string[];
};

export type Phase4Session = {
  id: string;
  schemaVersion: 1;
  revision: number;
  datasetId: string;
  datasetFingerprint: string;
  datasetIntegrityHash: string;
  guideVersion: number;
  guideContentHash: string;
  teachingRows: number;
  sealedRows: number;
  promptVersion: typeof PHASE4_PROMPT_VERSION;
  outputSchemaVersion: typeof PHASE4_SCHEMA_VERSION;
  modelId: string | null;
  assessmentProtocolHash: string | null;
  patternStatus: "not_started" | "generating" | "reviewing" | "approved";
  patternProcessedRows: number;
  patternProgress: number;
  patterns: Phase4Pattern[];
  patternLimitations: string[];
  teachingApprovedAt: string | null;
  teachingApprovedBy: string | null;
  practiceStatus:
    | "not_started"
    | "policy_locked"
    | "running"
    | "predictions_committed"
    | "revealed"
    | "passed"
    | "failed";
  acceptancePolicy: PracticeAcceptancePolicy | null;
  assessments: StoredBlindAssessment[];
  predictionHash: string | null;
  outcomes: Array<{ rowId: string; outcome: CanonicalOutcome }> | null;
  metrics: PracticeMetrics | null;
  metricsHash: string | null;
  evidenceReviewSampleIds: string[];
  evidenceReviewRowIds: string[];
  revealedAt: string | null;
  finalDecisionAt: string | null;
  finalDecisionBy: string | null;
  updatedAt: string;
};

export function selectEvidenceReviewSampleIds(
  assessments: readonly StoredBlindAssessment[],
  maximum = 10,
) {
  return assessments
    .filter((assessment) =>
      [...assessment.eligibility, ...assessment.elimination, ...assessment.criteria].some(
        (finding) => finding.evidence.length > 0,
      ),
    )
    .map((assessment) => assessment.rowId)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximum);
}

export type Phase4Summary = {
  status: "empty" | "teaching_approved" | "practice_passed" | "practice_failed" | "invalid";
  datasetId: string | null;
  datasetFingerprint: string | null;
  guideVersion: number | null;
  teachingApprovedAt: string | null;
  practiceDecidedAt: string | null;
};

export const EMPTY_PHASE4_SUMMARY: Phase4Summary = {
  status: "empty",
  datasetId: null,
  datasetFingerprint: null,
  guideVersion: null,
  teachingApprovedAt: null,
  practiceDecidedAt: null,
};

const PATTERN_RISK_ORDER: Record<Phase4Pattern["risk"], number> = {
  guide_aligned: 0,
  possible_bias: 1,
  inconsistent_history: 2,
  conflicts_with_guide: 3,
};

export function mergePhase4Patterns(
  current: Phase4Pattern[],
  incoming: Phase4Pattern[],
  maximum = 20,
) {
  const merged = new Map(current.map((pattern) => [pattern.id, pattern]));
  incoming.forEach((pattern) => {
    const previous = merged.get(pattern.id);
    if (!previous) {
      const contradictingRowIds = [...new Set(pattern.contradictingRowIds)];
      const contradictions = new Set(contradictingRowIds);
      const rawSupportingRowIds = [...new Set(pattern.supportingRowIds)];
      const supportingRowIds = rawSupportingRowIds.filter(
        (rowId) => !contradictions.has(rowId),
      );
      const hasConflict =
        contradictingRowIds.length > 0 || supportingRowIds.length < rawSupportingRowIds.length;
      merged.set(pattern.id, {
        ...pattern,
        risk:
          hasConflict && PATTERN_RISK_ORDER[pattern.risk] < PATTERN_RISK_ORDER.inconsistent_history
            ? "inconsistent_history"
            : pattern.risk,
        supportingRowIds,
        contradictingRowIds,
      });
      return;
    }
    const evidenceKey = (item: Phase4Pattern["evidence"][number]) =>
      `${item.rowId}:${item.answerIndex}:${item.quote}`;
    const evidence = new Map(previous.evidence.map((item) => [evidenceKey(item), item]));
    pattern.evidence.forEach((item) => evidence.set(evidenceKey(item), item));
    const contradictingRowIds = [
      ...new Set([...previous.contradictingRowIds, ...pattern.contradictingRowIds]),
    ];
    const contradictions = new Set(contradictingRowIds);
    const supportingRowIds = [
      ...new Set([...previous.supportingRowIds, ...pattern.supportingRowIds]),
    ].filter((rowId) => !contradictions.has(rowId));
    const overlapFound =
      supportingRowIds.length <
      new Set([...previous.supportingRowIds, ...pattern.supportingRowIds]).size;
    let risk =
      PATTERN_RISK_ORDER[pattern.risk] > PATTERN_RISK_ORDER[previous.risk]
        ? pattern.risk
        : previous.risk;
    if (overlapFound && PATTERN_RISK_ORDER[risk] < PATTERN_RISK_ORDER.inconsistent_history) {
      risk = "inconsistent_history";
    }
    merged.set(pattern.id, {
      ...previous,
      risk,
      evidence: [...evidence.values()].slice(0, 4),
      supportingRowIds,
      contradictingRowIds,
    });
  });
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.supportingRowIds.length - a.supportingRowIds.length || a.title.localeCompare(b.title),
    )
    .slice(0, maximum);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function sanitizePhase4Summary(value: unknown): Phase4Summary {
  if (!value || typeof value !== "object") return { ...EMPTY_PHASE4_SUMMARY };
  const source = value as Partial<Phase4Summary>;
  const status =
    source.status === "teaching_approved" ||
    source.status === "practice_passed" ||
    source.status === "practice_failed" ||
    source.status === "invalid"
      ? source.status
      : "empty";
  const guideVersion = Number(source.guideVersion);
  return {
    status,
    datasetId: cleanString(source.datasetId) || null,
    datasetFingerprint: cleanString(source.datasetFingerprint) || null,
    guideVersion: Number.isInteger(guideVersion) && guideVersion > 0 ? guideVersion : null,
    teachingApprovedAt: cleanString(source.teachingApprovedAt) || null,
    practiceDecidedAt: cleanString(source.practiceDecidedAt) || null,
  };
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Private browser storage failed."));
  });
}

export function phase4SessionId(datasetId: string, guideVersion: number) {
  return `phase4:${datasetId}:guide-${guideVersion}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function contentHash(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser hashing is unavailable.");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionMatchesBinding(session: Phase4Session, binding: HistoricalDatasetBinding) {
  return (
    session.datasetId === binding.datasetId &&
    session.datasetFingerprint === binding.datasetFingerprint &&
    session.datasetIntegrityHash === binding.integrityHash &&
    session.guideVersion === binding.guideVersion &&
    session.teachingRows === binding.teachingRows &&
    session.sealedRows === binding.sealedRows
  );
}

function sessionIsCoherent(session: Phase4Session) {
  if (
    !Array.isArray(session.patterns) ||
    !Array.isArray(session.patternLimitations) ||
    !Array.isArray(session.assessments) ||
    !Array.isArray(session.evidenceReviewSampleIds) ||
    !Array.isArray(session.evidenceReviewRowIds) ||
    session.id !== phase4SessionId(session.datasetId, session.guideVersion) ||
    session.schemaVersion !== 1 ||
    !Number.isInteger(session.revision) ||
    session.revision < 0 ||
    session.promptVersion !== PHASE4_PROMPT_VERSION ||
    session.outputSchemaVersion !== PHASE4_SCHEMA_VERSION ||
    (session.assessmentProtocolHash !== null &&
      !/^[a-f0-9]{64}$/.test(session.assessmentProtocolHash)) ||
    !session.guideContentHash ||
    !Number.isInteger(session.patternProcessedRows) ||
    session.patternProcessedRows < 0 ||
    session.patternProcessedRows > session.teachingRows ||
    !Number.isInteger(session.patternProgress) ||
    session.patternProgress < 0 ||
    session.patternProgress > 100 ||
    !["not_started", "generating", "reviewing", "approved"].includes(
      session.patternStatus,
    ) ||
    ![
      "not_started",
      "policy_locked",
      "running",
      "predictions_committed",
      "revealed",
      "passed",
      "failed",
    ].includes(session.practiceStatus) ||
    session.patternLimitations.some(
      (limitation) => typeof limitation !== "string" || !limitation.trim(),
    ) ||
    new Set(session.patterns.map((pattern) => pattern.id)).size !== session.patterns.length ||
    new Set(session.assessments.map((assessment) => assessment.rowId)).size !==
      session.assessments.length ||
    session.assessments.length > session.sealedRows ||
    new Set(session.evidenceReviewSampleIds).size !== session.evidenceReviewSampleIds.length ||
    new Set(session.evidenceReviewRowIds).size !== session.evidenceReviewRowIds.length ||
    session.evidenceReviewRowIds.some(
      (rowId) => !session.evidenceReviewSampleIds.includes(rowId),
    )
  ) {
    return false;
  }
  if (
    session.patternStatus === "approved" &&
    (!session.teachingApprovedAt ||
      !session.teachingApprovedBy ||
      !session.modelId ||
      session.patternProcessedRows !== session.teachingRows ||
      session.patternProgress !== 100 ||
      session.patterns.some((pattern) => pattern.decision === "pending") ||
      session.patterns.some(
        (pattern) =>
          pattern.decision === "approved" &&
          (pattern.risk !== "guide_aligned" ||
            pattern.supportingRowIds.length === 0 ||
            pattern.contradictingRowIds.length !== 0 ||
            (pattern.kind !== "criterion_anchor_example" &&
              pattern.kind !== "eligibility_example" &&
              pattern.kind !== "elimination_example")),
      ))
  ) {
    return false;
  }
  const practiceStarted = session.practiceStatus !== "not_started";
  const policy = session.acceptancePolicy;
  const policyValid =
    policy !== null &&
    (policy.evaluationMode === "binary_alignment" ||
      policy.evaluationMode === "ranking_alignment") &&
    Number.isInteger(policy.minimumHistoricalAlignment) &&
    policy.minimumHistoricalAlignment >= 0 &&
    policy.minimumHistoricalAlignment <= 100 &&
    policy.minimumProgressedCapture === 100 &&
    Number.isInteger(policy.maximumHumanReviewRate) &&
    policy.maximumHumanReviewRate >= 0 &&
    policy.maximumHumanReviewRate <= 100 &&
    (policy.waitlistPolicy === "exclude" || policy.waitlistPolicy === "not_progressed") &&
    Array.isArray(policy.tieBreakPriority) &&
    policy.tieBreakPriority.every(
      (ruleId) => typeof ruleId === "string" && ruleId.trim().length > 0,
    ) &&
    new Set(policy.tieBreakPriority).size === policy.tieBreakPriority.length &&
    Boolean(policy.lockedAt) &&
    Boolean(policy.lockedBy);
  if (
    practiceStarted &&
    (session.patternStatus !== "approved" || !policyValid)
  ) {
    return false;
  }
  if (
    session.practiceStatus === "not_started" &&
    (session.acceptancePolicy !== null ||
      session.assessments.length !== 0 ||
      session.assessmentProtocolHash !== null ||
      session.predictionHash !== null ||
      session.outcomes !== null ||
      session.metrics !== null ||
      session.metricsHash !== null ||
      session.evidenceReviewSampleIds.length !== 0 ||
      session.evidenceReviewRowIds.length !== 0 ||
      session.revealedAt !== null ||
      session.finalDecisionAt !== null ||
      session.finalDecisionBy !== null)
  ) {
    return false;
  }
  if (
    session.practiceStatus === "policy_locked" &&
    (session.assessments.length !== 0 ||
      session.assessmentProtocolHash !== null ||
      session.predictionHash !== null ||
      session.outcomes !== null ||
      session.metrics !== null ||
      session.metricsHash !== null)
  ) {
    return false;
  }
  if (
    session.practiceStatus === "running" &&
    (session.predictionHash !== null ||
      session.outcomes !== null ||
      session.metrics !== null ||
      session.metricsHash !== null)
  ) {
    return false;
  }
  if (session.assessments.length > 0 && !session.assessmentProtocolHash) return false;
  const predictionsComplete =
    session.assessments.length === session.sealedRows &&
    Boolean(session.predictionHash) &&
    Boolean(session.assessmentProtocolHash);
  if (
    (session.practiceStatus === "predictions_committed" ||
      session.practiceStatus === "revealed" ||
      session.practiceStatus === "passed" ||
      session.practiceStatus === "failed") &&
    !predictionsComplete
  ) {
    return false;
  }
  const outcomesAllowed =
    session.practiceStatus === "revealed" ||
    session.practiceStatus === "passed" ||
    session.practiceStatus === "failed";
  if (
    (!outcomesAllowed && (session.outcomes !== null || session.revealedAt !== null)) ||
    (outcomesAllowed &&
      (!session.outcomes ||
        session.outcomes.length !== session.sealedRows ||
        !session.revealedAt ||
        new Set(session.outcomes.map((item) => item.rowId)).size !== session.outcomes.length))
  ) {
    return false;
  }
  if (
    (session.practiceStatus === "passed" || session.practiceStatus === "failed") &&
    (!session.metrics ||
      !session.metricsHash ||
      !session.finalDecisionAt ||
      !session.finalDecisionBy)
  ) {
    return false;
  }
  if ((session.metrics === null) !== (session.metricsHash === null)) return false;
  if (
    session.metrics &&
    (!metricsAreCoherent(session.metrics, session.sealedRows) ||
      !metricsMatchLockedInputs(session))
  ) {
    return false;
  }
  const expectedEvidenceSample = selectEvidenceReviewSampleIds(session.assessments);
  if (
    session.metrics && !sameValue(session.evidenceReviewSampleIds, expectedEvidenceSample)
  ) {
    return false;
  }
  if (
    !session.metrics &&
    (session.evidenceReviewSampleIds.length !== 0 || session.evidenceReviewRowIds.length !== 0)
  ) {
    return false;
  }
  if (
    session.practiceStatus === "passed" &&
    (!policy ||
      !session.metrics ||
      !metricsPassPolicy(session.metrics, policy) ||
      session.evidenceReviewSampleIds.length === 0 ||
      session.evidenceReviewRowIds.length !== session.evidenceReviewSampleIds.length)
  ) {
    return false;
  }
  return true;
}

function metricRateIsCoherent(metric: PracticeMetrics["agreement"]) {
  if (
    typeof metric !== "object" ||
    !Number.isFinite(metric.numerator) ||
    !Number.isInteger(metric.denominator) ||
    metric.numerator < 0 ||
    metric.denominator < 0 ||
    metric.numerator > metric.denominator
  ) {
    return false;
  }
  if (metric.denominator === 0) return metric.value === null;
  if (metric.value === null || !Number.isFinite(metric.value)) return false;
  const expected =
    Math.round(((metric.numerator / metric.denominator) * 100 + Number.EPSILON) * 100) / 100;
  return metric.value === expected;
}

function metricsAreCoherent(metrics: PracticeMetrics, sealedRows: number) {
  return (
    metrics.totalCases === sealedRows &&
    metricRateIsCoherent(metrics.agreement) &&
    metricRateIsCoherent(metrics.progressedRecall) &&
    metricRateIsCoherent(metrics.progressedSafetyCapture) &&
    metricRateIsCoherent(metrics.humanReviewRate) &&
    metricRateIsCoherent(metrics.evidenceValidRate) &&
    metricRateIsCoherent(metrics.pairwiseRankingConcordance)
  );
}

function metricsMatchLockedInputs(session: Phase4Session) {
  if (!session.metrics || !session.outcomes || !session.acceptancePolicy) return false;
  return practiceMetricsMatchLockedInputs({
    assessments: session.assessments,
    outcomes: session.outcomes,
    policy: session.acceptancePolicy,
    metrics: session.metrics,
  });
}

function metricsPassPolicy(metrics: PracticeMetrics, policy: PracticeAcceptancePolicy) {
  const alignment =
    policy.evaluationMode === "ranking_alignment"
      ? metrics.pairwiseRankingConcordance.value
      : metrics.agreement.value;
  return (
    metrics.evidenceValidRate.value === 100 &&
    metrics.progressedSafetyCapture.value === 100 &&
    alignment !== null &&
    alignment >= policy.minimumHistoricalAlignment &&
    metrics.humanReviewRate.value !== null &&
    metrics.humanReviewRate.value <= policy.maximumHumanReviewRate
  );
}

function sameValue(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function patternCore(pattern: Phase4Pattern) {
  return Object.fromEntries(
    Object.entries(pattern).filter(
      ([key]) =>
        key !== "decision" &&
        key !== "rejectionReason" &&
        key !== "decidedAt" &&
        key !== "decidedBy",
    ),
  );
}

function sessionTransitionAllowed(current: Phase4Session, next: Phase4Session) {
  const immutableKeys: Array<keyof Phase4Session> = [
    "id",
    "schemaVersion",
    "datasetId",
    "datasetFingerprint",
    "datasetIntegrityHash",
    "guideVersion",
    "guideContentHash",
    "teachingRows",
    "sealedRows",
    "promptVersion",
    "outputSchemaVersion",
  ];
  if (
    next.revision !== current.revision ||
    immutableKeys.some((key) => !sameValue(current[key], next[key])) ||
    (current.modelId !== null && next.modelId !== current.modelId) ||
    (current.assessmentProtocolHash !== null &&
      next.assessmentProtocolHash !== current.assessmentProtocolHash)
  ) {
    return false;
  }

  const patternOrder = ["not_started", "generating", "reviewing", "approved"] as const;
  const currentPatternIndex = patternOrder.indexOf(current.patternStatus);
  const nextPatternIndex = patternOrder.indexOf(next.patternStatus);
  if (nextPatternIndex < currentPatternIndex || nextPatternIndex > currentPatternIndex + 1) {
    return false;
  }
  if (current.patternStatus === "approved") {
    if (
      !sameValue(current.patterns, next.patterns) ||
      !sameValue(current.patternLimitations, next.patternLimitations) ||
      current.teachingApprovedAt !== next.teachingApprovedAt ||
      current.teachingApprovedBy !== next.teachingApprovedBy
    ) {
      return false;
    }
  } else if (current.patternStatus === "reviewing") {
    if (
      current.patterns.length !== next.patterns.length ||
      current.patterns.some((pattern, index) => {
        const candidate = next.patterns[index];
        if (!candidate || !sameValue(patternCore(pattern), patternCore(candidate))) return true;
        if (pattern.decision !== "pending") return !sameValue(pattern, candidate);
        return candidate.decision !== "pending" &&
          candidate.decision !== "approved" &&
          candidate.decision !== "rejected";
      }) ||
      !sameValue(current.patternLimitations, next.patternLimitations)
    ) {
      return false;
    }
  }

  const practiceTransitions: Record<Phase4Session["practiceStatus"], Phase4Session["practiceStatus"][]> = {
    not_started: ["not_started", "policy_locked"],
    policy_locked: ["policy_locked", "running"],
    running: ["running", "predictions_committed"],
    predictions_committed: ["predictions_committed"],
    revealed: ["revealed", "passed", "failed"],
    passed: ["passed"],
    failed: ["failed"],
  };
  if (!practiceTransitions[current.practiceStatus].includes(next.practiceStatus)) return false;
  if (
    current.acceptancePolicy !== null &&
    !sameValue(current.acceptancePolicy, next.acceptancePolicy)
  ) {
    return false;
  }
  const nextAssessments = new Map(next.assessments.map((assessment) => [assessment.rowId, assessment]));
  if (
    current.assessments.some(
      (assessment) => !sameValue(assessment, nextAssessments.get(assessment.rowId)),
    ) ||
    (current.practiceStatus !== "running" &&
      current.assessments.length !== next.assessments.length &&
      next.practiceStatus !== "running")
  ) {
    return false;
  }
  if (
    (current.predictionHash !== null && current.predictionHash !== next.predictionHash) ||
    (current.outcomes !== null && !sameValue(current.outcomes, next.outcomes)) ||
    (current.metrics !== null && !sameValue(current.metrics, next.metrics)) ||
    (current.metricsHash !== null && current.metricsHash !== next.metricsHash) ||
    (current.revealedAt !== null && current.revealedAt !== next.revealedAt) ||
    (current.finalDecisionAt !== null && current.finalDecisionAt !== next.finalDecisionAt) ||
    (current.finalDecisionBy !== null && current.finalDecisionBy !== next.finalDecisionBy)
  ) {
    return false;
  }
  if (
    (current.metricsHash !== null &&
      !sameValue(current.evidenceReviewSampleIds, next.evidenceReviewSampleIds)) ||
    current.evidenceReviewRowIds.some(
      (rowId) => !next.evidenceReviewRowIds.includes(rowId),
    ) ||
    (next.evidenceReviewRowIds.length > current.evidenceReviewRowIds.length &&
      (current.practiceStatus !== "revealed" || next.practiceStatus !== "revealed"))
  ) {
    return false;
  }
  if (
    (current.practiceStatus === "passed" || current.practiceStatus === "failed") &&
    !sameValue(current, next)
  ) {
    return false;
  }
  return true;
}

function metricsHashPayload(session: Phase4Session) {
  return {
    assessments: session.assessments,
    outcomes: session.outcomes,
    acceptancePolicy: session.acceptancePolicy,
    metrics: session.metrics,
    evidenceReviewSampleIds: session.evidenceReviewSampleIds,
    assessmentProtocolHash: session.assessmentProtocolHash,
  };
}

function initialSessionIsPristine(session: Phase4Session) {
  return (
    session.revision === 0 &&
    session.modelId === null &&
    session.assessmentProtocolHash === null &&
    session.patternStatus === "not_started" &&
    session.patternProcessedRows === 0 &&
    session.patternProgress === 0 &&
    session.patterns.length === 0 &&
    session.patternLimitations.length === 0 &&
    session.teachingApprovedAt === null &&
    session.teachingApprovedBy === null &&
    session.practiceStatus === "not_started" &&
    session.acceptancePolicy === null &&
    session.assessments.length === 0 &&
    session.predictionHash === null &&
    session.outcomes === null &&
    session.metrics === null &&
    session.metricsHash === null &&
    session.evidenceReviewSampleIds.length === 0 &&
    session.evidenceReviewRowIds.length === 0 &&
    session.revealedAt === null &&
    session.finalDecisionAt === null &&
    session.finalDecisionBy === null
  );
}

async function derivedHashesAreValid(session: Phase4Session) {
  if (
    session.predictionHash !== null &&
    (await contentHash(session.assessments)) !== session.predictionHash
  ) {
    return false;
  }
  if (
    session.metricsHash !== null &&
    (await contentHash(metricsHashPayload(session))) !== session.metricsHash
  ) {
    return false;
  }
  return true;
}

export async function loadPhase4Session(datasetId: string, guideVersion: number) {
  const binding = await loadHistoricalDatasetBinding(datasetId);
  if (binding.guideVersion !== guideVersion) return null;
  const database = await openDatabase();
  try {
    const session = await requestResult(
      database
        .transaction(PHASE4_STORE, "readonly")
        .objectStore(PHASE4_STORE)
        .get(phase4SessionId(datasetId, guideVersion)) as IDBRequest<Phase4Session | undefined>,
    );
    if (!session) return null;
    if (
      !sessionMatchesBinding(session, binding) ||
      !sessionIsCoherent(session) ||
      !(await derivedHashesAreValid(session))
    ) {
      throw new Error("Phase 4 is locked because its historical data no longer matches.");
    }
    return session;
  } finally {
    database.close();
  }
}

export async function savePhase4Session(session: Phase4Session) {
  const binding = await loadHistoricalDatasetBinding(session.datasetId);
  if (
    !sessionMatchesBinding(session, binding) ||
    !sessionIsCoherent(session) ||
    !(await derivedHashesAreValid(session))
  ) {
    throw new Error("Phase 4 cannot save against changed historical data.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE4_STORE, PHASE4_CONSUMED_STORE],
      "readwrite",
    );
    const store = transaction.objectStore(PHASE4_STORE);
    const consumedStore = transaction.objectStore(PHASE4_CONSUMED_STORE);
    const request = store.get(session.id) as IDBRequest<Phase4Session | undefined>;
    const consumedRequest = consumedStore.get(
      session.datasetFingerprint,
    ) as IDBRequest<Phase4ConsumedFingerprint | undefined>;
    return await new Promise<Phase4Session>((resolve, reject) => {
      let settled = false;
      let currentLoaded = false;
      let consumedLoaded = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const saveWhenLoaded = () => {
        if (!currentLoaded || !consumedLoaded || settled) return;
        const current = request.result;
        const consumed = consumedRequest.result;
        if (
          consumed &&
          (!current || consumed.sessionId !== current.id)
        ) {
          transaction.abort();
          fail(new Error("This historical set has already been used for a revealed blind test."));
          return;
        }
        if (
          !consumed &&
          (session.practiceStatus === "revealed" ||
            session.practiceStatus === "passed" ||
            session.practiceStatus === "failed")
        ) {
          transaction.abort();
          fail(new Error("Historical outcomes can only be revealed through the one-use seal."));
          return;
        }
        if (
          (current && !sessionTransitionAllowed(current, session)) ||
          (!current && !initialSessionIsPristine(session))
        ) {
          transaction.abort();
          fail(new Error("Phase 4 changed in another tab or attempted an unsafe reversal."));
          return;
        }
        const saved: Phase4Session = {
          ...session,
          revision: current ? current.revision + 1 : 0,
          updatedAt: new Date().toISOString(),
        };
        store.put(saved);
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(saved);
        };
      };
      request.onsuccess = () => {
        currentLoaded = true;
        saveWhenLoaded();
      };
      consumedRequest.onsuccess = () => {
        consumedLoaded = true;
        saveWhenLoaded();
      };
      request.onerror = () =>
        fail(request.error ?? new Error("Private browser storage failed."));
      consumedRequest.onerror = () =>
        fail(consumedRequest.error ?? new Error("Private browser storage failed."));
      transaction.onabort = () =>
        fail(transaction.error ?? new Error("The Phase 4 save was cancelled."));
      transaction.onerror = () =>
        fail(transaction.error ?? new Error("Private browser storage failed."));
    });
  } finally {
    database.close();
  }
}

export async function createPhase4Session(args: {
  binding: HistoricalDatasetBinding;
  guideContentHash: string;
}): Promise<Phase4Session> {
  const now = new Date().toISOString();
  const { binding } = args;
  const database = await openDatabase();
  try {
    const consumed = await requestResult(
      database
        .transaction(PHASE4_CONSUMED_STORE, "readonly")
        .objectStore(PHASE4_CONSUMED_STORE)
        .get(binding.datasetFingerprint) as IDBRequest<
        Phase4ConsumedFingerprint | undefined
      >,
    );
    if (consumed) {
      throw new Error("This historical set has already been used for a revealed blind test.");
    }
  } finally {
    database.close();
  }
  return {
    id: phase4SessionId(binding.datasetId, binding.guideVersion),
    schemaVersion: 1,
    revision: 0,
    datasetId: binding.datasetId,
    datasetFingerprint: binding.datasetFingerprint,
    datasetIntegrityHash: binding.integrityHash,
    guideVersion: binding.guideVersion,
    guideContentHash: args.guideContentHash,
    teachingRows: binding.teachingRows,
    sealedRows: binding.sealedRows,
    promptVersion: PHASE4_PROMPT_VERSION,
    outputSchemaVersion: PHASE4_SCHEMA_VERSION,
    modelId: null,
    assessmentProtocolHash: null,
    patternStatus: "not_started",
    patternProcessedRows: 0,
    patternProgress: 0,
    patterns: [],
    patternLimitations: [],
    teachingApprovedAt: null,
    teachingApprovedBy: null,
    practiceStatus: "not_started",
    acceptancePolicy: null,
    assessments: [],
    predictionHash: null,
    outcomes: null,
    metrics: null,
    metricsHash: null,
    evidenceReviewSampleIds: [],
    evidenceReviewRowIds: [],
    revealedAt: null,
    finalDecisionAt: null,
    finalDecisionBy: null,
    updatedAt: now,
  };
}

export async function revealCommittedOutcomes(session: Phase4Session) {
  const current = await loadPhase4Session(session.datasetId, session.guideVersion);
  if (!current) throw new Error("The committed practice test could not be found.");
  if (
    current.practiceStatus === "revealed" ||
    current.practiceStatus === "passed" ||
    current.practiceStatus === "failed"
  ) {
    return current;
  }
  if (
    current.practiceStatus !== "predictions_committed" ||
    !current.predictionHash ||
    current.predictionHash !== session.predictionHash ||
    current.guideContentHash !== session.guideContentHash ||
    current.assessments.length !== current.sealedRows
  ) {
    throw new Error("All blind predictions must be committed before outcomes can be revealed.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [PHASE4_STORE, PHASE4_CONSUMED_STORE, SEALED_STORE],
      "readwrite",
    );
    const phase4Store = transaction.objectStore(PHASE4_STORE);
    const consumedStore = transaction.objectStore(PHASE4_CONSUMED_STORE);
    const sessionRequest = phase4Store.get(current.id) as IDBRequest<
      Phase4Session | undefined
    >;
    const consumedRequest = consumedStore.get(current.datasetFingerprint) as IDBRequest<
      Phase4ConsumedFingerprint | undefined
    >;
    const sealedRequest = transaction
      .objectStore(SEALED_STORE)
      .index("datasetId")
      .getAll(IDBKeyRange.only(current.datasetId)) as IDBRequest<StoredHistoricalRow[]>;

    return await new Promise<Phase4Session>((resolve, reject) => {
      let settled = false;
      let ready = 0;
      let result: Phase4Session | null = null;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const revealWhenReady = () => {
        ready += 1;
        if (ready !== 3 || settled) return;
        const persisted = sessionRequest.result;
        const consumed = consumedRequest.result;
        if (
          consumed &&
          persisted &&
          consumed.sessionId === persisted.id &&
          (persisted.practiceStatus === "revealed" ||
            persisted.practiceStatus === "passed" ||
            persisted.practiceStatus === "failed")
        ) {
          result = persisted;
          return;
        }
        if (
          consumed ||
          !persisted ||
          persisted.revision !== current.revision ||
          !sameValue(persisted, current) ||
          persisted.practiceStatus !== "predictions_committed" ||
          !persisted.predictionHash
        ) {
          transaction.abort();
          fail(new Error("The blind test changed or its outcomes were already revealed."));
          return;
        }
        const sealedRows = sealedRequest.result;
        const expectedRowIds = persisted.assessments
          .map((assessment) => assessment.rowId)
          .sort();
        const sealedRowIds = [...new Set(sealedRows.map((row) => row.rowId))].sort();
        if (
          sealedRows.length === 0 ||
          sealedRows.length !== persisted.sealedRows ||
          expectedRowIds.length !== sealedRowIds.length ||
          expectedRowIds.some((rowId, index) => rowId !== sealedRowIds[index])
        ) {
          transaction.abort();
          fail(new Error("Every sealed prediction must be committed before outcomes can be revealed."));
          return;
        }
        const revealedAt = new Date().toISOString();
        const revealed: Phase4Session = {
          ...persisted,
          practiceStatus: "revealed",
          outcomes: sealedRows
            .map((row) => ({ rowId: row.rowId, outcome: row.outcome }))
            .sort((left, right) => left.rowId.localeCompare(right.rowId)),
          revealedAt,
          revision: persisted.revision + 1,
          updatedAt: revealedAt,
        };
        if (!sessionIsCoherent(revealed)) {
          transaction.abort();
          fail(new Error("The revealed blind test did not pass its integrity checks."));
          return;
        }
        phase4Store.put(revealed);
        consumedStore.put({
          datasetFingerprint: revealed.datasetFingerprint,
          sessionId: revealed.id,
          revealedAt,
        } satisfies Phase4ConsumedFingerprint);
        result = revealed;
      };
      sessionRequest.onsuccess = revealWhenReady;
      consumedRequest.onsuccess = revealWhenReady;
      sealedRequest.onsuccess = revealWhenReady;
      sessionRequest.onerror = () =>
        fail(sessionRequest.error ?? new Error("Private browser storage failed."));
      consumedRequest.onerror = () =>
        fail(consumedRequest.error ?? new Error("Private browser storage failed."));
      sealedRequest.onerror = () =>
        fail(sealedRequest.error ?? new Error("Private browser storage failed."));
      transaction.oncomplete = () => {
        if (settled) return;
        if (!result) {
          fail(new Error("The blind outcomes were not revealed."));
          return;
        }
        settled = true;
        resolve(result);
      };
      transaction.onabort = () =>
        fail(transaction.error ?? new Error("The one-use reveal was cancelled."));
      transaction.onerror = () =>
        fail(transaction.error ?? new Error("Private browser storage failed."));
    });
  } finally {
    database.close();
  }
}

export function phase4SummaryFromSession(session: Phase4Session): Phase4Summary {
  const status =
    session.practiceStatus === "passed"
      ? "practice_passed"
      : session.practiceStatus === "failed"
        ? "practice_failed"
        : session.patternStatus === "approved"
          ? "teaching_approved"
          : "empty";
  return {
    status,
    datasetId: session.datasetId,
    datasetFingerprint: session.datasetFingerprint,
    guideVersion: session.guideVersion,
    teachingApprovedAt: session.teachingApprovedAt,
    practiceDecidedAt: session.finalDecisionAt,
  };
}
