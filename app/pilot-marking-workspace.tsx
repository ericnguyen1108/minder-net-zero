"use client";

import { useEffect, useMemo, useState } from "react";
import type { SafeCurrentCase, StoredCurrentIdentity } from "./current-data.ts";
import type { Phase5FullGuide } from "./phase5.tsx";
import {
  addPilotReviewer,
  humanRankingIsReady,
  listPilotReviewers,
  loadPilotAiReference,
  loadPilotMarkSets,
  loadPilotRanking,
  savePilotMark,
  setPilotReviewerActive,
  submitPilotMarkSet,
  syncPilotApprovedGuide,
} from "./pilot-marking.ts";
import type {
  PilotAiReference,
  PilotApprovedGuide,
  PilotMarkSet,
  PilotRankingRow,
  PilotReviewer,
} from "./pilot-marking.ts";

export default function PilotMarkingWorkspace({
  cases,
  identities,
  guide,
  guideContentHash,
  referenceRevision,
  onRosterChange,
  onRankingChange,
}: {
  cases: SafeCurrentCase[];
  identities: StoredCurrentIdentity[];
  guide: Phase5FullGuide;
  guideContentHash: string;
  referenceRevision: number;
  onRosterChange: (reviewers: PilotReviewer[]) => void;
  onRankingChange: (ranking: PilotRankingRow[], ready: boolean) => void;
}) {
  const [reviewers, setReviewers] = useState<PilotReviewer[]>([]);
  const [approvedGuide, setApprovedGuide] = useState<PilotApprovedGuide | null>(null);
  const [markSets, setMarkSets] = useState<PilotMarkSet[]>([]);
  const [ranking, setRanking] = useState<PilotRankingRow[]>([]);
  const [aiReference, setAiReference] = useState<PilotAiReference[]>([]);
  const [selectedReviewerId, setSelectedReviewerId] = useState("");
  const [selectedRowId, setSelectedRowId] = useState("");
  const [newReviewerName, setNewReviewerName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const activeReviewers = useMemo(() => reviewers.filter((reviewer) => reviewer.active), [reviewers]);
  const identityByRowId = useMemo(
    () => new Map(identities.map((identity) => [identity.rowId, identity])),
    [identities],
  );
  const caseByRowId = useMemo(() => new Map(cases.map((item) => [item.rowId, item])), [cases]);
  const aiByRowId = useMemo(
    () => new Map(aiReference.map((reference) => [reference.rowId, reference])),
    [aiReference],
  );
  const selectedCase = caseByRowId.get(selectedRowId) ?? cases[0] ?? null;
  const selectedIdentity = selectedCase ? identityByRowId.get(selectedCase.rowId) ?? null : null;
  const selectedMarkSet = markSets.find(
    (markSet) =>
      markSet.applicationRowId === selectedCase?.rowId &&
      markSet.reviewerId === selectedReviewerId,
  );
  const rankingReady = humanRankingIsReady(ranking, cases.map((item) => item.rowId));
  const submittedCount = markSets.filter(
    (markSet) =>
      markSet.status === "submitted" && activeReviewers.some((reviewer) => reviewer.id === markSet.reviewerId),
  ).length;
  const requiredCount = activeReviewers.length * cases.length;

  useEffect(() => {
    onRosterChange(reviewers);
  }, [onRosterChange, reviewers]);

  useEffect(() => {
    onRankingChange(ranking, rankingReady);
  }, [onRankingChange, ranking, rankingReady]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const centralGuide = await syncPilotApprovedGuide(guide, guideContentHash);
        const [loadedReviewers, loadedMarkSets, loadedRanking, loadedReference] = await Promise.all([
          listPilotReviewers(),
          loadPilotMarkSets(),
          loadPilotRanking(),
          loadPilotAiReference(),
        ]);
        if (!active) return;
        setApprovedGuide(centralGuide);
        setReviewers(loadedReviewers);
        setMarkSets(loadedMarkSets);
        setRanking(loadedRanking);
        setAiReference(loadedReference);
        setSelectedReviewerId((current) =>
          loadedReviewers.some((reviewer) => reviewer.id === current && reviewer.active)
            ? current
            : loadedReviewers.find((reviewer) => reviewer.active)?.id ?? "",
        );
        setSelectedRowId((current) =>
          cases.some((item) => item.rowId === current) ? current : cases[0]?.rowId ?? "",
        );
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "The human marking workspace could not be verified.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [cases, guide, guideContentHash]);

  useEffect(() => {
    let active = true;
    void loadPilotAiReference()
      .then((loaded) => {
        if (active) setAiReference(loaded);
      })
      .catch(() => {
        // The main workspace load owns actionable errors. A reference refresh
        // never blocks human marking because AI is explicitly non-authoritative.
      });
    return () => {
      active = false;
    };
  }, [referenceRevision]);

  async function refreshMarking() {
    const [loadedMarkSets, loadedRanking, loadedReference] = await Promise.all([
      loadPilotMarkSets(),
      loadPilotRanking(),
      loadPilotAiReference(),
    ]);
    setMarkSets(loadedMarkSets);
    setRanking(loadedRanking);
    setAiReference(loadedReference);
  }

  async function addReviewer() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await addPilotReviewer(newReviewerName);
      const loaded = await listPilotReviewers();
      setReviewers(loaded);
      setSelectedReviewerId(created.id);
      setNewReviewerName("");
      await refreshMarking();
      setNotice(`${created.displayName} is now required to mark every application.`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "The reviewer could not be added.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleReviewer(reviewer: PilotReviewer) {
    if (busy) return;
    const nextActive = !reviewer.active;
    if (
      !nextActive &&
      !window.confirm(
        `${reviewer.displayName}'s submitted scores will stop counting in the human ranking. Keep them inactive?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await setPilotReviewerActive(reviewer.id, nextActive);
      const loaded = await listPilotReviewers();
      setReviewers(loaded);
      if (!nextActive && selectedReviewerId === reviewer.id) {
        setSelectedReviewerId(loaded.find((item) => item.active)?.id ?? "");
      }
      await refreshMarking();
      setNotice(
        nextActive
          ? `${reviewer.displayName} is now required to mark every application.`
          : `${reviewer.displayName} no longer counts in coverage or ranking.`,
      );
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "The reviewer roster was not changed.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseScore(ruleId: string, score: number) {
    if (!selectedCase || !selectedReviewerId || !approvedGuide || selectedMarkSet?.status === "submitted") {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await savePilotMark({
        applicationRowId: selectedCase.rowId,
        reviewerId: selectedReviewerId,
        guideVersionId: approvedGuide.guideVersionId,
        ruleId,
        score,
      });
      setMarkSets(await loadPilotMarkSets());
      setNotice("Draft score saved centrally.");
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : "The score was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitMarks() {
    if (!selectedCase || !selectedReviewerId || !approvedGuide || busy) return;
    const complete = approvedGuide.criteria.every(
      (criterion) => Number.isInteger(selectedMarkSet?.scores[criterion.ruleId]),
    );
    if (!complete) {
      setError("Score every criterion from 1 to 5 before submitting.");
      return;
    }
    if (
      !window.confirm(
        "Submit and freeze this review? Its criterion scores cannot be edited afterwards.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const submitted = await submitPilotMarkSet(
        selectedCase.rowId,
        selectedReviewerId,
        approvedGuide.guideVersionId,
      );
      await refreshMarking();
      setNotice(`Review submitted with a derived weighted score of ${submitted.weightedScore}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The review was not submitted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="phase5-card phase-f-marking" aria-labelledby="human-marking-title">
      <div className="phase4-card-heading">
        <div>
          <span className="section-kicker">Human marking · authoritative ranking</span>
          <h3 id="human-marking-title">Score every application independently</h3>
          <p>
            Each active reviewer uses the same approved criteria. PostgreSQL derives every weighted
            score and the combined ranking uses human marks only.
          </p>
        </div>
        <span className={`phase4-status-badge ${rankingReady ? "safe" : "warning"}`}>
          {rankingReady ? "Human ranking complete" : `${submittedCount}/${requiredCount} reviews submitted`}
        </span>
      </div>

      <div className="phase-f-separation-note">
        <strong>AI cannot enter this ranking.</strong>
        <span>
          The AI column below is reference-only and comes from a physically separate database view.
          It is never added to a reviewer score.
        </span>
      </div>

      {loading ? <p className="phase4-note">Verifying the reviewer roster and approved guide…</p> : null}
      {error ? <div className="phase4-error" role="alert"><strong>Stopped safely</strong><span>{error}</span></div> : null}
      {notice && !error ? <div className="phase5-retry-notice" role="status"><strong>Saved</strong><span>{notice}</span></div> : null}

      <details className="phase-f-roster" open={activeReviewers.length === 0}>
        <summary>Reviewer roster · {activeReviewers.length} required marker{activeReviewers.length === 1 ? "" : "s"}</summary>
        <p>Adding or activating a reviewer makes their submitted mark required on every application before ranking is valid.</p>
        <div className="phase-f-add-reviewer">
          <label>
            <span>Reviewer name</span>
            <input
              value={newReviewerName}
              maxLength={120}
              onChange={(event) => setNewReviewerName(event.target.value)}
              placeholder="Full name"
            />
          </label>
          <button className="secondary-button" type="button" disabled={busy || !newReviewerName.trim()} onClick={() => void addReviewer()}>
            Add required reviewer
          </button>
        </div>
        <div className="phase-f-roster-list">
          {reviewers.map((reviewer) => (
            <div key={reviewer.id}>
              <span><strong>{reviewer.displayName}</strong><small>{reviewer.active ? "Required marker" : "Decision-only / inactive"}</small></span>
              <button className="quiet-button" type="button" disabled={busy} onClick={() => void toggleReviewer(reviewer)}>
                {reviewer.active ? "Make inactive" : "Require marking"}
              </button>
            </div>
          ))}
        </div>
      </details>

      {activeReviewers.length > 0 && approvedGuide ? (
        <div className="phase-f-workbench">
          <div className="phase-f-workbench-controls">
            <label>
              <span>Who is marking?</span>
              <select value={selectedReviewerId} onChange={(event) => setSelectedReviewerId(event.target.value)} disabled={busy}>
                {activeReviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.displayName}</option>)}
              </select>
            </label>
            <label>
              <span>Application</span>
              <select value={selectedCase?.rowId ?? ""} onChange={(event) => setSelectedRowId(event.target.value)} disabled={busy}>
                {cases.map((item, index) => {
                  const identity = identityByRowId.get(item.rowId);
                  const markSet = markSets.find(
                    (saved) => saved.applicationRowId === item.rowId && saved.reviewerId === selectedReviewerId,
                  );
                  return <option key={item.rowId} value={item.rowId}>{index + 1}. {identity?.teamName || identity?.externalId || "Application"} · {markSet?.status ?? "not started"}</option>;
                })}
              </select>
            </label>
          </div>

          {selectedCase ? (
            <article className="phase-f-review-card">
              <header>
                <div><span>{selectedIdentity?.externalId || "Application"}</span><h4>{selectedIdentity?.teamName || "Unnamed application"}</h4><small>{selectedIdentity?.track || "No track"}</small></div>
                <span className={`phase4-status-badge ${selectedMarkSet?.status === "submitted" ? "safe" : "warning"}`}>{selectedMarkSet?.status ?? "Not started"}</span>
              </header>
              <details className="phase-f-source-answers">
                <summary>Read the submitted answers</summary>
                {selectedCase.answers.map((answer, index) => <div key={`${answer.heading}-${index}`}><strong>{answer.heading}</strong><p>{answer.value}</p></div>)}
              </details>
              <div className="phase-f-criteria">
                {guide.rules.filter((rule) => rule.kind === "criterion").map((rule) => (
                  <fieldset key={rule.id} disabled={busy || selectedMarkSet?.status === "submitted"}>
                    <legend><span>{rule.title}</span><em>{rule.weight}%</em></legend>
                    <p>{rule.statement}</p>
                    <div className="phase-f-anchors"><span><b>1</b>{rule.anchor1}</span><span><b>3</b>{rule.anchor3}</span><span><b>5</b>{rule.anchor5}</span></div>
                    <label>
                      <span>Score</span>
                      <select
                        aria-label={`${rule.title} score`}
                        value={selectedMarkSet?.scores[rule.id] ?? ""}
                        onChange={(event) => void chooseScore(rule.id, Number(event.target.value))}
                      >
                        <option value="">Choose 1–5</option>
                        {[1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score}</option>)}
                      </select>
                    </label>
                  </fieldset>
                ))}
              </div>
              <div className="phase-f-submit-row">
                <span>{selectedMarkSet?.weightedScore === null || selectedMarkSet?.weightedScore === undefined ? "Complete every criterion to calculate the score." : `Database-derived weighted score: ${selectedMarkSet.weightedScore}`}</span>
                <button className="primary-button" type="button" disabled={busy || selectedMarkSet?.status === "submitted"} onClick={() => void submitMarks()}>
                  {selectedMarkSet?.status === "submitted" ? "Review frozen" : "Submit and freeze review"}
                </button>
              </div>
            </article>
          ) : null}
        </div>
      ) : null}

      <div className="phase-f-ranking-wrap">
        <div><h4>Combined human ranking</h4><p>{rankingReady ? "Every active reviewer has marked every application." : "Ranking remains locked until coverage is complete."}</p></div>
        <div className="phase5-results-table-wrap">
          <table className="phase5-results-table">
            <thead><tr><th>Human rank</th><th>Application</th><th>Human total</th><th>Coverage</th><th>AI reference · not counted</th></tr></thead>
            <tbody>
              {ranking.map((row) => {
                const identity = identityByRowId.get(row.rowId);
                const reference = aiByRowId.get(row.rowId);
                return <tr key={row.rowId}>
                  <td>{rankingReady ? row.rank : "—"}</td>
                  <td><strong>{identity?.teamName || identity?.externalId || "Application"}</strong><small>{identity?.externalId}</small></td>
                  <td>{row.totalScore}</td>
                  <td>{row.coverageComplete ? `${row.markCount}/${activeReviewers.length}` : `${row.markCount}/${activeReviewers.length} incomplete`}</td>
                  <td>{reference ? `${reference.aiRecommendation.replaceAll("_", " ")} · ${reference.aiWeightedScore ?? "no score"}` : "No AI reference"}</td>
                </tr>;
              })}
              {!loading && ranking.length === 0 ? <tr><td colSpan={5}>Add at least one required reviewer to begin human marking.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
