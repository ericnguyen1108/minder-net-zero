// Fast transport coverage for the migrated historical + Phase 4 clients. The
// real state-machine and seal round trip lives in pilot-historical-phase4.

import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteHistoricalDataset,
  historicalDatasetExists,
  loadActiveHistoricalSummary,
  loadBlindPracticeRows,
  loadHistoricalDatasetBinding,
  loadTeachingRows,
  saveHistoricalDataset,
} from "../app/historical-data.ts";
import { createPhase4Session, savePhase4Session } from "../app/phase4-storage.ts";

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

function stubPilot(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, ...request });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: handler(request.action, request.payload) }),
    };
  };
  return calls;
}

const binding = {
  datasetId: "dataset-db-id",
  datasetFingerprint: "a".repeat(64),
  integrityHash: "b".repeat(64),
  guideVersion: 1,
  teachingRows: 32,
  sealedRows: 8,
};

test("historical save sends raw mapped rows for server-side sealing", async () => {
  const summary = { status: "ready", datasetId: binding.datasetId };
  const calls = stubPilot(() => ({
    datasetId: binding.datasetId,
    fingerprint: binding.datasetFingerprint,
    summary,
  }));
  const table = {
    sheetName: "Applications",
    columns: [{ key: "id", label: "ID", index: 0 }],
    rows: [{ id: "APP-001" }],
    rowNumbers: [2],
  };
  const mapping = {
    applicationId: "id", teamName: "", responseColumns: [], outcome: "id",
    year: "", track: "", judgeScore: "", reviewerNotes: "",
  };
  const result = await saveHistoricalDataset({
    table,
    mapping,
    outcomeMapping: { shortlisted: "progressed" },
    fileName: "history.csv",
    fileSize: 100,
    guideVersion: 1,
    replaceDatasetId: "old-id",
  });
  assert.equal(result.summary, summary);
  assert.equal(calls[0].action, "historical.import");
  assert.equal(calls[0].url, "/api/pilot");
  assert.deepEqual(calls[0].payload.table, table);
  assert.equal(calls[0].payload.replaceDatasetId, "old-id");
  assert.equal("fingerprint" in calls[0].payload, false, "the browser cannot choose the seal");
});

test("historical readers and deletion use the Postgres actions", async () => {
  const summary = { status: "ready", datasetId: binding.datasetId };
  const calls = stubPilot((action) => ({
    "historical.active": summary,
    "historical.exists": { exists: true },
    "historical.binding": binding,
    "historical.teaching": [{ rowId: "t1", answers: [], outcome: "progressed" }],
    "historical.blind": [{ rowId: "s1", answers: [] }],
    "historical.delete": { ok: true },
  })[action]);
  assert.equal(await loadActiveHistoricalSummary(), summary);
  assert.equal(await historicalDatasetExists(binding.datasetId), true);
  assert.equal(await loadHistoricalDatasetBinding(binding.datasetId), binding);
  assert.equal((await loadTeachingRows(binding.datasetId)).length, 1);
  assert.equal((await loadBlindPracticeRows(binding.datasetId)).length, 1);
  await deleteHistoricalDataset(binding.datasetId);
  assert.deepEqual(calls.map((call) => call.action), [
    "historical.active", "historical.exists", "historical.binding",
    "historical.teaching", "historical.blind", "historical.delete",
  ]);
});

test("a pristine Phase 4 session loads and saves through calibration actions", async () => {
  let savedSession = null;
  const calls = stubPilot((action, payload) => {
    if (action === "calibration.consumed") return { consumed: false, headroom: 0 };
    if (action === "historical.binding") return binding;
    if (action === "calibration.load") return null;
    if (action === "calibration.save") {
      savedSession = { ...payload.session, blindnessCompromised: false };
      return savedSession;
    }
    throw new Error(`Unexpected action ${action}`);
  });
  const pristine = await createPhase4Session({ binding, guideContentHash: "guide-hash" });
  const saved = await savePhase4Session(pristine);
  assert.equal(saved, savedSession);
  assert.deepEqual(calls.map((call) => call.action), [
    "calibration.consumed", "historical.binding", "calibration.load", "calibration.save",
  ]);
});
