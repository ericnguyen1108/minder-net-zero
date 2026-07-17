// Proves the historical-dataset sealing computation - dataset fingerprint,
// teaching/sealed split, and integrity hash - runs correctly SERVER-SIDE
// (Node, no browser) and is deterministic. This is the integrity requirement
// the Postgres schema deliberately delegates to the API layer: the server must
// derive these values from the rows, never accept them from the browser.
//
// createSealedHistoricalDataset takes rows and OUTPUTS the partition; there is
// no partition input, so a client cannot hand-pick which rows are sealed. These
// tests lock in that the same file always yields the same split.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSealedHistoricalDataset,
  prepareHistoricalDataset,
} from "../app/historical-data.ts";

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
const outcomeMapping = { shortlisted: "progressed", "not selected": "not_progressed" };

function makeRows(progressed = 30, notProgressed = 30) {
  return Array.from({ length: progressed + notProgressed }, (_, index) => ({
    id: `APP-${String(index + 1).padStart(4, "0")}`,
    team: `Team ${index + 1}`,
    problem: `Problem statement ${index + 1} explains the material climate challenge in sufficient detail.`,
    solution: `Solution ${index + 1} explains the proposed intervention, evidence and delivery plan in detail.`,
    outcome: index < progressed ? "Shortlisted" : "Not selected",
    year: "2025",
  }));
}
function makeTable(rows) {
  return { sheetName: "Applications", columns, rows, rowNumbers: rows.map((_, i) => i + 2) };
}

async function seal(rows, datasetId = "ds-1") {
  const table = makeTable(rows);
  const prepared = prepareHistoricalDataset(table, mapping, outcomeMapping);
  return createSealedHistoricalDataset({
    datasetId,
    fileName: "history.csv",
    fileSize: 4096,
    table,
    guideVersion: 1,
    mapping,
    outcomeMapping,
    prepared,
  });
}

test("seals a historical dataset server-side (Node, no browser globals)", async () => {
  const sealed = await seal(makeRows(30, 30));
  assert.match(sealed.metadata.datasetFingerprint, /^[0-9a-f]{64}$/);
  assert.match(sealed.metadata.split.integrityHash, /^[0-9a-f]{64}$/);
  assert.equal(sealed.metadata.split.algorithm, "linked-outcome-sha256-v2");
  // A roughly 80/20 teaching/sealed split, with both partitions non-empty.
  assert.ok(sealed.teachingRows.length > 0 && sealed.sealedRows.length > 0);
  assert.equal(sealed.teachingRows.length + sealed.sealedRows.length, 60);
  assert.ok(sealed.sealedRows.length >= 8 && sealed.sealedRows.length <= 16,
    `sealed count ${sealed.sealedRows.length} should be ~20% of 60`);
});

test("the split is deterministic: same file, same fingerprint and same sealed set", async () => {
  const rows = makeRows(30, 30);
  const a = await seal(rows, "ds-A");
  const b = await seal(rows, "ds-B"); // different datasetId must not change the split
  assert.equal(a.metadata.datasetFingerprint, b.metadata.datasetFingerprint);
  assert.equal(a.metadata.split.integrityHash, b.metadata.split.integrityHash);
  const sealedA = a.sealedRows.map((r) => r.rowId).sort();
  const sealedB = b.sealedRows.map((r) => r.rowId).sort();
  assert.deepEqual(sealedA, sealedB, "the sealed set must be identical for identical input");
});

test("row order does not change the fingerprint or the sealed set", async () => {
  const rows = makeRows(30, 30);
  const shuffled = [...rows].reverse();
  const a = await seal(rows);
  const b = await seal(shuffled);
  assert.equal(a.metadata.datasetFingerprint, b.metadata.datasetFingerprint);
  assert.deepEqual(
    a.sealedRows.map((r) => r.rowId).sort(),
    b.sealedRows.map((r) => r.rowId).sort(),
    "input order must not influence which rows are sealed",
  );
});

test("a different file yields a different fingerprint and split", async () => {
  const a = await seal(makeRows(30, 30));
  const b = await seal(makeRows(28, 24)); // genuinely different content
  assert.notEqual(a.metadata.datasetFingerprint, b.metadata.datasetFingerprint);
});
