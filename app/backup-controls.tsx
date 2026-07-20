"use client";

import { useRef, useState } from "react";
import {
  backupFileName,
  describeBackup,
  exportWorkspace,
  importWorkspace,
  parseWorkspaceBackup,
} from "./backup.ts";

/**
 * Temporary backup panel for the setup/guide draft that is still browser-owned.
 */
export default function BackupControls() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function downloadBackup() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const exportedAt = new Date().toISOString();
      const backup = await exportWorkspace(exportedAt);
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = backupFileName(exportedAt);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice({ tone: "ok", text: "Setup backup downloaded. Keep it somewhere safe." });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The backup could not be created.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function restoreFromFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const backup = parseWorkspaceBackup(await file.text());
      const confirmed = window.confirm(
        `Replace the setup progress in this browser with the backup (${describeBackup(backup)})?\n\n` +
          "Close any other Minder Net Zero tabs first. Centrally saved competition data is not replaced.",
      );
      if (!confirmed) return;
      await importWorkspace(backup);
      window.location.reload();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The backup could not be restored.",
      });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="sidebar-backup" aria-label="Setup progress backup">
      <strong>Setup backup</strong>
      <p>Competition data is saved centrally. This file covers only the setup form and Decision Guide progress on this browser.</p>
      <div className="sidebar-backup-actions">
        <button type="button" onClick={downloadBackup} disabled={busy}>
          Download setup
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
          Restore…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void restoreFromFile(file);
          }}
        />
      </div>
      {notice ? (
        <p className={notice.tone === "error" ? "sidebar-backup-error" : "sidebar-backup-ok"} role="status">
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
