"use client";

import { OrganizationSwitcher, UserButton, useOrganization, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";

type RequestState = "idle" | "saving" | "error" | "success";

export default function AccountControls() {
  if (process.env.NEXT_PUBLIC_AUTH_MODE === "clerk") return <IndividualAccountControls />;
  return <LegacyAccountControls />;
}

function IndividualAccountControls() {
  const { user, isLoaded: userLoaded } = useUser();
  const { organization, isLoaded: organizationLoaded } = useOrganization();

  return (
    <div className="individual-account-controls">
      <div className="individual-account-heading">
        <UserButton
          showName
          userProfileMode="modal"
          appearance={{ elements: { userButtonBox: "minder-user-button" } }}
        />
        <span>{userLoaded ? user?.primaryEmailAddress?.emailAddress : "Loading account…"}</span>
      </div>
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/"
        appearance={{ elements: { rootBox: "minder-organization-switcher" } }}
      />
      <nav className="platform-links" aria-label="Team workspace">
        <Link href="/review">My review queue</Link>
        <Link href="/team">Team &amp; roles</Link>
        <Link href="/audit">Audit log</Link>
      </nav>
      <p className="individual-account-org">
        {organizationLoaded && organization ? organization.name : "Choose your competition organisation"}
      </p>
    </div>
  );
}

function LegacyAccountControls() {
  const [open, setOpen] = useState(false);
  const [passwordChangeAvailable, setPasswordChangeAvailable] = useState<boolean | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<RequestState>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open || passwordChangeAvailable !== null) return;
    void fetch("/api/auth", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { passwordChangeAvailable?: unknown };
        setPasswordChangeAvailable(body.passwordChangeAvailable === true);
      })
      .catch(() => setPasswordChangeAvailable(false));
  }, [open, passwordChangeAvailable]);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && state !== "saving") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, state]);

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "saving") return;
    if (newPassword !== confirmPassword) {
      setState("error");
      setMessage("The new passwords do not match.");
      return;
    }
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json().catch(() => null)) as {
        message?: string;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setState("error");
        setMessage(body?.error?.message ?? "Could not change the password.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setState("success");
      setMessage(body?.message ?? "Password changed.");
    } catch {
      setState("error");
      setMessage("Could not reach the server. Check your connection and try again.");
    }
  }

  async function signOut() {
    if (state === "saving") return;
    setState("saving");
    setMessage("");
    try {
      await fetch("/api/auth", { method: "DELETE" });
    } finally {
      window.location.reload();
    }
  }

  function close() {
    if (state === "saving") return;
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setState("idle");
    setMessage("");
  }

  return (
    <div className="account-controls">
      <button className="account-trigger" type="button" onClick={() => setOpen(true)}>
        <span aria-hidden="true">◎</span>
        Account &amp; password
      </button>

      {open ? (
        <div className="account-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
          <section
            className="account-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-modal-title"
          >
            <div className="account-modal-header">
              <div>
                <div className="eyebrow">Workspace security</div>
                <h2 id="account-modal-title">Account &amp; password</h2>
              </div>
              <button className="account-close" type="button" onClick={close} aria-label="Close">
                ×
              </button>
            </div>

            {passwordChangeAvailable === null ? (
              <p className="account-muted">Checking password settings…</p>
            ) : passwordChangeAvailable ? (
              <form className="account-password-form" onSubmit={changePassword}>
                <p>Changing the password securely signs out every other browser and device.</p>
                <label htmlFor="current-password">Current password</label>
                <input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  disabled={state === "saving"}
                  required
                />
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={state === "saving"}
                  required
                />
                <span className="account-field-help">Use at least 12 characters.</span>
                <label htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={state === "saving"}
                  required
                />
                {message ? (
                  <p className={state === "success" ? "account-success" : "account-error"} role="status">
                    {message}
                  </p>
                ) : null}
                <button
                  className="account-primary"
                  type="submit"
                  disabled={
                    state === "saving" ||
                    !currentPassword ||
                    newPassword.length < 12 ||
                    !confirmPassword
                  }
                >
                  {state === "saving" ? "Saving…" : "Change password"}
                </button>
              </form>
            ) : (
              <div className="account-warning" role="status">
                <strong>Password changes need one final administrator setup.</strong>
                <p>The login gate is active, but persistent password storage is not connected yet.</p>
              </div>
            )}

            <div className="account-signout">
              <div>
                <strong>Finished reviewing?</strong>
                <p>Sign out on shared or public computers.</p>
              </div>
              <button type="button" onClick={signOut} disabled={state === "saving"}>Sign out</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
