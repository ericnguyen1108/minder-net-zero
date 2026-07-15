import assert from "node:assert/strict";
import test from "node:test";

import { validateAiAssessmentBatch } from "../app/phase4-logic.ts";
import {
  PHASE5_BATCH_ALGORITHM,
  PHASE5_BATCH_ALGORITHM_VERSION,
  PHASE5_MAX_BATCH_CASES,
  PHASE5_MAX_EVIDENCE_SAMPLE,
  PHASE5_MAX_REQUEST_BYTES,
  PHASE5_PROMPT_VERSION,
  PHASE5_SCHEMA_VERSION,
  buildSafeCurrentPayload,
  classifyPhase5Cohort,
  packPhase5AssessmentBatches,
  phase5AssessmentRequestBytes,
  phase5RecoveryInputsDiffer,
  selectPhase5EvidenceReviewSampleIds,
  toPhase5StoredAssessment,
} from "../app/phase5-logic.ts";

function guide(mode = "top_n", shortlistTarget = "2", minimumScore = "70") {
  return {
    version: 1,
    status: "approved",
    rules: [
      { id: "eligible", kind: "eligibility", title: "Eligible", statement: "Eligible", weight: 0 },
      { id: "excluded", kind: "elimination", title: "Excluded", statement: "Excluded", weight: 0 },
      { id: "impact", kind: "criterion", title: "Impact", statement: "Impact", weight: 50 },
      { id: "delivery", kind: "criterion", title: "Delivery", statement: "Delivery", weight: 50 },
    ],
    selection: { mode, shortlistTarget, minimumScore },
    tieBreakPriority: ["impact", "delivery"],
  };
}

function scoreFor(scores) {
  return scores.reduce((sum, score) => sum + score * 10, 0);
}

function assessment(
  rowId,
  {
    scores = [4, 4],
    baseRecommendation = "rank_only",
    evidenceValid = true,
    humanReviewReasons = [],
    withEvidence = true,
  } = {},
) {
  return {
    runId: "run-1",
    rowId,
    eligibility: [
      {
        ruleId: "eligible",
        status: "pass",
        evidence: withEvidence ? [{ answerIndex: 0, quote: `Eligibility ${rowId}` }] : [],
      },
    ],
    elimination: [
      { ruleId: "excluded", status: "not_triggered", evidence: [] },
    ],
    criteria: [
      {
        criterionId: "impact",
        score: scores[0],
        evidence: withEvidence ? [{ answerIndex: 0, quote: `Impact ${rowId}` }] : [],
      },
      {
        criterionId: "delivery",
        score: scores[1],
        evidence: withEvidence ? [{ answerIndex: 1, quote: `Delivery ${rowId}` }] : [],
      },
    ],
    weightedScore: scoreFor(scores),
    baseRecommendation,
    evidenceValid,
    humanReviewReasons,
  };
}

test("exports the locked Phase 5 protocol and safety limits", () => {
  assert.equal(PHASE5_BATCH_ALGORITHM_VERSION, PHASE5_BATCH_ALGORITHM);
  assert.match(PHASE5_PROMPT_VERSION, /^phase5-/);
  assert.match(PHASE5_SCHEMA_VERSION, /^phase5-/);
  assert.equal(PHASE5_MAX_BATCH_CASES, 6);
  assert.equal(PHASE5_MAX_REQUEST_BYTES, 600_000);
  assert.equal(PHASE5_MAX_EVIDENCE_SAMPLE, 10);
});

test("safe payload copies only opaque rowId and answers", () => {
  const source = [
    {
      rowId: "current_001",
      answers: [{ heading: "Impact", value: "Cuts 20,000 tonnes." }],
      teamName: "DO-NOT-SEND-TEAM",
      email: "DO-NOT-SEND@example.com",
      outcome: "progressed",
      reviewerNotes: "DO-NOT-SEND-NOTES",
      judgeScore: 99,
      applicationText: "DO-NOT-SEND-COMPOSITE",
    },
  ];
  const safe = buildSafeCurrentPayload(source);
  assert.deepEqual(Object.keys(safe[0]).sort(), ["answers", "rowId"]);
  assert.deepEqual(Object.keys(safe[0].answers[0]).sort(), ["heading", "value"]);
  assert.doesNotMatch(JSON.stringify(safe), /DO-NOT-SEND|example\.com|99/);

  source[0].answers[0].value = "Changed later";
  assert.equal(safe[0].answers[0].value, "Cuts 20,000 tonnes.");
});

test("safe payload rejects duplicate or non-opaque identifiers", () => {
  assert.throws(
    () =>
      buildSafeCurrentPayload([
        { rowId: "case-1", answers: [{ heading: "A", value: "One" }] },
        { rowId: "case-1", answers: [{ heading: "A", value: "Two" }] },
      ]),
    /duplicate rowId/i,
  );
  assert.throws(
    () =>
      buildSafeCurrentPayload([
        { rowId: "a person@example.com", answers: [{ heading: "A", value: "One" }] },
      ]),
    /non-opaque/i,
  );
});

test("byte-aware packing is deterministic, complete, bounded and never truncates", () => {
  const cases = Array.from({ length: 14 }, (_, index) => ({
    rowId: `case_${String(14 - index).padStart(2, "0")}`,
    answers: [{ heading: "Answer", value: `Full answer ${index} ${"x".repeat(200)}` }],
  }));
  const fixedRequest = { action: "assess_cases", guide: { version: 1 } };
  const batches = packPhase5AssessmentBatches(cases, fixedRequest);
  assert.deepEqual(batches.map((batch) => batch.length), [6, 6, 2]);
  assert.ok(
    batches.every(
      (batch) =>
        batch.length <= PHASE5_MAX_BATCH_CASES &&
        phase5AssessmentRequestBytes(batch, fixedRequest) < PHASE5_MAX_REQUEST_BYTES,
    ),
  );
  const flattened = batches.flat();
  assert.deepEqual(
    flattened.map((item) => item.rowId),
    [...flattened.map((item) => item.rowId)].sort(),
  );
  assert.equal(flattened.length, cases.length);
  flattened.forEach((item) => {
    const source = cases.find((candidate) => candidate.rowId === item.rowId);
    assert.equal(item.answers[0].value, source.answers[0].value);
  });
  assert.deepEqual(
    packPhase5AssessmentBatches([...cases].reverse(), fixedRequest),
    batches,
  );
});

test("byte-aware packing splits on bytes and rejects one oversized case without truncation", () => {
  const largeCases = Array.from({ length: 4 }, (_, index) => ({
    rowId: `large_${index}`,
    answers: [{ heading: "Answer", value: `${index}${"ü".repeat(125_000)}` }],
  }));
  const batches = packPhase5AssessmentBatches(largeCases);
  assert.ok(batches.length > 1);
  assert.ok(
    batches.every((batch) => phase5AssessmentRequestBytes(batch) < PHASE5_MAX_REQUEST_BYTES),
  );

  const original = `start-${"x".repeat(PHASE5_MAX_REQUEST_BYTES)}-end`;
  assert.throws(
    () =>
      packPhase5AssessmentBatches([
        { rowId: "oversized_1", answers: [{ heading: "Answer", value: original }] },
      ]),
    /too large.*No answer text was truncated/i,
  );
  assert.match(original, /^start-/);
  assert.match(original, /-end$/);
});

test("converts a strict evidence-validated result to the storage shape", () => {
  const currentCase = {
    rowId: "case_01",
    answers: [
      { heading: "Impact", value: "We are eligible and can cut 20,000 tonnes." },
      { heading: "Delivery", value: "Delivery partners are signed." },
    ],
  };
  const raw = {
    assessments: [
      {
        rowId: "case_01",
        eligibilityChecks: [
          {
            ruleId: "eligible",
            result: "pass",
            evidence: { answerIndex: 0, quote: "eligible" },
            explanation: "Stated.",
          },
        ],
        eliminationChecks: [
          {
            ruleId: "excluded",
            result: "not_triggered",
            evidence: null,
            explanation: "No exclusion stated.",
          },
        ],
        criterionScores: [
          {
            ruleId: "impact",
            score: 5,
            evidence: { answerIndex: 0, quote: "20,000 tonnes" },
            explanation: "Strong impact.",
          },
          {
            ruleId: "delivery",
            score: 4,
            evidence: { answerIndex: 1, quote: "partners are signed" },
            explanation: "Strong delivery.",
          },
        ],
        uncertainties: [],
      },
    ],
  };
  const result = validateAiAssessmentBatch(
    raw,
    [currentCase],
    guide("minimum_score", "2", "70"),
  ).results.case_01;
  const stored = toPhase5StoredAssessment("run-1", "case_01", result);
  assert.equal(result.ok, true);
  assert.equal(stored.runId, "run-1");
  assert.equal(stored.weightedScore, 90);
  assert.equal(stored.baseRecommendation, "progressed");
  assert.equal(stored.criteria[0].evidence[0].quote, "20,000 tonnes");
  assert.deepEqual(stored.humanReviewReasons, []);
});

test("minimum-score cohorts preserve the validator's local result and Human Review", () => {
  const progressed = assessment("case_a", {
    scores: [4, 4],
    baseRecommendation: "progressed",
  });
  const notProgressed = assessment("case_b", {
    scores: [3, 3],
    baseRecommendation: "not_progressed",
  });
  const review = assessment("case_c", {
    scores: [2, 2],
    baseRecommendation: "human_review",
    humanReviewReasons: ["Missing evidence"],
  });
  const results = classifyPhase5Cohort({
    assessments: [review, progressed, notProgressed],
    expectedRowIds: ["case_a", "case_b", "case_c"],
    guide: guide("minimum_score", "2", "70"),
  });
  assert.deepEqual(
    results.map(({ rowId, recommendation }) => [rowId, recommendation]),
    [
      ["case_a", "progressed"],
      ["case_b", "not_progressed"],
      ["case_c", "human_review"],
    ],
  );
  assert.equal(results[2].rank, null);
});

test("both mode applies the minimum threshold before ranking and never buries Human Review", () => {
  const assessments = [
    assessment("high", { scores: [5, 5] }),
    assessment("medium", { scores: [4, 4] }),
    assessment("below", { scores: [3, 3] }),
    assessment("review", {
      scores: [2, 2],
      baseRecommendation: "human_review",
      humanReviewReasons: ["Unsupported claim"],
    }),
  ];
  const results = classifyPhase5Cohort({
    assessments,
    expectedRowIds: assessments.map((item) => item.rowId),
    guide: guide("both", "1", "70"),
  });
  const byId = new Map(results.map((item) => [item.rowId, item]));
  assert.equal(byId.get("high").recommendation, "progressed");
  assert.equal(byId.get("medium").recommendation, "not_progressed");
  assert.equal(byId.get("below").recommendation, "not_progressed");
  assert.equal(byId.get("below").reason, "minimum_score_result");
  assert.equal(byId.get("review").recommendation, "human_review");
  assert.equal(byId.get("review").rank, null);
});

test("ranking uses weighted score then guide criterion priority, never rowId", () => {
  const betterByTieBreak = assessment("z_last_alphabetically", { scores: [5, 3] });
  const worseByTieBreak = assessment("a_first_alphabetically", { scores: [4, 4] });
  const results = classifyPhase5Cohort({
    assessments: [worseByTieBreak, betterByTieBreak],
    expectedRowIds: [worseByTieBreak.rowId, betterByTieBreak.rowId],
    guide: guide("top_n", "1", ""),
  });
  const byId = new Map(results.map((item) => [item.rowId, item]));
  assert.equal(betterByTieBreak.weightedScore, worseByTieBreak.weightedScore);
  assert.equal(byId.get(betterByTieBreak.rowId).recommendation, "progressed");
  assert.equal(byId.get(worseByTieBreak.rowId).recommendation, "not_progressed");
});

test("an exact score-vector group crossing the boundary all goes to Human Review", () => {
  const assessments = [
    assessment("first", { scores: [5, 5] }),
    assessment("tie_one", { scores: [5, 4] }),
    assessment("tie_two", { scores: [5, 4] }),
    assessment("last", { scores: [4, 4] }),
  ];
  const results = classifyPhase5Cohort({
    assessments,
    expectedRowIds: assessments.map((item) => item.rowId),
    guide: guide("top_n", "2", ""),
  });
  const byId = new Map(results.map((item) => [item.rowId, item]));
  assert.equal(byId.get("first").recommendation, "progressed");
  assert.equal(byId.get("tie_one").recommendation, "human_review");
  assert.equal(byId.get("tie_two").recommendation, "human_review");
  assert.equal(byId.get("tie_one").reason, "shortlist_boundary_tie");
  assert.equal(byId.get("tie_two").rank, null);
  assert.equal(byId.get("last").recommendation, "not_progressed");
});

test("cohort output is identical when assessment input order changes", () => {
  const assessments = [
    assessment("one", { scores: [5, 5] }),
    assessment("two", { scores: [5, 4] }),
    assessment("three", { scores: [4, 5] }),
    assessment("four", { scores: [4, 4] }),
  ];
  const expectedRowIds = assessments.map((item) => item.rowId);
  const first = classifyPhase5Cohort({
    assessments,
    expectedRowIds,
    guide: guide("top_n", "2", ""),
  });
  const shuffled = classifyPhase5Cohort({
    assessments: [assessments[2], assessments[0], assessments[3], assessments[1]],
    expectedRowIds,
    guide: guide("top_n", "2", ""),
  });
  assert.deepEqual(shuffled, first);
});

test("partial, extra or duplicate assessment sets cannot produce cohort recommendations", () => {
  const one = assessment("one");
  const two = assessment("two");
  assert.throws(
    () =>
      classifyPhase5Cohort({
        assessments: [one],
        expectedRowIds: ["one", "two"],
        guide: guide(),
      }),
    /unavailable until every sealed current application/i,
  );
  assert.throws(
    () =>
      classifyPhase5Cohort({
        assessments: [one, two],
        expectedRowIds: ["one"],
        guide: guide(),
      }),
    /unavailable until every sealed current application/i,
  );
  assert.throws(
    () =>
      classifyPhase5Cohort({
        assessments: [one, { ...one }],
        expectedRowIds: ["one", "two"],
        guide: guide(),
      }),
    /unavailable until every sealed current application/i,
  );
  assert.throws(
    () =>
      classifyPhase5Cohort({
        assessments: [one, { ...two, runId: "different-run" }],
        expectedRowIds: ["one", "two"],
        guide: guide(),
      }),
    /unavailable until every sealed current application/i,
  );
});

test("evidence sample is deterministic, order-independent and capped at ten", () => {
  const assessments = Array.from({ length: 16 }, (_, index) =>
    assessment(`case_${String(index).padStart(2, "0")}`, {
      withEvidence: index !== 15,
    }),
  );
  const first = selectPhase5EvidenceReviewSampleIds(assessments, "run-seed", 99);
  const shuffled = selectPhase5EvidenceReviewSampleIds(
    [...assessments].reverse(),
    "run-seed",
    99,
  );
  assert.equal(first.length, 10);
  assert.deepEqual(shuffled, first);
  assert.ok(!first.includes("case_15"));
  assert.equal(new Set(first).size, first.length);
});

test("an invalid run cannot be retried until locked calibration inputs change", () => {
  const invalidContract = {
    phase4SessionId: "phase4-old",
    phase4MetricsHash: "metrics-old",
    guideContentHash: "guide-old",
    approvedPatternsHash: "patterns-old",
    expectedModelId: "model-old",
    promptVersion: PHASE5_PROMPT_VERSION,
    outputSchemaVersion: PHASE5_SCHEMA_VERSION,
    batchAlgorithm: PHASE5_BATCH_ALGORITHM,
    assessmentProtocolHash: "protocol-old",
  };
  const sameInputs = {
    ...invalidContract,
  };
  assert.equal(phase5RecoveryInputsDiffer(invalidContract, sameInputs), false);

  for (const [field, changedValue] of [
    ["phase4MetricsHash", "metrics-new"],
    ["guideContentHash", "guide-new"],
    ["approvedPatternsHash", "patterns-new"],
    ["expectedModelId", "model-new"],
    ["assessmentProtocolHash", "protocol-new"],
  ]) {
    assert.equal(
      phase5RecoveryInputsDiffer(invalidContract, {
        ...sameInputs,
        [field]: changedValue,
      }),
      true,
      `${field} should unlock a fresh immutable run`,
    );
  }
});
