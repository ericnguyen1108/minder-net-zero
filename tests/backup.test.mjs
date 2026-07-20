import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_STATE_STORAGE_KEY,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_SCOPE,
  backupFileName,
  exportWorkspace,
  importWorkspace,
  parseWorkspaceBackup,
} from "../app/backup.ts";

const localStorageData = new Map();
globalThis.localStorage = {
  getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: (key, value) => localStorageData.set(key, String(value)),
  removeItem: (key) => localStorageData.delete(key),
};

test("backup round-trips only browser-owned setup progress", async () => {
  localStorageData.set(APP_STATE_STORAGE_KEY, JSON.stringify({ schemaVersion: 5, sample: true }));
  const backup = await exportWorkspace("2026-07-20T00:00:00.000Z");

  assert.deepEqual(backup, {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    scope: BACKUP_SCOPE,
    exportedAt: "2026-07-20T00:00:00.000Z",
    appState: localStorageData.get(APP_STATE_STORAGE_KEY),
  });
  assert.equal("stores" in backup, false, "server-owned candidate records are never exported");

  localStorageData.delete(APP_STATE_STORAGE_KEY);
  await importWorkspace(parseWorkspaceBackup(JSON.stringify(backup)));
  assert.equal(localStorageData.get(APP_STATE_STORAGE_KEY), backup.appState);
});

test("a version-1 backup recovers setup progress but discards obsolete candidate stores", async () => {
  const legacy = {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    exportedAt: "2026-07-16T00:00:00.000Z",
    appState: JSON.stringify({ schemaVersion: 5, recovered: true }),
    stores: {
      "historical-sealed": [{ datasetId: "old", rowId: "secret", outcome: "progressed" }],
      "current-identities": [{ datasetId: "old", rowId: "secret", teamName: "Private" }],
    },
  };
  const parsed = parseWorkspaceBackup(JSON.stringify(legacy));
  assert.equal(parsed.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(parsed.scope, BACKUP_SCOPE);
  assert.equal("stores" in parsed, false);
  await importWorkspace(parsed);
  assert.equal(localStorageData.get(APP_STATE_STORAGE_KEY), legacy.appState);
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
        JSON.stringify({
          format: BACKUP_FORMAT,
          formatVersion: 999,
          scope: BACKUP_SCOPE,
          appState: null,
        }),
      ),
    /different version/,
  );
  assert.throws(
    () =>
      parseWorkspaceBackup(
        JSON.stringify({
          format: BACKUP_FORMAT,
          formatVersion: 1,
          stores: { "historical-datasets": "not-an-array" },
          appState: null,
        }),
      ),
    /damaged/,
  );
  await assert.rejects(
    importWorkspace({ ...await exportWorkspace(""), scope: "wrong-scope" }),
    /damaged/,
  );
  assert.equal(
    backupFileName("2026-07-16T10:00:00.000Z"),
    "minder-net-zero-setup-backup-2026-07-16T10-00-00-000Z.json",
  );
});
