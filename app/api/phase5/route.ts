import { GET as phase4Get, POST as phase4Post } from "../phase4/route.ts";
import {
  createPhase4InputFingerprint,
  stableStringify,
} from "../../phase4-logic.ts";
import { getPhase4AssessmentProtocolHash } from "../../phase4-protocol.ts";
import { isSensitiveAssessmentHeading } from "../../assessment-safety.ts";

export const PHASE5_PROMPT_VERSION = "phase5-current-assessment-v1";
export const PHASE5_OUTPUT_SCHEMA_VERSION = "phase5-assessment-v1";
export const PHASE5_BATCH_ALGORITHM = "opaque-row-order-byte-pack-v1";

const MAX_REQUEST_BYTES = 700_000;
const MAX_CASES = 6;
const MAX_DATASET_ROWS = 10_000;
const MAX_GUIDE_RULES = 60;
const MAX_ANSWERS_PER_CASE = 40;
const MAX_CASE_TEXT_CHARS = 70_000;

type RuleKind = "eligibility" | "elimination" | "criterion";
type SelectionMode = "top_n" | "minimum_score" | "both";

type GuideRule = {
  id: string;
  kind: RuleKind;
  title: string;
  statement: string;
  passingCondition: string;
  evidence: string;
  sourceNote: string;
  weight: number;
  anchor1: string;
  anchor3: string;
  anchor5: string;
};

type Selection = {
  mode: SelectionMode;
  shortlistTarget: string;
  minimumScore: string;
};

type FullApprovedGuide = {
  schemaVersion: 1;
  version: number;
  basedOnVersion: number | null;
  status: "approved";
  rules: GuideRule[];
  eligibilityConfirmedNone: boolean;
  eliminationConfirmedNone: boolean;
  selection: Selection;
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed";
  missingInformationAcknowledged: true;
  approvedAt: string;
  approvedBy: string;
};

type SafeGuide = {
  version: number;
  status: "approved";
  rules: Array<Omit<GuideRule, "sourceNote">>;
  selection: Selection;
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed";
};

type ApprovedPattern = {
  id: string;
  targetRuleId: string;
  proposedInterpretation: string;
};

type SafeCase = {
  rowId: string;
  answers: Array<{ heading: string; value: string }>;
};

type SelectionSnapshot = Selection & {
  tieBreakPriority: string[];
};

type Phase5RunContract = {
  runId: string;
  datasetFingerprint: string;
  datasetIntegrityHash: string;
  datasetRowCount: number;
  guideContentHash: string;
  phase4SessionId: string;
  phase4MetricsHash: string;
  assessmentProtocolHash: string;
  approvedPatternsHash: string;
  expectedModelId: string;
  promptVersion: typeof PHASE5_PROMPT_VERSION;
  outputSchemaVersion: typeof PHASE5_OUTPUT_SCHEMA_VERSION;
  batchAlgorithm: typeof PHASE5_BATCH_ALGORITHM;
  approvedBy: string;
  approvedAt: string;
  selection: SelectionSnapshot;
  contractHash: string;
};

type Phase5Batch = {
  batchId: string;
  batchInputHash: string;
};

class PublicApiError extends Error {
  status: number;
  code: string;
  publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

const ROOT_KEYS = ["action", "approvedPatterns", "batch", "cases", "guide", "run"];
const RUN_KEYS = [
  "approvedAt",
  "approvedBy",
  "approvedPatternsHash",
  "assessmentProtocolHash",
  "batchAlgorithm",
  "contractHash",
  "datasetFingerprint",
  "datasetIntegrityHash",
  "datasetRowCount",
  "expectedModelId",
  "guideContentHash",
  "outputSchemaVersion",
  "phase4MetricsHash",
  "phase4SessionId",
  "promptVersion",
  "runId",
  "selection",
];
const BATCH_KEYS = ["batchId", "batchInputHash"];
const GUIDE_KEYS = [
  "approvedAt",
  "approvedBy",
  "basedOnVersion",
  "clarificationPolicy",
  "eligibilityConfirmedNone",
  "eliminationConfirmedNone",
  "missingInformationAcknowledged",
  "rules",
  "schemaVersion",
  "selection",
  "status",
  "tieBreakPriority",
  "version",
];
const RULE_KEYS = [
  "anchor1",
  "anchor3",
  "anchor5",
  "evidence",
  "id",
  "kind",
  "passingCondition",
  "sourceNote",
  "statement",
  "title",
  "weight",
];
const GUIDE_SELECTION_KEYS = ["minimumScore", "mode", "shortlistTarget"];
const RUN_SELECTION_KEYS = [
  "minimumScore",
  "mode",
  "shortlistTarget",
  "tieBreakPriority",
];
const PATTERN_KEYS = ["id", "proposedInterpretation", "targetRuleId"];
const CASE_KEYS = ["answers", "rowId"];
const ANSWER_KEYS = ["heading", "value"];

const UNSAFE_FIELD_NAMES = new Set([
  "applicantidentity",
  "applicantname",
  "email",
  "externalid",
  "finaldecision",
  "identity",
  "instructions",
  "judgescore",
  "notes",
  "outcome",
  "phone",
  "recommendation",
  "reviewernotes",
  "systemprompt",
  "teamname",
  "total",
  "totalscore",
]);

export async function GET(request: Request) {
  return phase4Get(request);
}

export async function POST(request: Request) {
  const access = await phase4Get(request);
  if (!access.ok) return access;

  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new PublicApiError(415, "json_required", "This endpoint accepts JSON requests only.");
    }

    const parsed = await parseRequest(await readJsonBody(request));
    const assessmentProtocolHash = await verifyHashes(parsed);

    const forwarded = new Request(new URL("/api/phase4", request.url), {
      method: "POST",
      headers: forwardedHeaders(request.headers),
      body: JSON.stringify({
        action: "assess_cases",
        guide: parsed.safeGuide,
        approvedPatterns: parsed.approvedPatterns,
        cases: parsed.cases,
      }),
    });
    const gatewayResponse = await phase4Post(forwarded);
    if (!gatewayResponse.ok) return gatewayResponse;

    const gatewayBody = await gatewayResponse.json().catch(() => null);
    const gateway = requireRecord(
      gatewayBody,
      "The managed assessment service returned an unreadable response.",
      502,
    );
    const requestedModel = boundedString(gateway.requestedModel, 200);
    const model = boundedString(gateway.model, 200);
    const gatewayProtocolHash = boundedString(gateway.assessmentProtocolHash, 64);
    if (
      !requestedModel ||
      requestedModel !== parsed.run.expectedModelId ||
      !model ||
      model !== parsed.run.expectedModelId
    ) {
      throw new PublicApiError(
        409,
        "model_mismatch",
        "The AI model does not match the approved run. No findings were accepted.",
      );
    }
    if (
      gatewayProtocolHash !== assessmentProtocolHash ||
      gatewayProtocolHash !== parsed.run.assessmentProtocolHash
    ) {
      throw new PublicApiError(
        409,
        "protocol_mismatch",
        "The assessment protocol does not match the approved run. No findings were accepted.",
      );
    }
    if (gateway.action !== "assess_cases") {
      throw new PublicApiError(
        502,
        "invalid_ai_response",
        "The managed assessment service returned the wrong result type.",
      );
    }
    const result = requireRecord(
      gateway.result,
      "The managed assessment service returned no validated findings.",
      502,
    );
    if (!Array.isArray(result.assessments)) {
      throw new PublicApiError(
        502,
        "invalid_ai_response",
        "The managed assessment service returned no validated findings.",
      );
    }

    return json(
      {
        action: "assess_current_cases",
        runId: parsed.run.runId,
        contractHash: parsed.run.contractHash,
        batchId: parsed.batch.batchId,
        batchInputHash: parsed.batch.batchInputHash,
        guideContentHash: parsed.run.guideContentHash,
        approvedPatternsHash: parsed.run.approvedPatternsHash,
        assessmentProtocolHash,
        promptVersion: parsed.run.promptVersion,
        outputSchemaVersion: parsed.run.outputSchemaVersion,
        model,
        findings: result.assessments,
      },
      200,
    );
  } catch (error) {
    if (error instanceof PublicApiError) {
      return json({ error: { code: error.code, message: error.publicMessage } }, error.status);
    }
    return json(
      {
        error: {
          code: "phase5_failed",
          message: "The current-application assessment stopped safely. Nothing was accepted.",
        },
      },
      500,
    );
  }
}

function forwardedHeaders(source: Headers) {
  const headers = new Headers({ "content-type": "application/json" });
  ["oai-authenticated-user-email", "origin", "sec-fetch-site"].forEach((name) => {
    const value = source.get(name);
    if (value) headers.set(name, value);
  });
  return headers;
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

async function readJsonBody(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_REQUEST_BYTES) {
      throw new PublicApiError(413, "request_too_large", "Use a smaller assessment batch.");
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new PublicApiError(413, "request_too_large", "Use a smaller assessment batch.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

async function parseRequest(value: unknown) {
  const root = requireRecord(value, "The Phase 5 request must be a JSON object.");
  requireOnlyKeys(root, ROOT_KEYS, "request");
  if (root.action !== "assess_current_cases") {
    throw invalid("Choose the supported Phase 5 assessment action.");
  }

  const guide = parseGuide(root.guide);
  const safeGuide = projectSafeGuide(guide);
  const approvedPatterns = parseApprovedPatterns(root.approvedPatterns, guide);
  const cases = parseCases(root.cases);
  const run = parseRun(root.run);
  const batch = parseBatch(root.batch);

  if (run.datasetRowCount < cases.length) {
    throw invalid("The batch contains more cases than the locked current dataset.");
  }
  const selectionSnapshot: SelectionSnapshot = {
    ...guide.selection,
    tieBreakPriority: guide.tieBreakPriority,
  };
  if (stableStringify(run.selection) !== stableStringify(selectionSnapshot)) {
    throw hashMismatch("The selection rules do not match the locked run.");
  }

  return { guide, safeGuide, approvedPatterns, cases, run, batch };
}

function parseRun(value: unknown): Phase5RunContract {
  const run = requireRecord(value, "A locked Phase 5 run contract is required.");
  requireOnlyKeys(run, RUN_KEYS, "run contract");
  const datasetRowCount = readInteger(run.datasetRowCount, 1, MAX_DATASET_ROWS, "dataset row count");
  const promptVersion = readString(run.promptVersion, 100, "prompt version");
  const outputSchemaVersion = readString(run.outputSchemaVersion, 100, "output schema version");
  const batchAlgorithm = readString(run.batchAlgorithm, 100, "batch algorithm");
  if (
    promptVersion !== PHASE5_PROMPT_VERSION ||
    outputSchemaVersion !== PHASE5_OUTPUT_SCHEMA_VERSION ||
    batchAlgorithm !== PHASE5_BATCH_ALGORITHM
  ) {
    throw hashMismatch("The assessment versions do not match this deployment.");
  }

  const approvedAt = readString(run.approvedAt, 100, "approval time");
  if (!isIsoTimestamp(approvedAt)) throw invalid("The run approval time is invalid.");
  const expectedModelId = readString(run.expectedModelId, 200, "expected model");
  if (!/^[A-Za-z0-9._:-]+$/.test(expectedModelId)) {
    throw invalid("The expected model ID is invalid.");
  }

  return {
    runId: readString(run.runId, 300, "run ID"),
    datasetFingerprint: readHash(run.datasetFingerprint, "dataset fingerprint"),
    datasetIntegrityHash: readHash(run.datasetIntegrityHash, "dataset integrity hash"),
    datasetRowCount,
    guideContentHash: readHash(run.guideContentHash, "guide content hash"),
    phase4SessionId: readString(run.phase4SessionId, 300, "Phase 4 session ID"),
    phase4MetricsHash: readHash(run.phase4MetricsHash, "Phase 4 metrics hash"),
    assessmentProtocolHash: readHash(run.assessmentProtocolHash, "assessment protocol hash"),
    approvedPatternsHash: readHash(run.approvedPatternsHash, "approved patterns hash"),
    expectedModelId,
    promptVersion,
    outputSchemaVersion,
    batchAlgorithm,
    approvedBy: readString(run.approvedBy, 300, "approver"),
    approvedAt,
    selection: parseRunSelection(run.selection),
    contractHash: readHash(run.contractHash, "contract hash"),
  };
}

function parseBatch(value: unknown): Phase5Batch {
  const batch = requireRecord(value, "A Phase 5 batch identity is required.");
  requireOnlyKeys(batch, BATCH_KEYS, "batch");
  return {
    batchId: readString(batch.batchId, 300, "batch ID"),
    batchInputHash: readHash(batch.batchInputHash, "batch input hash"),
  };
}

function parseRunSelection(value: unknown): SelectionSnapshot {
  const selection = requireRecord(value, "The locked selection snapshot is required.");
  requireOnlyKeys(selection, RUN_SELECTION_KEYS, "selection snapshot");
  const base = parseSelection(selection);
  if (!Array.isArray(selection.tieBreakPriority) || selection.tieBreakPriority.length > MAX_GUIDE_RULES) {
    throw invalid("The locked tie-break order is invalid.");
  }
  const tieBreakPriority = selection.tieBreakPriority.map((item) =>
    readString(item, 300, "tie-break rule ID"),
  );
  if (new Set(tieBreakPriority).size !== tieBreakPriority.length) {
    throw invalid("The locked tie-break order contains duplicates.");
  }
  return { ...base, tieBreakPriority };
}

function parseGuide(value: unknown): FullApprovedGuide {
  const source = requireRecord(value, "An approved Decision Guide is required.");
  requireOnlyKeys(source, GUIDE_KEYS, "guide");
  if (source.schemaVersion !== 1 || source.status !== "approved") {
    throw invalid("Only an approved Decision Guide can be used in Phase 5.");
  }
  const version = readInteger(source.version, 1, Number.MAX_SAFE_INTEGER, "guide version");
  const basedOnVersion =
    source.basedOnVersion === null
      ? null
      : readInteger(source.basedOnVersion, 1, Number.MAX_SAFE_INTEGER, "base guide version");
  if (!Array.isArray(source.rules) || source.rules.length < 1 || source.rules.length > MAX_GUIDE_RULES) {
    throw invalid(`The guide must contain between 1 and ${MAX_GUIDE_RULES} rules.`);
  }

  const seen = new Set<string>();
  const rules = source.rules.map((value, index) => {
    const rule = requireRecord(value, `Guide rule ${index + 1} is invalid.`);
    requireOnlyKeys(rule, RULE_KEYS, `guide rule ${index + 1}`);
    const id = readString(rule.id, 300, `guide rule ${index + 1} ID`);
    const kind = rule.kind;
    if (!isRuleKind(kind) || seen.has(id)) throw invalid(`Guide rule ${index + 1} is invalid or duplicated.`);
    seen.add(id);
    return {
      id,
      kind,
      title: readString(rule.title, 300, `guide rule ${index + 1} title`),
      statement: readString(rule.statement, 4_000, `guide rule ${index + 1} statement`),
      passingCondition: readString(rule.passingCondition, 4_000, `guide rule ${index + 1} condition`, true),
      evidence: readString(rule.evidence, 4_000, `guide rule ${index + 1} evidence`, true),
      sourceNote: readString(rule.sourceNote, 4_000, `guide rule ${index + 1} source`),
      weight: readInteger(rule.weight, 0, 100, `guide rule ${index + 1} weight`),
      anchor1: readString(rule.anchor1, 4_000, `guide rule ${index + 1} score 1 anchor`, true),
      anchor3: readString(rule.anchor3, 4_000, `guide rule ${index + 1} score 3 anchor`, true),
      anchor5: readString(rule.anchor5, 4_000, `guide rule ${index + 1} score 5 anchor`, true),
    } satisfies GuideRule;
  });

  const criteria = rules.filter((rule) => rule.kind === "criterion");
  const eligibility = rules.filter((rule) => rule.kind === "eligibility");
  const elimination = rules.filter((rule) => rule.kind === "elimination");
  if (
    criteria.length < 1 ||
    criteria.some(
      (rule) => rule.weight < 1 || !rule.anchor1 || !rule.anchor3 || !rule.anchor5 || !rule.evidence,
    ) ||
    criteria.reduce((sum, rule) => sum + rule.weight, 0) !== 100
  ) {
    throw invalid("The approved criteria and weights are incomplete.");
  }
  if (eligibility.some((rule) => !rule.passingCondition || !rule.evidence)) {
    throw invalid("Every approved eligibility rule needs a passing condition and evidence requirement.");
  }
  if (elimination.some((rule) => !rule.evidence)) {
    throw invalid("Every approved elimination rule needs an evidence requirement.");
  }

  const selection = parseGuideSelection(source.selection);
  if (!Array.isArray(source.tieBreakPriority)) throw invalid("The guide tie-break order is invalid.");
  const tieBreakPriority = source.tieBreakPriority.map((item) =>
    readString(item, 300, "tie-break rule ID"),
  );
  const criterionIds = criteria.map((rule) => rule.id);
  if (
    tieBreakPriority.length !== criterionIds.length ||
    new Set(tieBreakPriority).size !== criterionIds.length ||
    tieBreakPriority.some((id) => !criterionIds.includes(id))
  ) {
    throw invalid("The guide tie-break order must include every criterion exactly once.");
  }

  if (typeof source.eligibilityConfirmedNone !== "boolean" || typeof source.eliminationConfirmedNone !== "boolean") {
    throw invalid("The guide entry-rule confirmations are invalid.");
  }
  const eligibilityCount = eligibility.length;
  const eliminationCount = elimination.length;
  if (
    source.eligibilityConfirmedNone !== (eligibilityCount === 0) ||
    source.eliminationConfirmedNone !== (eliminationCount === 0)
  ) {
    throw invalid("The guide entry-rule confirmations do not match its rules.");
  }
  if (source.clarificationPolicy !== "allowed" && source.clarificationPolicy !== "not_allowed") {
    throw invalid("The guide clarification policy is invalid.");
  }
  if (source.missingInformationAcknowledged !== true) {
    throw invalid("The approved guide must confirm its missing-information safeguard.");
  }
  const approvedAt = readString(source.approvedAt, 100, "guide approval time");
  if (!isIsoTimestamp(approvedAt)) throw invalid("The guide approval time is invalid.");

  return {
    schemaVersion: 1,
    version,
    basedOnVersion,
    status: "approved",
    rules,
    eligibilityConfirmedNone: source.eligibilityConfirmedNone,
    eliminationConfirmedNone: source.eliminationConfirmedNone,
    selection,
    tieBreakPriority,
    clarificationPolicy: source.clarificationPolicy,
    missingInformationAcknowledged: true,
    approvedAt,
    approvedBy: readString(source.approvedBy, 300, "guide approver"),
  };
}

function parseGuideSelection(value: unknown) {
  const selection = requireRecord(value, "The guide selection method is required.");
  requireOnlyKeys(selection, GUIDE_SELECTION_KEYS, "guide selection");
  return parseSelection(selection);
}

function parseSelection(source: Record<string, unknown>): Selection {
  const mode = source.mode;
  if (mode !== "top_n" && mode !== "minimum_score" && mode !== "both") {
    throw invalid("The selection method is invalid.");
  }
  const shortlistTarget = readString(source.shortlistTarget, 100, "shortlist target", true);
  const minimumScore = readString(source.minimumScore, 100, "minimum score", true);
  if ((mode === "top_n" || mode === "both") && !isIntegerText(shortlistTarget, 1, MAX_DATASET_ROWS)) {
    throw invalid("The shortlist target is invalid.");
  }
  if (shortlistTarget && !isIntegerText(shortlistTarget, 1, MAX_DATASET_ROWS)) {
    throw invalid("The shortlist target is invalid.");
  }
  if ((mode === "minimum_score" || mode === "both") && !isIntegerText(minimumScore, 1, 100)) {
    throw invalid("The minimum score is invalid.");
  }
  if (minimumScore && !isIntegerText(minimumScore, 1, 100)) {
    throw invalid("The minimum score is invalid.");
  }
  return { mode, shortlistTarget, minimumScore };
}

function projectSafeGuide(guide: FullApprovedGuide): SafeGuide {
  return {
    version: guide.version,
    status: "approved",
    rules: guide.rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      title: rule.title,
      statement: rule.statement,
      passingCondition: rule.passingCondition,
      evidence: rule.evidence,
      weight: rule.weight,
      anchor1: rule.anchor1,
      anchor3: rule.anchor3,
      anchor5: rule.anchor5,
    })),
    selection: guide.selection,
    tieBreakPriority: guide.tieBreakPriority,
    clarificationPolicy: guide.clarificationPolicy,
  };
}

function parseApprovedPatterns(value: unknown, guide: FullApprovedGuide): ApprovedPattern[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw invalid("The approved historical guidance is invalid or too large.");
  }
  const ruleIds = new Set(guide.rules.map((rule) => rule.id));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const pattern = requireRecord(item, `Approved pattern ${index + 1} is invalid.`);
    requireOnlyKeys(pattern, PATTERN_KEYS, `approved pattern ${index + 1}`);
    const id = readString(pattern.id, 300, `approved pattern ${index + 1} ID`);
    const targetRuleId = readString(
      pattern.targetRuleId,
      300,
      `approved pattern ${index + 1} rule ID`,
    );
    if (seen.has(id) || !ruleIds.has(targetRuleId)) {
      throw invalid(`Approved pattern ${index + 1} is duplicated or points to an unknown rule.`);
    }
    seen.add(id);
    return {
      id,
      targetRuleId,
      proposedInterpretation: readString(
        pattern.proposedInterpretation,
        2_000,
        `approved pattern ${index + 1} interpretation`,
      ),
    };
  });
}

function parseCases(value: unknown): SafeCase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CASES) {
    throw invalid(`Use between 1 and ${MAX_CASES} current applications per batch.`);
  }
  const seen = new Set<string>();
  const cases = value.map((item, caseIndex) => {
    const currentCase = requireRecord(item, `Case ${caseIndex + 1} is invalid.`);
    requireOnlyKeys(currentCase, CASE_KEYS, `case ${caseIndex + 1}`);
    const rowId = readString(currentCase.rowId, 300, `case ${caseIndex + 1} row ID`);
    if (!/^[A-Za-z0-9_-]+$/.test(rowId)) {
      throw invalid(`Case ${caseIndex + 1} must use an opaque row ID.`);
    }
    if (seen.has(rowId)) throw invalid(`Case ${caseIndex + 1} repeats a row ID.`);
    seen.add(rowId);
    if (
      !Array.isArray(currentCase.answers) ||
      currentCase.answers.length < 1 ||
      currentCase.answers.length > MAX_ANSWERS_PER_CASE
    ) {
      throw invalid(`Case ${caseIndex + 1} has an invalid answer set.`);
    }
    let totalCharacters = 0;
    const answers = currentCase.answers.map((item, answerIndex) => {
      const answer = requireRecord(item, `Answer ${answerIndex + 1} in case ${caseIndex + 1} is invalid.`);
      requireOnlyKeys(answer, ANSWER_KEYS, `answer ${answerIndex + 1}`);
      const heading = readString(answer.heading, 400, "answer heading", true);
      const answerValue = readString(answer.value, 30_000, "answer value");
      if (isSensitiveAssessmentHeading(heading)) {
        throw new PublicApiError(
          400,
          "unsafe_fields",
          `Answer ${answerIndex + 1} in case ${caseIndex + 1} is an identity, outcome, reviewer or score column and cannot be sent to AI.`,
        );
      }
      totalCharacters += heading.length + answerValue.length;
      return { heading, value: answerValue };
    });
    if (totalCharacters > MAX_CASE_TEXT_CHARS) {
      throw invalid(`Case ${caseIndex + 1} is too long for one safe assessment request.`);
    }
    return { rowId, answers };
  });
  const sortedIds = [...cases.map((item) => item.rowId)].sort((a, b) => a.localeCompare(b));
  if (cases.some((item, index) => item.rowId !== sortedIds[index])) {
    throw invalid("Current-application batches must use the locked row-ID order.");
  }
  return cases;
}

async function verifyHashes(parsed: Awaited<ReturnType<typeof parseRequest>>) {
  const assessmentProtocolHash = await getPhase4AssessmentProtocolHash();
  if (assessmentProtocolHash !== parsed.run.assessmentProtocolHash) {
    throw hashMismatch("The assessment prompt, schema or validation protocol changed after approval.");
  }
  const guideHash = await createPhase4InputFingerprint(parsed.guide);
  const patternsHash = await createPhase4InputFingerprint(parsed.approvedPatterns);
  const batchHash = await createPhase4InputFingerprint(parsed.cases);
  const contractCore = Object.fromEntries(
    Object.entries(parsed.run).filter(([key]) => key !== "contractHash"),
  );
  const contractHash = await createPhase4InputFingerprint(contractCore);
  if (guideHash !== parsed.run.guideContentHash) {
    throw hashMismatch("The Decision Guide changed after this run was approved.");
  }
  if (patternsHash !== parsed.run.approvedPatternsHash) {
    throw hashMismatch("The approved historical guidance changed after this run was approved.");
  }
  if (batchHash !== parsed.batch.batchInputHash) {
    throw hashMismatch("This application batch does not match its locked input hash.");
  }
  if (contractHash !== parsed.run.contractHash) {
    throw hashMismatch("The assessment run contract no longer matches its approval.");
  }
  return assessmentProtocolHash;
}

function requireRecord(
  value: unknown,
  message: string,
  status = 400,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicApiError(
      status,
      status === 502 ? "invalid_ai_response" : "invalid_request",
      message,
    );
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const allowedKeys = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (extras.length === 0) return;
  const unsafe = extras.some((key) => UNSAFE_FIELD_NAMES.has(normalizeFieldName(key)));
  throw new PublicApiError(
    400,
    unsafe ? "unsafe_fields" : "invalid_request",
    unsafe
      ? `The ${label} contains identity, outcome, notes, totals, recommendations or instructions that cannot be sent to AI.`
      : `The ${label} contains unsupported fields.`,
  );
}

function normalizeFieldName(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function boundedString(value: unknown, maximum: number, allowEmpty = false) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim())
    ? value
    : null;
}

function readString(value: unknown, maximum: number, label: string, allowEmpty = false) {
  const result = boundedString(value, maximum, allowEmpty);
  if (result === null) throw invalid(`The ${label} is missing or invalid.`);
  return result;
}

function readInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function readHash(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function isIntegerText(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum;
}

function isIsoTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRuleKind(value: unknown): value is RuleKind {
  return value === "eligibility" || value === "elimination" || value === "criterion";
}

function invalid(message: string) {
  return new PublicApiError(400, "invalid_request", message);
}

function hashMismatch(message: string) {
  return new PublicApiError(409, "contract_mismatch", `${message} No findings were accepted.`);
}
