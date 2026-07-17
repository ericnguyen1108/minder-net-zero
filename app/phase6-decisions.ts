/**
 * Phase 6: final human decisions and export.
 *
 * Minder's cohort recommendations are provisional. This module records what an
 * authorised person actually decided per application, keyed to the exact run
 * that produced the recommendation, and builds the CSV that leaves the app.
 * Decisions stay editable until the organiser is done — human authority, not
 * an immutable AI artifact — but every decision keeps who and when.
 */

import { FINAL_DECISIONS_STORE, openDatabase, transactionComplete } from "./historical-data.ts";
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
  const database = await openDatabase();
  try {
    const transaction = database.transaction([FINAL_DECISIONS_STORE], "readwrite");
    transaction.objectStore(FINAL_DECISIONS_STORE).put({ ...decision });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function clearFinalDecision(runId: string, rowId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([FINAL_DECISIONS_STORE], "readwrite");
    transaction.objectStore(FINAL_DECISIONS_STORE).delete([runId, rowId]);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadFinalDecisions(runId: string): Promise<FinalDecision[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([FINAL_DECISIONS_STORE], "readonly");
    const request = transaction
      .objectStore(FINAL_DECISIONS_STORE)
      .index("runId")
      .getAll(IDBKeyRange.only(runId));
    return await new Promise<FinalDecision[]>((resolve, reject) => {
      request.onsuccess = () => {
        const rows = Array.isArray(request.result) ? request.result : [];
        resolve(
          rows.filter(
            (row): row is FinalDecision =>
              Boolean(row) &&
              typeof (row as FinalDecision).rowId === "string" &&
              isDecisionValue((row as FinalDecision).decision),
          ),
        );
      };
      request.onerror = () => reject(request.error ?? new Error("Saved decisions could not be read."));
    });
  } finally {
    database.close();
  }
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
};

export const RESULTS_CSV_HEADER = [
  "application_id",
  "team_name",
  "track",
  "rank",
  "weighted_score",
  "minder_recommendation",
  "recommendation_reason",
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
    const leftRank = left.recommendation.rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.recommendation.rank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftScore = left.recommendation.weightedScore ?? -1;
    const rightScore = right.recommendation.weightedScore ?? -1;
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
