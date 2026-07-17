"use client";

import { useState } from "react";

/**
 * Full-page sign-in shown when a hosted deployment has no valid session.
 * The initial password is provided to the organiser by the Minder administrator.
 */
export default function AccessGate({ configured }: { configured: boolean }) {
  const [accessCode, setAccessCode] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "error">("idle");
  const [message, setMessage] = useState("");

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessCode.trim() || status === "checking") return;
    setStatus("checking");
    setMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode }),
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setStatus("error");
      setMessage(body?.error?.message ?? "Sign-in failed. Try again.");
    } catch {
      setStatus("error");
      setMessage("Could not reach the server. Check your connection and try again.");
    }
  }

  return (
    <main className="access-gate">
      <div className="access-gate-card">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">m<span /></div>
          <div>
            <div className="brand-name">Minder Net Zero</div>
            <div className="brand-subtitle">Application review</div>
          </div>
        </div>
        <h1>Private workspace</h1>
        <p>
          This review workspace is private to your competition team. Enter the password your
          Minder administrator gave you.
        </p>
        {configured ? (
          <form onSubmit={signIn}>
            <label htmlFor="access-code">Password</label>
            <input
              id="access-code"
              type="password"
              autoComplete="current-password"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              disabled={status === "checking"}
              autoFocus
            />
            <button type="submit" disabled={!accessCode.trim() || status === "checking"}>
              {status === "checking" ? "Signing in…" : "Sign in"}
            </button>
            {status === "error" ? <p className="access-gate-error" role="alert">{message}</p> : null}
          </form>
        ) : (
          <p className="access-gate-error" role="alert">
            Sign-in is not set up yet. An administrator must configure the deployment&apos;s
            ORGANISER_ACCESS_CODE and SESSION_SECRET before anyone can enter.
          </p>
        )}
      </div>
    </main>
  );
}
