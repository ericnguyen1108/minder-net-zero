import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiAssessmentGatewayError,
  createOpenAiAssessmentGateway,
} from "../lib/openai-assessment-gateway.ts";
import {
  PHASE4_ASSESS_CASES_FORMAT,
  PHASE4_BASE_INSTRUCTIONS,
  getPhase4AssessmentProtocolHash,
} from "../app/phase4-protocol.ts";

const API_KEY = "sk-test-12345678901234567890";
const PINNED_MODEL = "gpt-5.4-2026-06-01";

function guide() {
  return {
    version: 3,
    status: "approved",
    rules: [
      {
        id: "impact",
        kind: "criterion",
        title: "Climate impact",
        statement: "Assess the supported net-zero impact.",
        passingCondition: "Use only quantified or concrete submitted evidence.",
        evidence: "Quote the relevant current answer.",
        weight: 100,
        anchor1: "No credible impact is supported.",
        anchor3: "A plausible impact pathway is supported.",
        anchor5: "A quantified, credible impact pathway is supported.",
      },
    ],
    selection: { mode: "minimum_score", shortlistTarget: "20", minimumScore: "70" },
    tieBreakPriority: [],
    clarificationPolicy: "not_allowed",
  };
}

function cases() {
  return [
    {
      rowId: "opaque-case-001",
      answers: [
        {
          heading: "Climate impact",
          value: "Our verified pilot reduces emissions by 42 percent for each installation.",
        },
      ],
      teamName: "DO-NOT-SEND-TEAM",
      reviewerNotes: "DO-NOT-SEND-NOTES",
      outcome: "progressed",
    },
  ];
}

function validOutput(quote = "reduces emissions by 42 percent") {
  return {
    assessments: [
      {
        rowId: "opaque-case-001",
        eligibilityChecks: [],
        eliminationChecks: [],
        criterionScores: [
          {
            ruleId: "impact",
            score: 5,
            evidence: { answerIndex: 0, quote },
            explanation: "The submitted answer provides a quantified pilot result.",
          },
        ],
        uncertainties: [],
      },
    ],
  };
}

function providerPayload(overrides = {}) {
  return {
    id: "resp_gateway_test_001",
    object: "response",
    created_at: 1_784_220_000,
    status: "completed",
    incomplete_details: null,
    model: PINNED_MODEL,
    store: false,
    instructions: "DO-NOT-RETURN-PROVIDER-ECHO",
    metadata: { unsafeEcho: "DO-NOT-RETURN-METADATA" },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(validOutput()) }],
      },
    ],
    usage: { input_tokens: 800, output_tokens: 140, total_tokens: 940 },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function approvedBatch(overrides = {}) {
  return {
    assessmentProtocolHash: await getPhase4AssessmentProtocolHash(),
    guide: guide(),
    cases: cases(),
    approvedPatterns: [],
    ...overrides,
  };
}

function assertGatewayError(error, code) {
  assert.ok(error instanceof OpenAiAssessmentGatewayError);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /sk-test|42 percent|DO-NOT-SEND|Bearer/i);
  return true;
}

test("requires an explicit API key and pinned model without hidden fallbacks", () => {
  assert.throws(
    () => createOpenAiAssessmentGateway({ apiKey: "", pinnedModel: PINNED_MODEL }),
    (error) => assertGatewayError(error, "invalid_configuration"),
  );
  assert.throws(
    () => createOpenAiAssessmentGateway({ apiKey: API_KEY, pinnedModel: "" }),
    (error) => assertGatewayError(error, "invalid_configuration"),
  );
  assert.throws(
    () => createOpenAiAssessmentGateway({ apiKey: ` ${API_KEY}`, pinnedModel: PINNED_MODEL }),
    (error) => assertGatewayError(error, "invalid_configuration"),
  );
});

test("sends only blind allow-listed input with store false and the strict Phase 4 schema", async () => {
  let requestUrl;
  let requestInit;
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    fetchImplementation: async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return jsonResponse(providerPayload());
    },
  });

  const result = await gateway.assessBatch(await approvedBatch());
  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestInit.method, "POST");
  assert.equal(requestInit.headers.Authorization, `Bearer ${API_KEY}`);
  assert.ok(requestInit.signal instanceof AbortSignal);

  const body = JSON.parse(requestInit.body);
  assert.equal(body.model, PINNED_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.instructions, PHASE4_BASE_INSTRUCTIONS);
  assert.equal(body.max_output_tokens, 12_000);
  assert.deepEqual(body.text.format, PHASE4_ASSESS_CASES_FORMAT);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.doesNotMatch(body.input, /DO-NOT-SEND|reviewerNotes|teamName/);
  const safeInput = JSON.parse(body.input.split("Safe input:\n")[1]);
  assert.deepEqual(Object.keys(safeInput.cases[0]).sort(), ["answers", "rowId"]);
  assert.deepEqual(Object.keys(safeInput.cases[0].answers[0]).sort(), ["heading", "value"]);

  assert.deepEqual(Object.keys(result).sort(), [
    "assessmentProtocolHash",
    "provider",
    "results",
  ]);
  assert.deepEqual(Object.keys(result.provider).sort(), [
    "createdAt",
    "model",
    "provider",
    "responseId",
    "status",
    "usage",
  ]);
  assert.deepEqual(result.provider, {
    provider: "openai",
    responseId: "resp_gateway_test_001",
    model: PINNED_MODEL,
    status: "completed",
    createdAt: 1_784_220_000,
    usage: { inputTokens: 800, outputTokens: 140, totalTokens: 940 },
  });
  assert.equal(result.results[0].weightedScore, 100);
  assert.equal(result.results[0].classification.recommendation, "progressed");
  assert.equal(result.results[0].assessment.criterionScores[0].evidence.quote, "reduces emissions by 42 percent");
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-RETURN|DO-NOT-SEND/);
});

test("rejects stale protocol approval and sensitive headings before any provider call", async () => {
  let calls = 0;
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    fetchImplementation: async () => {
      calls += 1;
      return jsonResponse(providerPayload());
    },
  });

  await assert.rejects(
    gateway.assessBatch(await approvedBatch({ assessmentProtocolHash: "0".repeat(64) })),
    (error) => assertGatewayError(error, "assessment_protocol_mismatch"),
  );
  const unsafeCases = [{ rowId: "opaque-2", answers: [{ heading: "Reviewer score", value: "99" }] }];
  await assert.rejects(
    gateway.assessBatch(await approvedBatch({ cases: unsafeCases })),
    (error) => assertGatewayError(error, "invalid_assessment_input"),
  );
  assert.equal(calls, 0);
});

test("rejects provider model drift even when the structured result is otherwise valid", async () => {
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    fetchImplementation: async () =>
      jsonResponse(providerPayload({ model: "gpt-5.4-2026-07-01" })),
  });
  await assert.rejects(
    gateway.assessBatch(await approvedBatch()),
    (error) => assertGatewayError(error, "provider_model_mismatch"),
  );
});

test("rejects refusals and every incomplete response shape", async (context) => {
  const casesToReject = [
    {
      name: "refusal content",
      expected: "provider_refusal",
      payload: providerPayload({
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "refusal", refusal: "Cannot comply" }],
          },
        ],
      }),
    },
    {
      name: "top-level incomplete status",
      expected: "provider_incomplete",
      payload: providerPayload({ status: "incomplete" }),
    },
    {
      name: "incomplete details",
      expected: "provider_incomplete",
      payload: providerPayload({ incomplete_details: { reason: "max_output_tokens" } }),
    },
    {
      name: "incomplete message",
      expected: "provider_incomplete",
      payload: providerPayload({
        output: [
          {
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(validOutput()) }],
          },
        ],
      }),
    },
  ];

  for (const scenario of casesToReject) {
    await context.test(scenario.name, async () => {
      const gateway = createOpenAiAssessmentGateway({
        apiKey: API_KEY,
        pinnedModel: PINNED_MODEL,
        fetchImplementation: async () => jsonResponse(scenario.payload),
      });
      await assert.rejects(
        gateway.assessBatch(await approvedBatch()),
        (error) => assertGatewayError(error, scenario.expected),
      );
    });
  }
});

test("rejects schema-valid-looking output when exact current evidence validation fails", async () => {
  const payload = providerPayload({
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(validOutput("invented evidence not present in the answer")),
          },
        ],
      },
    ],
  });
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    fetchImplementation: async () => jsonResponse(payload),
  });
  await assert.rejects(
    gateway.assessBatch(await approvedBatch()),
    (error) => assertGatewayError(error, "assessment_validation_failed"),
  );
});

test("aborts the provider call at the configured timeout", async () => {
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    timeoutMs: 5,
    fetchImplementation: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    gateway.assessBatch(await approvedBatch()),
    (error) => {
      assertGatewayError(error, "provider_timeout");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("does not read or expose an upstream error body", async () => {
  let bodyRead = false;
  const gateway = createOpenAiAssessmentGateway({
    apiKey: API_KEY,
    pinnedModel: PINNED_MODEL,
    fetchImplementation: async () => {
      const response = jsonResponse({ secretEcho: "DO-NOT-READ-ERROR-BODY" }, 401);
      const originalText = response.text.bind(response);
      response.text = async () => {
        bodyRead = true;
        return originalText();
      };
      return response;
    },
  });
  await assert.rejects(
    gateway.assessBatch(await approvedBatch()),
    (error) => {
      assertGatewayError(error, "provider_rejected");
      assert.equal(error.providerStatus, 401);
      return true;
    },
  );
  assert.equal(bodyRead, false);
});
