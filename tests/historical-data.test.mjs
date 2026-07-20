import assert from "node:assert/strict";
import test from "node:test";
import {
  createSealedHistoricalDataset,
  prepareHistoricalDataset,
  sanitizeHistoricalImportSummary,
} from "../app/historical-data.ts";
import { buildSourceTable, parseDelimitedText } from "../app/historical-parser.ts";

const columns = [
  { key: "id", label: "Application ID", index: 0 },
  { key: "team", label: "Team", index: 1 },
  { key: "problem", label: "Problem", index: 2 },
  { key: "solution", label: "Solution", index: 3 },
  { key: "outcome", label: "Final result", index: 4 },
  { key: "year", label: "Year", index: 5 },
];

const mapping = {
  applicationId: "id",
  teamName: "team",
  responseColumns: ["problem", "solution"],
  outcome: "outcome",
  year: "year",
  track: "",
  judgeScore: "",
  reviewerNotes: "",
};

const outcomeMapping = {
  shortlisted: "progressed",
  "not selected": "not_progressed",
  withdrawn: "ignore",
};

function makeRows(progressed = 30, notProgressed = 30) {
  return Array.from({ length: progressed + notProgressed }, (_, index) => ({
    id: `APP-${String(index + 1).padStart(4, "0")}`,
    team: `Team ${index + 1}`,
    problem: `Problem statement ${index + 1} explains the material climate challenge in sufficient detail.`,
    solution: `Solution ${index + 1} explains the proposed intervention, evidence and delivery plan in sufficient detail.`,
    outcome: index < progressed ? "Shortlisted" : "Not selected",
    year: "2025",
  }));
}

function makeTable(rows) {
  return {
    sheetName: "Applications",
    columns,
    rows,
    rowNumbers: rows.map((_, index) => index + 2),
  };
}

test("parses BOM, quoted commas, multiline CSV, TSV and preserves row numbers across blanks", () => {
  const csv =
    '\uFEFFID,Team,Answer,Outcome\r\n0012,"Team, One","Line one\nLine two",Shortlisted\r\n\r\n0013,Team Two,Answer two,Not selected\r\n';
  const csvTable = buildSourceTable("CSV", parseDelimitedText(csv));
  assert.equal(csvTable.rows.length, 2);
  assert.equal(csvTable.rows[0][csvTable.columns[0].key], "0012");
  assert.equal(csvTable.rows[0][csvTable.columns[2].key], "Line one\nLine two");
  assert.deepEqual(csvTable.rowNumbers, [2, 4]);

  const tsvTable = buildSourceTable(
    "TSV",
    parseDelimitedText("ID\tTeam\tAnswer\tOutcome\n0007\tTeam Seven\tAnswer\tShortlisted\n"),
  );
  assert.equal(tsvTable.rows[0][tsvTable.columns[0].key], "0007");
});

test("de-duplicates headers without colliding with a real pre-existing label", () => {
  const table = buildSourceTable("CSV", [
    ["Name", "Name", "Name (2)"],
    ["a", "b", "c"],
  ]);
  const labels = table.columns.map((column) => column.label);
  assert.equal(new Set(labels).size, labels.length, "every emitted header label must be unique");
  assert.deepEqual(labels, ["Name", "Name (2)", "Name (2) (2)"]);
});

test("rejects an oversized file with a clear error instead of crashing on a huge spread", () => {
  const header = [["ID", "Answer"]];
  const rows = Array.from({ length: 10_002 }, (_, index) => [`ID-${index}`, `Answer ${index}`]);
  assert.throws(() => buildSourceTable("CSV", [...header, ...rows]), /accepts up to 10,000 rows/);
});

test("accepts exactly 10,000 real rows even with a trailing blank line", () => {
  const header = [["ID", "Answer"]];
  const rows = Array.from({ length: 10_000 }, (_, index) => [`ID-${index}`, `Answer ${index}`]);
  const trailingBlank = [[""]]; // exporters commonly add a trailing newline
  const table = buildSourceTable("CSV", [...header, ...rows, ...trailingBlank]);
  assert.equal(table.rows.length, 10_000);
});

test("keeps question headings, preserves leading-zero IDs and never guesses outcomes", () => {
  const rows = makeRows(10, 10);
  rows[0].id = "0012";
  rows.push({
    id: "0099",
    team: "Unknown decision team",
    problem: "A sufficiently detailed problem statement that must remain intact for later evidence checking.",
    solution: "A sufficiently detailed solution statement that must remain intact for later evidence checking.",
    outcome: "Maybe",
    year: "2025",
  });
  const prepared = prepareHistoricalDataset(makeTable(rows), mapping, outcomeMapping);

  assert.equal(prepared.rows[0].externalId, "0012");
  assert.deepEqual(prepared.rows[0].answers.map((answer) => answer.heading), ["Problem", "Solution"]);
  assert.match(prepared.rows[0].applicationText, /^Problem\n/);
  assert.equal(prepared.rows.at(-1).outcome, null);
  assert.ok(prepared.rows.at(-1).issues.includes("unmapped-outcome"));
  assert.equal(prepared.totalRows, prepared.validRows.length + prepared.excludedRows);
});

test("shows missing, ignored, exact duplicate and conflicting records as excluded", () => {
  const rows = makeRows(12, 12);
  rows.push({ ...rows[0] });
  rows.push({ ...rows[1], id: "NEW-ID" });
  rows.push({ ...rows[2], solution: "Different text", outcome: "Not selected" });
  rows.push({ ...rows[3], id: "BLANK-TEXT", problem: "", solution: "" });
  rows.push({ ...rows[4], id: "WITHDRAWN", outcome: "Withdrawn" });
  const prepared = prepareHistoricalDataset(makeTable(rows), mapping, outcomeMapping);

  assert.equal(prepared.excludedRows, 6);
  assert.equal(prepared.duplicateRows, 4);
  assert.ok((prepared.issueCounts["conflicting-id"] ?? 0) >= 2);
  assert.ok((prepared.issueCounts["missing-text"] ?? 0) >= 1);
  assert.ok((prepared.issueCounts["ignored-outcome"] ?? 0) >= 1);
  assert.equal(prepared.totalRows, prepared.validRows.length + prepared.excludedRows);
});

test("creates one exact, deterministic and outcome-balanced 80/20 blind split", async () => {
  const table = makeTable(makeRows());
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  assert.equal(prepared.canSeal, true);

  const common = {
    fileName: "history.xlsx",
    fileSize: 12000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  };
  const first = await createSealedHistoricalDataset({ ...common, datasetId: "history-one" });
  const reversedTable = makeTable([...table.rows].reverse());
  const reversedPrepared = prepareHistoricalDataset(reversedTable, mapping, outcomeMapping);
  const second = await createSealedHistoricalDataset({
    ...common,
    datasetId: "history-two",
    table: reversedTable,
    prepared: reversedPrepared,
  });

  assert.equal(first.sealedRows.length, 12);
  assert.equal(first.teachingRows.length, 48);
  assert.ok(first.sealedRows.some((row) => row.outcome === "progressed"));
  assert.ok(first.sealedRows.some((row) => row.outcome === "not_progressed"));
  const assignments = (dataset) =>
    Object.fromEntries(
      [...dataset.teachingRows, ...dataset.sealedRows]
        .map((row) => [row.externalId, row.partition])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  assert.deepEqual(assignments(first), assignments(second));
  assert.equal(first.metadata.split.algorithm, "linked-outcome-sha256-v2");
  assert.equal(first.metadata.split.status, "sealed");
});

test("scopes reused IDs by year and keeps linked team-year applications in one partition", async () => {
  const rows = makeRows(15, 15);
  rows[1].id = rows[0].id;
  rows[1].year = "2024";
  rows[0].team = "Linked team";
  rows[1].team = "Linked team";
  rows[0].year = "2025";
  rows[2].team = "Same-year linked team";
  rows[3].team = "Same-year linked team";
  rows[2].year = "2025";
  rows[3].year = "2025";
  const table = makeTable(rows);
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  assert.equal(prepared.issueCounts["conflicting-id"] ?? 0, 0);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "linked-history",
    fileName: "linked.csv",
    fileSize: 1000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  const partitions = Object.fromEntries(
    [...dataset.teachingRows, ...dataset.sealedRows].map((row) => [row.externalId, row.partition]),
  );
  assert.equal(partitions[rows[2].id], partitions[rows[3].id]);
});

test("splits 1,000 balanced examples into exactly 800 teaching and 200 sealed rows", async () => {
  const table = makeTable(makeRows(500, 500));
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  const dataset = await createSealedHistoricalDataset({
    datasetId: "history-1000",
    fileName: "history-1000.csv",
    fileSize: 250000,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
  assert.equal(dataset.teachingRows.length, 800);
  assert.equal(dataset.sealedRows.length, 200);
});

// Server-backed historical storage and the Phase 4 seal are covered end to end
// in tests/pilot-historical-phase4.test.mjs.

test("requires enough positive and negative examples and distrusts missing storage summaries", () => {
  const tooSmall = prepareHistoricalDataset(makeTable(makeRows(4, 16)), mapping, outcomeMapping);
  assert.equal(tooSmall.canSeal, false);
  assert.match(tooSmall.sealBlockers.join(" "), /5 progressed/i);

  const recovered = sanitizeHistoricalImportSummary({ status: "ready", datasetId: "" });
  assert.equal(recovered.status, "missing");
});
