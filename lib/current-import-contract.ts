export const CURRENT_IMPORT_SCHEMA_VERSION = 1;
export const MAX_CURRENT_IMPORT_ROWS = 1_000;
export const MAX_CURRENT_IMPORT_CHUNKS = 100;
export const MAX_CURRENT_IMPORT_ROWS_PER_CHUNK = 25;
export const MAX_CURRENT_IMPORT_CHUNK_CANONICAL_BYTES = 750_000;
export const MAX_CURRENT_IMPORT_REQUEST_BYTES = 900_000;
export const MAX_CURRENT_IMPORT_ROW_CANONICAL_BYTES = 250_000;
export const MAX_CURRENT_IMPORT_SOURCE_CANONICAL_BYTES = 32_000_000;

const HASH = /^[0-9a-f]{64}$/;
const EXTERNAL_REF = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

export type CurrentImportRowInput = Readonly<{
  externalRef: string;
  identityData: Readonly<Record<string, unknown>>;
  content: Readonly<Record<string, unknown>>;
  submittedAt?: string | null;
}>;

export type CanonicalCurrentImportRow = Readonly<{
  externalRef: string;
  identityData: Readonly<Record<string, unknown>>;
  content: Readonly<Record<string, unknown>>;
  submittedAt: string | null;
}>;

export type PreparedCurrentImportRow = Readonly<{
  canonical: CanonicalCurrentImportRow;
  identityHash: string;
  contentHash: string;
  rowHash: string;
  canonicalBytes: number;
}>;

export type PreparedCurrentImportChunk = Readonly<{
  rows: readonly PreparedCurrentImportRow[];
  chunkHash: string;
  canonicalBytes: number;
}>;

export class CurrentImportContractError extends Error {
  readonly code:
    | "invalid_json_value"
    | "invalid_external_ref"
    | "duplicate_external_ref"
    | "invalid_submitted_at"
    | "empty_application_content"
    | "row_too_large"
    | "chunk_too_large"
    | "invalid_chunk_size";

  constructor(code: CurrentImportContractError["code"]) {
    super(code);
    this.name = "CurrentImportContractError";
    this.code = code;
  }
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new CurrentImportContractError("invalid_json_value");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CurrentImportContractError("invalid_json_value");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new CurrentImportContractError("invalid_json_value");
    return value.map((item) => stableValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new CurrentImportContractError("invalid_json_value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CurrentImportContractError("invalid_json_value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw new CurrentImportContractError("invalid_json_value");
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => {
        if (
          key.length < 1 ||
          key.length > 200 ||
          /[\u0000-\u001f\u007f]/u.test(key) ||
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) throw new CurrentImportContractError("invalid_json_value");
        return [key, stableValue(nested, depth + 1)];
      }),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function isSafeImportIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && SAFE_KEY.test(value);
}

function canonicalSubmittedAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 64) {
    throw new CurrentImportContractError("invalid_submitted_at");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CurrentImportContractError("invalid_submitted_at");
  }
  return date.toISOString();
}

function canonicalObject(value: unknown): Readonly<Record<string, unknown>> {
  const stable = stableValue(value);
  if (!stable || typeof stable !== "object" || Array.isArray(stable)) {
    throw new CurrentImportContractError("invalid_json_value");
  }
  return stable as Readonly<Record<string, unknown>>;
}

export function normalizeCurrentImportRow(input: CurrentImportRowInput): CanonicalCurrentImportRow {
  const externalRef = input.externalRef.normalize("NFC").trim();
  if (!EXTERNAL_REF.test(externalRef)) {
    throw new CurrentImportContractError("invalid_external_ref");
  }
  const identityData = canonicalObject(input.identityData);
  const content = canonicalObject(input.content);
  if (Object.keys(content).length === 0) {
    throw new CurrentImportContractError("empty_application_content");
  }
  return {
    externalRef,
    identityData,
    content,
    submittedAt: canonicalSubmittedAt(input.submittedAt),
  };
}

export async function prepareCurrentImportChunk(
  inputs: readonly CurrentImportRowInput[],
): Promise<PreparedCurrentImportChunk> {
  if (inputs.length < 1 || inputs.length > MAX_CURRENT_IMPORT_ROWS_PER_CHUNK) {
    throw new CurrentImportContractError("invalid_chunk_size");
  }
  const externalRefs = new Set<string>();
  const rows: PreparedCurrentImportRow[] = [];
  for (const input of inputs) {
    const canonical = normalizeCurrentImportRow(input);
    if (externalRefs.has(canonical.externalRef)) {
      throw new CurrentImportContractError("duplicate_external_ref");
    }
    externalRefs.add(canonical.externalRef);
    const canonicalText = stableStringify(canonical);
    const canonicalBytes = new TextEncoder().encode(canonicalText).byteLength;
    if (canonicalBytes > MAX_CURRENT_IMPORT_ROW_CANONICAL_BYTES) {
      throw new CurrentImportContractError("row_too_large");
    }
    const [identityHash, contentHash, rowHash] = await Promise.all([
      sha256Text(stableStringify(canonical.identityData)),
      sha256Text(stableStringify(canonical.content)),
      sha256Text(canonicalText),
    ]);
    rows.push({ canonical, identityHash, contentHash, rowHash, canonicalBytes });
  }

  const chunkText = stableStringify(rows.map((row) => row.canonical));
  const canonicalBytes = new TextEncoder().encode(chunkText).byteLength;
  if (canonicalBytes > MAX_CURRENT_IMPORT_CHUNK_CANONICAL_BYTES) {
    throw new CurrentImportContractError("chunk_too_large");
  }
  return {
    rows,
    chunkHash: await sha256Text(chunkText),
    canonicalBytes,
  };
}

export async function currentImportSourceHash(
  rows: readonly CanonicalCurrentImportRow[],
): Promise<{ sourceHash: string; canonicalBytes: number }> {
  const sourceText = stableStringify(rows);
  const canonicalBytes = new TextEncoder().encode(sourceText).byteLength;
  if (canonicalBytes > MAX_CURRENT_IMPORT_SOURCE_CANONICAL_BYTES) {
    throw new CurrentImportContractError("chunk_too_large");
  }
  return { sourceHash: await sha256Text(sourceText), canonicalBytes };
}

