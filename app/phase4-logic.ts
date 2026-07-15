/**
 * Pure, fail-closed logic for Phase 4 calibration.
 *
 * This module deliberately does not know about React, IndexedDB, OpenAI, or the
 * network. AI output is untrusted input: it is only usable after it matches the
 * approved guide and every claimed evidence quote is found verbatim in one
 * current answer value.
 */

export type Phase4CanonicalOutcome =
  | "progressed"
  | "not_progressed"
  | "waitlist"
  | "ineligible";

export type Phase4RuleKind = "eligibility" | "elimination" | "criterion";
export type Phase4SelectionMode = "top_n" | "minimum_score" | "both";

export type Phase4GuideRule = {
  id: string;
  kind: Phase4RuleKind;
  title: string;
  statement: string;
  passingCondition?: string;
  evidence?: string;
  weight: number;
  anchor1?: string;
  anchor3?: string;
  anchor5?: string;
};

/** Structurally compatible with the approved DecisionGuide in page.tsx. */
export type Phase4ApprovedGuide = {
  version: number;
  status: "approved" | "draft";
  rules: Phase4GuideRule[];
  selection: {
    mode: Phase4SelectionMode | "";
    shortlistTarget?: string;
    minimumScore?: string;
  };
};

export type Phase4Answer = {
  heading: string;
  value: string;
};

export type Phase4SourceRow = {
  rowId: string;
  answers: Phase4Answer[];
  outcome?: Phase4CanonicalOutcome;
  // Callers can pass richer stored rows. Builders below intentionally ignore
  // every property not explicitly named above.
  [key: string]: unknown;
};

export type SafeTeachingExample = {
  row_id: string;
  answers: Array<{ heading: string; value: string }>;
  outcome: Phase4CanonicalOutcome;
};

export type BlindSealedCase = {
  row_id: string;
  answers: Array<{ heading: string; value: string }>;
};

export type EvidenceReference = {
  /** Zero-based position in the current case's answers array. */
  answerIndex: number;
  /** A verbatim, non-empty substring of that answer's value. */
  quote: string;
};

export type EligibilityResult = "pass" | "fail" | "unclear";
export type EliminationResult = "triggered" | "not_triggered" | "unclear";

export type AiEligibilityCheck = {
  ruleId: string;
  result: EligibilityResult;
  evidence: EvidenceReference | null;
  explanation: string;
};

export type AiEliminationCheck = {
  ruleId: string;
  result: EliminationResult;
  evidence: EvidenceReference | null;
  explanation: string;
};

export type AiCriterionScore = {
  ruleId: string;
  score: number | null;
  evidence: EvidenceReference | null;
  explanation: string;
};

export type AiCaseAssessment = {
  rowId: string;
  eligibilityChecks: AiEligibilityCheck[];
  eliminationChecks: AiEliminationCheck[];
  criterionScores: AiCriterionScore[];
  uncertainties: string[];
};

export type Phase4Recommendation =
  | "progressed"
  | "not_progressed"
  | "ineligible"
  | "rank_only"
  | "human_review";

export type LocalClassificationReason =
  | "validated_minimum_score"
  | "below_minimum_score"
  | "requires_cohort_ranking"
  | "eligibility_failed"
  | "elimination_triggered"
  | "unclear_or_unsupported"
  | "malformed_or_mismatched";

export type LocalClassification = {
  recommendation: Phase4Recommendation;
  reason: LocalClassificationReason;
};

export type AssessmentValidationIssueCode =
  | "guide_not_approved"
  | "invalid_guide"
  | "malformed_output"
  | "row_mismatch"
  | "missing_rule"
  | "unknown_rule"
  | "duplicate_rule"
  | "invalid_evidence_reference"
  | "evidence_not_exact"
  | "evidence_required"
  | "unclear_result";

export type AssessmentValidationIssue = {
  code: AssessmentValidationIssueCode;
  path: string;
  message: string;
};

export type CaseAssessmentValidation = {
  /** True only when the output, guide coverage, and all required evidence pass. */
  ok: boolean;
  structurallyValid: boolean;
  evidenceValid: boolean;
  assessment: AiCaseAssessment | null;
  issues: AssessmentValidationIssue[];
  weightedScore: number | null;
  classification: LocalClassification;
};

export type AssessmentBatchValidation = {
  ok: boolean;
  issues: AssessmentValidationIssue[];
  results: Record<string, CaseAssessmentValidation>;
};

const ROOT_KEYS = [
  "criterionScores",
  "eligibilityChecks",
  "eliminationChecks",
  "rowId",
  "uncertainties",
] as const;
const CHECK_KEYS = ["evidence", "explanation", "result", "ruleId"] as const;
const SCORE_KEYS = ["evidence", "explanation", "ruleId", "score"] as const;
const EVIDENCE_KEYS = ["answerIndex", "quote"] as const;
const MAX_EXPLANATION_LENGTH = 2_000;
const MAX_UNCERTAINTY_LENGTH = 1_000;
const MAX_QUOTE_LENGTH = 4_000;
const MAX_ITEMS_PER_KIND = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function parseEvidence(value: unknown, nullable: boolean): EvidenceReference | null | undefined {
  if (value === null && nullable) return null;
  if (!isRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) return undefined;
  if (!Number.isInteger(value.answerIndex) || Number(value.answerIndex) < 0) return undefined;
  if (!isBoundedString(value.quote, MAX_QUOTE_LENGTH)) return undefined;
  return { answerIndex: Number(value.answerIndex), quote: value.quote };
}

function parseEligibilityCheck(value: unknown): AiEligibilityCheck | null {
  if (!isRecord(value) || !hasExactKeys(value, CHECK_KEYS)) return null;
  if (!isBoundedString(value.ruleId, 300)) return null;
  if (value.result !== "pass" && value.result !== "fail" && value.result !== "unclear") return null;
  if (!isBoundedString(value.explanation, MAX_EXPLANATION_LENGTH, true)) return null;
  const evidence = parseEvidence(value.evidence, true);
  if (evidence === undefined) return null;
  return {
    ruleId: value.ruleId,
    result: value.result,
    evidence,
    explanation: value.explanation,
  };
}

function parseEliminationCheck(value: unknown): AiEliminationCheck | null {
  if (!isRecord(value) || !hasExactKeys(value, CHECK_KEYS)) return null;
  if (!isBoundedString(value.ruleId, 300)) return null;
  if (
    value.result !== "triggered" &&
    value.result !== "not_triggered" &&
    value.result !== "unclear"
  ) {
    return null;
  }
  if (!isBoundedString(value.explanation, MAX_EXPLANATION_LENGTH, true)) return null;
  const evidence = parseEvidence(value.evidence, true);
  if (evidence === undefined) return null;
  return {
    ruleId: value.ruleId,
    result: value.result,
    evidence,
    explanation: value.explanation,
  };
}

function parseCriterionScore(value: unknown): AiCriterionScore | null {
  if (!isRecord(value) || !hasExactKeys(value, SCORE_KEYS)) return null;
  if (!isBoundedString(value.ruleId, 300)) return null;
  if (!isBoundedString(value.explanation, MAX_EXPLANATION_LENGTH, true)) return null;
  if (value.score === null && value.evidence === null) {
    return {
      ruleId: value.ruleId,
      score: null,
      evidence: null,
      explanation: value.explanation,
    };
  }
  if (!Number.isInteger(value.score) || Number(value.score) < 1 || Number(value.score) > 5) {
    return null;
  }
  const evidence = parseEvidence(value.evidence, false);
  if (!evidence) return null;
  return {
    ruleId: value.ruleId,
    score: Number(value.score),
    evidence,
    explanation: value.explanation,
  };
}

/**
 * Parses the one accepted assessment shape. Extra keys, missing keys, invalid
 * enums, out-of-range scores, and overlong strings are rejected.
 */
export function parseAiCaseAssessment(value: unknown): AiCaseAssessment | null {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(source) || !hasExactKeys(source, ROOT_KEYS)) return null;
  if (!isBoundedString(source.rowId, 300)) return null;
  if (
    !Array.isArray(source.eligibilityChecks) ||
    !Array.isArray(source.eliminationChecks) ||
    !Array.isArray(source.criterionScores) ||
    !Array.isArray(source.uncertainties) ||
    source.eligibilityChecks.length > MAX_ITEMS_PER_KIND ||
    source.eliminationChecks.length > MAX_ITEMS_PER_KIND ||
    source.criterionScores.length > MAX_ITEMS_PER_KIND ||
    source.uncertainties.length > MAX_ITEMS_PER_KIND
  ) {
    return null;
  }

  const eligibilityChecks = source.eligibilityChecks.map(parseEligibilityCheck);
  const eliminationChecks = source.eliminationChecks.map(parseEliminationCheck);
  const criterionScores = source.criterionScores.map(parseCriterionScore);
  if (
    eligibilityChecks.some((item) => item === null) ||
    eliminationChecks.some((item) => item === null) ||
    criterionScores.some((item) => item === null) ||
    source.uncertainties.some(
      (item) => !isBoundedString(item, MAX_UNCERTAINTY_LENGTH, true),
    )
  ) {
    return null;
  }

  return {
    rowId: source.rowId,
    eligibilityChecks: eligibilityChecks as AiEligibilityCheck[],
    eliminationChecks: eliminationChecks as AiEliminationCheck[],
    criterionScores: criterionScores as AiCriterionScore[],
    uncertainties: source.uncertainties as string[],
  };
}

function validAnswers(answers: unknown): answers is Phase4Answer[] {
  return (
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.every(
      (answer) =>
        isRecord(answer) &&
        typeof answer.heading === "string" &&
        typeof answer.value === "string" &&
        answer.value.length > 0,
    )
  );
}

function copyAnswers(answers: Phase4Answer[]) {
  return answers.map((answer) => ({ heading: answer.heading, value: answer.value }));
}

function isCanonicalOutcome(value: unknown): value is Phase4CanonicalOutcome {
  return (
    value === "progressed" ||
    value === "not_progressed" ||
    value === "waitlist" ||
    value === "ineligible"
  );
}

/**
 * Creates labelled teaching examples by allow-list. Team names, external IDs,
 * reviewer notes, judge scores, source labels, and composite application text
 * can never be copied by this function.
 */
export function buildSafeTeachingPayload(rows: readonly Phase4SourceRow[]): SafeTeachingExample[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (!isBoundedString(row?.rowId, 300) || seen.has(row.rowId)) {
      throw new Error(`Teaching row ${index + 1} has a missing or duplicate rowId.`);
    }
    if (!validAnswers(row.answers)) {
      throw new Error(`Teaching row ${index + 1} has no usable answer values.`);
    }
    if (!isCanonicalOutcome(row.outcome)) {
      throw new Error(`Teaching row ${index + 1} has no canonical outcome.`);
    }
    seen.add(row.rowId);
    const safe: SafeTeachingExample = {
      row_id: row.rowId,
      answers: copyAnswers(row.answers),
      outcome: row.outcome,
    };
    return safe;
  });
}

/**
 * Creates blind practice cases by allow-list. Most importantly, historical
 * outcomes are never copied, even when present on the source objects.
 */
export function buildBlindSealedPayload(rows: readonly Phase4SourceRow[]): BlindSealedCase[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (!isBoundedString(row?.rowId, 300) || seen.has(row.rowId)) {
      throw new Error(`Sealed row ${index + 1} has a missing or duplicate rowId.`);
    }
    if (!validAnswers(row.answers)) {
      throw new Error(`Sealed row ${index + 1} has no usable answer values.`);
    }
    seen.add(row.rowId);
    const safe: BlindSealedCase = {
      row_id: row.rowId,
      answers: copyAnswers(row.answers),
    };
    return safe;
  });
}

/** Exact means exact: no case-folding, whitespace repair, or composite text. */
export function evidenceIsExactAnswerSubstring(
  evidence: EvidenceReference,
  answers: readonly Phase4Answer[],
) {
  if (
    !Number.isInteger(evidence.answerIndex) ||
    evidence.answerIndex < 0 ||
    evidence.answerIndex >= answers.length ||
    typeof evidence.quote !== "string" ||
    evidence.quote.trim().length === 0
  ) {
    return false;
  }
  const answer = answers[evidence.answerIndex];
  return typeof answer?.value === "string" && answer.value.includes(evidence.quote);
}

function validateGuide(guide: Phase4ApprovedGuide): AssessmentValidationIssue[] {
  const issues: AssessmentValidationIssue[] = [];
  if (!isRecord(guide) || guide.status !== "approved") {
    issues.push({
      code: "guide_not_approved",
      path: "guide.status",
      message: "Only an approved guide can be used for calibration.",
    });
    return issues;
  }
  if (!Array.isArray(guide.rules) || !isRecord(guide.selection)) {
    issues.push({ code: "invalid_guide", path: "guide", message: "The approved guide is malformed." });
    return issues;
  }
  const ids = new Set<string>();
  let criterionWeight = 0;
  let criterionCount = 0;
  for (const [index, rule] of guide.rules.entries()) {
    if (
      !isRecord(rule) ||
      !isBoundedString(rule.id, 300) ||
      (rule.kind !== "eligibility" && rule.kind !== "elimination" && rule.kind !== "criterion") ||
      ids.has(rule.id)
    ) {
      issues.push({
        code: "invalid_guide",
        path: `guide.rules[${index}]`,
        message: "Guide rule IDs must be unique and every rule must have a supported kind.",
      });
      continue;
    }
    ids.add(rule.id);
    if (rule.kind === "criterion") {
      criterionCount += 1;
      if (!Number.isInteger(rule.weight) || rule.weight <= 0 || rule.weight > 100) {
        issues.push({
          code: "invalid_guide",
          path: `guide.rules[${index}].weight`,
          message: "Every criterion must have a whole-number weight from 1 to 100.",
        });
      } else {
        criterionWeight += rule.weight;
      }
    }
  }
  if (criterionCount === 0 || criterionWeight !== 100) {
    issues.push({
      code: "invalid_guide",
      path: "guide.rules",
      message: "The approved guide must contain criteria whose weights total 100.",
    });
  }
  if (
    guide.selection.mode !== "top_n" &&
    guide.selection.mode !== "minimum_score" &&
    guide.selection.mode !== "both"
  ) {
    issues.push({
      code: "invalid_guide",
      path: "guide.selection.mode",
      message: "The approved guide has no valid recommendation method.",
    });
  }
  if (guide.selection.mode === "minimum_score" || guide.selection.mode === "both") {
    const minimum = Number(guide.selection.minimumScore);
    if (!Number.isInteger(minimum) || minimum < 1 || minimum > 100) {
      issues.push({
        code: "invalid_guide",
        path: "guide.selection.minimumScore",
        message: "The approved guide has no valid minimum score.",
      });
    }
  }
  return issues;
}

function validateRuleCoverage<T extends { ruleId: string }>(
  actual: readonly T[],
  expected: readonly Phase4GuideRule[],
  path: string,
) {
  const issues: AssessmentValidationIssue[] = [];
  const expectedIds = new Set(expected.map((rule) => rule.id));
  const counts = new Map<string, number>();
  for (const item of actual) {
    counts.set(item.ruleId, (counts.get(item.ruleId) ?? 0) + 1);
    if (!expectedIds.has(item.ruleId)) {
      issues.push({
        code: "unknown_rule",
        path,
        message: `Assessment refers to unknown or wrong-kind rule ${item.ruleId}.`,
      });
    }
  }
  for (const rule of expected) {
    const count = counts.get(rule.id) ?? 0;
    if (count === 0) {
      issues.push({ code: "missing_rule", path, message: `Assessment is missing rule ${rule.id}.` });
    } else if (count > 1) {
      issues.push({
        code: "duplicate_rule",
        path,
        message: `Assessment repeats rule ${rule.id}.`,
      });
    }
  }
  return issues;
}

function evidenceIssue(
  evidence: EvidenceReference | null,
  answers: readonly Phase4Answer[],
  path: string,
  required: boolean,
): AssessmentValidationIssue | null {
  if (!evidence) {
    return required
      ? { code: "evidence_required", path, message: "This decision requires an exact evidence quote." }
      : null;
  }
  if (
    !Number.isInteger(evidence.answerIndex) ||
    evidence.answerIndex < 0 ||
    evidence.answerIndex >= answers.length
  ) {
    return {
      code: "invalid_evidence_reference",
      path,
      message: "Evidence must point to one current answer value.",
    };
  }
  if (!evidenceIsExactAnswerSubstring(evidence, answers)) {
    return {
      code: "evidence_not_exact",
      path,
      message: "Evidence quote is not an exact substring of the referenced current answer value.",
    };
  }
  return null;
}

/**
 * Calculates a score out of 100 locally. Returns null unless every criterion is
 * present exactly once with an integer score from 1 to 5 and guide weights are
 * valid. The function never trusts an AI-provided total.
 */
export function calculateLocalWeightedScore(
  criterionScores: readonly Pick<AiCriterionScore, "ruleId" | "score">[],
  guide: Phase4ApprovedGuide,
): number | null {
  if (validateGuide(guide).length > 0) return null;
  const criteria = guide.rules.filter((rule) => rule.kind === "criterion");
  const byId = new Map<string, number>();
  for (const item of criterionScores) {
    if (
      byId.has(item.ruleId) ||
      typeof item.score !== "number" ||
      !Number.isInteger(item.score) ||
      item.score < 1 ||
      item.score > 5
    ) {
      return null;
    }
    byId.set(item.ruleId, item.score);
  }
  if (byId.size !== criteria.length || criteria.some((rule) => !byId.has(rule.id))) return null;
  const total = criteria.reduce(
    (sum, rule) => sum + ((byId.get(rule.id) as number) / 5) * rule.weight,
    0,
  );
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

function failClosed(reason: LocalClassificationReason): LocalClassification {
  return { recommendation: "human_review", reason };
}

/**
 * Validates one AI assessment against the exact current case and approved guide.
 * Any malformed data, missing rule, unsupported quote, or uncertainty fails
 * closed to Human Review and removes the score.
 */
export function validateAiCaseAssessment(
  raw: unknown,
  currentCase: Pick<Phase4SourceRow, "rowId" | "answers">,
  guide: Phase4ApprovedGuide,
): CaseAssessmentValidation {
  const guideIssues = validateGuide(guide);
  const assessment = parseAiCaseAssessment(raw);
  if (!assessment) {
    const issues = [
      ...guideIssues,
      {
        code: "malformed_output" as const,
        path: "assessment",
        message: "AI output does not match the one accepted assessment schema.",
      },
    ];
    return {
      ok: false,
      structurallyValid: false,
      evidenceValid: false,
      assessment: null,
      issues,
      weightedScore: null,
      classification: failClosed("malformed_or_mismatched"),
    };
  }

  const issues = [...guideIssues];
  if (assessment.rowId !== currentCase.rowId) {
    issues.push({
      code: "row_mismatch",
      path: "assessment.rowId",
      message: "Assessment rowId does not match the current case.",
    });
  }
  if (!validAnswers(currentCase.answers)) {
    issues.push({
      code: "invalid_guide",
      path: "currentCase.answers",
      message: "The current case has no usable answer values.",
    });
  }

  const eligibilityRules = guide.rules?.filter((rule) => rule.kind === "eligibility") ?? [];
  const eliminationRules = guide.rules?.filter((rule) => rule.kind === "elimination") ?? [];
  const criterionRules = guide.rules?.filter((rule) => rule.kind === "criterion") ?? [];
  issues.push(
    ...validateRuleCoverage(assessment.eligibilityChecks, eligibilityRules, "eligibilityChecks"),
    ...validateRuleCoverage(assessment.eliminationChecks, eliminationRules, "eliminationChecks"),
    ...validateRuleCoverage(assessment.criterionScores, criterionRules, "criterionScores"),
  );

  if (validAnswers(currentCase.answers)) {
    assessment.eligibilityChecks.forEach((check, index) => {
      const evidence = evidenceIssue(
        check.evidence,
        currentCase.answers,
        `eligibilityChecks[${index}].evidence`,
        check.result !== "unclear",
      );
      if (evidence) issues.push(evidence);
      if (check.result === "unclear") {
        issues.push({
          code: "unclear_result",
          path: `eligibilityChecks[${index}].result`,
          message: "Unclear eligibility requires Human Review.",
        });
      }
    });
    assessment.eliminationChecks.forEach((check, index) => {
      const evidence = evidenceIssue(
        check.evidence,
        currentCase.answers,
        `eliminationChecks[${index}].evidence`,
        check.result === "triggered",
      );
      if (evidence) issues.push(evidence);
      if (check.result === "unclear") {
        issues.push({
          code: "unclear_result",
          path: `eliminationChecks[${index}].result`,
          message: "Unclear elimination status requires Human Review.",
        });
      }
    });
    assessment.criterionScores.forEach((score, index) => {
      const evidence = evidenceIssue(
        score.evidence,
        currentCase.answers,
        `criterionScores[${index}].evidence`,
        score.score !== null,
      );
      if (evidence) issues.push(evidence);
      if (score.score === null) {
        issues.push({
          code: "unclear_result",
          path: `criterionScores[${index}].score`,
          message: "Missing criterion evidence requires Human Review.",
        });
      }
    });
  }

  const evidenceInvalidCodes = new Set<AssessmentValidationIssueCode>([
    "invalid_evidence_reference",
    "evidence_not_exact",
    "evidence_required",
  ]);
  const evidenceValid = !issues.some((issue) => evidenceInvalidCodes.has(issue.code));
  const noAssessmentUncertainty = assessment.uncertainties.length === 0;
  if (!noAssessmentUncertainty) {
    issues.push({
      code: "unclear_result",
      path: "uncertainties",
      message: "Reported uncertainty requires Human Review.",
    });
  }
  const ok = issues.length === 0;
  const weightedScore = ok
    ? calculateLocalWeightedScore(assessment.criterionScores, guide)
    : null;

  let classification: LocalClassification;
  if (!ok || weightedScore === null) {
    classification = failClosed(
      assessment.rowId === currentCase.rowId ? "unclear_or_unsupported" : "malformed_or_mismatched",
    );
  } else if (assessment.eligibilityChecks.some((check) => check.result === "fail")) {
    classification = { recommendation: "ineligible", reason: "eligibility_failed" };
  } else if (assessment.eliminationChecks.some((check) => check.result === "triggered")) {
    classification = { recommendation: "not_progressed", reason: "elimination_triggered" };
  } else if (guide.selection.mode === "minimum_score") {
    classification =
      weightedScore >= Number(guide.selection.minimumScore)
        ? { recommendation: "progressed", reason: "validated_minimum_score" }
        : { recommendation: "not_progressed", reason: "below_minimum_score" };
  } else if (
    guide.selection.mode === "both" &&
    weightedScore < Number(guide.selection.minimumScore)
  ) {
    classification = { recommendation: "not_progressed", reason: "below_minimum_score" };
  } else {
    // A single case cannot truthfully know whether it is within a cohort's top N.
    classification = { recommendation: "rank_only", reason: "requires_cohort_ranking" };
  }

  return {
    ok,
    structurallyValid: true,
    evidenceValid,
    assessment,
    issues,
    weightedScore,
    classification,
  };
}

function malformedCaseResult(message: string): CaseAssessmentValidation {
  return {
    ok: false,
    structurallyValid: false,
    evidenceValid: false,
    assessment: null,
    issues: [{ code: "malformed_output", path: "batch", message }],
    weightedScore: null,
    classification: failClosed("malformed_or_mismatched"),
  };
}

/** Validates a strict `{ assessments: [...] }` batch and accounts for every case. */
export function validateAiAssessmentBatch(
  raw: unknown,
  currentCases: readonly Pick<Phase4SourceRow, "rowId" | "answers">[],
  guide: Phase4ApprovedGuide,
): AssessmentBatchValidation {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      source = null;
    }
  }
  const results: Record<string, CaseAssessmentValidation> = {};
  if (
    !isRecord(source) ||
    !hasExactKeys(source, ["assessments"]) ||
    !Array.isArray(source.assessments)
  ) {
    for (const item of currentCases) {
      results[item.rowId] = malformedCaseResult("AI batch output is malformed or incomplete.");
    }
    return {
      ok: false,
      issues: [{ code: "malformed_output", path: "batch", message: "AI batch output is malformed." }],
      results,
    };
  }

  const casesById = new Map(currentCases.map((item) => [item.rowId, item]));
  const rawById = new Map<string, unknown>();
  const batchIssues: AssessmentValidationIssue[] = [];
  for (const item of source.assessments) {
    const rowId = isRecord(item) && typeof item.rowId === "string" ? item.rowId : "";
    if (!rowId || !casesById.has(rowId)) {
      batchIssues.push({
        code: "row_mismatch",
        path: "batch.assessments",
        message: "AI batch contains an unknown or missing rowId.",
      });
      continue;
    }
    if (rawById.has(rowId)) {
      batchIssues.push({
        code: "row_mismatch",
        path: "batch.assessments",
        message: `AI batch repeats rowId ${rowId}.`,
      });
      continue;
    }
    rawById.set(rowId, item);
  }

  for (const currentCase of currentCases) {
    const item = rawById.get(currentCase.rowId);
    results[currentCase.rowId] = item
      ? validateAiCaseAssessment(item, currentCase, guide)
      : malformedCaseResult(`AI batch is missing rowId ${currentCase.rowId}.`);
  }
  return {
    ok: batchIssues.length === 0 && Object.values(results).every((result) => result.ok),
    issues: batchIssues,
    results,
  };
}

export type PracticeMetricCase = {
  rowId: string;
  historicalOutcome: Phase4CanonicalOutcome;
  predictedOutcome: Phase4Recommendation;
  weightedScore: number | null;
  humanReview: boolean;
  evidenceValid: boolean;
  tieBreakScores?: number[];
};

export type MetricRate = {
  /** Percentage from 0 to 100, or null when there is no valid denominator. */
  value: number | null;
  numerator: number;
  denominator: number;
};

export type PracticeMetrics = {
  totalCases: number;
  agreement: MetricRate;
  progressedRecall: MetricRate;
  progressedSafetyCapture: MetricRate;
  humanReviewRate: MetricRate;
  evidenceValidRate: MetricRate;
  pairwiseRankingConcordance: MetricRate;
};

export type LockedPracticeMetricAssessment = {
  rowId: string;
  criteria: Array<{
    criterionId: string;
    score: 1 | 2 | 3 | 4 | 5 | null;
  }>;
  weightedScore: number | null;
  recommendation: Phase4Recommendation;
  evidenceValid: boolean;
};

export type LockedPracticeMetricPolicy = {
  waitlistPolicy: "exclude" | "not_progressed";
  tieBreakPriority: string[];
};

function rate(numerator: number, denominator: number): MetricRate {
  return {
    value:
      denominator === 0
        ? null
        : Math.round(((numerator / denominator) * 100 + Number.EPSILON) * 100) / 100,
    numerator,
    denominator,
  };
}

/**
 * Computes practice-test metrics from locked predictions and subsequently
 * revealed outcomes. Waitlist is excluded from exact agreement because it is
 * not a binary progression decision; it remains in safety-rate denominators.
 * Human Review counts as a missed exact decision, never as a hidden success.
 * Ranking ties receive half credit, as in standard concordance measures.
 */
export function calculatePracticeMetrics(cases: readonly PracticeMetricCase[]): PracticeMetrics {
  const comparable = cases.filter(
    (item) =>
      item.historicalOutcome !== "waitlist" && item.predictedOutcome !== "rank_only",
  );
  const agreementNumerator = comparable.filter(
    (item) => item.predictedOutcome === item.historicalOutcome,
  ).length;
  const progressed = cases.filter((item) => item.historicalOutcome === "progressed");
  const progressedTruePositive = progressed.filter(
    (item) => item.predictedOutcome === "progressed",
  ).length;
  const progressedSafelyCaptured = progressed.filter(
    (item) =>
      item.predictedOutcome === "progressed" ||
      item.predictedOutcome === "human_review" ||
      item.predictedOutcome === "rank_only",
  ).length;
  const humanReviewCount = cases.filter(
    (item) => item.humanReview || item.predictedOutcome === "human_review",
  ).length;
  const evidenceValidCount = cases.filter((item) => item.evidenceValid).length;

  const rankedProgressed = cases.filter(
    (item) =>
      item.historicalOutcome === "progressed" &&
      item.evidenceValid &&
      !item.humanReview &&
      typeof item.weightedScore === "number" &&
      Number.isFinite(item.weightedScore),
  );
  const rankedNotProgressed = cases.filter(
    (item) =>
      item.historicalOutcome === "not_progressed" &&
      item.evidenceValid &&
      !item.humanReview &&
      typeof item.weightedScore === "number" &&
      Number.isFinite(item.weightedScore),
  );
  let pairCredit = 0;
  let pairCount = 0;
  const compareRank = (left: PracticeMetricCase, right: PracticeMetricCase) => {
    const weightedDifference = (left.weightedScore as number) - (right.weightedScore as number);
    if (weightedDifference !== 0) return weightedDifference;
    const length = Math.max(left.tieBreakScores?.length ?? 0, right.tieBreakScores?.length ?? 0);
    for (let index = 0; index < length; index += 1) {
      const difference = (left.tieBreakScores?.[index] ?? 0) - (right.tieBreakScores?.[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  for (const positive of rankedProgressed) {
    for (const negative of rankedNotProgressed) {
      pairCount += 1;
      const comparison = compareRank(positive, negative);
      if (comparison > 0) pairCredit += 1;
      else if (comparison === 0) pairCredit += 0.5;
    }
  }

  return {
    totalCases: cases.length,
    agreement: rate(agreementNumerator, comparable.length),
    progressedRecall: rate(progressedTruePositive, progressed.length),
    progressedSafetyCapture: rate(progressedSafelyCaptured, progressed.length),
    humanReviewRate: rate(humanReviewCount, cases.length),
    evidenceValidRate: rate(evidenceValidCount, cases.length),
    pairwiseRankingConcordance: rate(pairCredit, pairCount),
  };
}

/**
 * Rebuilds every displayed practice metric from the locked case assessments,
 * the subsequently revealed outcome key, and the pass policy that was frozen
 * before the blind run. Both the UI and persisted-state validator use this one
 * path so caller-supplied totals can never become authoritative.
 */
export function calculateLockedPracticeMetrics(args: {
  assessments: readonly LockedPracticeMetricAssessment[];
  outcomes: ReadonlyArray<{ rowId: string; outcome: Phase4CanonicalOutcome }>;
  policy: LockedPracticeMetricPolicy;
}): PracticeMetrics {
  const { assessments, outcomes, policy } = args;
  if (
    !Array.isArray(assessments) ||
    !Array.isArray(outcomes) ||
    !policy ||
    (policy.waitlistPolicy !== "exclude" && policy.waitlistPolicy !== "not_progressed") ||
    !Array.isArray(policy.tieBreakPriority) ||
    policy.tieBreakPriority.some(
      (ruleId) => typeof ruleId !== "string" || ruleId.trim().length === 0,
    ) ||
    new Set(policy.tieBreakPriority).size !== policy.tieBreakPriority.length
  ) {
    throw new Error("The locked practice inputs are incomplete or invalid.");
  }

  const outcomeById = new Map<string, Phase4CanonicalOutcome>();
  for (const item of outcomes) {
    if (
      !item ||
      typeof item.rowId !== "string" ||
      !item.rowId ||
      outcomeById.has(item.rowId) ||
      !isCanonicalOutcome(item.outcome)
    ) {
      throw new Error("The revealed outcome key is incomplete or invalid.");
    }
    outcomeById.set(item.rowId, item.outcome);
  }

  const assessmentIds = new Set<string>();
  const metricCases: PracticeMetricCase[] = assessments.map((assessment) => {
    if (
      !assessment ||
      typeof assessment.rowId !== "string" ||
      !assessment.rowId ||
      assessmentIds.has(assessment.rowId) ||
      !Array.isArray(assessment.criteria) ||
      typeof assessment.evidenceValid !== "boolean" ||
      (assessment.recommendation !== "progressed" &&
        assessment.recommendation !== "not_progressed" &&
        assessment.recommendation !== "ineligible" &&
        assessment.recommendation !== "rank_only" &&
        assessment.recommendation !== "human_review")
    ) {
      throw new Error("The locked assessment set is incomplete or invalid.");
    }
    assessmentIds.add(assessment.rowId);
    const historical = outcomeById.get(assessment.rowId);
    if (!historical) {
      throw new Error("The locked assessment and outcome sets do not match.");
    }
    const historicalOutcome =
      historical === "waitlist" && policy.waitlistPolicy === "not_progressed"
        ? "not_progressed"
        : historical;
    return {
      rowId: assessment.rowId,
      historicalOutcome,
      predictedOutcome: assessment.recommendation,
      weightedScore: assessment.weightedScore,
      humanReview: assessment.recommendation === "human_review",
      evidenceValid: assessment.evidenceValid,
      tieBreakScores: policy.tieBreakPriority.map(
        (ruleId) =>
          assessment.criteria.find((criterion) => criterion.criterionId === ruleId)?.score ?? 0,
      ),
    };
  });

  if (assessmentIds.size !== outcomeById.size) {
    throw new Error("The locked assessment and outcome sets do not match.");
  }
  return calculatePracticeMetrics(metricCases);
}

export function practiceMetricsMatchLockedInputs(args: {
  assessments: readonly LockedPracticeMetricAssessment[];
  outcomes: ReadonlyArray<{ rowId: string; outcome: Phase4CanonicalOutcome }>;
  policy: LockedPracticeMetricPolicy;
  metrics: PracticeMetrics;
}) {
  try {
    const expected = calculateLockedPracticeMetrics(args);
    return stableStringify(args.metrics) === stableStringify(expected);
  } catch {
    return false;
  }
}

/** Canonical JSON: object keys sorted, array order preserved, no non-finite numbers. */
export function stableStringify(value: unknown): string {
  function canonical(item: unknown, inArray: boolean): string | undefined {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Cannot fingerprint a non-finite number.");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => canonical(entry, true) ?? "null").join(",")}]`;
    }
    if (isRecord(item)) {
      const parts = Object.keys(item)
        .sort()
        .flatMap((key) => {
          const encoded = canonical(item[key], false);
          return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
        });
      return `{${parts.join(",")}}`;
    }
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      return inArray ? "null" : undefined;
    }
    throw new TypeError("Cannot fingerprint this value type.");
  }

  return canonical(value, false) ?? "null";
}

/** SHA-256 fingerprint of the stable representation; safe for invalidation, not identity. */
export async function createPhase4InputFingerprint(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure fingerprinting is unavailable.");
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
