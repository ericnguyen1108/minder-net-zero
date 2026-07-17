"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import styles from "./assignment-admin.module.css";

type CompetitionChoice = { id: string; name: string };
type Reviewer = { id: string; name: string; email: string };
type Application = {
  id: string;
  externalRef: string;
  teamName: string;
  track: string;
  status: "imported" | "eligible";
};
type Assignment = {
  id: string;
  applicationId: string;
  reviewer: Reviewer;
  round: number;
  status: "assigned" | "in_progress" | "submitted" | "reassigned" | "cancelled";
  blind: boolean;
  revision: number;
  assignedAt: string;
  dueAt: string | null;
};
type BoardData = {
  applications: Application[];
  reviewers: Reviewer[];
  assignments: Assignment[];
  generatedAt?: string;
};

const PAGE_SIZE = 50;
const ACTIVE_STATUSES = new Set<Assignment["status"]>(["assigned", "in_progress", "submitted"]);

async function responseMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  return typeof body?.error?.message === "string"
    ? body.error.message
    : "The assignment change could not be completed.";
}

export default function AssignmentAdmin({ competitions }: { competitions: CompetitionChoice[] }) {
  const [competitionId, setCompetitionId] = useState(competitions[0]?.id ?? "");
  const [data, setData] = useState<BoardData | null>(null);
  const [reviewerByApplication, setReviewerByApplication] = useState<Record<string, string>>({});
  const [blind, setBlind] = useState(true);
  const [dueDate, setDueDate] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(Boolean(competitionId));
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const loadBoard = useCallback(async (selectedCompetitionId: string, signal?: AbortSignal) => {
    if (!selectedCompetitionId) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/platform/assignments?competitionId=${encodeURIComponent(selectedCompetitionId)}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      const next = (await response.json()) as BoardData;
      if (!signal?.aborted) setData(next);
    } catch (error) {
      if (signal?.aborted) return;
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The assignment board could not be loaded.",
      });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadBoard(competitionId, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [competitionId, loadBoard]);

  const assignmentsByApplication = useMemo(() => {
    const grouped = new Map<string, Assignment[]>();
    for (const assignment of data?.assignments ?? []) {
      grouped.set(assignment.applicationId, [
        ...(grouped.get(assignment.applicationId) ?? []),
        assignment,
      ]);
    }
    return grouped;
  }, [data?.assignments]);

  const filteredApplications = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return data?.applications ?? [];
    return (data?.applications ?? []).filter((application) =>
      [application.externalRef, application.teamName, application.track]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [data?.applications, query]);

  const pageCount = Math.max(1, Math.ceil(filteredApplications.length / PAGE_SIZE));
  const visibleApplications = filteredApplications.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function refreshAfterConflict(message: string) {
    setNotice({ tone: "error", text: message });
    await loadBoard(competitionId);
  }

  async function assign(applicationId: string) {
    const reviewerUserId = reviewerByApplication[applicationId] ?? "";
    if (!reviewerUserId || !data || busyId) return;
    const prior = (assignmentsByApplication.get(applicationId) ?? []).find(
      (assignment) => assignment.reviewer.id === reviewerUserId && assignment.round === 1,
    );
    setBusyId(applicationId);
    setNotice(null);
    try {
      const response = await fetch("/api/platform/assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitionId,
          applicationId,
          reviewerUserId,
          round: 1,
          blind,
          dueAt: dueDate ? new Date(`${dueDate}T23:59:59.000Z`).toISOString() : null,
          expectedRevision:
            prior && (prior.status === "cancelled" || prior.status === "reassigned")
              ? prior.revision
              : null,
        }),
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        if (response.status === 409) {
          await refreshAfterConflict(message);
          return;
        }
        throw new Error(message);
      }
      const body = (await response.json()) as { assignment: Assignment };
      setData((current) =>
        current
          ? {
              ...current,
              assignments: [
                ...current.assignments.filter((item) => item.id !== body.assignment.id),
                body.assignment,
              ],
            }
          : current,
      );
      setReviewerByApplication((current) => ({ ...current, [applicationId]: "" }));
      setNotice({ tone: "ok", text: "Reviewer assigned. The shared queue is updated." });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The reviewer could not be assigned.",
      });
    } finally {
      setBusyId("");
    }
  }

  async function unassign(assignment: Assignment) {
    if (busyId || assignment.status === "submitted") return;
    if (!window.confirm(`Remove ${assignment.reviewer.name} from this application?`)) return;

    // Optimistically update the projection; the server still performs a CAS on
    // the revision. A conflict reloads the authoritative shared state.
    const previous = data;
    setBusyId(assignment.id);
    setNotice(null);
    setData((current) =>
      current
        ? {
            ...current,
            assignments: current.assignments.map((item) =>
              item.id === assignment.id
                ? { ...item, status: "cancelled", revision: item.revision + 1 }
                : item,
            ),
          }
        : current,
    );
    try {
      const response = await fetch("/api/platform/assignments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitionId,
          assignmentId: assignment.id,
          expectedRevision: assignment.revision,
          action: "unassign",
        }),
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        if (response.status === 409) {
          await refreshAfterConflict(message);
          return;
        }
        throw new Error(message);
      }
      const body = (await response.json()) as { assignment: Assignment };
      setData((current) =>
        current
          ? {
              ...current,
              assignments: current.assignments.map((item) =>
                item.id === body.assignment.id ? body.assignment : item,
              ),
            }
          : current,
      );
      setNotice({ tone: "ok", text: "Assignment removed. The audit record was preserved." });
    } catch (error) {
      setData(previous);
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The assignment could not be removed.",
      });
    } finally {
      setBusyId("");
    }
  }

  if (competitions.length === 0) {
    return (
      <main className={styles.shell}>
        <section className={styles.empty}>
          <h1>Reviewer assignments</h1>
          <p>Your account does not have assignment-management access for an active competition.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Production operations</p>
          <h1>Reviewer assignments</h1>
          <p>Assign applications to named reviewer accounts. Reviewers cannot assign work to themselves.</p>
        </div>
        <Link className={styles.backLink} href="/">Return to Minder</Link>
      </header>

      <section className={styles.controls} aria-label="Assignment filters">
        <label>
          Competition
          <select
            value={competitionId}
            onChange={(event) => {
              setData(null);
              setNotice(null);
              setPage(0);
              setReviewerByApplication({});
              setLoading(true);
              setCompetitionId(event.target.value);
            }}
          >
            {competitions.map((competition) => (
              <option key={competition.id} value={competition.id}>{competition.name}</option>
            ))}
          </select>
        </label>
        <label>
          Find an application
          <input
            type="search"
            value={query}
            placeholder="Application ID, team or track"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          Due date (UTC, optional)
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} />
          Hide team identity from reviewer
        </label>
      </section>

      {notice ? (
        <p className={notice.tone === "ok" ? styles.success : styles.error} role="status">
          {notice.text}
        </p>
      ) : null}

      <section className={styles.board} aria-busy={loading}>
        <div className={styles.boardHeading}>
          <div>
            <h2>Applications</h2>
            <p>{filteredApplications.length.toLocaleString()} matching records</p>
          </div>
          <button type="button" onClick={() => void loadBoard(competitionId)} disabled={loading || Boolean(busyId)}>
            {loading ? "Refreshing…" : "Refresh shared state"}
          </button>
        </div>

        {loading && !data ? <p className={styles.loading}>Loading the shared assignment board…</p> : null}
        {!loading && data?.applications.length === 0 ? (
          <p className={styles.loading}>No assignable applications have been imported yet.</p>
        ) : null}

        <div className={styles.applicationList}>
          {visibleApplications.map((application) => {
            const history = assignmentsByApplication.get(application.id) ?? [];
            const active = history.filter((assignment) => ACTIVE_STATUSES.has(assignment.status));
            const selectedReviewer = reviewerByApplication[application.id] ?? "";
            return (
              <article className={styles.application} key={application.id}>
                <div className={styles.applicationIdentity}>
                  <strong>{application.externalRef}</strong>
                  <span>{application.teamName || "Team name unavailable"}</span>
                  <small>{application.track || "No track"}</small>
                </div>
                <div className={styles.assignmentList}>
                  {active.length === 0 ? <span className={styles.unassigned}>Unassigned</span> : null}
                  {active.map((assignment) => (
                    <span className={styles.assignmentPill} key={assignment.id}>
                      <span>
                        <strong>{assignment.reviewer.name}</strong>
                        <small>{assignment.status.replaceAll("_", " ")} · revision {assignment.revision}</small>
                      </span>
                      {assignment.status === "submitted" ? (
                        <em title="Submitted reviews remain in the permanent audit record">Locked</em>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(busyId)}
                          onClick={() => void unassign(assignment)}
                          aria-label={`Unassign ${assignment.reviewer.name}`}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                <div className={styles.assignAction}>
                  <select
                    aria-label={`Reviewer for ${application.externalRef}`}
                    value={selectedReviewer}
                    disabled={Boolean(busyId) || (data?.reviewers.length ?? 0) === 0}
                    onChange={(event) =>
                      setReviewerByApplication((current) => ({
                        ...current,
                        [application.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose reviewer</option>
                    {(data?.reviewers ?? []).map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>{reviewer.name} · {reviewer.email}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!selectedReviewer || Boolean(busyId)}
                    onClick={() => void assign(application.id)}
                  >
                    {busyId === application.id ? "Assigning…" : "Assign"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {filteredApplications.length > PAGE_SIZE ? (
          <nav className={styles.pagination} aria-label="Application pages">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button>
            <span>Page {page + 1} of {pageCount}</span>
            <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</button>
          </nav>
        ) : null}
      </section>
    </main>
  );
}
