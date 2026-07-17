import { isSensitiveAssessmentHeading } from "../app/assessment-safety.ts";
import {
  validateAiAssessmentBatch,
  type AiCaseAssessment,
  type LocalClassification,
  type Phase4ApprovedGuide,
  type Phase4SourceRow,
} from "../app/phase4-logic.ts";
import {
  PHASE4_ASSESSMENT_REQUEST_PROTOCOL,
  PHASE4_ASSESS_CASES_FORMAT,
  PHASE4_BASE_INSTRUCTIONS,
  buildPhase4AssessmentModelInput,
  getPhase4AssessmentProtocolHash,
} from "../app/phase4-protocol.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 55_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;

type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAiAssessmentGatewayOptions = {
  /** Server-side OpenAI project key. There is deliberately no environment fallback. */
  apiKey: string;
  /** Exact model ID approved during calibration. Provider aliases fail if they resolve differently. */
  pinnedModel: string;
  timeoutMs?: number;
  /** Dependency injection for focused tests; production callers should omit it. */
  fetchImplementation?: FetchImplementation;
};

export type AssessmentGatewayGuide = Phase4ApprovedGuide & {
  tieBreakPriority: readonly string[];
  clarificationPolicy: "allowed" | "not_allowed";
};

export type AssessmentGatewayApprovedPattern = {
  id: string;
  targetRuleId: string;
  proposedInterpretation: string;
};

export type AssessmentGatewayBatch = {
  /** Hash recorded with the organiser's frozen calibration approval. */
  assessmentProtocolHash: string;
  guide: AssessmentGatewayGuide;
  cases: readonly Pick<Phase4SourceRow, "rowId" | "answers">[];
  approvedPatterns?: readonly AssessmentGatewayApprovedPattern[];
};

export type SafeOpenAiProviderMetadata = {
  provider: "openai";
  responseId: string;
  model: string;
  status: "completed";
  createdAt: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
};

export type ValidatedAssessmentResult = {
  rowId: string;
  assessment: AiCaseAssessment;
  weightedScore: number;
  classification: LocalClassification;
};

export type OpenAiAssessmentGatewayResult = {
  assessmentProtocolHash: string;
  results: ValidatedAssessmentResult[];
  provider: SafeOpenAiProviderMetadata;
};

export type OpenAiAssessmentGatewayErrorCode =
  | "invalid_configuration"
  | "invalid_assessment_input"
  | "assessment_protocol_mismatch"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_incomplete"
  | "provider_refusal"
  | "provider_model_mismatch"
  | "provider_invalid_response"
  | "assessment_validation_failed";

/** Safe to log: it never contains an API key, application text, evidence, or provider body. */
export class OpenAiAssessmentGatewayError extends Error {
  readonly code: OpenAiAssessmentGatewayErrorCode;
  readonly retryable: boolean;
  readonly providerStatus: number | null;

  constructor(
    code: OpenAiAssessmentGatewayErrorCode,
    message: string,
    options: { retryable?: boolean; providerStatus?: number } = {},
  ) {
    super(message);
    this.name = "OpenAiAssessmentGatewayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.providerStatus = options.providerStatus ?? null;
  }
}

export type OpenAiAssessmentGateway = {
  readonly pinnedModel: string;
  assessBatch(batch: AssessmentGatewayBatch): Promise<OpenAiAssessmentGatewayResult>;
};

type SafeGuide = {
  version: number;
  status: "approved";
  rules: Array<{
    id: string;
    kind: "eligibility" | "elimination" | "criterion";
    title: string;
    statement: string;
    passingCondition: string;
    evidence: string;
    weight: number;
    anchor1: string;
    anchor3: string;
    anchor5: string;
  }>;
  selection: {
    mode: "top_n" | "minimum_score" | "both";
    shortlistTarget: string;
    minimumScore: string;
  };
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed";
};

type SafeCase = Pick<Phase4SourceRow, "rowId" | "answers">;

type SafeAssessmentRequest = {
  action: "assess_cases";
  guide: SafeGuide;
  cases: SafeCase[];
  approvedPatterns: AssessmentGatewayApprovedPattern[];
};

export function createOpenAiAssessmentGateway(
  options: OpenAiAssessmentGatewayOptions,
): OpenAiAssessmentGateway {
  const apiKey = requireApiKey(options.apiKey);
  const pinnedModel = requirePinnedModel(options.pinnedModel);
  const timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  if (typeof fetchImplementation !== "function") {
    throw configurationError("A server-side fetch implementation is required.");
  }

  return Object.freeze({
    pinnedModel,
    async assessBatch(batch: AssessmentGatewayBatch) {
      const currentProtocolHash = await getPhase4AssessmentProtocolHash();
      if (batch?.assessmentProtocolHash !== currentProtocolHash) {
        throw new OpenAiAssessmentGatewayError(
          "assessment_protocol_mismatch",
          "The approved assessment protocol does not match the running gateway.",
        );
      }

      const safeRequest = buildSafeRequest(batch);
      const modelInput = buildPhase4AssessmentModelInput(safeRequest);
      const body = JSON.stringify({
        model: pinnedModel,
        store: false,
        instructions: PHASE4_BASE_INSTRUCTIONS,
        input: modelInput,
        max_output_tokens: PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxOutputTokens,
        text: { format: PHASE4_ASSESS_CASES_FORMAT },
      });
      if (new TextEncoder().encode(body).byteLength > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxRequestBytes) {
        throw invalidInput("The assessment batch is too large for the approved protocol.");
      }

      const providerResponse = await callResponsesApi({
        apiKey,
        body,
        fetchImplementation,
        timeoutMs,
      });
      const parsed = parseCompletedProviderResponse(providerResponse, pinnedModel);
      const validation = validateAiAssessmentBatch(
        parsed.output,
        safeRequest.cases,
        safeRequest.guide,
      );
      if (!validation.ok) {
        throw new OpenAiAssessmentGatewayError(
          "assessment_validation_failed",
          "The provider output failed the approved evidence validation.",
        );
      }

      const results = safeRequest.cases.map((currentCase) => {
        const validated = validation.results[currentCase.rowId];
        if (
          !validated?.ok ||
          !validated.evidenceValid ||
          !validated.assessment ||
          typeof validated.weightedScore !== "number"
        ) {
          throw new OpenAiAssessmentGatewayError(
            "assessment_validation_failed",
            "The provider output failed the approved evidence validation.",
          );
        }
        return {
          rowId: currentCase.rowId,
          assessment: validated.assessment,
          weightedScore: validated.weightedScore,
          classification: validated.classification,
        };
      });

      return {
        assessmentProtocolHash: currentProtocolHash,
        results,
        provider: parsed.metadata,
      };
    },
  });
}

function requireApiKey(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 512 ||
    value.trim() !== value ||
    /\s|[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw configurationError("An explicit server-side OpenAI API key is required.");
  }
  return value;
}

function requirePinnedModel(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw configurationError("An explicit pinned OpenAI model ID is required.");
  }
  return value;
}

function requireTimeout(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_MS) {
    throw configurationError(`The provider timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
  }
  return Number(value);
}

function configurationError(message: string) {
  return new OpenAiAssessmentGatewayError("invalid_configuration", message);
}

function invalidInput(message: string) {
  return new OpenAiAssessmentGatewayError("invalid_assessment_input", message);
}

function boundedString(
  value: unknown,
  maxLength: number,
  label: string,
  allowEmpty = false,
) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw invalidInput(`${label} is missing or invalid.`);
  }
  return value;
}

function buildSafeRequest(batch: AssessmentGatewayBatch): SafeAssessmentRequest {
  if (!batch || typeof batch !== "object") throw invalidInput("An assessment batch is required.");
  const guide = buildSafeGuide(batch.guide);
  const cases = buildSafeCases(batch.cases);
  const approvedPatterns = buildSafePatterns(batch.approvedPatterns ?? [], guide);
  return { action: "assess_cases", guide, cases, approvedPatterns };
}

function buildSafeGuide(value: AssessmentGatewayGuide): SafeGuide {
  if (!value || typeof value !== "object" || value.status !== "approved") {
    throw invalidInput("Only an approved decision guide can be assessed.");
  }
  if (!Number.isInteger(value.version) || value.version < 1) {
    throw invalidInput("The approved guide version is invalid.");
  }
  if (
    !Array.isArray(value.rules) ||
    value.rules.length < 1 ||
    value.rules.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxGuideRules
  ) {
    throw invalidInput("The approved guide has an invalid number of rules.");
  }

  const ids = new Set<string>();
  let criterionWeight = 0;
  let criterionCount = 0;
  const rules = value.rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw invalidInput(`Guide rule ${index + 1} is invalid.`);
    const id = boundedString(rule.id, 300, `Guide rule ${index + 1} ID`);
    if (ids.has(id)) throw invalidInput(`Guide rule ${index + 1} repeats an ID.`);
    ids.add(id);
    if (rule.kind !== "eligibility" && rule.kind !== "elimination" && rule.kind !== "criterion") {
      throw invalidInput(`Guide rule ${index + 1} has an invalid kind.`);
    }
    const weight = Number(rule.weight);
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw invalidInput(`Guide rule ${index + 1} has an invalid weight.`);
    }
    const anchor1 = boundedString(rule.anchor1 ?? "", 4_000, `Guide rule ${index + 1} anchor 1`, true);
    const anchor3 = boundedString(rule.anchor3 ?? "", 4_000, `Guide rule ${index + 1} anchor 3`, true);
    const anchor5 = boundedString(rule.anchor5 ?? "", 4_000, `Guide rule ${index + 1} anchor 5`, true);
    if (rule.kind === "criterion") {
      if (weight < 1 || !anchor1 || !anchor3 || !anchor5) {
        throw invalidInput(`Criterion ${index + 1} needs a weight and all scoring anchors.`);
      }
      criterionCount += 1;
      criterionWeight += weight;
    }
    return {
      id,
      kind: rule.kind,
      title: boundedString(rule.title, 300, `Guide rule ${index + 1} title`),
      statement: boundedString(rule.statement, 4_000, `Guide rule ${index + 1} statement`),
      passingCondition: boundedString(
        rule.passingCondition ?? "",
        4_000,
        `Guide rule ${index + 1} passing condition`,
        true,
      ),
      evidence: boundedString(rule.evidence ?? "", 4_000, `Guide rule ${index + 1} evidence`, true),
      weight,
      anchor1,
      anchor3,
      anchor5,
    };
  });
  if (criterionCount < 1 || criterionWeight !== 100) {
    throw invalidInput("The approved guide criteria must have weights that total 100.");
  }

  const selection = value.selection;
  if (
    !selection ||
    (selection.mode !== "top_n" &&
      selection.mode !== "minimum_score" &&
      selection.mode !== "both")
  ) {
    throw invalidInput("The approved guide selection method is invalid.");
  }
  const shortlistTarget = boundedString(
    selection.shortlistTarget ?? "",
    100,
    "Guide shortlist target",
    true,
  );
  const minimumScore = boundedString(
    selection.minimumScore ?? "",
    100,
    "Guide minimum score",
    true,
  );
  if (selection.mode === "minimum_score" || selection.mode === "both") {
    const score = Number(minimumScore);
    if (!Number.isInteger(score) || score < 1 || score > 100) {
      throw invalidInput("The approved guide minimum score is invalid.");
    }
  }

  if (
    !Array.isArray(value.tieBreakPriority) ||
    value.tieBreakPriority.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxGuideRules
  ) {
    throw invalidInput("The approved guide tie-break priority is invalid.");
  }
  const tieBreakPriority = value.tieBreakPriority.map((item, index) =>
    boundedString(item, 300, `Tie-break priority ${index + 1}`),
  );
  if (value.clarificationPolicy !== "allowed" && value.clarificationPolicy !== "not_allowed") {
    throw invalidInput("The approved guide clarification policy is invalid.");
  }

  return {
    version: value.version,
    status: "approved",
    rules,
    selection: { mode: selection.mode, shortlistTarget, minimumScore },
    tieBreakPriority,
    clarificationPolicy: value.clarificationPolicy,
  };
}

function buildSafeCases(
  value: readonly Pick<Phase4SourceRow, "rowId" | "answers">[],
): SafeCase[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxCases
  ) {
    throw invalidInput("The assessment batch has an invalid number of cases.");
  }
  const ids = new Set<string>();
  return value.map((currentCase, caseIndex) => {
    if (!currentCase || typeof currentCase !== "object") {
      throw invalidInput(`Case ${caseIndex + 1} is invalid.`);
    }
    const rowId = boundedString(currentCase.rowId, 300, `Case ${caseIndex + 1} row ID`);
    if (ids.has(rowId)) throw invalidInput(`Case ${caseIndex + 1} repeats a row ID.`);
    ids.add(rowId);
    if (
      !Array.isArray(currentCase.answers) ||
      currentCase.answers.length < 1 ||
      currentCase.answers.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxAnswersPerRow
    ) {
      throw invalidInput(`Case ${caseIndex + 1} has an invalid number of answers.`);
    }
    let textLength = 0;
    const answers = currentCase.answers.map(
      (answer: Phase4SourceRow["answers"][number], answerIndex: number) => {
        if (!answer || typeof answer !== "object") {
          throw invalidInput(`Case ${caseIndex + 1} answer ${answerIndex + 1} is invalid.`);
        }
        const heading = boundedString(
          answer.heading,
          400,
          `Case ${caseIndex + 1} answer ${answerIndex + 1} heading`,
          true,
        );
        const answerValue = boundedString(
          answer.value,
          30_000,
          `Case ${caseIndex + 1} answer ${answerIndex + 1} value`,
        );
        if (isSensitiveAssessmentHeading(heading)) {
          throw invalidInput("An identity, outcome, reviewer, or score field cannot be sent to AI.");
        }
        textLength += heading.length + answerValue.length;
        return { heading, value: answerValue };
      },
    );
    if (textLength > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxRowTextChars) {
      throw invalidInput(`Case ${caseIndex + 1} exceeds the approved text limit.`);
    }
    return { rowId, answers };
  });
}

function buildSafePatterns(
  value: readonly AssessmentGatewayApprovedPattern[],
  guide: SafeGuide,
) {
  if (
    !Array.isArray(value) ||
    value.length > PHASE4_ASSESSMENT_REQUEST_PROTOCOL.maxApprovedPatterns
  ) {
    throw invalidInput("The approved historical context is invalid or too large.");
  }
  const patternIds = new Set<string>();
  const ruleIds = new Set(guide.rules.map((rule) => rule.id));
  return value.map((pattern, index) => {
    if (!pattern || typeof pattern !== "object") {
      throw invalidInput(`Approved pattern ${index + 1} is invalid.`);
    }
    const id = boundedString(pattern.id, 300, `Approved pattern ${index + 1} ID`);
    const targetRuleId = boundedString(
      pattern.targetRuleId,
      300,
      `Approved pattern ${index + 1} rule ID`,
    );
    if (patternIds.has(id) || !ruleIds.has(targetRuleId)) {
      throw invalidInput(`Approved pattern ${index + 1} is duplicated or targets an unknown rule.`);
    }
    patternIds.add(id);
    return {
      id,
      targetRuleId,
      proposedInterpretation: boundedString(
        pattern.proposedInterpretation,
        2_000,
        `Approved pattern ${index + 1} interpretation`,
      ),
    };
  });
}

async function callResponsesApi(input: {
  apiKey: string;
  body: string;
  fetchImplementation: FetchImplementation;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImplementation(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: input.body,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OpenAiAssessmentGatewayError(
        "provider_timeout",
        "The OpenAI assessment request timed out.",
        { retryable: true },
      );
    }
    throw new OpenAiAssessmentGatewayError(
      "provider_unavailable",
      "The OpenAI assessment service is unavailable.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new OpenAiAssessmentGatewayError(
      retryable ? "provider_unavailable" : "provider_rejected",
      retryable
        ? "The OpenAI assessment service is temporarily unavailable."
        : "The OpenAI assessment request was rejected.",
      { retryable, providerStatus: response.status },
    );
  }

  return readBoundedJson(response);
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw invalidProviderResponse();
  }
  if (!response.body) throw invalidProviderResponse();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidProviderResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidProviderResponse();
  }
  if (!isRecord(value)) throw invalidProviderResponse();
  return value;
}

function parseCompletedProviderResponse(
  response: Record<string, unknown>,
  pinnedModel: string,
): { output: unknown; metadata: SafeOpenAiProviderMetadata } {
  if (response.status !== "completed" || response.incomplete_details != null) {
    throw new OpenAiAssessmentGatewayError(
      "provider_incomplete",
      "The OpenAI assessment response was incomplete.",
      { retryable: true },
    );
  }
  if (response.model !== pinnedModel) {
    throw new OpenAiAssessmentGatewayError(
      "provider_model_mismatch",
      "The OpenAI response model did not match the calibrated model.",
    );
  }
  if (response.store !== false) throw invalidProviderResponse();
  const responseId = safeProviderString(response.id, 300);
  if (!responseId || !responseId.startsWith("resp_")) throw invalidProviderResponse();

  const outputText = extractOutputText(response.output);
  let output: unknown;
  try {
    output = JSON.parse(outputText) as unknown;
  } catch {
    throw invalidProviderResponse();
  }

  return {
    output,
    metadata: {
      provider: "openai",
      responseId,
      model: pinnedModel,
      status: "completed",
      createdAt: safeOptionalInteger(response.created_at),
      usage: safeUsage(response.usage),
    },
  };
}

function extractOutputText(value: unknown) {
  if (!Array.isArray(value)) throw invalidProviderResponse();
  const fragments: string[] = [];
  let messageCount = 0;
  for (const item of value) {
    if (!isRecord(item)) throw invalidProviderResponse();
    if (item.type !== "message") continue;
    messageCount += 1;
    if (item.status !== "completed" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new OpenAiAssessmentGatewayError(
        "provider_incomplete",
        "The OpenAI assessment response was incomplete.",
        { retryable: true },
      );
    }
    for (const content of item.content) {
      if (!isRecord(content)) throw invalidProviderResponse();
      if (content.type === "refusal") {
        throw new OpenAiAssessmentGatewayError(
          "provider_refusal",
          "The OpenAI model refused the assessment request.",
        );
      }
      if (content.type !== "output_text" || typeof content.text !== "string") {
        throw invalidProviderResponse();
      }
      fragments.push(content.text);
    }
  }
  if (messageCount !== 1) throw invalidProviderResponse();
  const outputText = fragments.join("").trim();
  if (!outputText) throw invalidProviderResponse();
  return outputText;
}

function safeProviderString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function safeOptionalInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeUsage(value: unknown): SafeOpenAiProviderMetadata["usage"] {
  if (!isRecord(value)) return null;
  const inputTokens = safeOptionalInteger(value.input_tokens);
  const outputTokens = safeOptionalInteger(value.output_tokens);
  const totalTokens = safeOptionalInteger(value.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function invalidProviderResponse() {
  return new OpenAiAssessmentGatewayError(
    "provider_invalid_response",
    "The OpenAI response did not match the required completed response shape.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
