"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { platformFetch } from "../platform-client.ts";

type DecisionCode = "shortlist" | "reject" | "waitlist" | "needs_more_review";
type DecisionApplication = {
  id: string;
  competitionId: string;
  externalId: string;
  teamName: string;
  track: string;
  applicationStatus: string;
  assessment: { recommendation: string; score: number | null } | null;
  reviewerSummary: { submitted: number; progress: number; doNotProgress: number; humanReview: number };
  finalDecision: { decision: DecisionCode; rationale: string; revision: number; decidedAt: string } | null;
  revision: number;
};

function DecisionForm({
  application,
  onSaved,
}: {
  application: DecisionApplication;
  onSaved: (application: DecisionApplication) => void;
}) {
  const [decision, setDecision] = useState<DecisionCode>(application.finalDecision?.decision ?? "needs_more_review");
  const [rationale, setRationale] = useState(application.finalDecision?.rationale ?? "");
  const [baseRevision, setBaseRevision] = useState(application.revision);
  const [state, setState] = useState<"ready" | "saving" | "error" | "success">("ready");
  const [message, setMessage] = useState("");
  const stale = application.revision !== baseRevision;

  function loadLatest() {
    setDecision(application.finalDecision?.decision ?? "needs_more_review");
    setRationale(application.finalDecision?.rationale ?? "");
    setBaseRevision(application.revision);
    setState("ready");
    setMessage("Latest recorded decision loaded.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stale) return;
    setState("saving");
    setMessage("");
    try {
      const body = await platformFetch<{ application: DecisionApplication }>(
        `/api/platform/decisions/${encodeURIComponent(application.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: baseRevision, decision, rationale }),
        },
      );
      setBaseRevision(body.application.revision);
      setDecision(body.application.finalDecision?.decision ?? "needs_more_review");
      setRationale(body.application.finalDecision?.rationale ?? "");
      setState("success");
      setMessage("Final decision recorded with your account and an immutable revision.");
      onSaved(body.application);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The decision could not be saved.");
    }
  }

  return (
    <form className="decision-form" onSubmit={submit}>
      {stale ? (
        <div className="platform-warning" role="alert">
          <strong>A newer decision was recorded in another session.</strong>
          <p>Your draft is preserved, but it cannot overwrite that revision.</p>
          <button type="button" onClick={loadLatest}>Load latest decision</button>
        </div>
      ) : null}
      <label>
        Authorised final outcome
        <select value={decision} onChange={(event) => setDecision(event.target.value as DecisionCode)}>
          <option value="shortlist">Shortlist</option>
          <option value="reject">Reject</option>
          <option value="waitlist">Waitlist</option>
          <option value="needs_more_review">Needs more human review</option>
        </select>
      </label>
      <label>
        Decision rationale
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          minLength={10}
          maxLength={10_000}
          placeholder="Explain the evidence and judgement behind this outcome. Do not include unnecessary personal information."
          required
        />
      </label>
      <div className="decision-form-footer">
        <p>Minder’s recommendation is advisory. Your signed-in account is accountable for this outcome.</p>
        <button className="platform-primary" disabled={state === "saving" || stale}>
          {state === "saving" ? "Recording…" : application.finalDecision ? "Record revised decision" : "Record final decision"}
        </button>
      </div>
      {message ? <p className={state === "error" ? "platform-error" : "platform-success"} role="status">{message}</p> : null}
    </form>
  );
}

export default function DecisionWorkspace() {
  const [applications, setApplications] = useState<DecisionApplication[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const selected = useMemo(
    () => applications.find((item) => item.id === selectedId) ?? applications[0] ?? null,
    [applications, selectedId],
  );

  const refresh = useCallback(async () => {
    try {
      const body = await platformFetch<{ applications: DecisionApplication[] }>("/api/platform/decisions");
      setApplications(body.applications);
      setSelectedId((current) => current && body.applications.some((item) => item.id === current)
        ? current
        : body.applications[0]?.id ?? null);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The final-decision workspace could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  function onSaved(saved: DecisionApplication) {
    setApplications((current) => current.map((item) => item.id === saved.id ? saved : item));
  }

  async function exportDecisions() {
    if (!selected || exporting) return;
    setExporting(true);
    try {
      const response = await fetch("/api/platform/exports/decisions", {
        method: "POST",
        headers: { accept: "text/csv", "content-type": "application/json" },
        body: JSON.stringify({ competitionId: selected.competitionId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "The decision export could not be created.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `minder-net-zero-decisions-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The decision export could not be created.");
      setState("error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="decision-layout">
      <aside className="decision-list">
        <div className="review-list-heading"><strong>Applications</strong><span>{applications.filter((item) => !item.finalDecision).length} undecided</span></div>
        {selected ? <button className="decision-export" type="button" onClick={() => void exportDecisions()} disabled={exporting}>{exporting ? "Preparing audited export…" : "Export decisions (CSV)"}</button> : null}
        {state === "loading" ? <p className="platform-muted decision-list-message">Loading decisions…</p> : null}
        {state === "error" ? <p className="platform-error">{message}</p> : null}
        {state === "ready" && applications.length === 0 ? <div className="platform-empty"><strong>No current applications</strong><p>An administrator must complete the central import first.</p></div> : null}
        {applications.map((application) => (
          <button
            key={application.id}
            type="button"
            className={selected?.id === application.id ? "decision-list-item active" : "decision-list-item"}
            onClick={() => setSelectedId(application.id)}
          >
            <span>{application.externalId}</span>
            <strong>{application.teamName || "Unnamed team"}</strong>
            <small>{application.finalDecision ? application.finalDecision.decision.replaceAll("_", " ") : "Awaiting decision"}</small>
          </button>
        ))}
      </aside>
      {selected ? (
        <section className="platform-card decision-detail">
          <div className="review-case-heading">
            <div><p className="eyebrow">Application {selected.externalId}</p><h2>{selected.teamName || "Unnamed team"}</h2><p>{selected.track || "General track"}</p></div>
            <span className={`review-state ${selected.finalDecision ? "review-state-submitted" : ""}`}>{selected.finalDecision ? `Revision ${selected.revision}` : "Undecided"}</span>
          </div>
          <div className="decision-evidence-grid">
            <article><span>Minder assessment</span><strong>{selected.assessment?.recommendation.replaceAll("_", " ") ?? "Not completed"}</strong><small>{selected.assessment?.score === null || selected.assessment?.score === undefined ? "No score" : `Score ${selected.assessment.score}`}</small></article>
            <article><span>Reviewer submissions</span><strong>{selected.reviewerSummary.submitted}</strong><small>{selected.reviewerSummary.progress} progress · {selected.reviewerSummary.doNotProgress} do not · {selected.reviewerSummary.humanReview} wider review</small></article>
            <article><span>Application state</span><strong>{selected.applicationStatus.replaceAll("_", " ")}</strong><small>Current central record</small></article>
          </div>
          <DecisionForm key={selected.id} application={selected} onSaved={onSaved} />
        </section>
      ) : null}
    </div>
  );
}
