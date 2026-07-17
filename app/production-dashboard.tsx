"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { platformFetch } from "./platform-client.ts";
import PlatformPage from "./platform-page.tsx";

type CompetitionOverview = {
  id: string;
  name: string;
  description: string;
  status: string;
  roles: string[];
  permissions: string[];
  guideApproved: boolean;
  historicalDataReady: boolean;
  currentDataReady: boolean;
  applications: number;
  assignments: number;
  submittedReviews: number;
  completedAssessmentRuns: number;
  finalDecisions: number;
};

type OverviewResponse = {
  user: { id: string; displayName: string };
  competitions: CompetitionOverview[];
};

function Status({ complete, children }: { complete: boolean; children: React.ReactNode }) {
  return <span className={complete ? "journey-status complete" : "journey-status"}>{complete ? "Complete" : children}</span>;
}

export default function ProductionDashboard() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [readiness, setReadiness] = useState<"checking" | "ready" | "not_ready">("checking");

  const competition = useMemo(
    () => overview?.competitions.find((item) => item.id === selectedId) ?? overview?.competitions[0] ?? null,
    [overview, selectedId],
  );

  useEffect(() => {
    let active = true;
    void platformFetch<OverviewResponse>("/api/platform/overview")
      .then((body) => {
        if (!active) return;
        setOverview(body);
        setSelectedId(body.competitions[0]?.id ?? null);
        setState("ready");
      })
      .catch((error: Error) => {
        if (!active) return;
        setMessage(error.message);
        setState("error");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!competition) return;
    const administrator = competition.roles.includes("owner") || competition.roles.includes("competition_admin");
    if (!administrator) return;
    void fetch("/api/health/ready", { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => setReadiness(response.ok ? "ready" : "not_ready"))
      .catch(() => setReadiness("not_ready"));
  }, [competition]);

  if (state === "loading") {
    return (
      <PlatformPage eyebrow="Shared workspace" title="Loading your competition…" description="Verifying your account and central data access.">
        <section className="platform-card dashboard-loading">Securely loading…</section>
      </PlatformPage>
    );
  }

  if (state === "error") {
    return (
      <PlatformPage eyebrow="Shared workspace" title="Workspace unavailable" description="Your account is signed in, but the central workspace could not be loaded.">
        <section className="platform-card dashboard-loading"><p className="platform-error">{message}</p></section>
      </PlatformPage>
    );
  }

  if (!competition) {
    return (
      <PlatformPage eyebrow="Shared workspace" title="No competition assigned" description="Ask the Minder administrator to finish the one-time competition setup for this account.">
        <section className="platform-card dashboard-loading">No candidate data has been loaded.</section>
      </PlatformPage>
    );
  }

  const permission = (value: string) => competition.permissions.includes(value);
  const allReviewsComplete = competition.assignments > 0 && competition.submittedReviews === competition.assignments;
  const allDecisionsComplete = competition.applications > 0 && competition.finalDecisions === competition.applications;

  return (
    <PlatformPage
      eyebrow="Competition control centre"
      title={competition.name}
      description={competition.description || "One shared, accountable workspace for every organiser and reviewer."}
    >
      <section className="dashboard-summary-grid" aria-label="Competition summary">
        <article className="platform-card dashboard-stat"><span>Applications</span><strong>{competition.applications}</strong><small>in the central database</small></article>
        <article className="platform-card dashboard-stat"><span>Assigned reviews</span><strong>{competition.submittedReviews}/{competition.assignments}</strong><small>submitted and revisioned</small></article>
        <article className="platform-card dashboard-stat"><span>Final decisions</span><strong>{competition.finalDecisions}</strong><small>recorded by approvers</small></article>
        <article className="platform-card dashboard-stat"><span>Platform</span><strong className={`readiness-${readiness}`}>{readiness === "ready" ? "Ready" : readiness === "not_ready" ? "Attention" : "Protected"}</strong><small>{readiness === "not_ready" ? "administrator check required" : "individual accounts and audit active"}</small></article>
      </section>

      <section className="platform-card dashboard-journey">
        <div className="platform-card-heading">
          <div><p className="eyebrow">Controlled journey</p><h2>Competition readiness</h2></div>
          <span>{competition.status.replaceAll("_", " ")}</span>
        </div>
        <div className="journey-list">
          <article><b>1</b><div><strong>Decision Guide</strong><p>Approved rules, rubric, selection and elimination logic.</p></div><Status complete={competition.guideApproved}>Needs approval</Status></article>
          <article><b>2</b><div><strong>Historical calibration</strong><p>Past examples remain separate from current applicants.</p></div><Status complete={competition.historicalDataReady}>Not imported</Status></article>
          <article><b>3</b><div><strong>Current applications</strong><p>Identity and answer text are centrally separated.</p></div><Status complete={competition.currentDataReady}>{permission("application.import") ? "Ready to import" : "Waiting for admin"}</Status></article>
          <article><b>4</b><div><strong>AI assessment</strong><p>Runs only against locked, approved evidence controls.</p></div><Status complete={competition.completedAssessmentRuns > 0}>Not run</Status></article>
          <article><b>5</b><div><strong>Independent review</strong><p>Each reviewer sees only their assigned applications.</p></div><Status complete={allReviewsComplete}>{competition.assignments ? "In progress" : "Not assigned"}</Status></article>
          <article><b>6</b><div><strong>Human decision</strong><p>Authorised people remain responsible for every outcome.</p></div><Status complete={allDecisionsComplete}>Pending</Status></article>
        </div>
      </section>

      <section className="dashboard-actions" aria-label="Workspace actions">
        {permission("rubric.read") ? <Link className="platform-card dashboard-action" href="/guide"><strong>Decision Guide</strong><span>Define, review and approve the exact rubric AI may use →</span></Link> : null}
        {permission("application.import") ? <Link className="platform-card dashboard-action" href="/applications"><strong>Import applications</strong><span>Validate and lock the organiser file centrally →</span></Link> : null}
        {permission("review.assign") ? <Link className="platform-card dashboard-action" href="/admin/assignments"><strong>Assign reviewers</strong><span>Allocate applications without exposing the full cohort →</span></Link> : null}
        {permission("review.read_assigned") || permission("review.read_all") ? <Link className="platform-card dashboard-action" href="/review"><strong>Open my review queue</strong><span>Review evidence and submit an accountable recommendation →</span></Link> : null}
        {permission("decision.read") ? <Link className="platform-card dashboard-action" href="/decisions"><strong>Final decisions</strong><span>Record the authorised human outcome and every revision →</span></Link> : null}
        {permission("membership.read") ? <Link className="platform-card dashboard-action" href="/team"><strong>Team and roles</strong><span>Invite people and keep access least-privileged →</span></Link> : null}
        {permission("audit.read") ? <Link className="platform-card dashboard-action" href="/audit"><strong>Central audit history</strong><span>Inspect who changed what and when →</span></Link> : null}
      </section>
    </PlatformPage>
  );
}
