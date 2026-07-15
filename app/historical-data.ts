export type CanonicalOutcome =
  | "progressed"
  | "not_progressed"
  | "waitlist"
  | "ineligible";

export type OutcomeChoice = CanonicalOutcome | "ignore";

export type SourceColumn = {
  key: string;
  label: string;
  index: number;
};

export type SourceTable = {
  sheetName: string;
  columns: SourceColumn[];
  rows: Array<Record<string, string>>;
  rowNumbers: number[];
};

export type HistoricalColumnMapping = {
  applicationId: string;
  teamName: string;
  responseColumns: string[];
  outcome: string;
  year: string;
  track: string;
  judgeScore: string;
  reviewerNotes: string;
};

export type HistoricalImportSummary = {
  status: "empty" | "ready" | "missing";
  datasetId: string | null;
  fileName: string;
  fileSize: number;
  sheetName: string;
  importedAt: string | null;
  guideVersion: number | null;
  totalRows: number;
  validRows: number;
  excludedRows: number;
  duplicateRows: number;
  warningRows: number;
  teachingRows: number;
  sealedRows: number;
  outcomeCounts: Record<CanonicalOutcome, number>;
};

export const EMPTY_HISTORICAL_IMPORT: HistoricalImportSummary = {
  status: "empty",
  datasetId: null,
  fileName: "",
  fileSize: 0,
  sheetName: "",
  importedAt: null,
  guideVersion: null,
  totalRows: 0,
  validRows: 0,
  excludedRows: 0,
  duplicateRows: 0,
  warningRows: 0,
  teachingRows: 0,
  sealedRows: 0,
  outcomeCounts: {
    progressed: 0,
    not_progressed: 0,
    waitlist: 0,
    ineligible: 0,
  },
};

export type HistoricalIssueCode =
  | "missing-team"
  | "missing-text"
  | "missing-outcome"
  | "unmapped-outcome"
  | "ignored-outcome"
  | "duplicate-id"
  | "conflicting-id"
  | "duplicate-text"
  | "conflicting-outcome";

export type HistoricalWarningCode = "short-text" | "repeated-team-year";

export type PreparedHistoricalRow = {
  sourceRowNumber: number;
  externalId: string;
  teamName: string;
  answers: Array<{ heading: string; value: string }>;
  applicationText: string;
  sourceOutcome: string;
  outcome: OutcomeChoice | null;
  year: string;
  track: string;
  judgeScore: string;
  reviewerNotes: string;
  issues: HistoricalIssueCode[];
  warnings: HistoricalWarningCode[];
};

export type PreparedHistoricalDataset = {
  rows: PreparedHistoricalRow[];
  validRows: PreparedHistoricalRow[];
  totalRows: number;
  excludedRows: number;
  duplicateRows: number;
  warningRows: number;
  outcomeCounts: Record<CanonicalOutcome, number>;
  issueCounts: Partial<Record<HistoricalIssueCode, number>>;
  warningCounts: Partial<Record<HistoricalWarningCode, number>>;
  canSeal: boolean;
  sealBlockers: string[];
};

export type StoredHistoricalRow = {
  datasetId: string;
  rowId: string;
  sourceRowNumber: number;
  externalId: string;
  teamName: string;
  answers: Array<{ heading: string; value: string }>;
  applicationText: string;
  sourceOutcome: string;
  outcome: CanonicalOutcome;
  year: string;
  track: string;
  judgeScore: string;
  reviewerNotes: string;
  partition: "teaching" | "sealed_test";
};

type HistoricalDatasetMetadata = {
  id: string;
  schemaVersion: 1;
  status: "ready_for_teaching";
  sourceName: string;
  sourceSheet: string;
  sourceSize: number;
  importedAt: string;
  guideVersion: number;
  mapping: HistoricalColumnMapping;
  outcomeMapping: Record<string, OutcomeChoice>;
  mappingHash: string;
  datasetFingerprint: string;
  split: {
    algorithm: "linked-outcome-sha256-v2";
    seed: string;
    integrityHash: string;
    status: "sealed";
  };
  summary: HistoricalImportSummary;
};

export type SealedHistoricalDataset = {
  metadata: HistoricalDatasetMetadata;
  teachingRows: StoredHistoricalRow[];
  sealedRows: StoredHistoricalRow[];
};

const DB_NAME = "minder-net-zero-private-v1";
const DB_VERSION = 2;
const DATASETS_STORE = "historical-datasets";
const TEACHING_STORE = "historical-teaching";
const SEALED_STORE = "historical-sealed";
const ACTIVE_STORE = "historical-active";

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function sanitizeHistoricalImportSummary(value: unknown): HistoricalImportSummary {
  if (!value || typeof value !== "object") return { ...EMPTY_HISTORICAL_IMPORT };
  const source = value as Partial<HistoricalImportSummary>;
  const rawCounts =
    source.outcomeCounts && typeof source.outcomeCounts === "object"
      ? source.outcomeCounts
      : EMPTY_HISTORICAL_IMPORT.outcomeCounts;
  const status =
    source.status === "ready" || source.status === "missing" ? source.status : "empty";
  const datasetId = cleanString(source.datasetId) || null;

  return {
    status: status === "ready" && !datasetId ? "missing" : status,
    datasetId,
    fileName: cleanString(source.fileName),
    fileSize: safeCount(source.fileSize),
    sheetName: cleanString(source.sheetName),
    importedAt: cleanString(source.importedAt) || null,
    guideVersion: safeCount(source.guideVersion) || null,
    totalRows: safeCount(source.totalRows),
    validRows: safeCount(source.validRows),
    excludedRows: safeCount(source.excludedRows),
    duplicateRows: safeCount(source.duplicateRows),
    warningRows: safeCount(source.warningRows),
    teachingRows: safeCount(source.teachingRows),
    sealedRows: safeCount(source.sealedRows),
    outcomeCounts: {
      progressed: safeCount(rawCounts.progressed),
      not_progressed: safeCount(rawCounts.not_progressed),
      waitlist: safeCount(rawCounts.waitlist),
      ineligible: safeCount(rawCounts.ineligible),
    },
  };
}

export function normalizeHistoricalValue(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

export function historicalMatchKey(value: string) {
  return normalizeHistoricalValue(value).replace(/\s+/g, " ").toLocaleLowerCase();
}

function addIssue(row: PreparedHistoricalRow, issue: HistoricalIssueCode) {
  if (!row.issues.includes(issue)) row.issues.push(issue);
}

function addWarning(row: PreparedHistoricalRow, warning: HistoricalWarningCode) {
  if (!row.warnings.includes(warning)) row.warnings.push(warning);
}

function groupIndexes(rows: PreparedHistoricalRow[], getKey: (row: PreparedHistoricalRow) => string) {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (row.issues.length > 0) return;
    const key = getKey(row);
    if (!key) return;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return groups;
}

export function prepareHistoricalDataset(
  table: SourceTable,
  mapping: HistoricalColumnMapping,
  outcomeMapping: Record<string, OutcomeChoice>,
): PreparedHistoricalDataset {
  const labelByKey = new Map(table.columns.map((column) => [column.key, column.label]));
  const rows: PreparedHistoricalRow[] = table.rows.map((source, index) => {
    const answers = mapping.responseColumns
      .map((key) => ({
        heading: labelByKey.get(key) ?? "Application answer",
        value: normalizeHistoricalValue(source[key] ?? ""),
      }))
      .filter((answer) => Boolean(answer.value));
    const applicationText = answers
      .map((answer) => `${answer.heading}\n${answer.value}`)
      .join("\n\n");
    const sourceOutcome = normalizeHistoricalValue(source[mapping.outcome] ?? "");
    const outcomeKey = historicalMatchKey(sourceOutcome);
    const outcome = outcomeKey ? outcomeMapping[outcomeKey] ?? null : null;
    const row: PreparedHistoricalRow = {
      sourceRowNumber: table.rowNumbers[index] ?? index + 2,
      externalId: normalizeHistoricalValue(source[mapping.applicationId] ?? ""),
      teamName: normalizeHistoricalValue(source[mapping.teamName] ?? ""),
      answers,
      applicationText,
      sourceOutcome,
      outcome,
      year: normalizeHistoricalValue(source[mapping.year] ?? ""),
      track: normalizeHistoricalValue(source[mapping.track] ?? ""),
      judgeScore: normalizeHistoricalValue(source[mapping.judgeScore] ?? ""),
      reviewerNotes: normalizeHistoricalValue(source[mapping.reviewerNotes] ?? ""),
      issues: [],
      warnings: [],
    };

    if (!row.teamName && !row.externalId) addIssue(row, "missing-team");
    if (!row.applicationText) addIssue(row, "missing-text");
    if (!row.sourceOutcome) addIssue(row, "missing-outcome");
    else if (!row.outcome) addIssue(row, "unmapped-outcome");
    else if (row.outcome === "ignore") addIssue(row, "ignored-outcome");
    if (row.applicationText && row.applicationText.length < 80) addWarning(row, "short-text");
    return row;
  });

  const idGroups = groupIndexes(rows, (row) => {
    const id = historicalMatchKey(row.externalId);
    const year = historicalMatchKey(row.year);
    return id ? `${year}\u0000${id}` : "";
  });
  idGroups.forEach((indexes) => {
    if (indexes.length < 2) return;
    const signatures = new Set(
      indexes.map((index) => {
        const row = rows[index];
        return `${historicalMatchKey(row.applicationText)}\u0000${row.outcome ?? ""}`;
      }),
    );
    if (signatures.size > 1) {
      indexes.forEach((index) => addIssue(rows[index], "conflicting-id"));
    } else {
      indexes.slice(1).forEach((index) => addIssue(rows[index], "duplicate-id"));
    }
  });

  const textGroups = groupIndexes(rows, (row) => historicalMatchKey(row.applicationText));
  textGroups.forEach((indexes) => {
    if (indexes.length < 2) return;
    const outcomes = new Set(indexes.map((index) => rows[index].outcome));
    if (outcomes.size > 1) {
      indexes.forEach((index) => addIssue(rows[index], "conflicting-outcome"));
    } else {
      indexes.slice(1).forEach((index) => addIssue(rows[index], "duplicate-text"));
    }
  });

  const teamYearGroups = groupIndexes(rows, (row) => {
    const team = historicalMatchKey(row.teamName);
    const year = historicalMatchKey(row.year);
    return team ? `${team}\u0000${year}` : "";
  });
  teamYearGroups.forEach((indexes) => {
    if (indexes.length > 1) indexes.forEach((index) => addWarning(rows[index], "repeated-team-year"));
  });

  const validRows = rows.filter(
    (row): row is PreparedHistoricalRow & { outcome: CanonicalOutcome } =>
      row.issues.length === 0 && row.outcome !== null && row.outcome !== "ignore",
  );
  const outcomeCounts: Record<CanonicalOutcome, number> = {
    progressed: 0,
    not_progressed: 0,
    waitlist: 0,
    ineligible: 0,
  };
  validRows.forEach((row) => {
    outcomeCounts[row.outcome] += 1;
  });
  const issueCounts: Partial<Record<HistoricalIssueCode, number>> = {};
  const warningCounts: Partial<Record<HistoricalWarningCode, number>> = {};
  rows.forEach((row) => {
    row.issues.forEach((issue) => {
      issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    });
    row.warnings.forEach((warning) => {
      warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
    });
  });
  const duplicateCodes: HistoricalIssueCode[] = [
    "duplicate-id",
    "conflicting-id",
    "duplicate-text",
    "conflicting-outcome",
  ];
  const duplicateRows = rows.filter((row) =>
    row.issues.some((issue) => duplicateCodes.includes(issue)),
  ).length;
  const sealBlockers: string[] = [];
  if (validRows.length < 20) sealBlockers.push("At least 20 usable past decisions are needed.");
  if (outcomeCounts.progressed < 5) {
    sealBlockers.push("At least 5 progressed or shortlisted examples are needed.");
  }
  if (outcomeCounts.not_progressed < 5) {
    sealBlockers.push("At least 5 not-progressed examples are needed.");
  }
  if (outcomeCounts.waitlist > 0 && outcomeCounts.waitlist < 5) {
    sealBlockers.push("Map waitlist rows to Do not use, or provide at least 5 waitlist examples.");
  }
  if (outcomeCounts.ineligible > 0 && outcomeCounts.ineligible < 5) {
    sealBlockers.push("Map ineligible rows to Do not use, or provide at least 5 ineligible examples.");
  }

  return {
    rows,
    validRows,
    totalRows: rows.length,
    excludedRows: rows.length - validRows.length,
    duplicateRows,
    warningRows: validRows.filter((row) => row.warnings.length > 0).length,
    outcomeCounts,
    issueCounts,
    warningCounts,
    canSeal: sealBlockers.length === 0,
    sealBlockers,
  };
}

function stableJson(value: unknown) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser hashing is unavailable.");
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowIdentity(
  row: Pick<
    PreparedHistoricalRow | StoredHistoricalRow,
    "externalId" | "teamName" | "answers" | "year" | "track" | "outcome"
  >,
) {
  return {
    externalId: historicalMatchKey(row.externalId),
    teamName: historicalMatchKey(row.teamName),
    answers: row.answers.map((answer) => ({
      heading: historicalMatchKey(answer.heading),
      value: normalizeHistoricalValue(answer.value),
    })),
    year: historicalMatchKey(row.year),
    track: historicalMatchKey(row.track),
    outcome: row.outcome,
  };
}

function emptyOutcomeCounts(): Record<CanonicalOutcome, number> {
  return { progressed: 0, not_progressed: 0, waitlist: 0, ineligible: 0 };
}

type FingerprintedRow = {
  row: PreparedHistoricalRow & { outcome: CanonicalOutcome };
  rowFingerprint: string;
};

type LinkedGroup = {
  rankKey: string;
  items: FingerprintedRow[];
  outcomeCounts: Record<CanonicalOutcome, number>;
};

type SplitState = {
  groupIndexes: number[];
  outcomeCounts: Record<CanonicalOutcome, number>;
};

function splitBalanceScore(
  counts: Record<CanonicalOutcome, number>,
  selectedTotal: number,
  allCounts: Record<CanonicalOutcome, number>,
  allTotal: number,
) {
  return (Object.keys(allCounts) as CanonicalOutcome[]).reduce((score, outcome) => {
    const expected = (allCounts[outcome] * selectedTotal) / allTotal;
    return score + (counts[outcome] - expected) ** 2;
  }, 0);
}

async function chooseLinkedSealedRows(
  fingerprints: FingerprintedRow[],
  outcomeCounts: Record<CanonicalOutcome, number>,
  seed: string,
) {
  const grouped = new Map<string, FingerprintedRow[]>();
  fingerprints.forEach((item) => {
    const team = historicalMatchKey(item.row.teamName);
    const year = historicalMatchKey(item.row.year);
    const externalId = historicalMatchKey(item.row.externalId);
    const linkedKey = team
      ? `team\u0000${team}\u0000year\u0000${year}`
      : `id\u0000${externalId || item.rowFingerprint}`;
    grouped.set(linkedKey, [...(grouped.get(linkedKey) ?? []), item]);
  });
  const groups: LinkedGroup[] = await Promise.all(
    [...grouped.entries()].map(async ([linkedKey, items]) => {
      const counts = emptyOutcomeCounts();
      items.forEach((item) => {
        counts[item.row.outcome] += 1;
      });
      return {
        rankKey: await sha256(
          `${seed}\u0000${linkedKey}\u0000${items.map((item) => item.rowFingerprint).sort().join("\u0000")}`,
        ),
        items,
        outcomeCounts: counts,
      };
    }),
  );
  groups.sort((a, b) => a.rankKey.localeCompare(b.rankKey));

  const total = fingerprints.length;
  const target = Math.round(total * 0.2);
  const largestGroup = Math.max(...groups.map((group) => group.items.length));
  const limit = Math.min(total - 1, target + largestGroup);
  const states: Array<SplitState | undefined> = Array.from({ length: limit + 1 });
  states[0] = { groupIndexes: [], outcomeCounts: emptyOutcomeCounts() };

  groups.forEach((group, groupIndex) => {
    const size = group.items.length;
    for (let selectedTotal = limit - size; selectedTotal >= 0; selectedTotal -= 1) {
      const previous = states[selectedTotal];
      if (!previous) continue;
      const nextTotal = selectedTotal + size;
      const nextCounts = emptyOutcomeCounts();
      (Object.keys(nextCounts) as CanonicalOutcome[]).forEach((outcome) => {
        nextCounts[outcome] = previous.outcomeCounts[outcome] + group.outcomeCounts[outcome];
      });
      const candidate: SplitState = {
        groupIndexes: [...previous.groupIndexes, groupIndex],
        outcomeCounts: nextCounts,
      };
      const existing = states[nextTotal];
      if (
        !existing ||
        splitBalanceScore(nextCounts, nextTotal, outcomeCounts, total) <
          splitBalanceScore(existing.outcomeCounts, nextTotal, outcomeCounts, total)
      ) {
        states[nextTotal] = candidate;
      }
    }
  });

  const candidates = states
    .map((state, selectedTotal) => ({ state, selectedTotal }))
    .filter(
      (item): item is { state: SplitState; selectedTotal: number } =>
        Boolean(item.state) &&
        item.selectedTotal > 0 &&
        (Object.keys(outcomeCounts) as CanonicalOutcome[]).every(
          (outcome) =>
            outcomeCounts[outcome] === 0 ||
            (item.state!.outcomeCounts[outcome] > 0 &&
              item.state!.outcomeCounts[outcome] < outcomeCounts[outcome]),
        ),
    )
    .sort(
      (a, b) =>
        Math.abs(a.selectedTotal - target) - Math.abs(b.selectedTotal - target) ||
        splitBalanceScore(a.state.outcomeCounts, a.selectedTotal, outcomeCounts, total) -
          splitBalanceScore(b.state.outcomeCounts, b.selectedTotal, outcomeCounts, total) ||
        a.selectedTotal - b.selectedTotal,
    );
  const selected = candidates[0];
  if (!selected) throw new Error("Linked applications prevent a safe 80/20 split.");
  const sealedFingerprints = new Set<string>();
  selected.state.groupIndexes.forEach((groupIndex) => {
    groups[groupIndex].items.forEach((item) => sealedFingerprints.add(item.rowFingerprint));
  });
  return sealedFingerprints;
}

export async function createSealedHistoricalDataset(args: {
  datasetId: string;
  fileName: string;
  fileSize: number;
  table: SourceTable;
  guideVersion: number;
  mapping: HistoricalColumnMapping;
  outcomeMapping: Record<string, OutcomeChoice>;
  prepared: PreparedHistoricalDataset;
}): Promise<SealedHistoricalDataset> {
  const { prepared } = args;
  if (!prepared.canSeal) throw new Error(prepared.sealBlockers[0] ?? "The historical set is not ready.");

  const fingerprints = await Promise.all(
    prepared.validRows.map(async (row) => {
      const rowFingerprint = await sha256(stableJson(rowIdentity(row)));
      return { row, rowFingerprint } as FingerprintedRow;
    }),
  );
  const datasetFingerprint = await sha256(
    fingerprints.map((item) => item.rowFingerprint).sort().join("\n"),
  );
  const seed = await sha256(`minder-net-zero-fixed-split-v2\u0000${datasetFingerprint}`);
  const sealedFingerprints = await chooseLinkedSealedRows(
    fingerprints,
    prepared.outcomeCounts,
    seed,
  );

  const storedRows: StoredHistoricalRow[] = fingerprints.map(({ row, rowFingerprint }) => {
    const partition = sealedFingerprints.has(rowFingerprint) ? "sealed_test" : "teaching";
    return {
      datasetId: args.datasetId,
      rowId: rowFingerprint,
      sourceRowNumber: row.sourceRowNumber,
      externalId: row.externalId,
      teamName: row.teamName,
      answers: row.answers,
      applicationText: row.applicationText,
      sourceOutcome: row.sourceOutcome,
      outcome: row.outcome as CanonicalOutcome,
      year: row.year,
      track: row.track,
      judgeScore: row.judgeScore,
      reviewerNotes: row.reviewerNotes,
      partition,
    };
  });
  const teachingRows = storedRows.filter((row) => row.partition === "teaching");
  const sealedRows = storedRows.filter((row) => row.partition === "sealed_test");

  const importedAt = new Date().toISOString();
  const mappingHash = await sha256(
    stableJson({ mapping: args.mapping, outcomeMapping: args.outcomeMapping }),
  );
  const integrityHash = await sha256(
    stableJson({
      algorithm: "linked-outcome-sha256-v2",
      datasetFingerprint,
      mappingHash,
      assignments: storedRows
        .map((row) => ({ rowId: row.rowId, partition: row.partition }))
        .sort((a, b) => a.rowId.localeCompare(b.rowId)),
    }),
  );
  const summary: HistoricalImportSummary = {
    status: "ready",
    datasetId: args.datasetId,
    fileName: args.fileName,
    fileSize: args.fileSize,
    sheetName: args.table.sheetName,
    importedAt,
    guideVersion: args.guideVersion,
    totalRows: prepared.totalRows,
    validRows: prepared.validRows.length,
    excludedRows: prepared.excludedRows,
    duplicateRows: prepared.duplicateRows,
    warningRows: prepared.warningRows,
    teachingRows: teachingRows.length,
    sealedRows: sealedRows.length,
    outcomeCounts: prepared.outcomeCounts,
  };

  return {
    metadata: {
      id: args.datasetId,
      schemaVersion: 1,
      status: "ready_for_teaching",
      sourceName: args.fileName,
      sourceSheet: args.table.sheetName,
      sourceSize: args.fileSize,
      importedAt,
      guideVersion: args.guideVersion,
      mapping: args.mapping,
      outcomeMapping: args.outcomeMapping,
      mappingHash,
      datasetFingerprint,
      split: {
        algorithm: "linked-outcome-sha256-v2",
        seed,
        integrityHash,
        status: "sealed",
      },
      summary,
    },
    teachingRows,
    sealedRows,
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Private browser storage is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATASETS_STORE)) {
        database.createObjectStore(DATASETS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(ACTIVE_STORE)) {
        database.createObjectStore(ACTIVE_STORE, { keyPath: "key" });
      }
      [TEACHING_STORE, SEALED_STORE].forEach((storeName) => {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, {
            keyPath: ["datasetId", "rowId"],
          });
          store.createIndex("datasetId", "datasetId", { unique: false });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Private browser storage failed."));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("The save was cancelled."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Private browser storage failed."));
  });
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

export async function saveHistoricalDataset(
  dataset: SealedHistoricalDataset,
  replaceDatasetId?: string | null,
) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [DATASETS_STORE, TEACHING_STORE, SEALED_STORE, ACTIVE_STORE],
      "readwrite",
    );
    const datasets = transaction.objectStore(DATASETS_STORE);
    const teaching = transaction.objectStore(TEACHING_STORE);
    const sealed = transaction.objectStore(SEALED_STORE);
    if (replaceDatasetId && replaceDatasetId !== dataset.metadata.id) {
      datasets.delete(replaceDatasetId);
      deleteRowsForDataset(teaching, replaceDatasetId);
      deleteRowsForDataset(sealed, replaceDatasetId);
    }
    datasets.put(dataset.metadata);
    dataset.teachingRows.forEach((row) => teaching.put(row));
    dataset.sealedRows.forEach((row) => sealed.put(row));
    transaction.objectStore(ACTIVE_STORE).put({
      key: "active",
      datasetId: dataset.metadata.id,
      summary: dataset.metadata.summary,
    });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

type StoredDatasetRead = {
  metadata: HistoricalDatasetMetadata | undefined;
  teachingRows: StoredHistoricalRow[];
  sealedRows: StoredHistoricalRow[];
};

function readStoredDataset(database: IDBDatabase, datasetId: string) {
  return new Promise<StoredDatasetRead>((resolve, reject) => {
    const transaction = database.transaction(
      [DATASETS_STORE, TEACHING_STORE, SEALED_STORE],
      "readonly",
    );
    const metadataRequest = transaction
      .objectStore(DATASETS_STORE)
      .get(datasetId) as IDBRequest<HistoricalDatasetMetadata | undefined>;
    const teachingRequest = transaction
      .objectStore(TEACHING_STORE)
      .index("datasetId")
      .getAll(IDBKeyRange.only(datasetId)) as IDBRequest<StoredHistoricalRow[]>;
    const sealedRequest = transaction
      .objectStore(SEALED_STORE)
      .index("datasetId")
      .getAll(IDBKeyRange.only(datasetId)) as IDBRequest<StoredHistoricalRow[]>;
    transaction.oncomplete = () =>
      resolve({
        metadata: metadataRequest.result,
        teachingRows: teachingRequest.result,
        sealedRows: sealedRequest.result,
      });
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Private browser storage failed."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Private browser storage failed."));
  });
}

async function verifyStoredDataset(datasetId: string, stored: StoredDatasetRead) {
  const { metadata, teachingRows, sealedRows } = stored;
  if (
    !metadata ||
    metadata.id !== datasetId ||
    metadata.status !== "ready_for_teaching" ||
    metadata.split.status !== "sealed" ||
    metadata.split.algorithm !== "linked-outcome-sha256-v2" ||
    teachingRows.length !== metadata.summary.teachingRows ||
    sealedRows.length !== metadata.summary.sealedRows
  ) {
    return false;
  }
  if (
    teachingRows.some((row) => row.datasetId !== datasetId || row.partition !== "teaching") ||
    sealedRows.some((row) => row.datasetId !== datasetId || row.partition !== "sealed_test")
  ) {
    return false;
  }
  const allRows = [...teachingRows, ...sealedRows];
  if (
    allRows.length !== metadata.summary.validRows ||
    metadata.summary.totalRows !== metadata.summary.validRows + metadata.summary.excludedRows ||
    new Set(allRows.map((row) => row.rowId)).size !== allRows.length
  ) {
    return false;
  }
  const recomputedRowIds = await Promise.all(
    allRows.map((row) => sha256(stableJson(rowIdentity(row)))),
  );
  if (recomputedRowIds.some((rowId, index) => rowId !== allRows[index].rowId)) return false;
  const datasetFingerprint = await sha256([...recomputedRowIds].sort().join("\n"));
  const mappingHash = await sha256(
    stableJson({ mapping: metadata.mapping, outcomeMapping: metadata.outcomeMapping }),
  );
  if (datasetFingerprint !== metadata.datasetFingerprint || mappingHash !== metadata.mappingHash) {
    return false;
  }
  const integrityHash = await sha256(
    stableJson({
      algorithm: metadata.split.algorithm,
      datasetFingerprint,
      mappingHash,
      assignments: allRows
        .map((row) => ({ rowId: row.rowId, partition: row.partition }))
        .sort((a, b) => a.rowId.localeCompare(b.rowId)),
    }),
  );
  if (integrityHash !== metadata.split.integrityHash) return false;
  const outcomeCounts = emptyOutcomeCounts();
  allRows.forEach((row) => {
    outcomeCounts[row.outcome] += 1;
  });
  return (Object.keys(outcomeCounts) as CanonicalOutcome[]).every(
    (outcome) => outcomeCounts[outcome] === metadata.summary.outcomeCounts[outcome],
  );
}

export async function historicalDatasetExists(datasetId: string) {
  const database = await openDatabase();
  try {
    return await verifyStoredDataset(datasetId, await readStoredDataset(database, datasetId));
  } finally {
    database.close();
  }
}

export async function loadActiveHistoricalSummary() {
  const database = await openDatabase();
  try {
    const pointer = await new Promise<
      { key: "active"; datasetId: string; summary: HistoricalImportSummary } | undefined
    >((resolve, reject) => {
      const request = database.transaction(ACTIVE_STORE, "readonly").objectStore(ACTIVE_STORE).get("active");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Private browser storage failed."));
    });
    if (!pointer?.datasetId) return null;
    const stored = await readStoredDataset(database, pointer.datasetId);
    if (!(await verifyStoredDataset(pointer.datasetId, stored))) {
      throw new Error("The saved historical set did not pass its integrity check.");
    }
    return stored.metadata?.summary ?? null;
  } finally {
    database.close();
  }
}

export async function deleteHistoricalDataset(datasetId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [DATASETS_STORE, TEACHING_STORE, SEALED_STORE, ACTIVE_STORE],
      "readwrite",
    );
    transaction.objectStore(DATASETS_STORE).delete(datasetId);
    deleteRowsForDataset(transaction.objectStore(TEACHING_STORE), datasetId);
    deleteRowsForDataset(transaction.objectStore(SEALED_STORE), datasetId);
    const active = transaction.objectStore(ACTIVE_STORE);
    const activeRequest = active.get("active");
    activeRequest.onsuccess = () => {
      if (activeRequest.result?.datasetId === datasetId) active.delete("active");
    };
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export type HistoricalTeachingExample = Pick<
  StoredHistoricalRow,
  "rowId" | "answers" | "applicationText" | "outcome" | "year" | "track"
>;

// Phase 4 can use this accessor. It cannot return sealed rows, identities, old scores or reviewer notes.
export async function loadTeachingRows(datasetId: string) {
  const database = await openDatabase();
  try {
    const stored = await readStoredDataset(database, datasetId);
    if (!(await verifyStoredDataset(datasetId, stored))) {
      throw new Error("The saved historical set did not pass its integrity check.");
    }
    return stored.teachingRows.map((row) => ({
      rowId: row.rowId,
      answers: row.answers,
      applicationText: row.applicationText,
      outcome: row.outcome,
      year: row.year,
      track: row.track,
    }));
  } finally {
    database.close();
  }
}
