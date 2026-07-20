import { historicalMatchKey, normalizeHistoricalValue } from "./historical-data.ts";
import { isSensitiveAssessmentHeading } from "./assessment-safety.ts";
export { isSensitiveAssessmentHeading } from "./assessment-safety.ts";
import type { SourceTable } from "./historical-data.ts";
import { pilot } from "./pilot-client.ts";

export const CURRENT_DATASETS_STORE = "current-datasets";
export const CURRENT_CASES_STORE = "current-cases";
export const CURRENT_IDENTITIES_STORE = "current-identities";
export const CURRENT_ACTIVE_STORE = "current-active";

export const MAX_CURRENT_ANSWER_COLUMNS = 40;
export const MAX_CURRENT_ANSWER_CHARS = 30_000;
export const MAX_CURRENT_APPLICATION_CHARS = 70_000;

export type CurrentColumnMapping = {
  applicationId: string;
  teamName: string;
  responseColumns: string[];
  track: string;
};

export type CurrentIssueCode =
  | "missing-id"
  | "missing-text"
  | "duplicate-id"
  | "conflicting-id"
  | "answer-too-long"
  | "application-too-long";

export type CurrentWarningCode = "identical-text" | "repeated-team";

export type PreparedCurrentRow = {
  sourceRowNumber: number;
  externalId: string;
  teamName: string;
  track: string;
  answers: Array<{ heading: string; value: string }>;
  applicationText: string;
  issues: CurrentIssueCode[];
  warnings: CurrentWarningCode[];
};

export type PreparedCurrentDataset = {
  rows: PreparedCurrentRow[];
  readyRows: PreparedCurrentRow[];
  totalRows: number;
  blockedRows: number;
  warningRows: number;
  issueCounts: Partial<Record<CurrentIssueCode, number>>;
  warningCounts: Partial<Record<CurrentWarningCode, number>>;
  mappingProblems: string[];
  canSeal: boolean;
  sealBlockers: string[];
};

export type CurrentImportSummary = {
  status: "empty" | "ready" | "missing";
  datasetId: string | null;
  fileName: string;
  fileSize: number;
  sheetName: string;
  importedAt: string | null;
  totalRows: number;
  readyRows: number;
  blockedRows: number;
  warningRows: number;
  identicalTextRows: number;
  repeatedTeamRows: number;
  datasetFingerprint: string | null;
};

export const EMPTY_CURRENT_IMPORT: CurrentImportSummary = {
  status: "empty",
  datasetId: null,
  fileName: "",
  fileSize: 0,
  sheetName: "",
  importedAt: null,
  totalRows: 0,
  readyRows: 0,
  blockedRows: 0,
  warningRows: 0,
  identicalTextRows: 0,
  repeatedTeamRows: 0,
  datasetFingerprint: null,
};

export type StoredCurrentCase = {
  datasetId: string;
  rowId: string;
  answers: Array<{ heading: string; value: string }>;
  contentHash: string;
};

export type StoredCurrentIdentity = {
  datasetId: string;
  rowId: string;
  sourceRowNumber: number;
  externalId: string;
  teamName: string;
  track: string;
  warnings: CurrentWarningCode[];
};

export type CurrentDatasetMetadata = {
  id: string;
  schemaVersion: 1;
  status: "sealed";
  sourceName: string;
  sourceSheet: string;
  sourceSize: number;
  importedAt: string;
  mapping: CurrentColumnMapping;
  mappingHash: string;
  datasetFingerprint: string;
  integrityHash: string;
  summary: CurrentImportSummary;
};

export type SealedCurrentDataset = {
  metadata: CurrentDatasetMetadata;
  cases: StoredCurrentCase[];
  identities: StoredCurrentIdentity[];
};

export type SafeCurrentCase = Pick<StoredCurrentCase, "rowId" | "answers">;

export type CurrentDatasetBinding = {
  datasetId: string;
  datasetFingerprint: string;
  integrityHash: string;
  totalRows: number;
};

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function sanitizeCurrentImportSummary(value: unknown): CurrentImportSummary {
  if (!value || typeof value !== "object") return { ...EMPTY_CURRENT_IMPORT };
  const source = value as Partial<CurrentImportSummary>;
  const requestedStatus =
    source.status === "ready" || source.status === "missing" ? source.status : "empty";
  const datasetId = cleanString(source.datasetId) || null;
  const datasetFingerprint = cleanString(source.datasetFingerprint) || null;
  const totalRows = safeCount(source.totalRows);
  const readyRows = safeCount(source.readyRows);
  const blockedRows = safeCount(source.blockedRows);
  const status =
    requestedStatus === "ready" && (!datasetId || !datasetFingerprint)
      ? "missing"
      : requestedStatus;
  return {
    status,
    datasetId,
    fileName: cleanString(source.fileName),
    fileSize: safeCount(source.fileSize),
    sheetName: cleanString(source.sheetName),
    importedAt: cleanString(source.importedAt) || null,
    totalRows,
    readyRows,
    blockedRows,
    warningRows: safeCount(source.warningRows),
    identicalTextRows: safeCount(source.identicalTextRows),
    repeatedTeamRows: safeCount(source.repeatedTeamRows),
    datasetFingerprint,
  };
}

function addIssue(row: PreparedCurrentRow, issue: CurrentIssueCode) {
  if (!row.issues.includes(issue)) row.issues.push(issue);
}

function addWarning(row: PreparedCurrentRow, warning: CurrentWarningCode) {
  if (!row.warnings.includes(warning)) row.warnings.push(warning);
}

function mappingProblems(table: SourceTable, mapping: CurrentColumnMapping) {
  const problems: string[] = [];
  const columns = new Map(table.columns.map((column) => [column.key, column]));
  if (!mapping.applicationId) {
    problems.push("Choose the stable application ID column.");
  }
  if (mapping.responseColumns.length === 0) {
    problems.push("Choose at least one application-answer column.");
  }
  if (mapping.responseColumns.length > MAX_CURRENT_ANSWER_COLUMNS) {
    problems.push(
      `Choose no more than ${MAX_CURRENT_ANSWER_COLUMNS} application-answer columns; none will be silently removed.`,
    );
  }
  const selected = [
    mapping.applicationId,
    mapping.teamName,
    mapping.track,
    ...mapping.responseColumns,
  ].filter(Boolean);
  if (new Set(selected).size !== selected.length) {
    problems.push("Each source column can be used only once.");
  }
  if (selected.some((key) => !columns.has(key))) {
    problems.push("One or more selected columns no longer exists in this sheet.");
  }
  const sensitive = mapping.responseColumns
    .map((key) => columns.get(key))
    .filter((column) => column && isSensitiveAssessmentHeading(column.label))
    .map((column) => column!.label);
  if (sensitive.length > 0) {
    problems.push(
      `Move identity, contact, outcome, reviewer or score columns out of assessment answers: ${sensitive.join(", ")}.`,
    );
  }
  return problems;
}

function groupRowIndexes(
  rows: PreparedCurrentRow[],
  getKey: (row: PreparedCurrentRow) => string,
) {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = getKey(row);
    if (!key) return;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return groups;
}

export function prepareCurrentDataset(
  table: SourceTable,
  mapping: CurrentColumnMapping,
): PreparedCurrentDataset {
  const labelByKey = new Map(table.columns.map((column) => [column.key, column.label]));
  const problems = mappingProblems(table, mapping);
  const rows: PreparedCurrentRow[] = table.rows.map((source, index) => {
    const answers = mapping.responseColumns
      .map((key) => ({
        heading: normalizeHistoricalValue(labelByKey.get(key) ?? "Application answer"),
        value: normalizeHistoricalValue(source[key] ?? ""),
      }))
      .filter((answer) => Boolean(answer.value));
    const applicationText = answers
      .map((answer) => `${answer.heading}\n${answer.value}`)
      .join("\n\n");
    const row: PreparedCurrentRow = {
      sourceRowNumber: table.rowNumbers[index] ?? index + 2,
      externalId: normalizeHistoricalValue(source[mapping.applicationId] ?? ""),
      teamName: normalizeHistoricalValue(source[mapping.teamName] ?? ""),
      track: normalizeHistoricalValue(source[mapping.track] ?? ""),
      answers,
      applicationText,
      issues: [],
      warnings: [],
    };
    if (!row.externalId) addIssue(row, "missing-id");
    if (!row.applicationText) addIssue(row, "missing-text");
    if (answers.some((answer) => answer.value.length > MAX_CURRENT_ANSWER_CHARS)) {
      addIssue(row, "answer-too-long");
    }
    const totalCharacters = answers.reduce(
      (total, answer) => total + answer.heading.length + answer.value.length,
      0,
    );
    if (totalCharacters > MAX_CURRENT_APPLICATION_CHARS) {
      addIssue(row, "application-too-long");
    }
    return row;
  });

  groupRowIndexes(rows, (row) => historicalMatchKey(row.externalId)).forEach((indexes) => {
    if (indexes.length < 2) return;
    const signatures = new Set(
      indexes.map((index) => {
        const row = rows[index];
        return [
          historicalMatchKey(row.teamName),
          historicalMatchKey(row.track),
          historicalMatchKey(row.applicationText),
        ].join("\u0000");
      }),
    );
    indexes.forEach((index) =>
      addIssue(rows[index], signatures.size === 1 ? "duplicate-id" : "conflicting-id"),
    );
  });

  groupRowIndexes(rows, (row) => historicalMatchKey(row.applicationText)).forEach((indexes) => {
    if (indexes.length < 2) return;
    indexes.forEach((index) => addWarning(rows[index], "identical-text"));
  });

  groupRowIndexes(rows, (row) => historicalMatchKey(row.teamName)).forEach((indexes) => {
    if (indexes.length < 2) return;
    indexes.forEach((index) => addWarning(rows[index], "repeated-team"));
  });

  const readyRows = rows.filter((row) => row.issues.length === 0);
  const issueCounts: Partial<Record<CurrentIssueCode, number>> = {};
  const warningCounts: Partial<Record<CurrentWarningCode, number>> = {};
  rows.forEach((row) => {
    row.issues.forEach((issue) => {
      issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    });
    row.warnings.forEach((warning) => {
      warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
    });
  });
  const blockedRows = rows.length - readyRows.length;
  const warningRows = rows.filter((row) => row.warnings.length > 0).length;
  const sealBlockers = [...problems];
  if (rows.length === 0) sealBlockers.push("The sheet has no application rows.");
  if (blockedRows > 0) {
    sealBlockers.push(
      `${blockedRows.toLocaleString()} application ${blockedRows === 1 ? "row needs" : "rows need"} correction; no candidate will be silently excluded.`,
    );
  }
  return {
    rows,
    readyRows,
    totalRows: rows.length,
    blockedRows,
    warningRows,
    issueCounts,
    warningCounts,
    mappingProblems: problems,
    canSeal: sealBlockers.length === 0 && readyRows.length === rows.length,
    sealBlockers,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser hashing is unavailable.");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function secureOpaqueId(prefix: string) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser cannot create private application identifiers.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function rowContent(row: Pick<PreparedCurrentRow, "externalId" | "teamName" | "track" | "answers">) {
  return {
    externalId: historicalMatchKey(row.externalId),
    teamName: historicalMatchKey(row.teamName),
    track: historicalMatchKey(row.track),
    answers: row.answers.map((answer) => ({
      heading: historicalMatchKey(answer.heading),
      value: normalizeHistoricalValue(answer.value),
    })),
  };
}

function integrityPayload(
  metadata: Omit<CurrentDatasetMetadata, "integrityHash">,
  cases: StoredCurrentCase[],
  identities: StoredCurrentIdentity[],
) {
  const identitiesByRow = new Map(identities.map((identity) => [identity.rowId, identity]));
  return {
    metadata,
    assignments: cases
      .map((item) => {
        const identity = identitiesByRow.get(item.rowId);
        return {
          rowId: item.rowId,
          contentHash: item.contentHash,
          sourceRowNumber: identity?.sourceRowNumber ?? null,
          warnings: identity?.warnings ?? [],
        };
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId)),
  };
}

export async function createCurrentDataset(args: {
  datasetId?: string;
  fileName: string;
  fileSize: number;
  table: SourceTable;
  mapping: CurrentColumnMapping;
}): Promise<SealedCurrentDataset> {
  const prepared = prepareCurrentDataset(args.table, args.mapping);
  if (!prepared.canSeal || prepared.readyRows.length !== prepared.totalRows) {
    throw new Error(prepared.sealBlockers[0] ?? "The current applications are not ready.");
  }
  const datasetId = normalizeHistoricalValue(args.datasetId ?? "") || secureOpaqueId("current");
  const usedRowIds = new Set<string>();
  const paired = await Promise.all(
    prepared.rows.map(async (row) => {
      let rowId = secureOpaqueId("case");
      while (usedRowIds.has(rowId)) rowId = secureOpaqueId("case");
      usedRowIds.add(rowId);
      const contentHash = await sha256(stableJson(rowContent(row)));
      const currentCase: StoredCurrentCase = {
        datasetId,
        rowId,
        answers: row.answers.map((answer) => ({ ...answer })),
        contentHash,
      };
      const identity: StoredCurrentIdentity = {
        datasetId,
        rowId,
        sourceRowNumber: row.sourceRowNumber,
        externalId: row.externalId,
        teamName: row.teamName,
        track: row.track,
        warnings: [...row.warnings],
      };
      return { currentCase, identity };
    }),
  );
  const cases = paired.map((item) => item.currentCase);
  const identities = paired.map((item) => item.identity);
  const datasetFingerprint = await sha256(
    cases.map((item) => item.contentHash).sort().join("\n"),
  );
  const mapping = {
    applicationId: args.mapping.applicationId,
    teamName: args.mapping.teamName,
    responseColumns: [...args.mapping.responseColumns],
    track: args.mapping.track,
  };
  const mappingHash = await sha256(stableJson(mapping));
  const importedAt = new Date().toISOString();
  const summary: CurrentImportSummary = {
    status: "ready",
    datasetId,
    fileName: args.fileName,
    fileSize: safeCount(args.fileSize),
    sheetName: args.table.sheetName,
    importedAt,
    totalRows: prepared.totalRows,
    readyRows: prepared.totalRows,
    blockedRows: 0,
    warningRows: prepared.warningRows,
    identicalTextRows: prepared.warningCounts["identical-text"] ?? 0,
    repeatedTeamRows: prepared.warningCounts["repeated-team"] ?? 0,
    datasetFingerprint,
  };
  const withoutIntegrity: Omit<CurrentDatasetMetadata, "integrityHash"> = {
    id: datasetId,
    schemaVersion: 1,
    status: "sealed",
    sourceName: args.fileName,
    sourceSheet: args.table.sheetName,
    sourceSize: safeCount(args.fileSize),
    importedAt,
    mapping,
    mappingHash,
    datasetFingerprint,
    summary,
  };
  const integrityHash = await sha256(
    stableJson(integrityPayload(withoutIntegrity, cases, identities)),
  );
  return {
    metadata: { ...withoutIntegrity, integrityHash },
    cases,
    identities,
  };
}

type StoredDatasetRead = {
  metadata: CurrentDatasetMetadata | undefined;
  cases: StoredCurrentCase[];
  identities: StoredCurrentIdentity[];
};

function allowedWarning(value: unknown): value is CurrentWarningCode {
  return value === "identical-text" || value === "repeated-team";
}

export async function sealedCurrentDatasetIsValid(
  datasetId: string,
  stored: StoredDatasetRead,
) {
  try {
    const { metadata, cases, identities } = stored;
    if (
      !metadata ||
      metadata.id !== datasetId ||
      metadata.schemaVersion !== 1 ||
      metadata.status !== "sealed" ||
      metadata.summary.status !== "ready" ||
      metadata.summary.datasetId !== datasetId ||
      metadata.summary.datasetFingerprint !== metadata.datasetFingerprint ||
      metadata.summary.totalRows !== cases.length ||
      metadata.summary.readyRows !== cases.length ||
      metadata.summary.blockedRows !== 0 ||
      cases.length === 0 ||
      cases.length !== identities.length
    ) {
      return false;
    }
    const casesByRow = new Map(cases.map((item) => [item.rowId, item]));
    const identitiesByRow = new Map(identities.map((item) => [item.rowId, item]));
    if (casesByRow.size !== cases.length || identitiesByRow.size !== identities.length) {
      return false;
    }
    const externalIds = new Set<string>();
    const rowsToHash: Array<{
      currentCase: StoredCurrentCase;
      identity: StoredCurrentIdentity;
    }> = [];
    for (const identity of identities) {
      const currentCase = casesByRow.get(identity.rowId);
      const externalIdKey = historicalMatchKey(identity.externalId);
      if (
        !currentCase ||
        currentCase.datasetId !== datasetId ||
        identity.datasetId !== datasetId ||
        !identity.rowId ||
        !externalIdKey ||
        externalIds.has(externalIdKey) ||
        !Number.isInteger(identity.sourceRowNumber) ||
        identity.sourceRowNumber < 1 ||
        !Array.isArray(identity.warnings) ||
        identity.warnings.some((warning) => !allowedWarning(warning)) ||
        !Array.isArray(currentCase.answers) ||
        currentCase.answers.length < 1 ||
        currentCase.answers.length > MAX_CURRENT_ANSWER_COLUMNS
      ) {
        return false;
      }
      externalIds.add(externalIdKey);
      let totalCharacters = 0;
      for (const answer of currentCase.answers) {
        if (
          !answer ||
          typeof answer.heading !== "string" ||
          typeof answer.value !== "string" ||
          !answer.value ||
          answer.value.length > MAX_CURRENT_ANSWER_CHARS
        ) {
          return false;
        }
        totalCharacters += answer.heading.length + answer.value.length;
      }
      if (totalCharacters > MAX_CURRENT_APPLICATION_CHARS) return false;
      rowsToHash.push({ currentCase, identity });
    }
    if (cases.some((item) => !identitiesByRow.has(item.rowId))) return false;
    const recomputedContentHashes = await Promise.all(
      rowsToHash.map(({ currentCase, identity }) =>
        sha256(
          stableJson(
            rowContent({
              externalId: identity.externalId,
              teamName: identity.teamName,
              track: identity.track,
              answers: currentCase.answers,
            }),
          ),
        ).then((contentHash) => ({ expected: currentCase.contentHash, contentHash })),
      ),
    );
    if (recomputedContentHashes.some((item) => item.contentHash !== item.expected)) return false;
    const datasetFingerprint = await sha256(
      recomputedContentHashes
        .map((item) => item.contentHash)
        .sort()
        .join("\n"),
    );
    const mappingHash = await sha256(stableJson(metadata.mapping));
    if (
      datasetFingerprint !== metadata.datasetFingerprint ||
      mappingHash !== metadata.mappingHash
    ) {
      return false;
    }
    const warningRows = identities.filter((item) => item.warnings.length > 0).length;
    const identicalTextRows = identities.filter((item) =>
      item.warnings.includes("identical-text"),
    ).length;
    const repeatedTeamRows = identities.filter((item) =>
      item.warnings.includes("repeated-team"),
    ).length;
    if (
      warningRows !== metadata.summary.warningRows ||
      identicalTextRows !== metadata.summary.identicalTextRows ||
      repeatedTeamRows !== metadata.summary.repeatedTeamRows ||
      metadata.sourceName !== metadata.summary.fileName ||
      metadata.sourceSheet !== metadata.summary.sheetName ||
      metadata.sourceSize !== metadata.summary.fileSize ||
      metadata.importedAt !== metadata.summary.importedAt
    ) {
      return false;
    }
    const { integrityHash, ...withoutIntegrity } = metadata;
    const recomputedIntegrity = await sha256(
      stableJson(integrityPayload(withoutIntegrity, cases, identities)),
    );
    return recomputedIntegrity === integrityHash;
  } catch {
    return false;
  }
}

export type CurrentDatasetSave = {
  fileName: string;
  fileSize: number;
  table: SourceTable;
  mapping: CurrentColumnMapping;
  replaceDatasetId?: string | null;
};

/** The API re-prepares, hashes and seals the raw current-applications import. */
export async function saveCurrentDataset(input: CurrentDatasetSave) {
  return pilot<{
    datasetId: string;
    fingerprint: string;
    summary: CurrentImportSummary;
  }>("current.import", {
    fileName: input.fileName,
    fileSize: input.fileSize,
    table: input.table,
    mapping: input.mapping,
    replaceDatasetId: input.replaceDatasetId ?? null,
  });
}

export async function currentDatasetExists(datasetId: string) {
  const result = await pilot<{ exists: boolean }>("current.exists", { datasetId });
  return result.exists;
}

export async function loadActiveCurrentSummary() {
  return pilot<CurrentImportSummary | null>("current.active");
}

export async function loadCurrentCasesForAi(datasetId: string): Promise<SafeCurrentCase[]> {
  const rows = await pilot<SafeCurrentCase[]>("current.aiCases", { datasetId });
  if (!Array.isArray(rows)) throw new Error("The server returned invalid application data.");
  return rows;
}

export async function loadCurrentIdentitiesForReview(datasetId: string) {
  const rows = await pilot<StoredCurrentIdentity[]>("current.identities", { datasetId });
  if (!Array.isArray(rows)) throw new Error("The server returned invalid application identities.");
  return rows;
}

export async function loadCurrentDatasetBinding(
  datasetId: string,
): Promise<CurrentDatasetBinding> {
  const binding = await pilot<CurrentDatasetBinding | null>("current.binding", { datasetId });
  if (!binding) {
    throw new Error("The saved current applications did not pass their integrity check.");
  }
  return binding;
}

export async function deleteCurrentDataset(datasetId: string) {
  await pilot("current.delete", { datasetId });
}
