import { isSensitiveAssessmentHeading } from "../app/assessment-safety.ts";
import { sha256Text, stableStringify } from "./current-import-contract.ts";

export const HISTORICAL_IMPORT_SCHEMA_VERSION = 1;
export const MAX_HISTORICAL_IMPORT_ROWS = 1_000;
export const MAX_HISTORICAL_IMPORT_CHUNKS = 100;
export const MAX_HISTORICAL_IMPORT_ROWS_PER_CHUNK = 25;
export const MAX_HISTORICAL_IMPORT_CHUNK_CANONICAL_BYTES = 750_000;
export const MAX_HISTORICAL_IMPORT_REQUEST_BYTES = 900_000;
export const MAX_HISTORICAL_IMPORT_ROW_CANONICAL_BYTES = 250_000;
export const MAX_HISTORICAL_IMPORT_SOURCE_CANONICAL_BYTES = 32_000_000;

const EXTERNAL_REF = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const OUTCOMES = new Set(["progressed", "not_progressed", "waitlist", "ineligible"]);

export type HistoricalOutcome = "progressed" | "not_progressed" | "waitlist" | "ineligible";

export type HistoricalImportRowInput = Readonly<{
  externalRef: string;
  answers: readonly Readonly<{ heading: string; value: string }>[];
  outcome: HistoricalOutcome;
  year?: string;
  track?: string;
}>;

export type CanonicalHistoricalImportRow = Readonly<{
  externalRef: string;
  answers: readonly Readonly<{ heading: string; value: string }>[];
  outcome: HistoricalOutcome;
  year: string;
  track: string;
}>;

export type PreparedHistoricalImportRow = Readonly<{
  canonical: CanonicalHistoricalImportRow;
  contentHash: string;
  labelHash: string;
  rowHash: string;
  canonicalBytes: number;
}>;

export type PreparedHistoricalImportChunk = Readonly<{
  rows: readonly PreparedHistoricalImportRow[];
  chunkHash: string;
  canonicalBytes: number;
}>;

export class HistoricalImportContractError extends Error {
  readonly code:
    | "invalid_external_ref"
    | "duplicate_external_ref"
    | "invalid_answer"
    | "sensitive_heading"
    | "invalid_outcome"
    | "invalid_metadata"
    | "row_too_large"
    | "chunk_too_large"
    | "invalid_chunk_size";

  constructor(code: HistoricalImportContractError["code"]) {
    super(code);
    this.name = "HistoricalImportContractError";
    this.code = code;
  }
}

function cleanMetadata(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new HistoricalImportContractError("invalid_metadata");
  const cleaned = value.normalize("NFC").trim();
  if (cleaned.length > 160 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new HistoricalImportContractError("invalid_metadata");
  }
  return cleaned;
}

export function normalizeHistoricalImportRow(
  input: HistoricalImportRowInput,
): CanonicalHistoricalImportRow {
  const externalRef = input.externalRef.normalize("NFC").trim();
  if (!EXTERNAL_REF.test(externalRef)) {
    throw new HistoricalImportContractError("invalid_external_ref");
  }
  if (!OUTCOMES.has(input.outcome)) {
    throw new HistoricalImportContractError("invalid_outcome");
  }
  if (!Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 40) {
    throw new HistoricalImportContractError("invalid_answer");
  }
  const answers = input.answers.map((answer) => {
    if (!answer || typeof answer.heading !== "string" || typeof answer.value !== "string") {
      throw new HistoricalImportContractError("invalid_answer");
    }
    const heading = answer.heading.normalize("NFC").trim();
    const value = answer.value.normalize("NFC").trim();
    if (
      heading.length < 1 ||
      heading.length > 300 ||
      value.length < 1 ||
      value.length > 100_000 ||
      /[\u0000\u007f]/u.test(heading) ||
      /\u0000/u.test(value)
    ) {
      throw new HistoricalImportContractError("invalid_answer");
    }
    if (isSensitiveAssessmentHeading(heading)) {
      throw new HistoricalImportContractError("sensitive_heading");
    }
    return { heading, value };
  });
  return {
    externalRef,
    answers,
    outcome: input.outcome,
    year: cleanMetadata(input.year),
    track: cleanMetadata(input.track),
  };
}

export async function prepareHistoricalImportChunk(
  inputs: readonly HistoricalImportRowInput[],
): Promise<PreparedHistoricalImportChunk> {
  if (inputs.length < 1 || inputs.length > MAX_HISTORICAL_IMPORT_ROWS_PER_CHUNK) {
    throw new HistoricalImportContractError("invalid_chunk_size");
  }
  const externalRefs = new Set<string>();
  const rows: PreparedHistoricalImportRow[] = [];
  for (const input of inputs) {
    const canonical = normalizeHistoricalImportRow(input);
    if (externalRefs.has(canonical.externalRef)) {
      throw new HistoricalImportContractError("duplicate_external_ref");
    }
    externalRefs.add(canonical.externalRef);
    const content = { answers: canonical.answers };
    const label = { outcome: canonical.outcome, year: canonical.year, track: canonical.track };
    const canonicalText = stableStringify(canonical);
    const canonicalBytes = new TextEncoder().encode(canonicalText).byteLength;
    if (canonicalBytes > MAX_HISTORICAL_IMPORT_ROW_CANONICAL_BYTES) {
      throw new HistoricalImportContractError("row_too_large");
    }
    const [contentHash, labelHash, rowHash] = await Promise.all([
      sha256Text(stableStringify(content)),
      sha256Text(stableStringify(label)),
      sha256Text(canonicalText),
    ]);
    rows.push({ canonical, contentHash, labelHash, rowHash, canonicalBytes });
  }
  const chunkText = stableStringify(rows.map((row) => row.canonical));
  const canonicalBytes = new TextEncoder().encode(chunkText).byteLength;
  if (canonicalBytes > MAX_HISTORICAL_IMPORT_CHUNK_CANONICAL_BYTES) {
    throw new HistoricalImportContractError("chunk_too_large");
  }
  return { rows, chunkHash: await sha256Text(chunkText), canonicalBytes };
}

export async function historicalImportSourceHash(
  rows: readonly CanonicalHistoricalImportRow[],
): Promise<{ sourceHash: string; canonicalBytes: number }> {
  const sourceText = stableStringify(rows);
  const canonicalBytes = new TextEncoder().encode(sourceText).byteLength;
  if (canonicalBytes > MAX_HISTORICAL_IMPORT_SOURCE_CANONICAL_BYTES) {
    throw new HistoricalImportContractError("chunk_too_large");
  }
  return { sourceHash: await sha256Text(sourceText), canonicalBytes };
}
