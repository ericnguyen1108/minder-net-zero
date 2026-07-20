/**
 * Phase F client boundary for human marking.
 *
 * Human scores and the final ranking live in the netzero schema. AI reference
 * output is loaded through a separate action/view and never participates in
 * these calculations. All identifiers are selected from server-owned roster,
 * guide and active-dataset records rather than typed into mark requests.
 */

import { pilot } from "./pilot-client.ts";

export type PilotReviewer = { id: string; displayName: string; active: boolean };

export type PilotApprovedGuide = {
  guideVersionId: string;
  version: number;
  contentHash: string;
  selectionMode: "top_n" | "minimum_score" | "both";
  shortlistTarget: number | null;
  minimumScore: number | null;
  criteria: Array<{ ruleId: string; title: string; weight: number; position: number }>;
};

export type PilotMarkSet = {
  applicationRowId: string;
  reviewerId: string;
  guideVersionId: string;
  status: "draft" | "submitted";
  weightedScore: number | null;
  scores: Record<string, number>;
};

export type PilotRankingRow = {
  rowId: string;
  totalScore: number;
  markCount: number;
  coverageComplete: boolean;
  rankingValid: boolean;
  rank: number;
};

export type PilotAiReference = {
  rowId: string;
  aiWeightedScore: number | null;
  aiRecommendation: string;
  evidenceValid: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function listPilotReviewers(): Promise<PilotReviewer[]> {
  const rows = await pilot<unknown>("reviewers.list");
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is PilotReviewer =>
          isRecord(row) &&
          typeof row.id === "string" &&
          typeof row.displayName === "string" &&
          typeof row.active === "boolean",
      )
    : [];
}

export async function addPilotReviewer(displayName: string): Promise<PilotReviewer> {
  const name = displayName.trim();
  if (!name || name.length > 120) {
    throw new Error("Enter a reviewer name between 1 and 120 characters.");
  }
  return pilot<PilotReviewer>("reviewers.add", { displayName: name });
}

export async function setPilotReviewerActive(reviewerId: string, active: boolean): Promise<void> {
  if (!reviewerId) throw new Error("Choose a reviewer first.");
  await pilot("reviewers.setActive", { reviewerId, active });
}

export async function syncPilotApprovedGuide(
  guide: unknown,
  contentHash: string,
): Promise<PilotApprovedGuide> {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("The passed practice-test guide receipt is missing or invalid.");
  }
  return pilot<PilotApprovedGuide>("guide.syncApproved", { guide, contentHash });
}

export async function loadPilotMarkSets(): Promise<PilotMarkSet[]> {
  const rows = await pilot<unknown>("marks.load");
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is PilotMarkSet =>
          isRecord(row) &&
          typeof row.applicationRowId === "string" &&
          typeof row.reviewerId === "string" &&
          typeof row.guideVersionId === "string" &&
          (row.status === "draft" || row.status === "submitted") &&
          isRecord(row.scores),
      )
    : [];
}

export async function savePilotMark(input: {
  applicationRowId: string;
  reviewerId: string;
  guideVersionId: string;
  ruleId: string;
  score: number;
}): Promise<void> {
  if (
    !input.applicationRowId ||
    !input.reviewerId ||
    !input.guideVersionId ||
    !input.ruleId ||
    !Number.isInteger(input.score) ||
    input.score < 1 ||
    input.score > 5
  ) {
    throw new Error("Choose one score from 1 to 5 for a valid reviewer, application and criterion.");
  }
  await pilot("marks.upsert", input);
}

export async function submitPilotMarkSet(
  applicationRowId: string,
  reviewerId: string,
  guideVersionId: string,
): Promise<{ weightedScore: number }> {
  if (!applicationRowId || !reviewerId || !guideVersionId) {
    throw new Error("Choose a reviewer, application and approved guide first.");
  }
  return pilot("marks.submit", { applicationRowId, reviewerId, guideVersionId });
}

export async function loadPilotRanking(): Promise<PilotRankingRow[]> {
  const rows = await pilot<unknown>("ranking.load");
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is PilotRankingRow =>
          isRecord(row) &&
          typeof row.rowId === "string" &&
          typeof row.totalScore === "number" &&
          typeof row.markCount === "number" &&
          typeof row.coverageComplete === "boolean" &&
          typeof row.rankingValid === "boolean" &&
          typeof row.rank === "number",
      )
    : [];
}

export async function loadPilotAiReference(): Promise<PilotAiReference[]> {
  const rows = await pilot<unknown>("ai.reference");
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is PilotAiReference =>
          isRecord(row) &&
          typeof row.rowId === "string" &&
          (row.aiWeightedScore === null || typeof row.aiWeightedScore === "number") &&
          typeof row.aiRecommendation === "string" &&
          typeof row.evidenceValid === "boolean",
      )
    : [];
}

export function humanRankingIsReady(
  ranking: readonly PilotRankingRow[],
  applicationRowIds: readonly string[],
): boolean {
  if (applicationRowIds.length === 0 || ranking.length !== applicationRowIds.length) return false;
  const expected = new Set(applicationRowIds);
  return ranking.every(
    (row) => expected.delete(row.rowId) && row.coverageComplete && row.rankingValid,
  ) && expected.size === 0;
}
