import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import {
  APP_STATE_STORAGE_KEY,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  backupFileName,
  exportWorkspace,
  importWorkspace,
  parseWorkspaceBackup,
} from "../app/backup.ts";
import { openDatabase, PHASE4_CONSUMED_STORE } from "../app/historical-data.ts";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const localStorageData = new Map();
globalThis.localStorage = {
  getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: (key, value) => localStorageData.set(key, String(value)),
  removeItem: (key) => localStorageData.delete(key),
};

async function put(storeName, value) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readwrite");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(storeName).put(value);
    });
  } finally {
    database.close();
  }
}

async function getAll(storeName) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

test("backup round-trips the app state and every store", async () => {
  localStorageData.set(APP_STATE_STORAGE_KEY, JSON.stringify({ schemaVersion: 5, sample: true }));
  await put("historical-datasets", { id: "dataset-1", label: "History 2025" });
  await put(PHASE4_CONSUMED_STORE, {
    datasetFingerprint: "fp-original",
    sessionId: "session-1",
    revealedAt: "2026-07-01T00:00:00.000Z",
  });

  const backup = await exportWorkspace("2026-07-16T00:00:00.000Z");
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(typeof backup.appState, "string");
  assert.equal(backup.stores["historical-datasets"].length, 1);

  // Wipe, then restore.
  localStorageData.delete(APP_STATE_STORAGE_KEY);
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["historical-datasets"], "readwrite");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.objectStore("historical-datasets").clear();
  });
  database.close();
  assert.deepEqual(await getAll("historical-datasets"), []);

  const reparsed = parseWorkspaceBackup(JSON.stringify(backup));
  await importWorkspace(reparsed);

  assert.equal(localStorageData.get(APP_STATE_STORAGE_KEY), backup.appState);
  const datasets = await getAll("historical-datasets");
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].id, "dataset-1");
});

test("restore never removes existing one-use reveal receipts", async () => {
  await put(PHASE4_CONSUMED_STORE, {
    datasetFingerprint: "fp-after-backup",
    sessionId: "session-2",
    revealedAt: "2026-07-10T00:00:00.000Z",
  });

  // A backup exported before that receipt existed must not erase it.
  const backup = await exportWorkspace("2026-07-16T00:00:00.000Z");
  backup.stores[PHASE4_CONSUMED_STORE] = backup.stores[PHASE4_CONSUMED_STORE].filter(
    (row) => row.datasetFingerprint !== "fp-after-backup",
  );
  await importWorkspace(parseWorkspaceBackup(JSON.stringify(backup)));

  const receipts = await getAll(PHASE4_CONSUMED_STORE);
  const fingerprints = receipts.map((row) => row.datasetFingerprint).sort();
  assert.deepEqual(fingerprints, ["fp-after-backup", "fp-original"]);
});

test("restore fails closed on foreign, damaged, or newer-version files", async () => {
  assert.throws(() => parseWorkspaceBackup("not json"), /not a readable Minder backup/);
  assert.throws(
    () => parseWorkspaceBackup(JSON.stringify({ format: "something-else" })),
    /not a Minder Net Zero workspace backup/,
  );
  assert.throws(
    () =>
      parseWorkspaceBackup(
        JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 999, stores: {}, appState: null }),
      ),
    /different version/,
  );
  assert.throws(
    () =>
      parseWorkspaceBackup(
        JSON.stringify({
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_FORMAT_VERSION,
          stores: { "historical-datasets": "not-an-array" },
          appState: null,
        }),
      ),
    /damaged/,
  );

  const withUnknownStore = await exportWorkspace("2026-07-16T00:00:00.000Z");
  withUnknownStore.stores["future-store"] = [{ id: "x" }];
  await assert.rejects(importWorkspace(withUnknownStore), /newer version/);

  assert.equal(
    backupFileName("2026-07-16T10:00:00.000Z"),
    "minder-net-zero-backup-2026-07-16T10-00-00-000Z.json",
  );
});
