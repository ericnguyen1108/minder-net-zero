import { loadHistoricalDatasetBinding } from "./historical-data.ts";
import type { CanonicalOutcome, HistoricalDatasetBinding } from "./historical-data.ts";
import { pilot } from "./pilot-client.ts";
import { practiceMetricsMatchLockedInputs } from "./phase4-logic.ts";
import type { PracticeMetrics } from "./phase4-logic.ts";

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
  /**
   * True when this session was created with a recalibration credit after a
   * failed Phase 5 evidence audit: the historical outcomes were revealed once
   * before, so its practice test is no longer strictly blind.
   */
  blindnessCompromised?: boolean;
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

export function phase4SessionMatchesBinding(
  session: Phase4Session,
  binding: HistoricalDatasetBinding,
) {
  return (
    session.datasetId === binding.datasetId &&
    session.datasetFingerprint === binding.datasetFingerprint &&
    session.datasetIntegrityHash === binding.integrityHash &&
    session.guideVersion === binding.guideVersion &&
    session.teachingRows === binding.teachingRows &&
    session.sealedRows === binding.sealedRows
  );
}

export function phase4SessionIsCoherent(session: Phase4Session) {
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
    // Real historical decisions are noisy: past judges sometimes disagreed
    // with their own rubric. The organiser chooses how many previously
    // progressed cases the AI must re-capture, but never below 90%.
    Number.isInteger(policy.minimumProgressedCapture) &&
    policy.minimumProgressedCapture >= 90 &&
    policy.minimumProgressedCapture <= 100 &&
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
    metrics.progressedSafetyCapture.value !== null &&
    metrics.progressedSafetyCapture.value >= policy.minimumProgressedCapture &&
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

export function phase4SessionTransitionAllowed(current: Phase4Session, next: Phase4Session) {
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

export function initialPhase4SessionIsPristine(session: Phase4Session) {
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

export async function phase4DerivedHashesAreValid(session: Phase4Session) {
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
  const session = await pilot<Phase4Session | null>("calibration.load", {
    datasetId,
    guideVersion,
  });
  if (!session) return null;
  if (
    !phase4SessionMatchesBinding(session, binding) ||
    !phase4SessionIsCoherent(session) ||
    !(await phase4DerivedHashesAreValid(session))
  ) {
    throw new Error("Phase 4 is locked because its historical data no longer matches.");
  }
  return session;
}

export async function savePhase4Session(session: Phase4Session) {
  const binding = await loadHistoricalDatasetBinding(session.datasetId);
  if (
    !phase4SessionMatchesBinding(session, binding) ||
    !phase4SessionIsCoherent(session) ||
    !(await phase4DerivedHashesAreValid(session))
  ) {
    throw new Error("Phase 4 cannot save against changed historical data.");
  }
  const current = await pilot<Phase4Session | null>("calibration.load", {
    datasetId: session.datasetId,
    guideVersion: session.guideVersion,
  });
  if (
    (current && !phase4SessionTransitionAllowed(current, session)) ||
    (!current && !initialPhase4SessionIsPristine(session))
  ) {
    throw new Error("Phase 4 changed in another tab or attempted an unsafe reversal.");
  }
  const saved = await pilot<Phase4Session>("calibration.save", { session });
  if (
    !phase4SessionMatchesBinding(saved, binding) ||
    !phase4SessionIsCoherent(saved) ||
    !(await phase4DerivedHashesAreValid(saved))
  ) {
    throw new Error("The server returned an invalid Phase 4 session.");
  }
  return saved;
}

export async function createPhase4Session(args: {
  binding: HistoricalDatasetBinding;
  guideContentHash: string;
}): Promise<Phase4Session> {
  const now = new Date().toISOString();
  const { binding } = args;
  const consumed = await pilot<{ consumed: boolean; headroom: number }>(
    "calibration.consumed",
    { datasetFingerprint: binding.datasetFingerprint },
  );
  if (consumed.consumed) {
    throw new Error("This historical set has already been used for a revealed blind test.");
  }
  return buildPristinePhase4Session(binding, args.guideContentHash, now, false);
}

/**
 * Builds a fresh, pristine session for a dataset. `blindnessCompromised` marks
 * a recalibration retry whose historical outcomes were revealed once before.
 */
export function buildPristinePhase4Session(
  binding: HistoricalDatasetBinding,
  guideContentHash: string,
  now: string,
  blindnessCompromised: boolean,
): Phase4Session {
  return {
    id: phase4SessionId(binding.datasetId, binding.guideVersion),
    schemaVersion: 1,
    revision: 0,
    datasetId: binding.datasetId,
    datasetFingerprint: binding.datasetFingerprint,
    datasetIntegrityHash: binding.integrityHash,
    guideVersion: binding.guideVersion,
    guideContentHash,
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
    ...(blindnessCompromised ? { blindnessCompromised: true } : {}),
    finalDecisionAt: null,
    finalDecisionBy: null,
    updatedAt: now,
  };
}

/**
 * Grants one recalibration retry on the one-use receipt behind a Phase 4
 * session — called when a Phase 5 run fails its human evidence audit, so the
 * organiser can recalibrate on the same historical file instead of being
 * forced to source a new one. Raises the durable reveal budget by one. Returns
 * false (no-op) when the receipt does not belong to that session.
 */
export async function grantPhase4RecalibrationCredit(
  phase4SessionId: string,
): Promise<boolean> {
  const result = await pilot<{ granted: boolean }>("calibration.credit", {
    sessionId: phase4SessionId,
    reason: "phase5_audit_failure",
  });
  return result.granted;
}

/** How many recalibration retries are currently available for a dataset. */
export async function loadPhase4RecalibrationCredits(
  datasetFingerprint: string,
): Promise<number> {
  const state = await pilot<{ consumed: boolean; headroom: number }>(
    "calibration.consumed",
    { datasetFingerprint },
  );
  return state.headroom;
}

/**
 * Resets a consumed session to a fresh pristine one using one recalibration
 * credit, in a single transaction. Because Phase 4 session ids are
 * deterministic per (dataset, guide version), this replaces the old revealed
 * document in the same server row — the sanctioned exception to the reversal
 * guard. The durable receipt and its unspent reveal credit remain untouched;
 * the retry spends that credit only when its outcomes are revealed.
 */
export async function resetPhase4SessionWithCredit(args: {
  binding: HistoricalDatasetBinding;
  guideContentHash: string;
}): Promise<Phase4Session> {
  const { binding } = args;
  const current = await loadPhase4Session(binding.datasetId, binding.guideVersion);
  const state = await pilot<{ consumed: boolean; headroom: number }>(
    "calibration.consumed",
    { datasetFingerprint: binding.datasetFingerprint },
  );
  if (
    !current ||
    state.headroom < 1 ||
    !["revealed", "passed", "failed"].includes(current.practiceStatus)
  ) {
    throw new Error("No recalibration retry is available for this historical set.");
  }
  const fresh = buildPristinePhase4Session(
    binding,
    args.guideContentHash,
    new Date().toISOString(),
    true,
  );
  const reset = await pilot<Phase4Session>("calibration.save", {
    session: { ...fresh, revision: current.revision },
    resetWithCredit: true,
  });
  if (
    !phase4SessionMatchesBinding(reset, binding) ||
    !phase4SessionIsCoherent(reset) ||
    !(await phase4DerivedHashesAreValid(reset)) ||
    !reset.blindnessCompromised
  ) {
    throw new Error("The recalibration reset failed its integrity checks.");
  }
  return reset;
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
  const revealed = await pilot<Phase4Session>("calibration.reveal", {
    datasetId: current.datasetId,
    guideVersion: current.guideVersion,
    expectedRevision: current.revision,
  });
  const binding = await loadHistoricalDatasetBinding(current.datasetId);
  if (
    !phase4SessionMatchesBinding(revealed, binding) ||
    !phase4SessionIsCoherent(revealed) ||
    !(await phase4DerivedHashesAreValid(revealed)) ||
    !revealed.outcomes
  ) {
    throw new Error("The revealed blind test did not pass its integrity checks.");
  }
  return revealed;
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
