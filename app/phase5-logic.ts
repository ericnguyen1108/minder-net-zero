/**
 * Pure, fail-closed logic for Phase 5 current-application assessment.
 *
 * AI output is converted from Phase 4's strict per-case validator, but the AI
 * never decides a cohort result. Thresholds, weighting, ranking, ties and
 * evidence-review sampling are all calculated locally in this module.
 */

import type {
  CaseAssessmentValidation,
  Phase4Answer,
  Phase4ApprovedGuide,
} from "./phase4-logic.ts";
import { calculateLocalWeightedScore } from "./phase4-logic.ts";
import {
  PHASE5_BATCH_ALGORITHM,
  PHASE5_PROMPT_VERSION,
  PHASE5_SCHEMA_VERSION,
} from "./phase5-storage.ts";
import type {
  Phase5CohortRecommendation,
  Phase5RunContract,
  Phase5SafeguardApproval,
  Phase5StoredAssessment,
} from "./phase5-storage.ts";

export { PHASE5_BATCH_ALGORITHM, PHASE5_PROMPT_VERSION, PHASE5_SCHEMA_VERSION };
export type {
  Phase5CohortRecommendation,
  Phase5RunContract,
  Phase5SafeguardApproval,
  Phase5StoredAssessment,
};
export type Phase5SafeguardsApproval = Phase5SafeguardApproval;
export const PHASE5_BATCH_ALGORITHM_VERSION = PHASE5_BATCH_ALGORITHM;
export const PHASE5_MAX_BATCH_CASES = 6;
export const PHASE5_MAX_REQUEST_BYTES = 600_000;
export const PHASE5_MAX_EVIDENCE_SAMPLE = 10;

export type Phase5CurrentCase = {
  rowId: string;
  answers: Phase4Answer[];
  // Import records may contain display names, contact details and other local
  // fields. The safe builder below deliberately ignores all of them.
  [key: string]: unknown;
};

export type Phase5SafeCase = {
  rowId: string;
  answers: Array<{ heading: string; value: string }>;
};

export type Phase5ApprovedGuide = Phase4ApprovedGuide & {
  tieBreakPriority: string[];
};

export type Phase5RecoveryInputs = {
  phase4SessionId: string;
  phase4MetricsHash: string;
  guideContentHash: string;
  approvedPatternsHash: string;
  expectedModelId: string;
  promptVersion: string;
  outputSchemaVersion: string;
  batchAlgorithm: string;
  assessmentProtocolHash: string;
};

type Phase5RecoveryContract = Pick<
  Phase5RunContract,
  | "phase4SessionId"
  | "phase4MetricsHash"
  | "guideContentHash"
  | "approvedPatternsHash"
  | "expectedModelId"
  | "promptVersion"
  | "outputSchemaVersion"
  | "batchAlgorithm"
  | "assessmentProtocolHash"
>;

/**
 * A failed human audit may never be retried with identical locked inputs.
 * A new run is permitted only after calibration, safeguards, model or the
 * assessment protocol has genuinely changed.
 */
export function phase5RecoveryInputsDiffer(
  invalidRun: Phase5RecoveryContract,
  current: Phase5RecoveryInputs,
) {
  const lockedInputsChanged =
    invalidRun.phase4SessionId !== current.phase4SessionId ||
    invalidRun.phase4MetricsHash !== current.phase4MetricsHash ||
    invalidRun.guideContentHash !== current.guideContentHash ||
    invalidRun.approvedPatternsHash !== current.approvedPatternsHash ||
    invalidRun.expectedModelId !== current.expectedModelId ||
    invalidRun.promptVersion !== current.promptVersion ||
    invalidRun.outputSchemaVersion !== current.outputSchemaVersion ||
    invalidRun.batchAlgorithm !== current.batchAlgorithm;
  const protocolChanged =
    invalidRun.assessmentProtocolHash !== current.assessmentProtocolHash;
  return lockedInputsChanged || protocolChanged;
}

function usableAnswers(value: unknown): value is Phase4Answer[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (answer) =>
        answer !== null &&
        typeof answer === "object" &&
        typeof (answer as Phase4Answer).heading === "string" &&
        typeof (answer as Phase4Answer).value === "string" &&
        (answer as Phase4Answer).value.length > 0,
    )
  );
}

function usableOpaqueRowId(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Copies only the opaque row ID and submitted answers. Extra properties such
 * as names, emails, outcomes, reviewer notes and old scores cannot cross this
 * allow-list boundary.
 */
export function buildSafeCurrentPayload(
  cases: readonly Phase5CurrentCase[],
): Phase5SafeCase[] {
  if (!Array.isArray(cases)) throw new Error("Current applications must be a list.");
  const seen = new Set<string>();
  return cases.map((currentCase, index) => {
    if (!usableOpaqueRowId(currentCase?.rowId) || seen.has(currentCase.rowId)) {
      throw new Error(`Current application ${index + 1} has a missing, non-opaque or duplicate rowId.`);
    }
    if (!usableAnswers(currentCase.answers)) {
      throw new Error(`Current application ${index + 1} has no usable answer values.`);
    }
    seen.add(currentCase.rowId);
    return {
      rowId: currentCase.rowId,
      answers: currentCase.answers.map((answer: Phase4Answer) => ({
        heading: answer.heading,
        value: answer.value,
      })),
    };
  });
}

function jsonBytes(value: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("The assessment request cannot be safely encoded.");
  }
  if (typeof encoded !== "string") {
    throw new Error("The assessment request cannot be safely encoded.");
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function requestForSize(
  cases: readonly Phase5SafeCase[],
  fixedRequest: Readonly<Record<string, unknown>>,
) {
  if (Object.hasOwn(fixedRequest, "cases")) {
    throw new Error("The fixed request must not contain a cases field.");
  }
  return { ...fixedRequest, cases };
}

export function phase5AssessmentRequestBytes(
  cases: readonly Phase5SafeCase[],
  fixedRequest: Readonly<Record<string, unknown>> = {},
) {
  return jsonBytes(requestForSize(cases, fixedRequest));
}

/**
 * Packs complete cases in a deterministic operational order. Nothing is
 * truncated: a single oversized case stops the run with a clear error.
 */
export function packPhase5AssessmentBatches(
  cases: readonly Phase5CurrentCase[],
  fixedRequest: Readonly<Record<string, unknown>> = {},
): Phase5SafeCase[][] {
  const safeCases = buildSafeCurrentPayload(cases).sort((left, right) =>
    left.rowId.localeCompare(right.rowId),
  );
  const batches: Phase5SafeCase[][] = [];
  let current: Phase5SafeCase[] = [];

  for (const currentCase of safeCases) {
    const candidate = [...current, currentCase];
    const candidateFits =
      candidate.length <= PHASE5_MAX_BATCH_CASES &&
      phase5AssessmentRequestBytes(candidate, fixedRequest) < PHASE5_MAX_REQUEST_BYTES;
    if (candidateFits) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
    if (
      phase5AssessmentRequestBytes([currentCase], fixedRequest) >=
      PHASE5_MAX_REQUEST_BYTES
    ) {
      throw new Error(
        `Current application ${currentCase.rowId} is too large for one safe AI request. No answer text was truncated.`,
      );
    }
    current = [currentCase];
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function uniqueReasons(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Converts one strict Phase 4 validator result into the Phase 5 stored shape. */
export function toPhase5StoredAssessment(
  runId: string,
  rowId: string,
  result: CaseAssessmentValidation,
): Phase5StoredAssessment {
  if (!runId.trim()) throw new Error("The stored assessment needs a runId.");
  if (!usableOpaqueRowId(rowId)) throw new Error("The stored assessment rowId is not opaque.");
  const assessment = result.assessment;
  const humanReviewReasons = uniqueReasons([
    ...result.issues.map((issue) => issue.message),
    ...(assessment?.uncertainties ?? []),
  ]);
  if (result.classification.recommendation === "human_review" && humanReviewReasons.length === 0) {
    humanReviewReasons.push("This application requires Human Review.");
  }
  return {
    runId,
    rowId,
    eligibility:
      assessment?.eligibilityChecks.map((check) => ({
        ruleId: check.ruleId,
        status: check.result,
        evidence: check.evidence ? [{ ...check.evidence }] : [],
      })) ?? [],
    elimination:
      assessment?.eliminationChecks.map((check) => ({
        ruleId: check.ruleId,
        status: check.result,
        evidence: check.evidence ? [{ ...check.evidence }] : [],
      })) ?? [],
    criteria:
      assessment?.criterionScores.map((criterion) => ({
        criterionId: criterion.ruleId,
        score: criterion.score as 1 | 2 | 3 | 4 | 5 | null,
        evidence: criterion.evidence ? [{ ...criterion.evidence }] : [],
      })) ?? [],
    weightedScore: result.weightedScore,
    baseRecommendation: result.classification.recommendation,
    evidenceValid: result.evidenceValid,
    humanReviewReasons,
  };
}

function reviewRecommendation(
  assessment: Phase5StoredAssessment,
  reason: string,
): Phase5CohortRecommendation {
  return {
    rowId: assessment.rowId,
    recommendation: "human_review",
    reason,
    weightedScore: assessment.weightedScore,
    rank: null,
  };
}

function fixedRecommendation(
  assessment: Phase5StoredAssessment,
  recommendation: "progressed" | "not_progressed" | "ineligible",
  reason: string,
): Phase5CohortRecommendation {
  return {
    rowId: assessment.rowId,
    recommendation,
    reason,
    weightedScore: assessment.weightedScore,
    rank: null,
  };
}

function validateCompleteCohort(
  assessments: readonly Phase5StoredAssessment[],
  expectedRowIds: readonly string[],
) {
  const expected = new Set(expectedRowIds);
  const actual = new Set(assessments.map((assessment) => assessment.rowId));
  const runIds = new Set(assessments.map((assessment) => assessment.runId));
  if (
    expected.size === 0 ||
    expected.size !== expectedRowIds.length ||
    actual.size !== assessments.length ||
    actual.size !== expected.size ||
    runIds.size !== 1 ||
    [...runIds].some((runId) => !runId.trim()) ||
    [...expected].some((rowId) => !actual.has(rowId))
  ) {
    throw new Error(
      "Cohort recommendations are unavailable until every sealed current application has exactly one assessment.",
    );
  }
}

function rankingConfiguration(guide: Phase5ApprovedGuide) {
  if (guide.status !== "approved") throw new Error("Only an approved guide can rank a cohort.");
  const criterionIds = new Set(
    guide.rules.filter((rule) => rule.kind === "criterion").map((rule) => rule.id),
  );
  if (
    !Array.isArray(guide.tieBreakPriority) ||
    new Set(guide.tieBreakPriority).size !== guide.tieBreakPriority.length ||
    guide.tieBreakPriority.some((ruleId) => !criterionIds.has(ruleId))
  ) {
    throw new Error("The approved guide has an invalid criterion tie-break order.");
  }
  const shortlistTarget = Number(guide.selection.shortlistTarget);
  if (!Number.isInteger(shortlistTarget) || shortlistTarget < 1) {
    throw new Error("The approved guide has no valid shortlist target.");
  }
  const minimumScore = Number(guide.selection.minimumScore);
  if (
    guide.selection.mode === "both" &&
    (!Number.isInteger(minimumScore) || minimumScore < 1 || minimumScore > 100)
  ) {
    throw new Error("The approved guide has no valid minimum score.");
  }
  return { shortlistTarget, minimumScore };
}

function rankingVector(
  assessment: Phase5StoredAssessment,
  guide: Phase5ApprovedGuide,
) {
  if (
    typeof assessment.weightedScore !== "number" ||
    !Number.isFinite(assessment.weightedScore) ||
    !assessment.evidenceValid ||
    assessment.humanReviewReasons.length > 0 ||
    assessment.eligibility.some((finding) => finding.status !== "pass") ||
    assessment.elimination.some((finding) => finding.status !== "not_triggered")
  ) {
    return null;
  }
  const scores = new Map<string, number>();
  for (const criterion of assessment.criteria) {
    if (
      scores.has(criterion.criterionId) ||
      typeof criterion.score !== "number" ||
      !Number.isInteger(criterion.score) ||
      criterion.score < 1 ||
      criterion.score > 5
    ) {
      return null;
    }
    scores.set(criterion.criterionId, criterion.score);
  }
  if (guide.tieBreakPriority.some((ruleId) => !scores.has(ruleId))) return null;
  const recalculated = calculateLocalWeightedScore(
    assessment.criteria.map((criterion) => ({
      ruleId: criterion.criterionId,
      score: criterion.score,
    })),
    guide,
  );
  if (recalculated === null || recalculated !== assessment.weightedScore) return null;
  return [
    recalculated,
    ...guide.tieBreakPriority.map((ruleId) => scores.get(ruleId) as number),
  ];
}

function compareVectorsDescending(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Produces cohort recommendations only after the exact expected set is
 * complete. rowId is used only to make returned display order stable; it is
 * never used to break a score tie.
 */
export function classifyPhase5Cohort(args: {
  assessments: readonly Phase5StoredAssessment[];
  expectedRowIds: readonly string[];
  guide: Phase5ApprovedGuide;
}): Phase5CohortRecommendation[] {
  const { assessments, expectedRowIds, guide } = args;
  validateCompleteCohort(assessments, expectedRowIds);
  if (guide.status !== "approved") {
    throw new Error("Only an approved guide can classify a current cohort.");
  }

  if (guide.selection.mode === "minimum_score") {
    const minimumScore = Number(guide.selection.minimumScore);
    if (!Number.isInteger(minimumScore) || minimumScore < 1 || minimumScore > 100) {
      throw new Error("The approved guide has no valid minimum score.");
    }
    return assessments
      .map((assessment) => {
        if (assessment.baseRecommendation === "human_review") {
          return reviewRecommendation(assessment, "requires_human_review");
        }
        if (assessment.baseRecommendation === "ineligible") {
          return fixedRecommendation(assessment, "ineligible", "base_ineligible");
        }
        if (assessment.baseRecommendation === "not_progressed") {
          return fixedRecommendation(assessment, "not_progressed", "minimum_score_result");
        }
        if (assessment.baseRecommendation === "progressed") {
          return fixedRecommendation(assessment, "progressed", "minimum_score_result");
        }
        return reviewRecommendation(
          assessment,
          "invalid_for_cohort_ranking",
        );
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
  }

  if (guide.selection.mode !== "top_n" && guide.selection.mode !== "both") {
    throw new Error("The approved guide has no supported cohort recommendation method.");
  }
  const { shortlistTarget, minimumScore } = rankingConfiguration(guide);
  const completed = new Map<string, Phase5CohortRecommendation>();
  const rankingCases: Array<{ assessment: Phase5StoredAssessment; vector: number[] }> = [];

  for (const assessment of assessments) {
    if (assessment.baseRecommendation === "human_review") {
      completed.set(
        assessment.rowId,
        reviewRecommendation(assessment, "requires_human_review"),
      );
      continue;
    }
    if (assessment.baseRecommendation === "ineligible") {
      completed.set(
        assessment.rowId,
        fixedRecommendation(assessment, "ineligible", "base_ineligible"),
      );
      continue;
    }
    if (assessment.baseRecommendation === "not_progressed") {
      completed.set(
        assessment.rowId,
        fixedRecommendation(assessment, "not_progressed", "base_not_progressed"),
      );
      continue;
    }
    if (assessment.baseRecommendation !== "rank_only") {
      completed.set(
        assessment.rowId,
        reviewRecommendation(
          assessment,
          "invalid_for_cohort_ranking",
        ),
      );
      continue;
    }

    const vector = rankingVector(assessment, guide);
    if (!vector) {
      completed.set(
        assessment.rowId,
        reviewRecommendation(
          assessment,
          "invalid_for_cohort_ranking",
        ),
      );
      continue;
    }
    // In “both” mode the approved minimum is applied before any top-N ranking.
    if (guide.selection.mode === "both" && vector[0] < minimumScore) {
      completed.set(
        assessment.rowId,
        fixedRecommendation(assessment, "not_progressed", "minimum_score_result"),
      );
      continue;
    }
    rankingCases.push({ assessment, vector });
  }

  const groups = new Map<string, { vector: number[]; assessments: Phase5StoredAssessment[] }>();
  for (const item of rankingCases) {
    const key = JSON.stringify(item.vector);
    const group = groups.get(key) ?? { vector: item.vector, assessments: [] };
    group.assessments.push(item.assessment);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    compareVectorsDescending(left.vector, right.vector),
  );
  let position = 1;
  for (const group of orderedGroups) {
    const rankStart = position;
    const rankEnd = position + group.assessments.length - 1;
    const crossesBoundary = rankStart <= shortlistTarget && rankEnd > shortlistTarget;
    for (const assessment of group.assessments) {
      if (crossesBoundary) {
        completed.set(assessment.rowId, {
          rowId: assessment.rowId,
          recommendation: "human_review",
          reason: "shortlist_boundary_tie",
          weightedScore: assessment.weightedScore,
          rank: null,
        });
      } else {
        completed.set(assessment.rowId, {
          rowId: assessment.rowId,
          recommendation: rankEnd <= shortlistTarget ? "progressed" : "not_progressed",
          reason: rankEnd <= shortlistTarget ? "ranked_within_target" : "ranked_below_target",
          weightedScore: assessment.weightedScore,
          rank: rankStart,
        });
      }
    }
    position = rankEnd + 1;
  }

  return [...completed.values()].sort((left, right) => left.rowId.localeCompare(right.rowId));
}

function hasStoredEvidence(assessment: Phase5StoredAssessment) {
  return [...assessment.eligibility, ...assessment.elimination, ...assessment.criteria].some(
    (finding) => finding.evidence.length > 0,
  );
}

// Small deterministic hash for unbiased operational sampling; not cryptography.
function sampleHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Returns a fixed evidence-bearing sample, independent of assessment order. */
export function selectPhase5EvidenceReviewSampleIds(
  assessments: readonly Phase5StoredAssessment[],
  seed: string,
  requestedMaximum = PHASE5_MAX_EVIDENCE_SAMPLE,
) {
  const maximum = Math.max(
    0,
    Math.min(PHASE5_MAX_EVIDENCE_SAMPLE, Math.floor(requestedMaximum)),
  );
  return assessments
    .filter(hasStoredEvidence)
    .map((assessment) => assessment.rowId)
    .filter((rowId, index, values) => values.indexOf(rowId) === index)
    .sort((left, right) => {
      const difference = sampleHash(`${seed}\u0000${left}`) - sampleHash(`${seed}\u0000${right}`);
      return difference || left.localeCompare(right);
    })
    .slice(0, maximum);
}
