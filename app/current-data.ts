import {
  PHASE5_RUNS_STORE,
  historicalMatchKey,
  normalizeHistoricalValue,
  openDatabase,
  transactionComplete,
} from "./historical-data.ts";
import { isSensitiveAssessmentHeading } from "./assessment-safety.ts";
export { isSensitiveAssessmentHeading } from "./assessment-safety.ts";
import type { SourceTable } from "./historical-data.ts";

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

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Private browser storage failed."));
  });
}

type StoredDatasetRead = {
  metadata: CurrentDatasetMetadata | undefined;
  cases: StoredCurrentCase[];
  identities: StoredCurrentIdentity[];
};

function readStoredDataset(database: IDBDatabase, datasetId: string) {
  return new Promise<StoredDatasetRead>((resolve, reject) => {
    const transaction = database.transaction(
      [CURRENT_DATASETS_STORE, CURRENT_CASES_STORE, CURRENT_IDENTITIES_STORE],
      "readonly",
    );
    const metadataRequest = transaction
      .objectStore(CURRENT_DATASETS_STORE)
      .get(datasetId) as IDBRequest<CurrentDatasetMetadata | undefined>;
    const casesRequest = transaction
      .objectStore(CURRENT_CASES_STORE)
      .index("datasetId")
      .getAll(IDBKeyRange.only(datasetId)) as IDBRequest<StoredCurrentCase[]>;
    const identitiesRequest = transaction
      .objectStore(CURRENT_IDENTITIES_STORE)
      .index("datasetId")
      .getAll(IDBKeyRange.only(datasetId)) as IDBRequest<StoredCurrentIdentity[]>;
    transaction.oncomplete = () =>
      resolve({
        metadata: metadataRequest.result,
        cases: casesRequest.result,
        identities: identitiesRequest.result,
      });
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Private browser storage failed."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Private browser storage failed."));
  });
}

function allowedWarning(value: unknown): value is CurrentWarningCode {
  return value === "identical-text" || value === "repeated-team";
}

async function verifyDatasetRecords(datasetId: string, stored: StoredDatasetRead) {
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

function deleteRowsForDataset(store: IDBObjectStore, datasetId: string) {
  const request = store.index("datasetId").openCursor(IDBKeyRange.only(datasetId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

export async function saveCurrentDataset(
  dataset: SealedCurrentDataset,
  replaceDatasetId?: string | null,
) {
  if (
    !(await verifyDatasetRecords(dataset.metadata.id, {
      metadata: dataset.metadata,
      cases: dataset.cases,
      identities: dataset.identities,
    }))
  ) {
    throw new Error("The current-application set did not pass its integrity check.");
  }
  if (replaceDatasetId && replaceDatasetId === dataset.metadata.id) {
    throw new Error("A sealed current-application set is immutable; create a replacement set.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [
        CURRENT_DATASETS_STORE,
        CURRENT_CASES_STORE,
        CURRENT_IDENTITIES_STORE,
        CURRENT_ACTIVE_STORE,
        PHASE5_RUNS_STORE,
      ],
      "readwrite",
    );
    const datasets = transaction.objectStore(CURRENT_DATASETS_STORE);
    const cases = transaction.objectStore(CURRENT_CASES_STORE);
    const identities = transaction.objectStore(CURRENT_IDENTITIES_STORE);
    if (replaceDatasetId) {
      const referencedRuns = await requestResult(
        transaction
          .objectStore(PHASE5_RUNS_STORE)
          .index("datasetId")
          .getAllKeys(IDBKeyRange.only(replaceDatasetId)),
      );
      if (referencedRuns.length === 0) {
        datasets.delete(replaceDatasetId);
        deleteRowsForDataset(cases, replaceDatasetId);
        deleteRowsForDataset(identities, replaceDatasetId);
      }
    }
    datasets.add(dataset.metadata);
    dataset.cases.forEach((item) => cases.add(item));
    dataset.identities.forEach((item) => identities.add(item));
    transaction.objectStore(CURRENT_ACTIVE_STORE).put({
      key: "active",
      datasetId: dataset.metadata.id,
      summary: dataset.metadata.summary,
    });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function currentDatasetExists(datasetId: string) {
  const database = await openDatabase();
  try {
    return await verifyDatasetRecords(datasetId, await readStoredDataset(database, datasetId));
  } finally {
    database.close();
  }
}

export async function loadActiveCurrentSummary() {
  const database = await openDatabase();
  try {
    const pointer = await requestResult(
      database
        .transaction(CURRENT_ACTIVE_STORE, "readonly")
        .objectStore(CURRENT_ACTIVE_STORE)
        .get("active") as IDBRequest<
        | { key: "active"; datasetId: string; summary: CurrentImportSummary }
        | undefined
      >,
    );
    if (!pointer?.datasetId) return null;
    const stored = await readStoredDataset(database, pointer.datasetId);
    if (!(await verifyDatasetRecords(pointer.datasetId, stored)) || !stored.metadata) {
      throw new Error("The saved current applications did not pass their integrity check.");
    }
    return stored.metadata.summary;
  } finally {
    database.close();
  }
}

export async function loadCurrentCasesForAi(datasetId: string): Promise<SafeCurrentCase[]> {
  const database = await openDatabase();
  try {
    const stored = await readStoredDataset(database, datasetId);
    if (!(await verifyDatasetRecords(datasetId, stored))) {
      throw new Error("The saved current applications did not pass their integrity check.");
    }
    return stored.cases
      .map((item) => ({
        rowId: item.rowId,
        answers: item.answers.map((answer) => ({ ...answer })),
      }))
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
  } finally {
    database.close();
  }
}

export async function loadCurrentIdentitiesForReview(datasetId: string) {
  const database = await openDatabase();
  try {
    const stored = await readStoredDataset(database, datasetId);
    if (!(await verifyDatasetRecords(datasetId, stored))) {
      throw new Error("The saved current applications did not pass their integrity check.");
    }
    return stored.identities
      .map((item) => ({ ...item, warnings: [...item.warnings] }))
      .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  } finally {
    database.close();
  }
}

export async function loadCurrentDatasetBinding(
  datasetId: string,
): Promise<CurrentDatasetBinding> {
  const database = await openDatabase();
  try {
    const stored = await readStoredDataset(database, datasetId);
    if (!(await verifyDatasetRecords(datasetId, stored)) || !stored.metadata) {
      throw new Error("The saved current applications did not pass their integrity check.");
    }
    return {
      datasetId,
      datasetFingerprint: stored.metadata.datasetFingerprint,
      integrityHash: stored.metadata.integrityHash,
      totalRows: stored.cases.length,
    };
  } finally {
    database.close();
  }
}

export async function deleteCurrentDataset(datasetId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [
        CURRENT_DATASETS_STORE,
        CURRENT_CASES_STORE,
        CURRENT_IDENTITIES_STORE,
        CURRENT_ACTIVE_STORE,
        PHASE5_RUNS_STORE,
      ],
      "readwrite",
    );
    const referencedRuns = await requestResult(
      transaction
        .objectStore(PHASE5_RUNS_STORE)
        .index("datasetId")
        .getAllKeys(IDBKeyRange.only(datasetId)),
    );
    if (referencedRuns.length > 0) {
      transaction.abort();
      throw new Error("Applications referenced by an assessment run cannot be removed.");
    }
    transaction.objectStore(CURRENT_DATASETS_STORE).delete(datasetId);
    deleteRowsForDataset(transaction.objectStore(CURRENT_CASES_STORE), datasetId);
    deleteRowsForDataset(transaction.objectStore(CURRENT_IDENTITIES_STORE), datasetId);
    const active = transaction.objectStore(CURRENT_ACTIVE_STORE);
    const activeRequest = active.get("active");
    activeRequest.onsuccess = () => {
      if (activeRequest.result?.datasetId === datasetId) active.delete("active");
    };
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
