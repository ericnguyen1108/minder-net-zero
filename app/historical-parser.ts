import Papa from "papaparse";
import { normalizeHistoricalValue } from "./historical-data.ts";
import type { SourceColumn, SourceTable } from "./historical-data.ts";

export const MAX_HISTORICAL_ROWS = 10_000;

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function uniqueHeaderLabels(rawHeaders: unknown[]) {
  const seen = new Map<string, number>();
  return rawHeaders.map((header, index) => {
    const raw = formatCell(header).replace(/^\uFEFF/, "").trim();
    const base = raw || `Column ${index + 1}`;
    const count = (seen.get(base.toLocaleLowerCase()) ?? 0) + 1;
    seen.set(base.toLocaleLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function buildSourceTable(sheetName: string, matrix: unknown[][]): SourceTable {
  if (matrix.length < 2) throw new Error("We found headings but no application rows.");
  const width = Math.max(...matrix.map((row) => row.length));
  const labels = uniqueHeaderLabels(
    Array.from({ length: width }, (_, index) => matrix[0]?.[index] ?? ""),
  );
  const columns: SourceColumn[] = labels.map((label, index) => ({
    key: `${index}:${label}`,
    label,
    index,
  }));
  const numberedRows = matrix
    .slice(1)
    .map((row, index) => ({
      rowNumber: index + 2,
      values: Object.fromEntries(
        columns.map((column) => [column.key, formatCell(row[column.index])]),
      ),
    }))
    .filter((row) => Object.values(row.values).some((value) => normalizeHistoricalValue(value)));
  if (numberedRows.length === 0) throw new Error("We found headings but no application rows.");
  if (numberedRows.length > MAX_HISTORICAL_ROWS) {
    throw new Error(
      `This preview accepts up to ${MAX_HISTORICAL_ROWS.toLocaleString()} rows in one file.`,
    );
  }
  return {
    sheetName,
    columns,
    rows: numberedRows.map((row) => row.values),
    rowNumbers: numberedRows.map((row) => row.rowNumber),
  };
}

export function parseDelimitedText(contents: string) {
  const results = Papa.parse<string[]>(contents, {
    dynamicTyping: false,
    skipEmptyLines: false,
  });
  const seriousError = results.errors.find((error) => error.code !== "UndetectableDelimiter");
  if (seriousError) {
    throw new Error(`We could not safely read row ${(seriousError.row ?? 0) + 1}.`);
  }
  return results.data as unknown[][];
}
