import readXlsxFile from "read-excel-file/browser";
import { buildSourceTable, parseDelimitedText } from "./historical-parser";
import type { SourceColumn, SourceTable } from "./historical-data";

export type ParsedWorkbook = {
  fileName: string;
  fileSize: number;
  sheets: SourceTable[];
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;

export async function parseWorkbookFile(file: File): Promise<ParsedWorkbook> {
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
        sheets: [buildSourceTable("Applications", matrix)],
      };
    }
    const workbook = await readXlsxFile(file);
    const sheets = workbook
      .filter((sheet) => sheet.data.length > 1)
      .map((sheet) => buildSourceTable(sheet.sheet, sheet.data));
    if (!sheets.length) throw new Error("We could not find a worksheet with application rows.");
    return { fileName: file.name, fileSize: file.size, sheets };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("We ")) throw error;
    throw new Error(
      "We could not read this file. It may be damaged or password protected. Export an unlocked copy and try again.",
    );
  }
}

export function formatImportFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function columnMatches(column: SourceColumn, patterns: RegExp[]) {
  const label = column.label.toLocaleLowerCase();
  return patterns.some((pattern) => pattern.test(label));
}

export function firstMatchingColumn(
  columns: SourceColumn[],
  patterns: RegExp[],
  excluded = new Set<string>(),
) {
  return columns.find((column) => !excluded.has(column.key) && columnMatches(column, patterns))
    ?.key ?? "";
}
