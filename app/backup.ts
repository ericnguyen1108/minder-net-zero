/**
 * Browser-state backup and restore during the staged Postgres port.
 *
 * Historical data, Phase 4 sessions and final decisions are now server-owned.
 * This file still protects the not-yet-migrated journey/guide state, current
 * applications and Phase 5 browser records until their Postgres flip removes
 * this temporary backup path.
 *
 * Restore replaces browser state wholesale, with one deliberate exception:
 * one-use reveal receipts (phase4-consumed) are union-merged and never
 * removed. Restoring an older backup must not let a sealed practice test be
 * taken twice.
 */

import { openDatabase, PHASE4_CONSUMED_STORE } from "./historical-data.ts";

export const APP_STATE_STORAGE_KEY = "minder-net-zero-app-v5";
export const BACKUP_FORMAT = "minder-net-zero-workspace-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type WorkspaceBackup = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string;
  appState: string | null;
  stores: Record<string, unknown[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storageArea(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function storeNames(database: IDBDatabase): string[] {
  return Array.from(database.objectStoreNames);
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage request failed."));
  });
}

export async function exportWorkspace(exportedAt: string): Promise<WorkspaceBackup> {
  const database = await openDatabase();
  try {
    const names = storeNames(database);
    const transaction = database.transaction(names, "readonly");
    const stores: Record<string, unknown[]> = {};
    for (const name of names) {
      stores[name] = await requestAsPromise(transaction.objectStore(name).getAll());
    }
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt,
      appState: storageArea()?.getItem(APP_STATE_STORAGE_KEY) ?? null,
      stores,
    };
  } finally {
    database.close();
  }
}

export function parseWorkspaceBackup(raw: string): WorkspaceBackup {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("This file is not a readable Minder backup.");
  }
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new Error("This file is not a Minder Net Zero workspace backup.");
  }
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      "This backup was made by a different version of Minder Net Zero and cannot be restored here.",
    );
  }
  if (!isRecord(value.stores) || Object.values(value.stores).some((rows) => !Array.isArray(rows))) {
    throw new Error("This backup file is damaged and was not restored.");
  }
  if (value.appState !== null && typeof value.appState !== "string") {
    throw new Error("This backup file is damaged and was not restored.");
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
    appState: value.appState,
    stores: value.stores as Record<string, unknown[]>,
  };
}

/** Never lets a restore lower a reveal receipt's recorded reveal count. */
function mergeConsumedReceipt(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return incoming;
  const existingCount = typeof existing.revealCount === "number" ? existing.revealCount : 1;
  const incomingCount = typeof incoming.revealCount === "number" ? incoming.revealCount : 1;
  // Keep whichever recorded more reveals; a stale backup can never re-open a
  // seal by rolling the count back.
  return incomingCount > existingCount ? incoming : existing;
}

/**
 * Replaces every store with the backup's contents inside one transaction, so a
 * failed restore leaves the workspace unchanged. Unknown store names fail
 * closed rather than silently dropping data from a newer app version.
 */
export async function importWorkspace(backup: WorkspaceBackup): Promise<void> {
  const database = await openDatabase();
  try {
    const names = storeNames(database);
    const known = new Set(names);
    const unknown = Object.keys(backup.stores).filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        "This backup came from a newer version of Minder Net Zero. Update the app before restoring it.",
      );
    }
    // Validate every row up front so a bad row cannot throw mid-transaction and
    // leave a partial restore (some stores wiped, others not).
    for (const name of names) {
      const rows = backup.stores[name] ?? [];
      if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new Error("This backup file is damaged and was not restored.");
      }
    }

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(names, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("The restore was interrupted; nothing was changed."));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("The restore failed; nothing was changed."));

      try {
        for (const name of names) {
          const store = transaction.objectStore(name);
          const incoming = (backup.stores[name] ?? []) as Record<string, unknown>[];
          if (name === PHASE4_CONSUMED_STORE) {
            // Union-merge: existing reveal receipts are permanent and their
            // reveal count is monotonic, so restoring an older backup can never
            // re-open a one-use seal.
            for (const row of incoming) {
              const key = row.datasetFingerprint;
              const getRequest = store.get(key as IDBValidKey);
              getRequest.onsuccess = () => {
                store.put(mergeConsumedReceipt(getRequest.result as Record<string, unknown> | undefined, row));
              };
            }
          } else {
            store.clear();
            for (const row of incoming) store.put(row);
          }
        }
      } catch (error) {
        transaction.abort();
        reject(error instanceof Error ? error : new Error("The restore failed; nothing was changed."));
      }
    });
  } finally {
    database.close();
  }

  const area = storageArea();
  if (!area) throw new Error("Browser storage is unavailable, so the setup state was not restored.");
  if (typeof backup.appState === "string") {
    area.setItem(APP_STATE_STORAGE_KEY, backup.appState);
  } else {
    // The backup captured no journey state; clear any stale pointer so it does
    // not reference datasets/runs that the restore just wiped.
    area.removeItem?.(APP_STATE_STORAGE_KEY);
  }
}

export function backupFileName(timestamp: string): string {
  const safe = timestamp.replace(/[:.]/g, "-");
  return `minder-net-zero-backup-${safe}.json`;
}

export function describeBackup(backup: WorkspaceBackup): string {
  const rowCount = Object.values(backup.stores).reduce((sum, rows) => sum + rows.length, 0);
  const exported = backup.exportedAt ? ` exported ${backup.exportedAt.slice(0, 10)}` : "";
  return `${rowCount} saved records${exported}`;
}
