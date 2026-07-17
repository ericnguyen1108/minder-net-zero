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
 * Sidebar backup panel. Browser storage is evictable, so downloading a backup
 * file is the organiser's only protection against losing the approved guide,
 * calibration and results between sessions.
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
      setNotice({ tone: "ok", text: "Backup downloaded. Keep it somewhere safe." });
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
        `Replace everything in this browser with the backup (${describeBackup(backup)})?\n\n` +
          "Close any other Minder Net Zero tabs first. Existing one-use practice-test receipts are kept either way.",
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
    <div className="sidebar-backup" aria-label="Workspace backup">
      <strong>Data safety</strong>
      <p>Work is saved in this browser only. Download a backup after important steps.</p>
      <div className="sidebar-backup-actions">
        <button type="button" onClick={downloadBackup} disabled={busy}>
          Download backup
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
