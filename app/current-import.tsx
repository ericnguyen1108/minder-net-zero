"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  EMPTY_CURRENT_IMPORT,
  createCurrentDataset,
  deleteCurrentDataset,
  isSensitiveAssessmentHeading,
  prepareCurrentDataset,
  saveCurrentDataset,
} from "./current-data";
import type {
  CurrentColumnMapping,
  CurrentImportSummary,
  CurrentIssueCode,
  CurrentWarningCode,
  PreparedCurrentDataset,
} from "./current-data";
import { MAX_HISTORICAL_ROWS } from "./historical-parser";
import {
  columnMatches,
  firstMatchingColumn,
  formatImportFileSize,
  parseWorkbookFile,
} from "./import-workbook";
import type { ParsedWorkbook } from "./import-workbook";
import { normalizeHistoricalValue } from "./historical-data";
import type { SourceColumn, SourceTable } from "./historical-data";

type ImportStage = "file" | "columns" | "check";

const EMPTY_MAPPING: CurrentColumnMapping = {
  applicationId: "",
  teamName: "",
  responseColumns: [],
  track: "",
};

const STAGES: Array<{ id: ImportStage; number: string; label: string }> = [
  { id: "file", number: "1", label: "Choose file" },
  { id: "columns", number: "2", label: "Match columns" },
  { id: "check", number: "3", label: "Check & freeze" },
];

const ISSUE_LABELS: Record<CurrentIssueCode, string> = {
  "missing-id": "Missing stable application ID",
  "missing-text": "Missing all selected application answers",
  "duplicate-id": "Duplicate application ID",
  "conflicting-id": "Same application ID has different data",
  "answer-too-long": "One answer is over 30,000 characters",
  "application-too-long": "Selected answers exceed 70,000 characters",
};

const WARNING_LABELS: Record<CurrentWarningCode, string> = {
  "identical-text": "Different IDs have identical selected answers",
  "repeated-team": "The same team name appears more than once",
};

function suggestMapping(table: SourceTable): CurrentColumnMapping {
  const applicationId = firstMatchingColumn(table.columns, [
    /application.*\bid\b/,
    /submission.*\bid\b/,
    /entry.*\bid\b/,
    /^id$/,
  ]);
  const excluded = new Set([applicationId].filter(Boolean));
  const teamName = firstMatchingColumn(
    table.columns,
    [/^team( name)?$/, /organisation|organization|company|venture|startup|project name/],
    excluded,
  );
  if (teamName) excluded.add(teamName);
  const track = firstMatchingColumn(
    table.columns,
    [/track|category|challenge area|theme/],
    excluded,
  );
  if (track) excluded.add(track);
  let responseColumns = table.columns
    .filter(
      (column) =>
        !excluded.has(column.key) &&
        !isSensitiveAssessmentHeading(column.label) &&
        columnMatches(column, [
          /answer|response|question|submission|proposal|solution|impact|innovation|description|application text|delivery|team experience/,
        ]),
    )
    .map((column) => column.key);
  if (responseColumns.length === 0) {
    const longest = table.columns
      .filter(
        (column) =>
          !excluded.has(column.key) && !isSensitiveAssessmentHeading(column.label),
      )
      .map((column) => ({
        key: column.key,
        average:
          table.rows
            .slice(0, 20)
            .reduce((total, row) => total + (row[column.key]?.length ?? 0), 0) /
          Math.max(1, Math.min(20, table.rows.length)),
      }))
      .sort((left, right) => right.average - left.average)[0];
    responseColumns = longest?.key ? [longest.key] : [];
  }
  return { applicationId, teamName, responseColumns, track };
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

function escapeCsv(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadTemplate() {
  const headings = [
    "Application ID",
    "Team name",
    "Track",
    "Application answer 1",
    "Application answer 2",
  ];
  downloadTextFile("minder-net-zero-current-applications-template.csv", `\uFEFF${headings.join(",")}\n`);
}

function downloadIssues(prepared: PreparedCurrentDataset) {
  const lines = ["Spreadsheet row,Type,Finding"];
  prepared.rows.forEach((row) => {
    row.issues.forEach((issue) =>
      lines.push([row.sourceRowNumber, "Must correct", ISSUE_LABELS[issue]].map(escapeCsv).join(",")),
    );
    row.warnings.forEach((warning) =>
      lines.push([row.sourceRowNumber, "Review warning", WARNING_LABELS[warning]].map(escapeCsv).join(",")),
    );
  });
  downloadTextFile("minder-net-zero-current-import-check.csv", `\uFEFF${lines.join("\n")}\n`);
}

function shortFingerprint(value: string | null) {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "Not available";
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

export function CurrentImportBuilder({
  summary,
  assessmentStarted,
  assessmentInvalid,
  onSummaryChange,
  onSupersededDataset,
  onContinue,
  onBack,
}: {
  summary: CurrentImportSummary;
  assessmentStarted: boolean;
  assessmentInvalid: boolean;
  onSummaryChange: (summary: CurrentImportSummary) => void;
  onSupersededDataset: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<ImportStage>("file");
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<CurrentColumnMapping>(EMPTY_MAPPING);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);
  const [storageConfirmed, setStorageConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const table = workbook?.sheets[sheetIndex] ?? null;
  const prepared = useMemo(
    () => (table ? prepareCurrentDataset(table, mapping) : null),
    [mapping, table],
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
      const parsed = await parseWorkbookFile(file);
      const first = parsed.sheets[0];
      if (first.rows.length > MAX_HISTORICAL_ROWS) {
        throw new Error(
          `This file has more than ${MAX_HISTORICAL_ROWS.toLocaleString()} rows. Split the export before continuing.`,
        );
      }
      setWorkbook(parsed);
      setSheetIndex(0);
      setMapping(suggestMapping(first));
      setMappingConfirmed(false);
      setWarningsConfirmed(false);
      setStorageConfirmed(false);
      setStage("columns");
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "We could not read this file.");
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setReading(false);
    }
  }

  function chooseSheet(index: number) {
    if (!workbook) return;
    setSheetIndex(index);
    setMapping(suggestMapping(workbook.sheets[index]));
    setMappingConfirmed(false);
    setWarningsConfirmed(false);
    setStorageConfirmed(false);
  }

  function updateMapping(next: CurrentColumnMapping) {
    setMapping(next);
    setMappingConfirmed(false);
    setWarningsConfirmed(false);
    setStorageConfirmed(false);
  }

  async function freezeApplications() {
    if (
      !workbook ||
      !table ||
      !prepared?.canSeal ||
      (prepared.warningRows > 0 && !warningsConfirmed) ||
      !storageConfirmed
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      const dataset = await createCurrentDataset({
        fileName: workbook.fileName,
        fileSize: workbook.fileSize,
        table,
        mapping,
      });
      await saveCurrentDataset(dataset, replacing ? summary.datasetId : null);
      onSummaryChange(dataset.metadata.summary);
      if (superseding) onSupersededDataset();
      setWorkbook(null);
      setReplacing(false);
      setSuperseding(false);
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

  async function removeDataset() {
    if (!summary.datasetId || assessmentStarted) return;
    if (!window.confirm("Remove these current applications from this browser?")) return;
    setRemoving(true);
    setError("");
    try {
      await deleteCurrentDataset(summary.datasetId);
      onSummaryChange({ ...EMPTY_CURRENT_IMPORT });
    } catch {
      setError("The applications could not be removed. Close other Minder tabs and try again.");
    } finally {
      setRemoving(false);
    }
  }

  function leaveImport() {
    if (
      workbook &&
      !window.confirm("This import is not saved until it is frozen. Leave and discard this draft?")
    ) {
      return;
    }
    onBack();
  }

  if (summary.status === "ready" && !replacing && !superseding) {
    return (
      <div className="history-layout">
        <section className="history-main">
          <div className="guide-heading history-heading">
            <button className="back-button" type="button" onClick={onBack}>←</button>
            <div>
              <span className="section-kicker">Step 07 · Current applications</span>
              <h2>{summary.totalRows.toLocaleString()} applications are frozen</h2>
              <p>Every source row is included. Identity stays separate from assessment text.</p>
            </div>
            <span className="guide-status guide-status-approved">Integrity checked</span>
          </div>
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
          <div className="history-ready-card current-ready-card">
            <div className="seal-icon" aria-hidden="true">✓</div>
            <div>
              <span className="section-kicker">Fixed application set</span>
              <h3>{summary.fileName}</h3>
              <p>Frozen {formatDate(summary.importedAt)} · {summary.sheetName} · fingerprint {shortFingerprint(summary.datasetFingerprint)}</p>
            </div>
          </div>
          <div className="history-stat-grid">
            <div><span>Source rows</span><strong>{summary.totalRows.toLocaleString()}</strong></div>
            <div className="stat-good"><span>Frozen for assessment</span><strong>{summary.readyRows.toLocaleString()}</strong></div>
            <div><span>Silently excluded</span><strong>0</strong></div>
            <div><span>Reviewed warnings</span><strong>{summary.warningRows.toLocaleString()}</strong></div>
          </div>
          {assessmentStarted ? (
            <div className="history-alert">
              <strong>This set cannot be replaced after an assessment run starts.</strong>
              <p>Failed and superseded runs remain audit records. This sealed set and every run that used it will not be edited or deleted.</p>
              {assessmentInvalid ? <p>If bad source data caused the failed audit, import a corrected file as a new sealed set. The old dataset and failed run remain preserved.</p> : null}
            </div>
          ) : null}
          <div className="wizard-actions">
            <button className="secondary-button" type="button" disabled={assessmentStarted || removing} onClick={() => { setReplacing(true); setStage("file"); }}>Replace file</button>
            <button className="danger-button" type="button" disabled={assessmentStarted || removing} onClick={() => void removeDataset()}>{removing ? "Removing…" : "Remove from this device"}</button>
            {assessmentInvalid ? <button className="secondary-button" type="button" onClick={() => { setSuperseding(true); setStage("file"); setError(""); }}>Import corrected set as new</button> : null}
            <button className="primary-button" type="button" onClick={onContinue}>Continue to supervised assessment <span aria-hidden="true">→</span></button>
          </div>
        </section>
        <aside className="history-rail">
          <section className="rail-card history-privacy-card">
            <div className="rail-label">Pilot limitation</div>
            <h3>Device-local test data only</h3>
            <p>This browser is not a shared, backed-up candidate database. Do not use live competition data in this phase.</p>
          </section>
          <section className="rail-card"><div className="rail-label">What goes to AI</div><p>Only opaque case IDs and the answer columns you approved. Team name, application ID and track stay local.</p></section>
        </aside>
      </div>
    );
  }

  return (
    <div className="history-layout">
      <section className="history-main">
        <div className="guide-heading history-heading">
          <button className="back-button" type="button" onClick={leaveImport}>←</button>
          <div>
            <span className="section-kicker">Step 07 · Current applications</span>
            <h2>Freeze this round’s applications</h2>
            <p>Match the file, correct every blocked row and freeze one complete set before AI begins.</p>
          </div>
          <span className="guide-status guide-status-draft">No AI in this step</span>
        </div>
        {summary.status === "missing" ? (
          <div className="history-alert history-alert-danger" role="alert"><strong>The saved file is no longer available.</strong><p>Choose the original export again. Minder will not treat missing browser data as ready.</p></div>
        ) : null}
        {workbook ? <div className="history-alert import-draft-alert"><strong>Keep this tab open.</strong><p>This draft is not saved until “Check & freeze” is complete.</p></div> : null}
        {replacing ? <div className="history-alert"><strong>The existing frozen set stays active until its replacement is safely saved.</strong></div> : null}
        {superseding ? <div className="history-alert"><strong>You are creating a separate corrected set.</strong><p>The earlier sealed data and its failed assessment run remain immutable audit records. This new set becomes active only after it is safely frozen.</p></div> : null}
        <div className="history-tabs current-tabs" aria-label="Current application import steps">
          {STAGES.map((item, index) => {
            const activeIndex = STAGES.findIndex((candidate) => candidate.id === stage);
            return (
              <button
                className={`history-tab ${stage === item.id ? "history-tab-active" : ""}`}
                type="button"
                key={item.id}
                disabled={index > activeIndex || !workbook}
                onClick={() => setStage(item.id)}
              ><span>{index < activeIndex ? "✓" : item.number}</span>{item.label}</button>
            );
          })}
        </div>
        <div className="history-card">
          {stage === "file" ? (
            <FileStage inputRef={inputRef} reading={reading} error={error} onFile={(event) => { const file = event.target.files?.[0]; if (file) void handleFile(file); }} />
          ) : stage === "columns" && workbook && table && prepared ? (
            <ColumnsStage
              workbook={workbook}
              sheetIndex={sheetIndex}
              table={table}
              mapping={mapping}
              prepared={prepared}
              confirmed={mappingConfirmed}
              onChooseSheet={chooseSheet}
              onChange={updateMapping}
              onConfirm={setMappingConfirmed}
              onBack={() => setStage("file")}
              onContinue={() => setStage("check")}
            />
          ) : stage === "check" && prepared ? (
            <CheckStage
              prepared={prepared}
              warningsConfirmed={warningsConfirmed}
              storageConfirmed={storageConfirmed}
              saving={saving}
              error={error}
              onWarningsConfirmed={setWarningsConfirmed}
              onStorageConfirmed={setStorageConfirmed}
              onBack={() => setStage("columns")}
              onFreeze={() => void freezeApplications()}
            />
          ) : null}
        </div>
      </section>
      <aside className="history-rail">
        <section className="rail-card history-privacy-card">
          <div className="rail-label">Privacy in this pilot</div>
          <h3>Checked on this device</h3>
          <p>The file is not uploaded during import. Only selected answers are kept with opaque IDs; identity stays in a separate local store.</p>
          <div className="prototype-warning"><strong>Not production storage</strong><p>Use only dummy or deliberately de-identified data. Device storage can be cleared and is not backed up.</p></div>
        </section>
        <section className="rail-card"><div className="rail-label">Important</div><p>Names, emails or other personal data written inside free-text answers are not automatically removed.</p></section>
        <section className="rail-card"><div className="rail-label">No silent exclusions</div><p>All source rows must be corrected before this set can be frozen. Minder will not quietly drop a candidate.</p></section>
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
      <div className="section-intro"><span className="section-kicker">1 · Choose file</span><h3>Choose the complete application export</h3><p>Use one row per team, a stable application ID and every answer judges are allowed to assess.</p></div>
      <label className="file-picker">
        <span className="file-picker-icon" aria-hidden="true">↑</span>
        <strong>{reading ? "Checking your file…" : "Choose spreadsheet"}</strong>
        <span>.xlsx, .csv or .tsv · up to 25 MB · up to {MAX_HISTORICAL_ROWS.toLocaleString()} rows</span>
        <input ref={inputRef} type="file" accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values" onChange={onFile} disabled={reading} />
      </label>
      <button className="text-button template-button" type="button" onClick={downloadTemplate}>Download a simple template <span aria-hidden="true">↓</span></button>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="history-note-grid">
        <div><span>1</span><p><strong>One row per application</strong>No merged cells or repeated header rows.</p></div>
        <div><span>2</span><p><strong>Stable application ID</strong>Save IDs with leading zeros as Text in Excel.</p></div>
        <div><span>3</span><p><strong>Remove sensitive extras</strong>Delete contact, banking, health or identity-document fields first.</p></div>
      </div>
    </section>
  );
}

function ColumnsStage({
  workbook,
  sheetIndex,
  table,
  mapping,
  prepared,
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
  mapping: CurrentColumnMapping;
  prepared: PreparedCurrentDataset;
  confirmed: boolean;
  onChooseSheet: (index: number) => void;
  onChange: (mapping: CurrentColumnMapping) => void;
  onConfirm: (value: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const update = (field: "applicationId" | "teamName" | "track", value: string) =>
    onChange({ ...mapping, [field]: value });
  const previewRows = table.rows.slice(0, 3);
  return (
    <section>
      <div className="section-intro"><span className="section-kicker">2 · Match columns</span><h3>Choose exactly what Minder may assess</h3><p>Suggestions are only a starting point. Check all mappings before continuing.</p></div>
      <div className="file-summary-bar">
        <div><strong>{workbook.fileName}</strong><span>{formatImportFileSize(workbook.fileSize)} · {table.rows.length.toLocaleString()} rows · {table.columns.length} columns</span></div>
        {workbook.sheets.length > 1 ? <label>Worksheet<select value={sheetIndex} onChange={(event) => onChooseSheet(Number(event.target.value))}>{workbook.sheets.map((sheet, index) => <option value={index} key={sheet.sheetName}>{sheet.sheetName}</option>)}</select></label> : <span>Worksheet: {table.sheetName}</span>}
      </div>
      <div className="column-map-grid current-column-grid">
        <ColumnSelect label="Application ID" required value={mapping.applicationId} columns={table.columns} onChange={(value) => update("applicationId", value)} help="Required; identity stays local and is never sent to AI" />
        <ColumnSelect label="Team or application name" value={mapping.teamName} columns={table.columns} onChange={(value) => update("teamName", value)} help="Optional; shown later to human reviewers only" />
        <ColumnSelect label="Track or category" value={mapping.track} columns={table.columns} onChange={(value) => update("track", value)} help="Optional; not used or sent for assessment" />
      </div>
      <fieldset className="response-picker">
        <legend>Application-answer columns <em>Required</em></legend>
        <p>Select only official answers that the Decision Guide is allowed to assess.</p>
        <div>{table.columns.map((column) => {
          const sensitive = isSensitiveAssessmentHeading(column.label);
          return <label key={column.key} className={sensitive ? "sensitive-column" : ""}>
            <input
              type="checkbox"
              checked={mapping.responseColumns.includes(column.key)}
              disabled={sensitive}
              onChange={(event) => onChange({ ...mapping, responseColumns: event.target.checked ? [...mapping.responseColumns, column.key] : mapping.responseColumns.filter((key) => key !== column.key) })}
            />
            <span>{column.label}{sensitive ? <small>Blocked: identity or contact field</small> : null}</span>
          </label>;
        })}</div>
      </fieldset>
      {prepared.mappingProblems.length ? <div className="inline-error" role="alert"><strong>Check the matches:</strong><ul>{prepared.mappingProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div> : null}
      {!prepared.mappingProblems.length ? <div className="mapping-preview">
        <div className="rail-label">Check three examples · {mapping.responseColumns.length} answer columns selected</div>
        {previewRows.map((row, index) => <details key={table.rowNumbers[index] ?? index}>
          <summary><strong>{normalizeHistoricalValue(row[mapping.teamName] ?? "") || normalizeHistoricalValue(row[mapping.applicationId] ?? "") || `Spreadsheet row ${table.rowNumbers[index]}`}</strong><span>{normalizeHistoricalValue(row[mapping.applicationId] ?? "") || "No ID"}</span><em>View mapped answers</em></summary>
          <div className="preview-answers">{mapping.responseColumns.map((key) => <div key={key}><strong>{table.columns.find((item) => item.key === key)?.label ?? "Application answer"}</strong><p>{normalizeHistoricalValue(row[key] ?? "") || "Blank in this row"}</p></div>)}</div>
        </details>)}
      </div> : null}
      <label className="approval-checkbox mapping-confirmation"><input type="checkbox" checked={confirmed} disabled={prepared.mappingProblems.length > 0} onChange={(event) => onConfirm(event.target.checked)} /><span><strong>I checked these matches</strong><small>Only the selected answer columns may be sent for assessment.</small></span></label>
      <WizardActions onBack={onBack} onContinue={onContinue} continueLabel="Check every row" disabled={prepared.mappingProblems.length > 0 || !confirmed} />
    </section>
  );
}

function CheckStage({
  prepared,
  warningsConfirmed,
  storageConfirmed,
  saving,
  error,
  onWarningsConfirmed,
  onStorageConfirmed,
  onBack,
  onFreeze,
}: {
  prepared: PreparedCurrentDataset;
  warningsConfirmed: boolean;
  storageConfirmed: boolean;
  saving: boolean;
  error: string;
  onWarningsConfirmed: (value: boolean) => void;
  onStorageConfirmed: (value: boolean) => void;
  onBack: () => void;
  onFreeze: () => void;
}) {
  const issueEntries = Object.entries(prepared.issueCounts).filter(([, count]) => Boolean(count));
  const warningEntries = Object.entries(prepared.warningCounts).filter(([, count]) => Boolean(count));
  return (
    <section>
      <div className="section-intro"><span className="section-kicker">3 · Check & freeze</span><h3>Account for every application</h3><p>The source total must equal the frozen total. Any blocked row must be corrected in the spreadsheet and re-imported.</p></div>
      <div className="history-stat-grid">
        <div><span>Source rows</span><strong>{prepared.totalRows.toLocaleString()}</strong></div>
        <div className={prepared.canSeal ? "stat-good" : ""}><span>Ready rows</span><strong>{prepared.readyRows.length.toLocaleString()}</strong></div>
        <div className={prepared.blockedRows ? "stat-warn" : ""}><span>Must correct</span><strong>{prepared.blockedRows.toLocaleString()}</strong></div>
        <div><span>Review warnings</span><strong>{prepared.warningRows.toLocaleString()}</strong></div>
      </div>
      <div className="history-check-grid">
        <div className="check-panel"><div className="rail-label">Rows that block freezing</div>{issueEntries.length ? issueEntries.map(([issue, count]) => <div className="count-row" key={issue}><span>{ISSUE_LABELS[issue as CurrentIssueCode]}</span><strong>{count}</strong></div>) : <p className="all-clear">✓ No blocked rows</p>}</div>
        <div className="check-panel"><div className="rail-label">Warnings retained for people</div>{warningEntries.length ? warningEntries.map(([warning, count]) => <div className="count-row" key={warning}><span>{WARNING_LABELS[warning as CurrentWarningCode]}</span><strong>{count}</strong></div>) : <p className="all-clear">✓ No warnings found</p>}</div>
      </div>
      {prepared.blockedRows || prepared.warningRows ? <button className="text-button issue-download" type="button" onClick={() => downloadIssues(prepared)}>Download row-by-row check list <span aria-hidden="true">↓</span></button> : null}
      {prepared.sealBlockers.length ? <div className="history-alert history-alert-danger" role="alert"><strong>This set cannot be frozen yet.</strong><ul>{prepared.sealBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : <div className="seal-preview"><div className="seal-icon" aria-hidden="true">◎</div><div><span className="section-kicker">Complete set</span><h4>{prepared.totalRows.toLocaleString()} source rows = {prepared.readyRows.length.toLocaleString()} frozen applications</h4><p>Opaque case IDs will be created. Application ID, team name and track stay in a separate identity store.</p></div></div>}
      <div className="seal-confirmations">
        {prepared.warningRows ? <label className="approval-checkbox"><input type="checkbox" checked={warningsConfirmed} onChange={(event) => onWarningsConfirmed(event.target.checked)} /><span><strong>I reviewed every warning</strong><small>Identical text and repeated teams remain visible for human review.</small></span></label> : null}
        <label className="approval-checkbox"><input type="checkbox" checked={storageConfirmed} onChange={(event) => onStorageConfirmed(event.target.checked)} /><span><strong>I am using test or deliberately de-identified data</strong><small>This device-local pilot has no shared database, role controls or backup. Free-text personal data is not automatically removed.</small></span></label>
      </div>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <WizardActions onBack={onBack} onContinue={onFreeze} continueLabel={saving ? "Freezing safely…" : "Freeze all applications"} disabled={!prepared.canSeal || (prepared.warningRows > 0 && !warningsConfirmed) || !storageConfirmed || saving} />
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
  return <label className="field-label column-select"><span>{label}{required ? <em>Required</em> : null}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{required ? "Choose a column" : "Not included"}</option>{columns.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}</select>{help ? <small>{help}</small> : null}</label>;
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
  return <div className="wizard-actions"><button className="secondary-button" type="button" onClick={onBack}>Back</button><button className="primary-button" type="button" onClick={onContinue} disabled={disabled}>{continueLabel}<span aria-hidden="true">→</span></button></div>;
}
