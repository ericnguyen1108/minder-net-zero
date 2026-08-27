"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useState } from "react";

import type { CurrentColumnMapping } from "../current-data.ts";
import {
  isSensitiveAssessmentHeading,
  prepareCurrentDataset,
} from "../current-data.ts";
import type { SourceTable } from "../historical-data.ts";
import {
  MAX_CURRENT_IMPORT_ROWS,
  MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
  currentImportSourceHash,
  normalizeCurrentImportRow,
  prepareCurrentImportChunk,
  type CanonicalCurrentImportRow,
  type CurrentImportRowInput,
} from "../../lib/current-import-contract.ts";
import {
  columnMatches,
  firstMatchingColumn,
  formatImportFileSize,
  parseWorkbookFile,
  type ParsedWorkbook,
} from "../import-workbook.ts";
import { platformFetch } from "../platform-client.ts";

type Competition = { id: string; name: string; permissions: string[] };
type ImportSession = {
  id: string;
  competitionId: string;
  status: "staging" | "completed" | "cancelled" | "expired";
  revision: number;
  expectedRowCount: number;
  expectedChunkCount: number;
  receivedRowCount: number;
  receivedChunkCount: number;
  completedDatasetId: string | null;
  expiresAt: string;
};

const EMPTY_MAPPING: CurrentColumnMapping = {
  applicationId: "",
  teamName: "",
  track: "",
  responseColumns: [],
};

function suggestMapping(table: SourceTable): CurrentColumnMapping {
  const applicationId = firstMatchingColumn(table.columns, [
    /application.*\bid\b/, /submission.*\bid\b/, /entry.*\bid\b/, /^id$/,
  ]);
  const excluded = new Set([applicationId].filter(Boolean));
  const teamName = firstMatchingColumn(
    table.columns,
    [/^team( name)?$/, /organisation|organization|company|venture|startup|project name/],
    excluded,
  );
  if (teamName) excluded.add(teamName);
  const track = firstMatchingColumn(table.columns, [/track|category|challenge area|theme/], excluded);
  if (track) excluded.add(track);
  let responseColumns = table.columns
    .filter((column) =>
      !excluded.has(column.key) &&
      !isSensitiveAssessmentHeading(column.label) &&
      columnMatches(column, [/answer|response|question|submission|proposal|solution|impact|innovation|description|application text|delivery|team experience/]),
    )
    .map((column) => column.key);
  if (responseColumns.length === 0) {
    responseColumns = table.columns
      .filter((column) => !excluded.has(column.key) && !isSensitiveAssessmentHeading(column.label))
      .slice(0, 1)
      .map((column) => column.key);
  }
  return { applicationId, teamName, track, responseColumns };
}

async function fetchImport<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new Error(error?.message ?? "The shared import could not be completed safely.");
  }
  return body as T;
}

export default function CurrentImportManager() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<CurrentColumnMapping>(EMPTY_MAPPING);
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [completeConfirmed, setCompleteConfirmed] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "reading" | "uploading" | "complete" | "error">("loading");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [datasetId, setDatasetId] = useState<string | null>(null);

  useEffect(() => {
    void platformFetch<{ competitions: Competition[] }>("/api/platform/context")
      .then((body) => {
        const available = body.competitions.filter((item) => item.permissions.includes("application.import"));
        setCompetitions(available);
        setCompetitionId(available[0]?.id ?? "");
        setState("ready");
      })
      .catch((error: Error) => { setMessage(error.message); setState("error"); });
  }, []);

  const table = workbook?.sheets[sheetIndex] ?? null;
  const prepared = useMemo(
    () => table ? prepareCurrentDataset(table, mapping) : null,
    [mapping, table],
  );

  function resetConfirmations() {
    setWarningsConfirmed(false);
    setPrivacyConfirmed(false);
    setCompleteConfirmed(false);
  }

  function resetPublishedResult() {
    resetConfirmations();
    setProgress(0);
    setDatasetId(null);
    setMessage("");
    setState("ready");
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setState("reading");
    setMessage("");
    setWorkbook(null);
    setSheetIndex(0);
    setMapping(EMPTY_MAPPING);
    resetConfirmations();
    setProgress(0);
    setDatasetId(null);
    try {
      const parsed = await parseWorkbookFile(file);
      if (parsed.sheets.some((sheet) => sheet.rows.length > MAX_CURRENT_IMPORT_ROWS)) {
        throw new Error(`This production import accepts up to ${MAX_CURRENT_IMPORT_ROWS.toLocaleString()} applications at once.`);
      }
      setWorkbook(parsed);
      setSheetIndex(0);
      setMapping(suggestMapping(parsed.sheets[0]));
      setState("ready");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The spreadsheet could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function chooseSheet(index: number) {
    if (state === "uploading") return;
    setSheetIndex(index);
    setMapping(suggestMapping(workbook!.sheets[index]));
    resetPublishedResult();
  }

  function chooseCompetition(value: string) {
    if (state === "uploading" || value === competitionId) return;
    setCompetitionId(value);
    resetPublishedResult();
  }

  function updateMapping(update: (current: CurrentColumnMapping) => CurrentColumnMapping) {
    if (state === "uploading") return;
    setMapping(update);
    resetPublishedResult();
  }

  function toggleResponse(key: string) {
    updateMapping((current) => ({
      ...current,
      responseColumns: current.responseColumns.includes(key)
        ? current.responseColumns.filter((item) => item !== key)
        : [...current.responseColumns, key],
    }));
  }

  async function status(importId: string): Promise<ImportSession> {
    const body = await platformFetch<{ import: ImportSession }>(
      `/api/platform/imports/current/${encodeURIComponent(importId)}?competitionId=${encodeURIComponent(competitionId)}`,
    );
    return body.import;
  }

  async function publish() {
    if (!prepared?.canSeal || !workbook || !table || !competitionId) return;
    setState("uploading");
    setMessage("");
    setProgress(1);
    try {
      const inputs: CurrentImportRowInput[] = prepared.rows.map((row) => ({
        externalRef: row.externalId,
        identityData: {
          teamName: row.teamName,
          track: row.track,
          sourceRowNumber: row.sourceRowNumber,
          warnings: row.warnings,
        },
        content: { answers: row.answers },
        submittedAt: null,
      }));
      const canonicalRows: CanonicalCurrentImportRow[] = inputs.map(normalizeCurrentImportRow);
      const { sourceHash } = await currentImportSourceHash(canonicalRows);
      const rawChunks = Array.from(
        { length: Math.ceil(inputs.length / MAX_CURRENT_IMPORT_ROWS_PER_CHUNK) },
        (_, index) => inputs.slice(index * MAX_CURRENT_IMPORT_ROWS_PER_CHUNK, (index + 1) * MAX_CURRENT_IMPORT_ROWS_PER_CHUNK),
      );
      const preparedChunks = await Promise.all(rawChunks.map(prepareCurrentImportChunk));
      const idempotencyKey = `import-${crypto.randomUUID()}`;
      let session: ImportSession;
      const created = await fetchImport<{ import: ImportSession }>("/api/platform/imports/current", {
        method: "POST",
        body: JSON.stringify({
          competitionId,
          idempotencyKey,
          sourceFilename: workbook.fileName,
          sourceHash,
          expectedRowCount: inputs.length,
          expectedChunkCount: rawChunks.length,
          schemaVersion: 1,
        }),
      });
      session = created.import;

      for (let index = 0; index < rawChunks.length; index += 1) {
        try {
          const response = await fetchImport<{ import: ImportSession }>(
            `/api/platform/imports/current/${encodeURIComponent(session.id)}/chunks/${index}?competitionId=${encodeURIComponent(competitionId)}`,
            {
              method: "PUT",
              body: JSON.stringify({
                expectedRevision: session.revision,
                startRow: index * MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
                chunkHash: preparedChunks[index].chunkHash,
                rows: rawChunks[index],
              }),
            },
          );
          session = response.import;
        } catch (error) {
          const recovered = await status(session.id);
          if (recovered.receivedChunkCount <= index) throw error;
          session = recovered;
        }
        setProgress(Math.round(((index + 1) / rawChunks.length) * 85));
      }

      try {
        const finalized = await fetchImport<{ import: ImportSession; datasetId: string }>(
          `/api/platform/imports/current/${encodeURIComponent(session.id)}/finalize?competitionId=${encodeURIComponent(competitionId)}`,
          { method: "POST", body: JSON.stringify({ expectedRevision: session.revision }) },
        );
        session = finalized.import;
        setDatasetId(finalized.datasetId);
      } catch (error) {
        const recovered = await status(session.id);
        if (recovered.status !== "completed" || !recovered.completedDatasetId) throw error;
        session = recovered;
        setDatasetId(recovered.completedDatasetId);
      }
      setProgress(100);
      setState("complete");
      setMessage(`${session.expectedRowCount.toLocaleString()} applications were published to the shared workspace. No row was silently excluded.`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The import could not be completed safely.");
    }
  }

  const selectedIdentityKeys = new Set([mapping.applicationId, mapping.teamName, mapping.track].filter(Boolean));
  const readyToPublish = Boolean(
    prepared?.canSeal &&
    prepared.totalRows > 0 &&
    prepared.totalRows <= MAX_CURRENT_IMPORT_ROWS &&
    (!prepared.warningRows || warningsConfirmed) &&
    privacyConfirmed &&
    completeConfirmed,
  );

  if (competitions.length === 0 && state !== "loading") {
    return <section className="platform-card dashboard-loading"><p className="platform-error">{message || "Your account does not have application-import access."}</p></section>;
  }

  return (
    <div className="central-import-workspace">
      <section className="platform-card import-control-card">
        <div className="import-step"><b>1</b><div><strong>Choose the complete spreadsheet</strong><p>Excel, CSV or TSV · one row per team · maximum {MAX_CURRENT_IMPORT_ROWS.toLocaleString()} applications</p></div></div>
        <div className="import-top-grid">
          <label>Competition<select value={competitionId} disabled={state === "reading" || state === "uploading"} onChange={(event) => chooseCompetition(event.target.value)}>{competitions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="central-file-picker"><input type="file" accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values" onChange={(event) => void chooseFile(event)} disabled={state === "reading" || state === "uploading"} /><span>{state === "reading" ? "Checking file…" : workbook ? "Choose a different file" : "Choose spreadsheet"}</span></label>
        </div>
        {workbook ? <div className="central-file-summary"><strong>{workbook.fileName}</strong><span>{formatImportFileSize(workbook.fileSize)} · {table?.rows.length.toLocaleString()} rows</span>{workbook.sheets.length > 1 ? <label>Worksheet<select value={sheetIndex} disabled={state === "uploading"} onChange={(event) => chooseSheet(Number(event.target.value))}>{workbook.sheets.map((sheet, index) => <option key={sheet.sheetName} value={index}>{sheet.sheetName}</option>)}</select></label> : null}</div> : null}
      </section>

      {table ? (
        <section className="platform-card import-control-card">
          <div className="import-step"><b>2</b><div><strong>Tell Minder what each column means</strong><p>Identity stays separate. Only checked answer columns may be used for assessment.</p></div></div>
          <div className="import-mapping-grid">
            <ColumnSelect label="Stable application ID" value={mapping.applicationId} table={table} required disabled={state === "uploading"} onChange={(value) => updateMapping((current) => ({ ...current, applicationId: value }))} />
            <ColumnSelect label="Team name" value={mapping.teamName} table={table} disabled={state === "uploading"} onChange={(value) => updateMapping((current) => ({ ...current, teamName: value }))} />
            <ColumnSelect label="Track or category" value={mapping.track} table={table} disabled={state === "uploading"} onChange={(value) => updateMapping((current) => ({ ...current, track: value }))} />
          </div>
          <fieldset className="central-response-picker" disabled={state === "uploading"}><legend>Application answers AI and reviewers may assess</legend>{table.columns.map((column) => { const sensitive = isSensitiveAssessmentHeading(column.label); const identity = selectedIdentityKeys.has(column.key); return <label className={sensitive ? "blocked" : ""} key={column.key}><input type="checkbox" checked={mapping.responseColumns.includes(column.key)} disabled={sensitive || identity} onChange={() => toggleResponse(column.key)} /><span><strong>{column.label}</strong><small>{sensitive ? "Blocked: identity, contact, outcome or reviewer field" : identity ? "Stored as identity, not assessment text" : "Include only if judges are allowed to assess this answer"}</small></span></label>; })}</fieldset>
        </section>
      ) : null}

      {prepared ? (
        <section className="platform-card import-control-card">
          <div className="import-step"><b>3</b><div><strong>Check every row, then publish</strong><p>The server rechecks all hashes, counts and duplicate IDs before one atomic publish.</p></div></div>
          <div className="import-check-grid"><article><span>Source rows</span><strong>{prepared.totalRows}</strong></article><article><span>Ready rows</span><strong>{prepared.readyRows.length}</strong></article><article className={prepared.blockedRows ? "bad" : "good"}><span>Rows needing correction</span><strong>{prepared.blockedRows}</strong></article><article className={prepared.warningRows ? "warn" : "good"}><span>Warnings</span><strong>{prepared.warningRows}</strong></article></div>
          {prepared.sealBlockers.length ? <div className="platform-error"><strong>Correct the spreadsheet or mapping before publishing.</strong><ul>{prepared.sealBlockers.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
          <div className="import-confirmations">
            {prepared.warningRows ? <label><input type="checkbox" checked={warningsConfirmed} onChange={(event) => setWarningsConfirmed(event.target.checked)} />I reviewed the repeated-team or identical-answer warnings.</label> : null}
            <label><input type="checkbox" checked={completeConfirmed} onChange={(event) => setCompleteConfirmed(event.target.checked)} />This is the complete cohort. No application has been deliberately omitted.</label>
            <label><input type="checkbox" checked={privacyConfirmed} onChange={(event) => setPrivacyConfirmed(event.target.checked)} />I removed unnecessary contact, health, banking and identity-document data. I understand personal details written inside an answer may remain.</label>
          </div>
          {state === "uploading" ? <div className="import-progress" role="status"><span style={{ width: `${progress}%` }} /><strong>{progress}% safely published</strong></div> : null}
          {message ? <p className={state === "error" ? "platform-error" : "platform-success"} role="status">{message}</p> : null}
          <div className="import-publish-row"><p>Check carefully before publishing: this pilot supports one current cohort per competition. Successful imports are centrally shared, revisioned and audited; raw staging rows are removed after publish.</p><button className="platform-primary" type="button" disabled={!readyToPublish || state === "uploading" || state === "complete"} onClick={() => void publish()}>{state === "uploading" ? "Publishing complete cohort…" : state === "complete" ? "Published" : "Publish to shared workspace"}</button></div>
          {datasetId ? <div className="import-next"><strong>Applications are ready for assignment.</strong><Link href="/admin/assignments">Assign reviewers →</Link></div> : null}
        </section>
      ) : null}
    </div>
  );
}

function ColumnSelect({ label, value, table, required = false, disabled = false, onChange }: { label: string; value: string; table: SourceTable; required?: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} required={required}><option value="">{required ? "Choose a column" : "Not included"}</option>{table.columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select></label>;
}
