/**
 * Phase 6: final human decisions and export.
 *
 * Minder's cohort recommendations are provisional. This module records what an
 * authorised person actually decided per application and builds the CSV that
 * leaves the app. Decisions stay editable until the organiser is done — human
 * authority, not an immutable AI artifact — but every decision keeps who and
 * when.
 *
 * Storage is the Postgres pilot backend (POST /api/pilot), not the browser:
 *   - Decisions are workspace + application scoped, not run scoped. A human
 *     decision is about the application; the AI run is reference only, so a
 *     decision persists across re-runs. `runId` is kept in the signatures purely
 *     as a caller-side label and is not a storage key.
 *   - `decidedBy` (a display name) resolves server-side to a roster reviewer, so
 *     the stored attribution is a real reviewer, the same roster the Phase F
 *     dropdown will use. Load returns that reviewer's display name back.
 *   - Clearing a decision records it as `undecided` (kept in the append-only
 *     journal) rather than deleting; load hides `undecided`, so a cleared
 *     decision reads as absent.
 */

import { pilot } from "./pilot-client.ts";
import type { Phase5CohortRecommendation, Phase5StoredAssessment } from "./phase5-storage.ts";
import type { StoredCurrentIdentity } from "./current-data.ts";

export const FINAL_DECISION_VALUES = ["shortlist", "reject", "waitlist"] as const;
export type FinalDecisionValue = (typeof FINAL_DECISION_VALUES)[number];

export type FinalDecision = {
  runId: string;
  rowId: string;
  decision: FinalDecisionValue;
  decidedBy: string;
  decidedAt: string;
};

function isDecisionValue(value: unknown): value is FinalDecisionValue {
  return FINAL_DECISION_VALUES.includes(value as FinalDecisionValue);
}

export async function saveFinalDecision(decision: FinalDecision): Promise<void> {
  if (!decision.runId.trim() || !decision.rowId.trim()) {
    throw new Error("A final decision needs its run and application.");
  }
  if (!isDecisionValue(decision.decision)) {
    throw new Error("Only shortlist, reject or waitlist can be recorded.");
  }
  if (!decision.decidedBy.trim()) {
    throw new Error("A final decision must name the person who made it.");
  }
  await pilot("decisions.record", {
    applicationRowId: decision.rowId,
    decision: decision.decision,
    decidedByName: decision.decidedBy,
  });
}

// runId is workspace-scoped now (see the module header) and kept only for the
// legacy call signature; the application row identifies the decision.
export async function clearFinalDecision(
  runId: string,
  rowId: string,
  decidedBy = "",
): Promise<void> {
  await pilot("decisions.clear", {
    applicationRowId: rowId,
    ...(decidedBy.trim() ? { decidedByName: decidedBy.trim() } : {}),
  });
}

export async function loadFinalDecisions(runId: string): Promise<FinalDecision[]> {
  const rows = await pilot<
    { rowId: string; decision: FinalDecisionValue; decidedBy: string; decidedAt: string }[]
  >("decisions.load");
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => Boolean(row) && typeof row.rowId === "string" && isDecisionValue(row.decision))
    .map((row) => ({
      runId,
      rowId: row.rowId,
      decision: row.decision,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
    }));
}

/**
 * CSV escaping with a spreadsheet formula-injection guard: any field starting
 * with = + - @ or a control character is prefixed with a single quote so Excel
 * and Sheets treat it as text. Applicant-authored text is untrusted.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export type ResultsExportRow = {
  recommendation: Phase5CohortRecommendation;
  identity: StoredCurrentIdentity | null;
  assessment: Phase5StoredAssessment | null;
  decision: FinalDecision | null;
  humanRanking: {
    rank: number;
    totalScore: number;
    markCount: number;
    coverageComplete: boolean;
    rankingValid: boolean;
  } | null;
};

export const RESULTS_CSV_HEADER = [
  "application_id",
  "team_name",
  "track",
  "human_rank",
  "human_total_score",
  "human_review_count",
  "human_coverage_complete",
  "ai_reference_rank",
  "ai_reference_score",
  "ai_reference_recommendation",
  "ai_reference_reason",
  "human_review_reasons",
  "final_decision",
  "decided_by",
  "decided_at",
].join(",");

/**
 * Sorted for reading: ranked rows first by rank, then unranked by score, then
 * by application id — the same order as the on-screen table.
 */
export function sortResultsForExport(rows: readonly ResultsExportRow[]): ResultsExportRow[] {
  return [...rows].sort((left, right) => {
    const leftRank = left.humanRanking?.rankingValid
      ? left.humanRanking.rank
      : Number.POSITIVE_INFINITY;
    const rightRank = right.humanRanking?.rankingValid
      ? right.humanRanking.rank
      : Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftScore = left.humanRanking?.totalScore ?? -1;
    const rightScore = right.humanRanking?.totalScore ?? -1;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.recommendation.rowId.localeCompare(right.recommendation.rowId);
  });
}

export function buildResultsCsv(rows: readonly ResultsExportRow[]): string {
  const lines = [RESULTS_CSV_HEADER];
  for (const row of sortResultsForExport(rows)) {
    lines.push(
      [
        csvField(row.identity?.externalId || row.recommendation.rowId),
        csvField(row.identity?.teamName ?? ""),
        csvField(row.identity?.track ?? ""),
        csvField(row.humanRanking?.rankingValid ? row.humanRanking.rank : null),
        csvField(row.humanRanking?.totalScore),
        csvField(row.humanRanking?.markCount),
        csvField(row.humanRanking?.coverageComplete ? "yes" : "no"),
        csvField(row.recommendation.rank),
        csvField(row.recommendation.weightedScore),
        csvField(row.recommendation.recommendation),
        csvField(row.recommendation.reason),
        csvField((row.assessment?.humanReviewReasons ?? []).join(" | ")),
        csvField(row.decision?.decision ?? ""),
        csvField(row.decision?.decidedBy ?? ""),
        csvField(row.decision?.decidedAt ?? ""),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function resultsFileName(competitionName: string, timestamp: string): string {
  const safeName =
    competitionName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "minder-net-zero";
  return `${safeName}-results-${timestamp.slice(0, 10)}.csv`;
}
