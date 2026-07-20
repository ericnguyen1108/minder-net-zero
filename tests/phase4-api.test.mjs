import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET, POST } from "../app/api/phase4/route.ts";
import { createSessionToken } from "../app/auth.ts";
import {
  buildPhase4AssessmentModelInput,
  getPhase4AssessmentProtocolHash,
  resolvePhase4AssessmentEvidence,
} from "../app/phase4-protocol.ts";

const guide = {
  version: 1,
  status: "approved",
  rules: [
    {
      id: "impact",
      kind: "criterion",
      title: "Climate impact",
      statement: "Assess the stated climate impact.",
      passingCondition: "",
      evidence: "Use submitted text only.",
      weight: 100,
      anchor1: "Impact is unsupported.",
      anchor3: "Impact has some support.",
      anchor5: "Impact is quantified and credible.",
    },
  ],
  selection: { mode: "minimum_score", shortlistTarget: "20", minimumScore: "70" },
  tieBreakPriority: [],
  clarificationPolicy: "not_allowed",
};

function localRequest(path = "/api/phase4", init = {}) {
  // A constructed Request carries no Host header; the app authorizes localhost
  // by the Host header, so set it explicitly for these local bypass cases.
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", ...(init.headers ?? {}) },
  });
}

test("evidence span IDs are unique across a batch and cannot cross cases", () => {
  const currentCases = [
    {
      rowId: "case-a",
      answers: [{ heading: "Impact", value: "First case evidence." }],
    },
    {
      rowId: "case-b",
      answers: [{ heading: "Impact", value: "Second case evidence." }],
    },
  ];
  const input = buildPhase4AssessmentModelInput({
    action: "assess_cases",
    guide,
    approvedPatterns: [],
    cases: currentCases,
  });
  const safeInput = JSON.parse(input.split("Safe input:\n")[1]);
  assert.equal(safeInput.cases[0].answers[0].evidenceSpans[0].spanId, "c0-a0-s0");
  assert.equal(safeInput.cases[1].answers[0].evidenceSpans[0].spanId, "c1-a0-s0");

  const resolved = resolvePhase4AssessmentEvidence(
    {
      assessments: [
        {
          rowId: "case-b",
          eligibilityChecks: [],
          eliminationChecks: [],
          criterionScores: [
            {
              ruleId: "impact",
              score: 5,
              evidence: { spanId: "c0-a0-s0" },
              explanation: "Wrong case span.",
            },
          ],
          uncertainties: [],
        },
      ],
    },
    currentCases,
  );
  assert.deepEqual(resolved.assessments[0].criterionScores[0].evidence, {
    answerIndex: -1,
    quote: "",
  });
});

test("reports a server-managed but unconfigured AI connection without exposing a key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const response = await GET(localRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      assessmentProtocolHash: await getPhase4AssessmentProtocolHash(),
      ai: { configured: false, state: "not_configured", serverManaged: true },
    });
    const post = await POST(
      localRequest("/api/phase4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discover_patterns", guide, rows: [] }),
      }),
    );
    assert.equal(post.status, 503);
    assert.doesNotMatch(JSON.stringify(await post.json()), /OPENAI_API_KEY|Bearer\s/i);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("requires a valid session away from localhost; spoofed legacy headers do not count", async () => {
  const response = await GET(new Request("https://minder.example/api/phase4"));
  assert.equal(response.status, 401);

  // The legacy ChatGPT-proxy header must no longer grant access: it is
  // client-forgeable on any self-hosted deployment.
  const forgedHeader = await GET(
    new Request("https://minder.example/api/phase4", {
      headers: { "oai-authenticated-user-email": "attacker@evil.example" },
    }),
  );
  assert.equal(forgedHeader.status, 401);

  const garbageCookie = await GET(
    new Request("https://minder.example/api/phase4", {
      headers: { cookie: "minder_session=v1.9999999999999.forged-signature" },
    }),
  );
  assert.equal(garbageCookie.status, 401);

  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "phase4-api-test-secret";
  try {
    const token = await createSessionToken("phase4-api-test-secret", Date.now() + 60_000);
    const authed = await GET(
      new Request("https://minder.example/api/phase4", {
        headers: { cookie: `minder_session=${token}` },
      }),
    );
    assert.equal(authed.status, 200);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("Unauthenticated requests must not reach OpenAI.");
  };
  try {
    const post = await POST(
      new Request("https://minder.example/api/phase4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(post.status, 401);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const crossSite = await GET(
    new Request("https://minder.example/api/phase4", {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    }),
  );
  assert.equal(crossSite.status, 403);
});

test("rejects sealed outcomes and identity fields before calling OpenAI", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-server-only-key";
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("Unsafe blind payloads must not reach OpenAI.");
  };

  try {
    for (const extra of [
      { outcome: "progressed" },
      { teamName: "DO-NOT-SEND-TEAM" },
    ]) {
      const response = await POST(
        localRequest("/api/phase4", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "assess_cases",
            guide,
            approvedPatterns: [],
            cases: [
              {
                row_id: "sealed-1",
                answers: [{ heading: "Impact", value: "We expect measurable reductions." }],
                ...extra,
              },
            ],
          }),
        }),
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_request");
    }
    for (const heading of [
      "Team name",
      "Application ID",
      "Outcome",
      "Reviewer notes",
      "Judge score",
      "Total score",
      "Gender",
      "team_name",
      "application-id",
      "final_outcome",
      "reviewer.notes",
      "judge_score",
      "total-score",
      "challenge_track",
    ]) {
      const response = await POST(
        localRequest("/api/phase4", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "assess_cases",
            guide,
            approvedPatterns: [],
            cases: [
              {
                row_id: "sealed-sensitive-heading",
                answers: [{ heading, value: "DO-NOT-SEND" }],
              },
            ],
          }),
        }),
      );
      assert.equal(response.status, 400, heading);
      assert.equal((await response.json()).error.code, "unsafe_fields", heading);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("rejects hallucinated assessment evidence at the server boundary", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-server-only-key";
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({
      model: "gpt-5.6-terra",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                assessments: [
                  {
                    rowId: "sealed-1",
                    eligibilityChecks: [],
                    eliminationChecks: [],
                    criterionScores: [
                      {
                        ruleId: "impact",
                        score: 5,
                        evidence: { spanId: "c0-a0-s999" },
                        explanation: "The claimed impact is high.",
                      },
                    ],
                    uncertainties: [],
                  },
                ],
              }),
            },
          ],
        },
      ],
    });
  };

  try {
    const response = await POST(
      localRequest("/api/phase4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "assess_cases",
          guide,
          approvedPatterns: [],
          cases: [
            {
              row_id: "sealed-1",
              answers: [{ heading: "Impact", value: "We expect measurable reductions." }],
            },
          ],
        }),
      }),
    );
    assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.equal(error.code, "invalid_ai_response");
    assert.equal(error.validationReason, "criterion_evidence_answer_index_invalid");
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("sends only strict, non-stored structured requests through the server gateway", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-server-only-key";
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({
      model: "gpt-5.6-terra",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                patterns: [
                  {
                    patternKey: "impact-quantification",
                    kind: "criterion_anchor_example",
                    targetRuleId: "impact",
                    title: "Quantified impact",
                    proposedInterpretation: "Quantified outcomes clarify the existing impact anchor.",
                    evidence: [
                      { rowId: "teaching-1", answerIndex: 0, quote: "12,000 tonnes" },
                    ],
                    supportingRowIds: ["teaching-1"],
                    contradictingRowIds: [],
                    risk: "guide_aligned",
                  },
                ],
                limitations: [],
              }),
            },
          ],
        },
      ],
    });
  };

  try {
    const response = await POST(
      localRequest("/api/phase4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "discover_patterns",
          guide,
          rows: [
            {
              row_id: "teaching-1",
              answers: [{ heading: "Impact", value: "We expect to avoid 12,000 tonnes annually." }],
              outcome: "progressed",
            },
          ],
        }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(captured.url, "https://api.openai.com/v1/responses");
    const upstreamBody = JSON.parse(captured.init.body);
    assert.equal(upstreamBody.store, false);
    assert.equal(upstreamBody.text.format.strict, true);
    assert.equal(upstreamBody.text.format.type, "json_schema");
    assert.match(captured.init.headers.Authorization, /^Bearer test-server-only-key$/);
    const publicBody = JSON.stringify(await response.json());
    assert.doesNotMatch(publicBody, /test-server-only-key|Authorization|Bearer/i);
    assert.doesNotMatch(publicBody, /assessmentProtocolHash/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("keeps OpenAI credentials and direct OpenAI calls out of client modules", async () => {
  const [page, phase4, logic, storage, route, protocol] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-logic.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/phase4/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-protocol.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${page}\n${phase4}\n${logic}\n${storage}`, /OPENAI_API_KEY|api\.openai\.com/);
  assert.match(route, /OPENAI_API_KEY/);
  assert.match(route, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(protocol, /storeResponse:\s*false/);
});
