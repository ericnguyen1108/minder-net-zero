"use client";

import readXlsxFile from "read-excel-file/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  EMPTY_HISTORICAL_IMPORT,
  deleteHistoricalDataset,
  historicalMatchKey,
  normalizeHistoricalValue,
  prepareHistoricalDataset,
  saveHistoricalDataset,
} from "./historical-data";
import { MAX_HISTORICAL_ROWS, buildSourceTable, parseDelimitedText } from "./historical-parser";
import type {
  CanonicalOutcome,
  HistoricalColumnMapping,
  HistoricalImportSummary,
  HistoricalIssueCode,
  OutcomeChoice,
  SourceColumn,
  SourceTable,
} from "./historical-data";

type ImportStage = "file" | "columns" | "outcomes" | "check";

type ParsedWorkbook = {
  fileName: string;
  fileSize: number;
  sheets: SourceTable[];
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const EMPTY_MAPPING: HistoricalColumnMapping = {
  applicationId: "",
  teamName: "",
  responseColumns: [],
  outcome: "",
  year: "",
  track: "",
  judgeScore: "",
  reviewerNotes: "",
};

const STAGES: Array<{ id: ImportStage; number: string; label: string }> = [
  { id: "file", number: "1", label: "Choose file" },
  { id: "columns", number: "2", label: "Match columns" },
  { id: "outcomes", number: "3", label: "Match decisions" },
  { id: "check", number: "4", label: "Check & seal" },
];

const OUTCOME_OPTIONS: Array<{ value: OutcomeChoice; label: string; help: string }> = [
  {
    value: "progressed",
    label: "Progressed / shortlisted",
    help: "The team moved to the next competition stage.",
  },
  {
    value: "not_progressed",
    label: "Did not progress",
    help: "The team was assessed but did not move forward.",
  },
  {
    value: "waitlist",
    label: "Waitlist / reserve",
    help: "The team was held as a reserve.",
  },
  {
    value: "ineligible",
    label: "Ineligible / eliminated",
    help: "The team did not meet an entry or elimination rule.",
  },
  {
    value: "ignore",
    label: "Do not use",
    help: "Withdrawn, incomplete or unreliable historical records.",
  },
];

const OUTCOME_LABELS: Record<CanonicalOutcome, string> = {
  progressed: "Progressed",
  not_progressed: "Did not progress",
  waitlist: "Waitlist",
  ineligible: "Ineligible",
};

const ISSUE_LABELS: Record<HistoricalIssueCode, string> = {
  "missing-team": "Missing both application ID and name",
  "missing-text": "Missing application answers",
  "missing-outcome": "Missing past decision",
  "unmapped-outcome": "Past decision has not been explained",
  "ignored-outcome": "Marked “Do not use”",
  "duplicate-id": "Exact duplicate application ID",
  "conflicting-id": "Same ID has different text or decisions",
  "duplicate-text": "Exact duplicate application answers",
  "conflicting-outcome": "Same answers have different decisions",
};

const WARNING_LABELS = {
  "short-text": "Application text is unusually short",
  "repeated-team-year": "Linked applications from the same team and round will stay together",
} as const;

function isSensitiveColumn(column: SourceColumn) {
  return /email|phone|mobile|contact|address|passport|identity|date of birth|bank|account number/i.test(
    column.label,
  );
}

async function parseWorkbook(file: File): Promise<ParsedWorkbook> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("This file is over 25 MB. Remove unused columns or split the export first.");
  }
  const extension = file.name.split(".").pop()?.toLocaleLowerCase();
  if (extension !== "csv" && extension !== "tsv" && extension !== "xlsx") {
    throw new Error("Use an Excel (.xlsx), CSV or TSV file.");
  }

  try {
    if (extension === "csv" || extension === "tsv") {
      const matrix = parseDelimitedText(await file.text());
      return {
        fileName: file.name,
        fileSize: file.size,
        sheets: [buildSourceTable("Data", matrix)],
      };
    }
    const workbook = await readXlsxFile(file);
    const sheets = workbook
      .filter((sheet) => sheet.data.length > 1)
      .map((sheet) => buildSourceTable(sheet.sheet, sheet.data));
    if (sheets.length === 0) throw new Error("We could not find a worksheet with application rows.");
    return { fileName: file.name, fileSize: file.size, sheets };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("We ")) throw error;
    throw new Error(
      "We could not read this file. It may be damaged or password protected. Export an unlocked copy and try again.",
    );
  }
}

function matches(column: SourceColumn, patterns: RegExp[]) {
  const label = column.label.toLocaleLowerCase();
  return patterns.some((pattern) => pattern.test(label));
}

function firstMatch(columns: SourceColumn[], patterns: RegExp[], excluded = new Set<string>()) {
  return columns.find((column) => !excluded.has(column.key) && matches(column, patterns))?.key ?? "";
}

function suggestMapping(table: SourceTable): HistoricalColumnMapping {
  const teamName = firstMatch(table.columns, [
    /^team( name)?$/,
    /organisation|organization|company|applicant|venture|startup|project name/,
  ]);
  const outcome = firstMatch(table.columns, [
    /final (decision|outcome|status)/,
    /decision|outcome|result|shortlist|selected|progressed|status/,
  ]);
  const excluded = new Set([teamName, outcome].filter(Boolean));
  const applicationId = firstMatch(
    table.columns,
    [/application.*\bid\b|submission.*\bid\b|entry.*\bid\b|^id$/],
    excluded,
  );
  if (applicationId) excluded.add(applicationId);
  const year = firstMatch(table.columns, [/^year$|competition year|round year/], excluded);
  if (year) excluded.add(year);
  const track = firstMatch(table.columns, [/track|category|challenge area|theme/], excluded);
  if (track) excluded.add(track);
  const judgeScore = firstMatch(table.columns, [/judge.*score|review.*score|final score/], excluded);
  if (judgeScore) excluded.add(judgeScore);
  const reviewerNotes = firstMatch(
    table.columns,
    [/reviewer.*(note|comment)|judge.*(note|comment)|assessment notes/],
    excluded,
  );
  if (reviewerNotes) excluded.add(reviewerNotes);
  let responseColumns = table.columns
    .filter(
      (column) =>
        !excluded.has(column.key) &&
        !isSensitiveColumn(column) &&
        matches(column, [
          /answer|response|question|submission|proposal|solution|impact|innovation|description|application text/,
        ]),
    )
    .map((column) => column.key);
  if (responseColumns.length === 0) {
    const longest = table.columns
      .filter((column) => !excluded.has(column.key) && !isSensitiveColumn(column))
      .map((column) => ({
        key: column.key,
        average:
          table.rows.slice(0, 20).reduce((sum, row) => sum + (row[column.key]?.length ?? 0), 0) /
          Math.max(1, Math.min(20, table.rows.length)),
      }))
      .sort((a, b) => b.average - a.average)[0];
    responseColumns = longest?.key ? [longest.key] : [];
  }
  return {
    applicationId,
    teamName,
    responseColumns,
    outcome,
    year,
    track,
    judgeScore,
    reviewerNotes,
  };
}

function mappingProblems(mapping: HistoricalColumnMapping) {
  const problems: string[] = [];
  if (!mapping.applicationId && !mapping.teamName) {
    problems.push("Choose an application ID or a team/application-name column.");
  }
  if (!mapping.outcome) problems.push("Choose the column containing each past decision.");
  if (mapping.responseColumns.length === 0) {
    problems.push("Choose at least one application-answer column.");
  }
  const allSelected = [
    mapping.applicationId,
    mapping.teamName,
    mapping.outcome,
    mapping.year,
    mapping.track,
    mapping.judgeScore,
    mapping.reviewerNotes,
    ...mapping.responseColumns,
  ].filter(Boolean);
  if (new Set(allSelected).size !== allSelected.length) {
    problems.push("Each source column can be used only once.");
  }
  return problems;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadTextFile(fileName: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadHistoricalTemplate() {
  const headings = [
    "Application ID",
    "Team or application name",
    "Application answer 1",
    "Application answer 2",
    "Final decision",
    "Year",
    "Track",
    "Past judge score",
    "Reviewer notes",
  ];
  downloadTextFile("minder-net-zero-past-decisions-template.csv", `\uFEFF${headings.join(",")}\n`);
}

function escapeCsv(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadIssueList(prepared: ReturnType<typeof prepareHistoricalDataset>) {
  const lines = ["Spreadsheet row,Type,Finding"];
  prepared.rows
    .filter((row) => row.issues.length > 0 || row.warnings.length > 0)
    .forEach((row) => {
      row.issues.forEach((issue) =>
        lines.push([row.sourceRowNumber, "Excluded", ISSUE_LABELS[issue]].map(escapeCsv).join(",")),
      );
      row.warnings.forEach((warning) =>
        lines.push(
          [row.sourceRowNumber, "Review warning", WARNING_LABELS[warning]]
            .map(escapeCsv)
            .join(","),
        ),
      );
    });
  downloadTextFile("minder-net-zero-import-issues.csv", `\uFEFF${lines.join("\n")}\n`);
}

function formatDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function HistoricalImportBuilder({
  summary,
  guideVersion,
  onSummaryChange,
  onBack,
}: {
  summary: HistoricalImportSummary;
  guideVersion: number;
  onSummaryChange: (summary: HistoricalImportSummary) => void;
  onBack: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<ImportStage>("file");
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<HistoricalColumnMapping>(EMPTY_MAPPING);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [outcomeMapping, setOutcomeMapping] = useState<Record<string, OutcomeChoice>>({});
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmation, setConfirmation] = useState({ outcomes: false, warnings: false, sealed: false });
  const [error, setError] = useState("");
  const table = workbook?.sheets[sheetIndex] ?? null;
  const problems = useMemo(() => mappingProblems(mapping), [mapping]);

  const distinctOutcomes = useMemo(() => {
    if (!table || !mapping.outcome) return [];
    const grouped = new Map<string, { key: string; label: string; count: number }>();
    table.rows.forEach((row) => {
      const label = normalizeHistoricalValue(row[mapping.outcome] ?? "");
      const key = historicalMatchKey(label);
      if (!key) return;
      const current = grouped.get(key);
      grouped.set(key, { key, label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
    });
    return [...grouped.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [mapping.outcome, table]);
  const blankOutcomes = useMemo(
    () =>
      table && mapping.outcome
        ? table.rows.filter((row) => !normalizeHistoricalValue(row[mapping.outcome] ?? "")).length
        : 0,
    [mapping.outcome, table],
  );
  const outcomesComplete =
    distinctOutcomes.length > 0 && distinctOutcomes.every((item) => Boolean(outcomeMapping[item.key]));
  const prepared = useMemo(
    () =>
      table && problems.length === 0
        ? prepareHistoricalDataset(table, mapping, outcomeMapping)
        : null,
    [mapping, outcomeMapping, problems.length, table],
  );

  useEffect(() => {
    if (!workbook) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [workbook]);

  async function handleFile(file: File) {
    setReading(true);
    setError("");
    try {
      const parsed = await parseWorkbook(file);
      const suggested = suggestMapping(parsed.sheets[0]);
      setWorkbook(parsed);
      setSheetIndex(0);
      setMapping(suggested);
      setMappingConfirmed(false);
      setOutcomeMapping({});
      setConfirmation({ outcomes: false, warnings: false, sealed: false });
      setStage("columns");
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "We could not read this file.");
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setReading(false);
    }
  }

  function updateMapping(next: HistoricalColumnMapping) {
    setMapping(next);
    setMappingConfirmed(false);
    setOutcomeMapping({});
    setConfirmation({ outcomes: false, warnings: false, sealed: false });
  }

  function chooseSheet(index: number) {
    if (!workbook) return;
    const nextTable = workbook.sheets[index];
    setSheetIndex(index);
    updateMapping(suggestMapping(nextTable));
  }

  async function sealDataset() {
    if (
      !workbook ||
      !table ||
      !prepared?.canSeal ||
      !confirmation.outcomes ||
      (prepared.warningRows > 0 && !confirmation.warnings) ||
      !confirmation.sealed
    ) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveHistoricalDataset({
        table,
        mapping,
        outcomeMapping,
        fileName: workbook.fileName,
        fileSize: workbook.fileSize,
        guideVersion,
        replaceDatasetId:
          replacing || summary.status === "missing" ? summary.datasetId : null,
      });
      onSummaryChange(saved.summary);
      setReplacing(false);
      setWorkbook(null);
      setStage("file");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `This import is not saved. ${saveError.message}`
          : "This import is not saved. Keep this tab open and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function leaveImport() {
    if (
      workbook &&
      !window.confirm("This import is not saved until it is sealed. Leave and discard this import draft?")
    ) {
      return;
    }
    onBack();
  }

  async function removeDataset() {
    if (!summary.datasetId) return;
    if (!window.confirm("Remove all imported historical application data from this workspace?")) return;
    setRemoving(true);
    setError("");
    try {
      await deleteHistoricalDataset(summary.datasetId);
      onSummaryChange({ ...EMPTY_HISTORICAL_IMPORT });
      setReplacing(false);
    } catch {
      setError("The historical data could not be removed. Check your connection and try again.");
    } finally {
      setRemoving(false);
    }
  }

  if (summary.status === "ready" && !replacing) {
    return (
      <HistoricalReady
        summary={summary}
        removing={removing}
        error={error}
        onBack={onBack}
        onReplace={() => {
          setReplacing(true);
          setStage("file");
          setError("");
        }}
        onRemove={removeDataset}
      />
    );
  }

  return (
    <div className="history-layout">
      <section className="history-main">
        <div className="guide-heading history-heading">
          <button className="back-button" type="button" onClick={leaveImport} aria-label="Back to setup overview">←</button>
          <div>
            <span className="section-kicker">Step 03 · Past decisions</span>
            <h2>Prepare historical examples</h2>
            <p>Match your spreadsheet, check problems and keep about 20% unseen for an honest practice check.</p>
          </div>
          <span className="guide-status guide-status-draft">No AI in this step</span>
        </div>

        {summary.status === "missing" ? (
          <div className="history-alert history-alert-danger" role="alert">
            <strong>The saved file is no longer available in this browser.</strong>
            <p>Choose the original file again. Minder will not pretend that missing data is ready.</p>
          </div>
        ) : null}
        {replacing ? (
          <div className="history-alert">
            <strong>Your current sealed set stays active until the replacement is safely saved.</strong>
          </div>
        ) : null}
        {workbook ? (
          <div className="history-alert import-draft-alert" role="status">
            <strong>Keep this tab open.</strong>
            <p>This import draft is not saved until you complete “Check & seal.”</p>
          </div>
        ) : null}

        <div className="history-tabs" aria-label="Historical import steps">
          {STAGES.map((item, index) => {
            const activeIndex = STAGES.findIndex((candidate) => candidate.id === stage);
            const complete = index < activeIndex;
            return (
              <button
                className={`history-tab ${stage === item.id ? "history-tab-active" : ""}`}
                type="button"
                key={item.id}
                disabled={index > activeIndex || !workbook}
                onClick={() => setStage(item.id)}
              >
                <span>{complete ? "✓" : item.number}</span>{item.label}
              </button>
            );
          })}
        </div>

        <div className="history-card">
          {stage === "file" ? (
            <FileStage
              inputRef={inputRef}
              reading={reading}
              error={error}
              onFile={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          ) : stage === "columns" && workbook && table ? (
            <ColumnsStage
              workbook={workbook}
              sheetIndex={sheetIndex}
              table={table}
              mapping={mapping}
              problems={problems}
              confirmed={mappingConfirmed}
              onChooseSheet={chooseSheet}
              onChange={updateMapping}
              onConfirm={setMappingConfirmed}
              onBack={() => setStage("file")}
              onContinue={() => setStage("outcomes")}
            />
          ) : stage === "outcomes" && table ? (
            <OutcomesStage
              items={distinctOutcomes}
              blankOutcomes={blankOutcomes}
              mapping={outcomeMapping}
              complete={outcomesComplete}
              onChange={(key, value) => {
                setOutcomeMapping((current) => ({ ...current, [key]: value }));
                setConfirmation({ outcomes: false, warnings: false, sealed: false });
              }}
              onBack={() => setStage("columns")}
              onContinue={() => setStage("check")}
            />
          ) : stage === "check" && prepared ? (
            <CheckStage
              prepared={prepared}
              confirmation={confirmation}
              saving={saving}
              error={error}
              onConfirmation={setConfirmation}
              onBack={() => setStage("outcomes")}
              onSeal={() => void sealDataset()}
            />
          ) : null}
        </div>
      </section>

      <aside className="history-rail">
        <section className="rail-card history-privacy-card">
          <div className="rail-label">Privacy in this preview</div>
          <h3>Checked on this device</h3>
          <p>Your file is not uploaded or sent to AI. Only the columns you approve are saved in this browser.</p>
          <div className="prototype-warning">
            <strong>Not production storage</strong>
            <p>Do not use real applicant data until secure accounts and managed storage are added.</p>
          </div>
        </section>
        <section className="rail-card">
          <div className="rail-label">Why seal 20%?</div>
          <p className="rail-explainer">Like setting aside exam questions before teaching, the sealed examples show whether Minder can apply the guide to cases it has not seen.</p>
        </section>
        <section className="rail-card">
          <div className="rail-label">Still locked</div>
          <div className="promise compact-promise">
            <span className="promise-check" aria-hidden="true">✓</span>
            <div><strong>No scoring</strong><p>Uploading history does not assess any application or create a rule.</p></div>
          </div>
        </section>
      </aside>
    </div>
  );
}

function FileStage({
  inputRef,
  reading,
  error,
  onFile,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  reading: boolean;
  error: string;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <section>
      <div className="section-intro">
        <span className="section-kicker">1 · Choose file</span>
        <h3>Upload past applications and their final decisions</h3>
        <p>This version needs the applications and final outcomes in the same Excel, CSV or TSV file. The first row must contain column names and each later row must be one application.</p>
      </div>
      <label className="file-picker">
        <span className="file-picker-icon" aria-hidden="true">↑</span>
        <strong>{reading ? "Checking your file…" : "Choose spreadsheet"}</strong>
        <span>.xlsx, .csv or .tsv · up to 25 MB · up to {MAX_HISTORICAL_ROWS.toLocaleString()} rows</span>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values"
          onChange={onFile}
          disabled={reading}
        />
      </label>
      <button className="text-button template-button" type="button" onClick={downloadHistoricalTemplate}>
        Download a simple spreadsheet template <span aria-hidden="true">↓</span>
      </button>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="history-note-grid">
        <div><span>1</span><p><strong>One application per row</strong>Keep all application-answer columns in the file.</p></div>
        <div><span>2</span><p><strong>Include the final outcome</strong>For example “Shortlisted” or “Not selected.”</p></div>
        <div><span>3</span><p><strong>Remove sensitive extras</strong>Do not include identity documents, banking, health or unrelated data.</p></div>
      </div>
    </section>
  );
}

function ColumnsStage({
  workbook,
  sheetIndex,
  table,
  mapping,
  problems,
  confirmed,
  onChooseSheet,
  onChange,
  onConfirm,
  onBack,
  onContinue,
}: {
  workbook: ParsedWorkbook;
  sheetIndex: number;
  table: SourceTable;
  mapping: HistoricalColumnMapping;
  problems: string[];
  confirmed: boolean;
  onChooseSheet: (index: number) => void;
  onChange: (mapping: HistoricalColumnMapping) => void;
  onConfirm: (confirmed: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const previewRows = table.rows.slice(0, 3);
  const update = (field: keyof HistoricalColumnMapping, value: string) =>
    onChange({ ...mapping, [field]: value });
  return (
    <section>
      <div className="section-intro">
        <span className="section-kicker">2 · Match columns</span>
        <h3>Tell Minder what each column means</h3>
        <p>We suggested likely matches. Check them carefully—nothing is accepted automatically.</p>
      </div>
      <div className="file-summary-bar">
        <div><strong>{workbook.fileName}</strong><span>{formatFileSize(workbook.fileSize)} · {table.rows.length.toLocaleString()} rows · {table.columns.length} columns</span></div>
        {workbook.sheets.length > 1 ? (
          <label>Worksheet
            <select value={sheetIndex} onChange={(event) => onChooseSheet(Number(event.target.value))}>
              {workbook.sheets.map((sheet, index) => <option value={index} key={sheet.sheetName}>{sheet.sheetName}</option>)}
            </select>
          </label>
        ) : <span>Worksheet: {table.sheetName}</span>}
      </div>
      <div className="column-map-grid">
        <ColumnSelect label="Application ID" required={!mapping.teamName} value={mapping.applicationId} columns={table.columns} onChange={(value) => update("applicationId", value)} help="Preferred. In Excel, save IDs with leading zeros as Text." />
        <ColumnSelect label="Team or application name" required={!mapping.applicationId} value={mapping.teamName} columns={table.columns} onChange={(value) => update("teamName", value)} help="Optional when a stable application ID is available" />
        <ColumnSelect label="Past final decision" required value={mapping.outcome} columns={table.columns} onChange={(value) => update("outcome", value)} />
        <ColumnSelect label="Year or round" value={mapping.year} columns={table.columns} onChange={(value) => update("year", value)} />
        <ColumnSelect label="Track or category" value={mapping.track} columns={table.columns} onChange={(value) => update("track", value)} />
        <ColumnSelect label="Past judge score" value={mapping.judgeScore} columns={table.columns} onChange={(value) => update("judgeScore", value)} />
        <ColumnSelect label="Reviewer notes" value={mapping.reviewerNotes} columns={table.columns} onChange={(value) => update("reviewerNotes", value)} help="Stored for audit; not teaching text" />
      </div>
      <fieldset className="response-picker">
        <legend>Application-answer columns <em>Required</em></legend>
        <p>Select every question or answer the judges reviewed. The column heading stays attached to its answer.</p>
        <div>
          {table.columns.map((column) => (
            <label key={column.key} className={isSensitiveColumn(column) ? "sensitive-column" : ""}>
              <input
                type="checkbox"
                checked={mapping.responseColumns.includes(column.key)}
                disabled={isSensitiveColumn(column)}
                onChange={(event) =>
                  onChange({
                    ...mapping,
                    responseColumns: event.target.checked
                      ? [...mapping.responseColumns, column.key]
                      : mapping.responseColumns.filter((key) => key !== column.key),
                  })
                }
              />
              <span>{column.label}{isSensitiveColumn(column) ? <small>Not available: contact or sensitive field</small> : null}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {problems.length > 0 ? (
        <div className="inline-error" role="alert"><strong>Check the matches:</strong><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
      ) : null}
      {problems.length === 0 ? (
        <div className="mapping-preview">
          <div className="rail-label">Check three examples · {mapping.responseColumns.length} answer columns selected</div>
          {previewRows.map((row, index) => (
            <details key={index}>
              <summary>
                <strong>{normalizeHistoricalValue(row[mapping.teamName] ?? "") || normalizeHistoricalValue(row[mapping.applicationId] ?? "") || `Spreadsheet row ${table.rowNumbers[index]}`}</strong>
                <span>{normalizeHistoricalValue(row[mapping.outcome] ?? "") || "No outcome"}</span>
                <em>View mapped answers</em>
              </summary>
              <div className="preview-answers">
                {mapping.responseColumns.map((key) => {
                  const column = table.columns.find((item) => item.key === key);
                  return (
                    <div key={key}><strong>{column?.label ?? "Application answer"}</strong><p>{normalizeHistoricalValue(row[key] ?? "") || "Blank in this row"}</p></div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      ) : null}
      <label className="approval-checkbox mapping-confirmation">
        <input type="checkbox" checked={confirmed} disabled={problems.length > 0} onChange={(event) => onConfirm(event.target.checked)} />
        <span><strong>I checked these matches</strong><small>The selected answer columns contain the complete text reviewed by judges.</small></span>
      </label>
      <WizardActions onBack={onBack} onContinue={onContinue} continueLabel="Match past decisions" disabled={problems.length > 0 || !confirmed} />
    </section>
  );
}

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
  required = false,
  help,
}: {
  label: string;
  value: string;
  columns: SourceColumn[];
  onChange: (value: string) => void;
  required?: boolean;
  help?: string;
}) {
  return (
    <label className="field-label column-select">
      <span>{label}{required ? <em>Required</em> : null}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{required ? "Choose a column" : "Not included"}</option>
        {columns.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}
      </select>
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function OutcomesStage({
  items,
  blankOutcomes,
  mapping,
  complete,
  onChange,
  onBack,
  onContinue,
}: {
  items: Array<{ key: string; label: string; count: number }>;
  blankOutcomes: number;
  mapping: Record<string, OutcomeChoice>;
  complete: boolean;
  onChange: (key: string, value: OutcomeChoice) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <section>
      <div className="section-intro">
        <span className="section-kicker">3 · Match decisions</span>
        <h3>Explain every historical outcome</h3>
        <p>Minder will not guess what a label means. Choose the matching decision for every value found in your file.</p>
      </div>
      <div className="outcome-map-list">
        {items.map((item) => (
          <div className="outcome-map-row" key={item.key}>
            <div><strong>{item.label}</strong><span>{item.count.toLocaleString()} rows in your file</span></div>
            <label>
              <span className="sr-only">Meaning of {item.label}</span>
              <select value={mapping[item.key] ?? ""} onChange={(event) => onChange(item.key, event.target.value as OutcomeChoice)}>
                <option value="">Choose what this means</option>
                {OUTCOME_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            {mapping[item.key] ? <p>{OUTCOME_OPTIONS.find((option) => option.value === mapping[item.key])?.help}</p> : null}
          </div>
        ))}
      </div>
      {blankOutcomes > 0 ? (
        <div className="history-alert"><strong>{blankOutcomes.toLocaleString()} rows have no past decision.</strong><p>They will be shown as excluded in the next check.</p></div>
      ) : null}
      {!complete ? <div className="inline-error" role="status">Choose a meaning for every outcome before continuing.</div> : null}
      <WizardActions onBack={onBack} onContinue={onContinue} continueLabel="Check the data" disabled={!complete} />
    </section>
  );
}

function CheckStage({
  prepared,
  confirmation,
  saving,
  error,
  onConfirmation,
  onBack,
  onSeal,
}: {
  prepared: ReturnType<typeof prepareHistoricalDataset>;
  confirmation: { outcomes: boolean; warnings: boolean; sealed: boolean };
  saving: boolean;
  error: string;
  onConfirmation: (confirmation: { outcomes: boolean; warnings: boolean; sealed: boolean }) => void;
  onBack: () => void;
  onSeal: () => void;
}) {
  const sealedCount = Math.round(prepared.validRows.length * 0.2);
  const teachingCount = prepared.validRows.length - sealedCount;
  const issueEntries = Object.entries(prepared.issueCounts).filter(([, count]) => Boolean(count));
  const warningEntries = Object.entries(prepared.warningCounts).filter(([, count]) => Boolean(count));
  const progressedTestEstimate = Math.round(prepared.outcomeCounts.progressed * 0.2);
  const notProgressedTestEstimate = Math.round(prepared.outcomeCounts.not_progressed * 0.2);
  const limitedTest = progressedTestEstimate < 10 || notProgressedTestEstimate < 10;
  return (
    <section>
      <div className="section-intro">
        <span className="section-kicker">4 · Check & seal</span>
        <h3>Review what will be used</h3>
        <p>Rows with missing, ignored, duplicate or conflicting information are excluded. Nothing is silently repaired.</p>
      </div>
      <div className="history-stat-grid">
        <div><span>Total rows</span><strong>{prepared.totalRows.toLocaleString()}</strong></div>
        <div className="stat-good"><span>Usable examples</span><strong>{prepared.validRows.length.toLocaleString()}</strong></div>
        <div className={prepared.excludedRows ? "stat-warn" : ""}><span>Excluded rows</span><strong>{prepared.excludedRows.toLocaleString()}</strong></div>
        <div><span>Review warnings</span><strong>{prepared.warningRows.toLocaleString()}</strong></div>
      </div>
      <div className="history-check-grid check-grid-three">
        <div className="check-panel">
          <div className="rail-label">Outcome balance</div>
          {(Object.keys(OUTCOME_LABELS) as CanonicalOutcome[]).map((outcome) => (
            <div className="count-row" key={outcome}><span>{OUTCOME_LABELS[outcome]}</span><strong>{prepared.outcomeCounts[outcome].toLocaleString()}</strong></div>
          ))}
        </div>
        <div className="check-panel">
          <div className="rail-label">Rows not used</div>
          {issueEntries.length > 0 ? issueEntries.map(([issue, count]) => (
            <div className="count-row" key={issue}><span>{ISSUE_LABELS[issue as HistoricalIssueCode]}</span><strong>{count}</strong></div>
          )) : <p className="all-clear">✓ No exclusions found</p>}
        </div>
        <div className="check-panel">
          <div className="rail-label">Warnings to review</div>
          {warningEntries.length > 0 ? warningEntries.map(([warning, count]) => (
            <div className="count-row" key={warning}><span>{WARNING_LABELS[warning as keyof typeof WARNING_LABELS]}</span><strong>{count}</strong></div>
          )) : <p className="all-clear">✓ No warnings found</p>}
        </div>
      </div>
      {prepared.excludedRows > 0 || prepared.warningRows > 0 ? (
        <button className="text-button issue-download" type="button" onClick={() => downloadIssueList(prepared)}>
          Download the issue and warning list <span aria-hidden="true">↓</span>
        </button>
      ) : null}
      {prepared.sealBlockers.length > 0 ? (
        <div className="history-alert history-alert-danger" role="alert"><strong>This set is too small to seal safely.</strong><ul>{prepared.sealBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>
      ) : (
        <div className="seal-preview">
          <div className="seal-icon" aria-hidden="true">◎</div>
          <div><span className="section-kicker">Fixed blind split</span><h4>About {teachingCount.toLocaleString()} for teaching · {sealedCount.toLocaleString()} sealed for testing</h4><p>Linked applications from the same team and year stay together, so the final count can move slightly. The split is fixed and cannot be reshuffled by re-importing the same data.</p></div>
        </div>
      )}
      {prepared.canSeal && limitedTest ? (
        <div className="history-alert" role="status"><strong>Limited practice-test strength</strong><p>The sealed set may contain only about {progressedTestEstimate} progressed and {notProgressedTestEstimate} not-progressed cases. This can check the workflow, but it is too small for a confident accuracy claim. Add more history if possible.</p></div>
      ) : null}
      <div className="seal-confirmations">
        <label className="approval-checkbox">
          <input type="checkbox" checked={confirmation.outcomes} onChange={(event) => onConfirmation({ ...confirmation, outcomes: event.target.checked })} />
          <span><strong>I reviewed the mappings and exclusions</strong><small>These outcomes represent the competition’s final historical decisions.</small></span>
        </label>
        {prepared.warningRows > 0 ? (
          <label className="approval-checkbox">
            <input type="checkbox" checked={confirmation.warnings} onChange={(event) => onConfirmation({ ...confirmation, warnings: event.target.checked })} />
            <span><strong>I reviewed the warning rows</strong><small>Short or linked applications are understood and can remain in the usable set.</small></span>
          </label>
        ) : null}
        <label className="approval-checkbox">
          <input type="checkbox" checked={confirmation.sealed} onChange={(event) => onConfirmation({ ...confirmation, sealed: event.target.checked })} />
          <span><strong>I understand that about 20% will stay unseen</strong><small>The sealed set cannot be hand-picked or reshuffled for a better test result.</small></span>
        </label>
      </div>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <WizardActions
        onBack={onBack}
        onContinue={onSeal}
        continueLabel={saving ? "Sealing safely…" : "Seal test set and complete Step 3"}
        disabled={!prepared.canSeal || !confirmation.outcomes || (prepared.warningRows > 0 && !confirmation.warnings) || !confirmation.sealed || saving}
      />
    </section>
  );
}

function WizardActions({
  onBack,
  onContinue,
  continueLabel,
  disabled,
}: {
  onBack: () => void;
  onContinue: () => void;
  continueLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="wizard-actions">
      <button className="secondary-button" type="button" onClick={onBack}>Back</button>
      <button className="primary-button" type="button" onClick={onContinue} disabled={disabled}>{continueLabel}<span aria-hidden="true">→</span></button>
    </div>
  );
}

function HistoricalReady({
  summary,
  removing,
  error,
  onBack,
  onReplace,
  onRemove,
}: {
  summary: HistoricalImportSummary;
  removing: boolean;
  error: string;
  onBack: () => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="history-layout">
      <section className="history-main">
        <div className="guide-heading history-heading">
          <button className="back-button" type="button" onClick={onBack} aria-label="Back to setup overview">←</button>
          <div><span className="section-kicker">Step 03 · Complete</span><h2>Historical set sealed</h2><p>No application has been assessed, and no past decision has become a rule.</p></div>
          <span className="guide-status guide-status-approved">Ready for Step 4</span>
        </div>
        <div className="history-ready-card">
          <div className="approval-seal" aria-hidden="true">✓</div>
          <div><span className="section-kicker">Saved on this device</span><h3>{summary.fileName}</h3><p>{summary.sheetName ? `${summary.sheetName} · ` : ""}{formatFileSize(summary.fileSize)} · imported {formatDate(summary.importedAt)}</p></div>
        </div>
        <div className="history-stat-grid ready-stats">
          <div><span>Source rows</span><strong>{summary.totalRows.toLocaleString()}</strong></div>
          <div className="stat-good"><span>Teaching examples</span><strong>{summary.teachingRows.toLocaleString()}</strong></div>
          <div><span>Sealed test examples</span><strong>{summary.sealedRows.toLocaleString()}</strong></div>
          <div className={summary.excludedRows ? "stat-warn" : ""}><span>Excluded rows</span><strong>{summary.excludedRows.toLocaleString()}</strong></div>
        </div>
        <div className="history-check-grid">
          <div className="check-panel">
            <div className="rail-label">Usable outcome mix</div>
            {(Object.keys(OUTCOME_LABELS) as CanonicalOutcome[]).map((outcome) => (
              <div className="count-row" key={outcome}><span>{OUTCOME_LABELS[outcome]}</span><strong>{summary.outcomeCounts[outcome].toLocaleString()}</strong></div>
            ))}
          </div>
          <div className="check-panel sealed-explanation">
            <div className="rail-label">Blind-test protection</div>
            <strong>The test cases are deliberately not identified here.</strong>
            <p>Phase 4 can read only the teaching set. The sealed set stays separate until the dedicated practice test.</p>
          </div>
        </div>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="wizard-actions">
          <button className="secondary-button" type="button" onClick={onReplace}>Replace spreadsheet</button>
          <button className="danger-button" type="button" onClick={onRemove} disabled={removing}>{removing ? "Removing…" : "Remove historical data"}</button>
        </div>
      </section>
      <aside className="history-rail">
        <section className="rail-card accent-card"><div className="rail-label">Phase 3 complete</div><h2>{summary.teachingRows.toLocaleString()} examples ready</h2><p>{summary.sealedRows.toLocaleString()} additional examples are reserved for the blind practice check. Teaching remains off until Step 4.</p><button className="primary-button full-width" type="button" disabled>Step 4 comes next</button></section>
        <section className="rail-card history-privacy-card"><div className="rail-label">Current storage</div><h3>This browser only</h3><p>This preview is not a secure shared workspace. Delete the data before using a shared Mac.</p></section>
      </aside>
    </div>
  );
}
