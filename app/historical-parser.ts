import Papa from "papaparse";
import { MAX_HISTORICAL_ROWS, normalizeHistoricalValue } from "./historical-data.ts";
import type { SourceColumn, SourceTable } from "./historical-data.ts";

export { MAX_HISTORICAL_ROWS } from "./historical-data.ts";
export const MAX_CURRENT_SOURCE_ROWS = 10_000;

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function uniqueHeaderLabels(rawHeaders: unknown[]) {
  // Locale-independent lower-casing keeps dedup keys stable regardless of the
  // host's locale (e.g. the Turkish dotless-i). The taken-set guarantees the
  // emitted label is globally unique, so a suffixed label can never collide
  // with a real pre-existing column such as "Name (2)".
  const taken = new Set<string>();
  return rawHeaders.map((header, index) => {
    const raw = formatCell(header).replace(/^\uFEFF/, "").trim();
    const base = raw || `Column ${index + 1}`;
    let candidate = base;
    let count = 1;
    while (taken.has(candidate.toLowerCase())) {
      count += 1;
      candidate = `${base} (${count})`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

export function buildSourceTable(
  sheetName: string,
  matrix: unknown[][],
  maxRows = MAX_HISTORICAL_ROWS,
): SourceTable {
  if (matrix.length < 2) throw new Error("We found headings but no application rows.");
  // Coarse guard against pathological inputs (never spread a huge array into
  // Math.max, which throws on ~100k+ elements). The exact row limit is enforced
  // below on numberedRows, AFTER blank/trailing rows are filtered — so a normal
  // trailing newline on a full file is not wrongly rejected here.
  if (matrix.length - 1 > maxRows + 1) {
    throw new Error(
      `This preview accepts up to ${maxRows.toLocaleString()} rows in one file.`,
    );
  }
  let width = 0;
  for (const row of matrix) {
    if (row.length > width) width = row.length;
  }
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
  if (numberedRows.length > maxRows) {
    throw new Error(
      `This preview accepts up to ${maxRows.toLocaleString()} rows in one file.`,
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
