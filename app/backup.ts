/**
 * Setup-progress backup for the remaining browser-owned legacy state.
 *
 * Historical/current applications, Phase 4, Phase 5 and final decisions are
 * server-owned and are deliberately absent. Version-1 backups are accepted
 * only to recover their appState field; their obsolete IndexedDB stores are
 * validated and discarded, never restored.
 */

export const APP_STATE_STORAGE_KEY = "minder-net-zero-app-v5";
export const BACKUP_FORMAT = "minder-net-zero-workspace-backup";
export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_SCOPE = "browser-setup-progress";

export type WorkspaceBackup = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  scope: typeof BACKUP_SCOPE;
  exportedAt: string;
  appState: string | null;
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

function requireAppState(value: Record<string, unknown>) {
  if (value.appState !== null && typeof value.appState !== "string") {
    throw new Error("This backup file is damaged and was not restored.");
  }
  return value.appState as string | null;
}

export async function exportWorkspace(exportedAt: string): Promise<WorkspaceBackup> {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    scope: BACKUP_SCOPE,
    exportedAt,
    appState: storageArea()?.getItem(APP_STATE_STORAGE_KEY) ?? null,
  };
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

  if (value.formatVersion === 1) {
    if (
      !isRecord(value.stores) ||
      Object.values(value.stores).some((rows) => !Array.isArray(rows))
    ) {
      throw new Error("This backup file is damaged and was not restored.");
    }
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      scope: BACKUP_SCOPE,
      exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
      appState: requireAppState(value),
    };
  }

  if (value.formatVersion !== BACKUP_FORMAT_VERSION || value.scope !== BACKUP_SCOPE) {
    throw new Error(
      "This backup was made by a different version of Minder Net Zero and cannot be restored here.",
    );
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    scope: BACKUP_SCOPE,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
    appState: requireAppState(value),
  };
}

/** Restores setup/guide progress only. Central competition records are untouched. */
export async function importWorkspace(backup: WorkspaceBackup): Promise<void> {
  if (
    backup.format !== BACKUP_FORMAT ||
    backup.formatVersion !== BACKUP_FORMAT_VERSION ||
    backup.scope !== BACKUP_SCOPE ||
    (backup.appState !== null && typeof backup.appState !== "string")
  ) {
    throw new Error("This backup file is damaged and was not restored.");
  }
  const area = storageArea();
  if (!area) throw new Error("Browser storage is unavailable, so setup progress was not restored.");
  if (typeof backup.appState === "string") {
    area.setItem(APP_STATE_STORAGE_KEY, backup.appState);
  } else {
    area.removeItem?.(APP_STATE_STORAGE_KEY);
  }
}

export function backupFileName(timestamp: string): string {
  const safe = timestamp.replace(/[:.]/g, "-");
  return `minder-net-zero-setup-backup-${safe}.json`;
}

export function describeBackup(backup: WorkspaceBackup): string {
  const exported = backup.exportedAt ? ` exported ${backup.exportedAt.slice(0, 10)}` : "";
  return `${backup.appState ? "setup progress" : "empty setup progress"}${exported}`;
}
