import {
  PHASE4_ASSESSMENT_REQUEST_PROTOCOL,
  PHASE4_ASSESS_CASES_FORMAT,
  PHASE4_BASE_INSTRUCTIONS,
  buildPhase4AssessmentModelInput,
  getPhase4AssessmentProtocolHash,
} from "../../phase4-protocol.ts";
import { isSensitiveAssessmentHeading } from "../../assessment-safety.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_REQUEST_BYTES = PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxRequestBytes;
const MAX_TEACHING_ROWS = 12;
const MAX_BLIND_CASES = PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxCases;
const MAX_ANSWERS_PER_ROW = PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxAnswersPerRow;
const MAX_ROW_TEXT_CHARS = PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxRowTextChars;
const MAX_GUIDE_RULES = PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxGuideRules;
const MAX_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 25_000;

type RuleKind = "eligibility" | "elimination" | "criterion";
type CanonicalOutcome =
  | "progressed"
  | "not_progressed"
  | "waitlist"
  | "ineligible";

type RuntimeEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
};

type SafeAnswer = {
  heading: string;
  value: string;
};

type SafeTeachingRow = {
  rowId: string;
  answers: SafeAnswer[];
  outcome: CanonicalOutcome;
};

type SafeBlindCase = {
  rowId: string;
  answers: SafeAnswer[];
};

type SafeRule = {
  id: string;
  kind: RuleKind;
  title: string;
  statement: string;
  passingCondition: string;
  evidence: string;
  weight: number;
  anchor1: string;
  anchor3: string;
  anchor5: string;
};

type SafeGuide = {
  version: number;
  status: "approved";
  rules: SafeRule[];
  selection: {
    mode: "top_n" | "minimum_score" | "both";
    shortlistTarget: string;
    minimumScore: string;
  };
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed";
};

type ApprovedPattern = {
  id: string;
  targetRuleId: string;
  proposedInterpretation: string;
};

type DiscoverRequest = {
  action: "discover_patterns";
  guide: SafeGuide;
  rows: SafeTeachingRow[];
};

type AssessRequest = {
  action: "assess_cases";
  guide: SafeGuide;
  cases: SafeBlindCase[];
  approvedPatterns: ApprovedPattern[];
};

type ParsedRequest = DiscoverRequest | AssessRequest;

class PublicApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(
    status: number,
    code: string,
    publicMessage: string,
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

class UpstreamError extends Error {
  readonly timedOut: boolean;

  constructor(timedOut: boolean) {
    super(timedOut ? "upstream_timeout" : "upstream_unavailable");
    this.timedOut = timedOut;
  }
}

const patternEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rowId: { type: "string", minLength: 1, maxLength: 300 },
    answerIndex: { type: "integer", minimum: 0 },
    quote: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["rowId", "answerIndex", "quote"],
} as const;

const DISCOVER_PATTERNS_FORMAT = {
  type: "json_schema",
  name: "minder_phase4_pattern_observations",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      patterns: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            patternKey: { type: "string", minLength: 1, maxLength: 100 },
            kind: {
              type: "string",
              enum: [
                "criterion_anchor_example",
                "eligibility_example",
                "elimination_example",
                "ambiguity",
                "historical_conflict",
                "possible_policy_gap",
              ],
            },
            targetRuleId: { type: "string", maxLength: 300 },
            title: { type: "string", minLength: 1, maxLength: 160 },
            proposedInterpretation: {
              type: "string",
              minLength: 1,
              maxLength: 2_000,
            },
            evidence: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: patternEvidenceSchema,
            },
            supportingRowIds: {
              type: "array",
              maxItems: 12,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            contradictingRowIds: {
              type: "array",
              maxItems: 12,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            risk: {
              type: "string",
              enum: [
                "guide_aligned",
                "possible_bias",
                "inconsistent_history",
                "conflicts_with_guide",
              ],
            },
          },
          required: [
            "patternKey",
            "kind",
            "targetRuleId",
            "title",
            "proposedInterpretation",
            "evidence",
            "supportingRowIds",
            "contradictingRowIds",
            "risk",
          ],
        },
      },
      limitations: {
        type: "array",
        maxItems: 10,
        items: { type: "string", maxLength: 500 },
      },
    },
    required: ["patterns", "limitations"],
  },
} as const;

export async function GET(request: Request) {
  const accessError = checkAccess(request);
  if (accessError) return accessError;

  const runtime = await getRuntimeEnv();
  const configured = Boolean(runtime.OPENAI_API_KEY?.trim());
  return json(
    {
      assessmentProtocolHash: await getPhase4AssessmentProtocolHash(),
      ai: {
        configured,
        state: configured ? "ready" : "not_configured",
        serverManaged: true,
      },
    },
    200,
  );
}

export async function POST(request: Request) {
  const accessError = checkAccess(request);
  if (accessError) return accessError;

  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new PublicApiError(
        415,
        "json_required",
        "This endpoint accepts JSON requests only.",
      );
    }

    const runtime = await getRuntimeEnv();
    const apiKey = runtime.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new PublicApiError(
        503,
        "ai_not_configured",
        "Managed AI is not connected. Ask a Minder administrator to configure it.",
      );
    }
    const model = runtime.OPENAI_MODEL?.trim() || DEFAULT_MODEL;

    const parsed = parseRequest(await readJsonBody(request));
    const format =
      parsed.action === "discover_patterns"
        ? DISCOVER_PATTERNS_FORMAT
        : PHASE4_ASSESS_CASES_FORMAT;
    const input = buildModelInput(parsed);

    const upstream = await callResponsesApi({
      apiKey,
      model,
      input,
      format,
      maxOutputTokens:
        parsed.action === "discover_patterns"
          ? 6_000
          : PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxOutputTokens,
    });
    const resolvedModel = readStringField(upstream, "model");
    if (!resolvedModel) {
      throw new PublicApiError(
        502,
        "invalid_ai_response",
        "The AI service did not identify the model used. Nothing was saved.",
      );
    }
    const outputText = extractOutputText(upstream);
    if (!outputText) {
      throw new PublicApiError(
        502,
        "invalid_ai_response",
        "The AI service returned no usable structured result. Nothing was saved.",
      );
    }

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(outputText) as unknown;
    } catch {
      throw new PublicApiError(
        502,
        "invalid_ai_response",
        "The AI service returned an invalid structured result. Nothing was saved.",
      );
    }

    const result =
      parsed.action === "discover_patterns"
        ? normalizePatternResult(rawResult, parsed)
        : normalizeAssessmentResult(rawResult, parsed);

    const responseBody: Record<string, unknown> = {
      action: parsed.action,
      requestedModel: model,
      model: resolvedModel,
      result,
    };
    if (parsed.action === "assess_cases") {
      responseBody.assessmentProtocolHash = await getPhase4AssessmentProtocolHash();
    }
    return json(responseBody, 200);
  } catch (error) {
    if (error instanceof PublicApiError) {
      return json(
        { error: { code: error.code, message: error.publicMessage } },
        error.status,
      );
    }
    if (error instanceof UpstreamError) {
      return json(
        {
          error: {
            code: error.timedOut ? "ai_timeout" : "ai_unavailable",
            message: error.timedOut
              ? "The AI service timed out after limited retries. Nothing was saved."
              : "The AI service is temporarily unavailable. Nothing was saved.",
          },
        },
        error.timedOut ? 504 : 502,
      );
    }
    return json(
      {
        error: {
          code: "phase4_failed",
          message: "Phase 4 could not complete safely. Nothing was saved.",
        },
      },
      500,
    );
  }
}

async function getRuntimeEnv(): Promise<RuntimeEnv> {
  const nodeEnv: RuntimeEnv =
    typeof process === "undefined"
      ? {}
      : {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_MODEL: process.env.OPENAI_MODEL,
        };
  try {
    const cloudflare = (await import("cloudflare:workers")) as unknown as {
      env?: RuntimeEnv;
    };
    return {
      OPENAI_API_KEY: nodeEnv.OPENAI_API_KEY ?? cloudflare.env?.OPENAI_API_KEY,
      OPENAI_MODEL: nodeEnv.OPENAI_MODEL ?? cloudflare.env?.OPENAI_MODEL,
    };
  } catch {
    return nodeEnv;
  }
}

function json(value: unknown, status: number) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function checkAccess(request: Request): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(
      { error: { code: "forbidden", message: "This request was not allowed." } },
      403,
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(origin).origin;
    } catch {
      return json(
        { error: { code: "forbidden", message: "This request was not allowed." } },
        403,
      );
    }
    if (requestOrigin !== url.origin) {
      return json(
        { error: { code: "forbidden", message: "This request was not allowed." } },
        403,
      );
    }
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return json(
      { error: { code: "forbidden", message: "This request was not allowed." } },
      403,
    );
  }

  if (isLocalHost(url.hostname)) return null;
  if (!request.headers.get("oai-authenticated-user-email")?.trim()) {
    return json(
      {
        error: {
          code: "authentication_required",
          message: "Sign in through the private Minder Net Zero site to continue.",
        },
      },
      401,
    );
  }
  return null;
}

function isLocalHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_REQUEST_BYTES) {
      throw new PublicApiError(
        413,
        "request_too_large",
        "This calibration batch is too large. Use a smaller batch.",
      );
    }
  }
  if (!request.body) {
    throw new PublicApiError(400, "invalid_request", "A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new PublicApiError(
          413,
          "request_too_large",
          "This calibration batch is too large. Use a smaller batch.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function parseRequest(value: unknown): ParsedRequest {
  const source = requireRecord(value, "The Phase 4 request must be a JSON object.");
  const action = source.action;
  if (action !== "discover_patterns" && action !== "assess_cases") {
    throw invalid("Choose a supported Phase 4 action.");
  }

  const allowed =
    action === "discover_patterns"
      ? ["action", "guide", "rows"]
      : [...PHASE4_ASSESSMENT_REQUEST_PROTOCOL.requestKeys];
  requireOnlyKeys(source, allowed, "The request contains unsupported fields.");
  const guide = parseGuide(source.guide);

  if (action === "discover_patterns") {
    if (!Array.isArray(source.rows) || source.rows.length < 1 || source.rows.length > MAX_TEACHING_ROWS) {
      throw invalid(`Use between 1 and ${MAX_TEACHING_ROWS} teaching rows per batch.`);
    }
    const rows = parseRows(source.rows, true) as SafeTeachingRow[];
    return { action, guide, rows };
  }

  if (!Array.isArray(source.cases) || source.cases.length < 1 || source.cases.length > MAX_BLIND_CASES) {
    throw invalid(`Use between 1 and ${MAX_BLIND_CASES} blind cases per batch.`);
  }
  const cases = parseRows(source.cases, false) as SafeBlindCase[];
  const approvedPatterns = parseApprovedPatterns(source.approvedPatterns, guide);
  return { action, guide, cases, approvedPatterns };
}

function parseRows(values: unknown[], labelled: boolean) {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const row = requireRecord(value, `Row ${index + 1} must be an object.`);
    requireOnlyKeys(
      row,
      labelled
        ? ["answers", "outcome", "rowId", "row_id"]
        : [...PHASE4_ASSESSMENT_REQUEST_PROTOCOL.caseKeys],
      `Row ${index + 1} contains unsupported fields.`,
    );
    const hasCamelId = Object.hasOwn(row, "rowId");
    const hasSnakeId = Object.hasOwn(row, "row_id");
    if (hasCamelId === hasSnakeId) {
      throw invalid(`Row ${index + 1} must contain exactly one row identifier.`);
    }
    const rowId = boundedString(hasCamelId ? row.rowId : row.row_id, 300);
    if (!rowId || seen.has(rowId)) {
      throw invalid(`Row ${index + 1} has a missing or duplicate row identifier.`);
    }
    seen.add(rowId);
    const answers = parseAnswers(row.answers, index);
    if (!labelled) return { rowId, answers };

    const outcome = row.outcome;
    if (!isCanonicalOutcome(outcome)) {
      throw invalid(`Teaching row ${index + 1} has no supported outcome.`);
    }
    return { rowId, answers, outcome };
  });
}

function parseAnswers(value: unknown, rowIndex: number): SafeAnswer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ANSWERS_PER_ROW) {
    throw invalid(
      `Row ${rowIndex + 1} must contain between 1 and ${MAX_ANSWERS_PER_ROW} answers.`,
    );
  }
  let total = 0;
  const answers = value.map((answer, answerIndex) => {
    const source = requireRecord(
      answer,
      `Answer ${answerIndex + 1} in row ${rowIndex + 1} must be an object.`,
    );
    requireOnlyKeys(
      source,
      [...PHASE4_ASSESSMENT_REQUEST_PROTOCOL.answerKeys],
      `Answer ${answerIndex + 1} in row ${rowIndex + 1} contains unsupported fields.`,
    );
    const heading = boundedString(source.heading, 400, true);
    const answerValue = boundedString(source.value, 30_000);
    if (heading === null || answerValue === null) {
      throw invalid(`Answer ${answerIndex + 1} in row ${rowIndex + 1} is invalid or too long.`);
    }
    if (isSensitiveAssessmentHeading(heading)) {
      throw new PublicApiError(
        400,
        "unsafe_fields",
        `Answer ${answerIndex + 1} in row ${rowIndex + 1} is an identity, outcome, reviewer or score column and cannot be sent to AI.`,
      );
    }
    total += heading.length + answerValue.length;
    return { heading, value: answerValue };
  });
  if (total > MAX_ROW_TEXT_CHARS) {
    throw invalid(`Row ${rowIndex + 1} is too long. Use a smaller answer set.`);
  }
  return answers;
}

function parseGuide(value: unknown): SafeGuide {
  const source = requireRecord(value, "An approved decision guide is required.");
  if (source.status !== "approved") {
    throw invalid("Only an approved decision guide can be used in Phase 4.");
  }
  if (!Number.isInteger(source.version) || Number(source.version) < 1) {
    throw invalid("The approved decision guide has no valid version.");
  }
  if (!Array.isArray(source.rules) || source.rules.length < 1 || source.rules.length > MAX_GUIDE_RULES) {
    throw invalid(`The approved guide must contain between 1 and ${MAX_GUIDE_RULES} rules.`);
  }

  const seen = new Set<string>();
  let criterionWeight = 0;
  let criterionCount = 0;
  const rules = source.rules.map((value, index) => {
    const rule = requireRecord(value, `Guide rule ${index + 1} is invalid.`);
    const id = boundedString(rule.id, 300);
    const kind = rule.kind;
    if (!id || seen.has(id) || !isRuleKind(kind)) {
      throw invalid(`Guide rule ${index + 1} has an invalid or duplicate ID or kind.`);
    }
    seen.add(id);
    const title = boundedString(rule.title, 300);
    const statement = boundedString(rule.statement, 4_000);
    const passingCondition = boundedString(rule.passingCondition, 4_000, true);
    const evidence = boundedString(rule.evidence, 4_000, true);
    const anchor1 = boundedString(rule.anchor1, 4_000, true);
    const anchor3 = boundedString(rule.anchor3, 4_000, true);
    const anchor5 = boundedString(rule.anchor5, 4_000, true);
    const weight = Number(rule.weight);
    if (
      title === null ||
      statement === null ||
      passingCondition === null ||
      evidence === null ||
      anchor1 === null ||
      anchor3 === null ||
      anchor5 === null ||
      !Number.isInteger(weight) ||
      weight < 0 ||
      weight > 100
    ) {
      throw invalid(`Guide rule ${index + 1} is incomplete or invalid.`);
    }
    if (kind === "criterion") {
      if (weight < 1 || !anchor1 || !anchor3 || !anchor5) {
        throw invalid(`Criterion ${index + 1} needs a weight and all three scoring anchors.`);
      }
      criterionCount += 1;
      criterionWeight += weight;
    }
    return {
      id,
      kind,
      title,
      statement,
      passingCondition,
      evidence,
      weight,
      anchor1,
      anchor3,
      anchor5,
    };
  });
  if (criterionCount < 1 || criterionWeight !== 100) {
    throw invalid("The approved guide criteria must have weights that total 100.");
  }

  const selectionSource = requireRecord(source.selection, "The guide selection method is invalid.");
  const mode = selectionSource.mode;
  if (mode !== "top_n" && mode !== "minimum_score" && mode !== "both") {
    throw invalid("The guide selection method is invalid.");
  }
  const shortlistTarget = boundedString(selectionSource.shortlistTarget, 100, true);
  const minimumScore = boundedString(selectionSource.minimumScore, 100, true);
  if (shortlistTarget === null || minimumScore === null) {
    throw invalid("The guide selection settings are invalid.");
  }
  if ((mode === "minimum_score" || mode === "both") && !validMinimumScore(minimumScore)) {
    throw invalid("The guide minimum score must be a whole number from 1 to 100.");
  }

  if (!Array.isArray(source.tieBreakPriority) || source.tieBreakPriority.length > MAX_GUIDE_RULES) {
    throw invalid("The guide has too many tie-break rules.");
  }
  const tieBreakPriority = source.tieBreakPriority.map((item) => boundedString(item, 300));
  if (tieBreakPriority.some((item) => item === null)) {
    throw invalid("The guide tie-break rules are invalid.");
  }
  const clarificationPolicy = source.clarificationPolicy;
  if (clarificationPolicy !== "allowed" && clarificationPolicy !== "not_allowed") {
    throw invalid("The guide clarification policy is invalid.");
  }

  return {
    version: Number(source.version),
    status: "approved",
    rules,
    selection: { mode, shortlistTarget, minimumScore },
    tieBreakPriority: tieBreakPriority as string[],
    clarificationPolicy,
  };
}

function parseApprovedPatterns(value: unknown, guide: SafeGuide): ApprovedPattern[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxApprovedPatterns
  ) {
    throw invalid("Approved historical context is invalid or too large.");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const source = requireRecord(item, `Approved pattern ${index + 1} is invalid.`);
    requireOnlyKeys(
      source,
      [...PHASE4_ASSESSMENT_REQUEST_PROTOCOL.approvedPatternKeys],
      `Approved pattern ${index + 1} contains unsupported fields.`,
    );
    const id = boundedString(source.id, 300);
    const targetRuleId = boundedString(source.targetRuleId, 300);
    const proposedInterpretation = boundedString(source.proposedInterpretation, 2_000);
    if (
      !id ||
      !targetRuleId ||
      !proposedInterpretation ||
      seen.has(id) ||
      !guide.rules.some((rule) => rule.id === targetRuleId)
    ) {
      throw invalid(`Approved pattern ${index + 1} is incomplete or duplicated.`);
    }
    seen.add(id);
    return { id, targetRuleId, proposedInterpretation };
  });
}

function buildModelInput(parsed: ParsedRequest) {
  if (parsed.action === "discover_patterns") {
    return `Task: identify cautious teaching examples and conflicts in the labelled historical examples. Outcomes may be used only to compare patterns. A guide-aligned example must target exactly one existing rule. A possible policy gap may use an empty targetRuleId but can never become an approved rule. Use short verbatim evidence from the supplied answers, with its opaque rowId and zero-based answerIndex. Every supporting, contradicting, and evidence row ID must come from this batch. Do not report identity or unique details outside those minimal evidence quotes. If history conflicts with the guide, flag it; never turn history into a rule.\n\nSafe input:\n${JSON.stringify(parsed)}`;
  }
  return buildPhase4AssessmentModelInput(parsed);
}

async function callResponsesApi(input: {
  apiKey: string;
  model: string;
  input: string;
  format: typeof DISCOVER_PATTERNS_FORMAT | typeof PHASE4_ASSESS_CASES_FORMAT;
  maxOutputTokens: number;
}): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    model: input.model,
    store: PHASE4_ASSESSMENT_REQUEST_PROTOCOL.storeResponse,
    instructions: PHASE4_BASE_INSTRUCTIONS,
    input: input.input,
    max_output_tokens: input.maxOutputTokens,
    text: { format: input.format },
  });

  let lastTimedOut = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      lastTimedOut = false;
    } catch (error) {
      const timedOut = controller.signal.aborted || isAbortError(error);
      lastTimedOut = timedOut;
      if (!timedOut || attempt === MAX_ATTEMPTS) {
        throw new UpstreamError(timedOut);
      }
      await delay(retryDelay(attempt));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      let value: unknown;
      try {
        value = (await response.json()) as unknown;
      } catch {
        throw new UpstreamError(false);
      }
      if (!isRecord(value)) throw new UpstreamError(false);
      return value;
    }

    const retryable =
      response.status === 408 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new PublicApiError(
          502,
          "ai_configuration_error",
          "The managed AI connection needs administrator attention. Nothing was saved.",
        );
      }
      throw new UpstreamError(false);
    }
    await delay(readRetryAfter(response.headers.get("retry-after")) ?? retryDelay(attempt));
  }
  throw new UpstreamError(lastTimedOut);
}

function extractOutputText(response: Record<string, unknown>): string | null {
  const fragments: string[] = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (!isRecord(content)) continue;
        if (content.type === "refusal") return null;
        if (content.type === "output_text" && typeof content.text === "string") {
          fragments.push(content.text);
        }
      }
    }
  }
  const joined = fragments.join("").trim();
  if (joined) return joined;
  return typeof response.output_text === "string" && response.output_text.trim()
    ? response.output_text
    : null;
}

function normalizePatternResult(value: unknown, request: DiscoverRequest) {
  const source = requireUpstreamRecord(value);
  if (!Array.isArray(source.patterns) || source.patterns.length > 8) throw invalidUpstream();
  if (!Array.isArray(source.limitations) || source.limitations.length > 10) throw invalidUpstream();
  const rows = new Map(request.rows.map((row) => [row.rowId, row]));
  const rules = new Map(request.guide.rules.map((rule) => [rule.id, rule]));
  const keys = new Set<string>();
  const patterns = source.patterns.map((value) => {
    const pattern = requireUpstreamRecord(value);
    const patternKey = upstreamString(pattern.patternKey, 100);
    const kind = upstreamString(pattern.kind, 80);
    const targetRuleId = upstreamString(pattern.targetRuleId, 300, true);
    const title = upstreamString(pattern.title, 160);
    const proposedInterpretation = upstreamString(pattern.proposedInterpretation, 2_000);
    const supportingRowIds = upstreamStringArray(pattern.supportingRowIds, 12, 300);
    const contradictingRowIds = upstreamStringArray(pattern.contradictingRowIds, 12, 300);
    const evidence = normalizePatternEvidence(pattern.evidence, rows);
    const targetRule = rules.get(targetRuleId);
    if (
      keys.has(patternKey) ||
      !isPatternKind(kind) ||
      !patternKindMatchesRule(kind, targetRuleId, targetRule) ||
      supportingRowIds.some((id) => !rows.has(id)) ||
      contradictingRowIds.some((id) => !rows.has(id)) ||
      (pattern.risk !== "guide_aligned" &&
        pattern.risk !== "possible_bias" &&
        pattern.risk !== "inconsistent_history" &&
        pattern.risk !== "conflicts_with_guide")
    ) {
      throw invalidUpstream();
    }
    keys.add(patternKey);
    return {
      patternKey,
      kind,
      targetRuleId,
      title,
      proposedInterpretation,
      evidence,
      supportingRowIds,
      contradictingRowIds,
      risk: pattern.risk,
    };
  });
  const limitations = source.limitations.map((item) => upstreamString(item, 500, true));
  return { patterns, limitations };
}

function normalizePatternEvidence(
  value: unknown,
  rows: ReadonlyMap<string, SafeTeachingRow>,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw invalidUpstream();
  }
  return value.map((item) => {
    const source = requireUpstreamRecord(item);
    const rowId = upstreamString(source.rowId, 300);
    const answerIndex = Number(source.answerIndex);
    const quote = upstreamString(source.quote, 500);
    const row = rows.get(rowId);
    if (
      !row ||
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= row.answers.length ||
      !row.answers[answerIndex].value.includes(quote)
    ) {
      throw invalidUpstream();
    }
    return { rowId, answerIndex, quote };
  });
}

function isPatternKind(value: string) {
  return (
    value === "criterion_anchor_example" ||
    value === "eligibility_example" ||
    value === "elimination_example" ||
    value === "ambiguity" ||
    value === "historical_conflict" ||
    value === "possible_policy_gap"
  );
}

function patternKindMatchesRule(
  kind: string,
  targetRuleId: string,
  rule: SafeRule | undefined,
) {
  if (kind === "possible_policy_gap") return targetRuleId === "" && rule === undefined;
  if (!rule) return false;
  if (kind === "criterion_anchor_example") return rule.kind === "criterion";
  if (kind === "eligibility_example") return rule.kind === "eligibility";
  if (kind === "elimination_example") return rule.kind === "elimination";
  return true;
}

function normalizeAssessmentResult(value: unknown, request: AssessRequest) {
  const source = requireUpstreamRecord(value);
  if (!Array.isArray(source.assessments) || source.assessments.length !== request.cases.length) {
    throw invalidUpstream();
  }
  const casesById = new Map(request.cases.map((item) => [item.rowId, item]));
  const caseIds = new Set(casesById.keys());
  const seenRows = new Set<string>();
  const byKind = {
    eligibility: request.guide.rules.filter((rule) => rule.kind === "eligibility").map((rule) => rule.id),
    elimination: request.guide.rules.filter((rule) => rule.kind === "elimination").map((rule) => rule.id),
    criterion: request.guide.rules.filter((rule) => rule.kind === "criterion").map((rule) => rule.id),
  };

  const assessments = source.assessments.map((value) => {
    const assessment = requireUpstreamRecord(value);
    const rowId = upstreamString(assessment.rowId, 300);
    if (!caseIds.has(rowId) || seenRows.has(rowId)) throw invalidUpstream();
    const currentCase = casesById.get(rowId);
    if (!currentCase) throw invalidUpstream();
    seenRows.add(rowId);

    const eligibilityChecks = normalizeChecks(
      assessment.eligibilityChecks,
      byKind.eligibility,
      ["pass", "fail", "unclear"],
      currentCase.answers,
    );
    const eliminationChecks = normalizeChecks(
      assessment.eliminationChecks,
      byKind.elimination,
      ["triggered", "not_triggered", "unclear"],
      currentCase.answers,
    );
    const criterionScores = normalizeScores(
      assessment.criterionScores,
      byKind.criterion,
      currentCase.answers,
    );
    const uncertainties = upstreamStringArray(assessment.uncertainties, 50, 1_000, true);
    return {
      rowId,
      eligibilityChecks,
      eliminationChecks,
      criterionScores,
      uncertainties,
    };
  });
  if (seenRows.size !== caseIds.size) throw invalidUpstream();
  return { assessments };
}

function normalizeChecks(
  value: unknown,
  expectedIds: string[],
  allowedResults: string[],
  answers: SafeAnswer[],
) {
  if (!Array.isArray(value) || value.length !== expectedIds.length) throw invalidUpstream();
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  return value.map((item) => {
    const source = requireUpstreamRecord(item);
    const ruleId = upstreamString(source.ruleId, 300);
    if (!expected.has(ruleId) || seen.has(ruleId) || !allowedResults.includes(String(source.result))) {
      throw invalidUpstream();
    }
    seen.add(ruleId);
    return {
      ruleId,
      result: source.result as string,
      evidence: source.evidence === null ? null : normalizeEvidence(source.evidence, answers),
      explanation: upstreamString(source.explanation, 2_000, true),
    };
  });
}

function normalizeScores(value: unknown, expectedIds: string[], answers: SafeAnswer[]) {
  if (!Array.isArray(value) || value.length !== expectedIds.length) throw invalidUpstream();
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  return value.map((item) => {
    const source = requireUpstreamRecord(item);
    const ruleId = upstreamString(source.ruleId, 300);
    const score = source.score === null ? null : Number(source.score);
    const evidence =
      source.evidence === null ? null : normalizeEvidence(source.evidence, answers);
    if (
      !expected.has(ruleId) ||
      seen.has(ruleId) ||
      (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) ||
      (score === null) !== (evidence === null)
    ) {
      throw invalidUpstream();
    }
    seen.add(ruleId);
    return {
      ruleId,
      score,
      evidence,
      explanation: upstreamString(source.explanation, 2_000, true),
    };
  });
}

function normalizeEvidence(value: unknown, answers: SafeAnswer[]) {
  const evidence = requireUpstreamRecord(value);
  const answerIndex = Number(evidence.answerIndex);
  const quote = upstreamString(evidence.quote, 4_000);
  if (
    !Number.isInteger(answerIndex) ||
    answerIndex < 0 ||
    answerIndex >= answers.length ||
    !answers[answerIndex].value.includes(quote)
  ) {
    throw invalidUpstream();
  }
  return { answerIndex, quote };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(message);
  return value;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], message: string) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw invalid(message);
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  if (!allowEmpty && value.trim().length === 0) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRuleKind(value: unknown): value is RuleKind {
  return value === "eligibility" || value === "elimination" || value === "criterion";
}

function isCanonicalOutcome(value: unknown): value is CanonicalOutcome {
  return (
    value === "progressed" ||
    value === "not_progressed" ||
    value === "waitlist" ||
    value === "ineligible"
  );
}

function validMinimumScore(value: string) {
  const score = Number(value);
  return Number.isInteger(score) && score >= 1 && score <= 100;
}

function invalid(message: string) {
  return new PublicApiError(400, "invalid_request", message);
}

function invalidUpstream() {
  return new PublicApiError(
    502,
    "invalid_ai_response",
    "The AI service returned a result that failed safety validation. Nothing was saved.",
  );
}

function requireUpstreamRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidUpstream();
  return value;
}

function upstreamString(value: unknown, maxLength: number, allowEmpty = false) {
  const result = boundedString(value, maxLength, allowEmpty);
  if (result === null) throw invalidUpstream();
  return result;
}

function upstreamStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  allowEmpty = false,
) {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidUpstream();
  return value.map((item) => upstreamString(item, maxLength, allowEmpty));
}

function readStringField(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key] : null;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function retryDelay(attempt: number) {
  return Math.min(1_500, 250 * 2 ** (attempt - 1));
}

function readRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, seconds * 1_000);
  return null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
