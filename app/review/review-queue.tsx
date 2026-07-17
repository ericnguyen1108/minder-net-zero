"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { platformFetch } from "../platform-client.ts";

type ReviewDecision = "progress" | "do_not_progress" | "human_review";
type ReviewConfidence = "low" | "medium" | "high";
type Assignment = {
  id: string;
  revision: number;
  status: "assigned" | "in_progress" | "submitted";
  dueAt: string | null;
  application: {
    externalId: string;
    teamName: string;
    track: string;
    answers: Array<{ heading: string; value: string }>;
  };
  review: {
    decision: ReviewDecision;
    confidence: ReviewConfidence;
    notes: string;
    revision: number;
  } | null;
};

function initialDecision(assignment: Assignment): ReviewDecision {
  return assignment.review?.decision ?? "human_review";
}

function ReviewForm({
  assignment,
  onSaved,
}: {
  assignment: Assignment;
  onSaved: (assignment: Assignment) => void;
}) {
  const [decision, setDecision] = useState<ReviewDecision>(() => initialDecision(assignment));
  const [confidence, setConfidence] = useState<ReviewConfidence>(assignment.review?.confidence ?? "medium");
  const [notes, setNotes] = useState(assignment.review?.notes ?? "");
  const [baseRevision, setBaseRevision] = useState(assignment.revision);
  const [state, setState] = useState<"ready" | "saving" | "error" | "success">("ready");
  const [message, setMessage] = useState("");
  const stale = assignment.revision !== baseRevision;

  function restoreLatest() {
    setDecision(initialDecision(assignment));
    setConfidence(assignment.review?.confidence ?? "medium");
    setNotes(assignment.review?.notes ?? "");
    setBaseRevision(assignment.revision);
    setState("ready");
    setMessage("Latest saved review loaded.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stale) {
      setState("error");
      setMessage("A newer saved review exists. Load it before submitting your changes.");
      return;
    }
    setState("saving");
    setMessage("");
    try {
      const body = await platformFetch<{ assignment: Assignment }>(
        `/api/platform/reviews/${encodeURIComponent(assignment.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            expectedRevision: baseRevision,
            decision,
            confidence,
            notes,
          }),
        },
      );
      setBaseRevision(body.assignment.revision);
      setDecision(initialDecision(body.assignment));
      setConfidence(body.assignment.review?.confidence ?? "medium");
      setNotes(body.assignment.review?.notes ?? "");
      setState("success");
      setMessage("Review submitted and added to the central audit history.");
      onSaved(body.assignment);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The review could not be saved.");
    }
  }

  return (
    <form className="review-form" onSubmit={submit}>
      {stale ? (
        <div className="platform-warning" role="alert">
          <strong>This review changed in another signed-in session.</strong>
          <p>Your draft has not been overwritten. Load the latest saved version before continuing.</p>
          <button type="button" onClick={restoreLatest}>Load latest review</button>
        </div>
      ) : null}
      <fieldset>
        <legend>Your recommendation</legend>
        <label>
          <input
            type="radio"
            name="decision"
            value="progress"
            checked={decision === "progress"}
            onChange={() => setDecision("progress")}
            required
          />
          Progress
        </label>
        <label>
          <input
            type="radio"
            name="decision"
            value="do_not_progress"
            checked={decision === "do_not_progress"}
            onChange={() => setDecision("do_not_progress")}
          />
          Do not progress
        </label>
        <label>
          <input
            type="radio"
            name="decision"
            value="human_review"
            checked={decision === "human_review"}
            onChange={() => setDecision("human_review")}
          />
          Needs wider human review
        </label>
      </fieldset>
      <label>
        Confidence
        <select
          name="confidence"
          value={confidence}
          onChange={(event) => setConfidence(event.target.value as ReviewConfidence)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label>
        Reviewer notes
        <textarea
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Explain the evidence behind your recommendation. Do not add sensitive personal information."
          minLength={10}
          maxLength={10_000}
          required
        />
      </label>
      <div className="review-form-footer">
        <p>Minder records your identity and every revision. A decision approver remains responsible for the final outcome.</p>
        <button className="platform-primary" disabled={state === "saving" || stale}>
          {state === "saving"
            ? "Submitting…"
            : assignment.status === "submitted"
              ? "Submit revised review"
              : "Submit review"}
        </button>
      </div>
      {message ? (
        <p className={state === "error" ? "platform-error" : "platform-success"} role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export default function ReviewQueue() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const selected = useMemo(
    () => assignments.find((item) => item.id === selectedId) ?? assignments[0] ?? null,
    [assignments, selectedId],
  );

  const refresh = useCallback(async (initial = false) => {
    try {
      const body = await platformFetch<{ assignments: Assignment[] }>("/api/platform/reviews");
      setAssignments(body.assignments);
      setSelectedId((current) =>
        current && body.assignments.some((item) => item.id === current)
          ? current
          : body.assignments[0]?.id ?? null,
      );
      setState("ready");
      if (initial) setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The shared review queue could not be refreshed.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(true), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  function onSaved(saved: Assignment) {
    setAssignments((current) => current.map((item) => item.id === saved.id ? saved : item));
  }

  return (
    <div className="review-layout">
      <aside className="review-list">
        <div className="review-list-heading">
          <strong>Review queue</strong>
          <span>{assignments.filter((item) => item.status !== "submitted").length} remaining</span>
        </div>
        {state === "loading" ? (
          <p className="platform-muted">Loading assignments…</p>
        ) : assignments.length === 0 ? (
          <div className="platform-empty">
            <strong>You are up to date</strong>
            <p>No applications are assigned to your account.</p>
          </div>
        ) : assignments.map((assignment) => (
          <button
            type="button"
            key={assignment.id}
            className={selected?.id === assignment.id ? "review-list-item active" : "review-list-item"}
            onClick={() => { setSelectedId(assignment.id); setMessage(""); }}
          >
            <span>{assignment.application.externalId}</span>
            <strong>{assignment.application.teamName || "Identity withheld"}</strong>
            <small>{assignment.application.track || "General track"} · {assignment.status.replaceAll("_", " ")}</small>
          </button>
        ))}
        {state === "error" && message ? <p className="platform-error" role="status">{message}</p> : null}
      </aside>
      {selected ? (
        <section className="platform-card review-detail">
          <div className="review-case-heading">
            <div>
              <p className="eyebrow">Application {selected.application.externalId}</p>
              <h2>{selected.application.teamName || "Identity withheld for review"}</h2>
              <p>{selected.application.track || "General track"}</p>
            </div>
            <span className={`review-state review-state-${selected.status}`}>
              {selected.status.replaceAll("_", " ")}
            </span>
          </div>
          <div className="application-answers">
            {selected.application.answers.map((answer, index) => (
              <article key={`${answer.heading}-${index}`}>
                <h3>{answer.heading}</h3>
                <p>{answer.value}</p>
              </article>
            ))}
          </div>
          <ReviewForm key={selected.id} assignment={selected} onSaved={onSaved} />
        </section>
      ) : null}
    </div>
  );
}
