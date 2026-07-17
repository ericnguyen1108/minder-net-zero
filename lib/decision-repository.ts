import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  applicantIdentities,
  applications,
  assessmentResults,
  datasets,
  finalDecisionRevisions,
  reviewerReviews,
} from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import type { ServerPrincipal } from "./auth/context.ts";

export type FinalDecisionCode = "shortlist" | "reject" | "waitlist" | "needs_more_review";

export type DecisionApplicationDto = {
  id: string;
  competitionId: string;
  externalId: string;
  teamName: string;
  track: string;
  applicationStatus: string;
  assessment: { recommendation: string; score: number | null } | null;
  reviewerSummary: {
    submitted: number;
    progress: number;
    doNotProgress: number;
    humanReview: number;
  };
  finalDecision: {
    decision: FinalDecisionCode;
    rationale: string;
    revision: number;
    decidedAt: string;
  } | null;
  revision: number;
};

function identityText(identity: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return "";
}

function decisionCode(value: string): FinalDecisionCode {
  if (value === "shortlist" || value === "reject" || value === "waitlist") return value;
  return "needs_more_review";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableValue(value))),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listDecisionApplications(
  transaction: TenantTransaction,
  principal: ServerPrincipal,
): Promise<DecisionApplicationDto[]> {
  const rows = await transaction
    .select({ application: applications, identity: applicantIdentities })
    .from(applications)
    .innerJoin(
      datasets,
      and(
        eq(datasets.tenantId, applications.tenantId),
        eq(datasets.competitionId, applications.competitionId),
        eq(datasets.id, applications.datasetId),
        eq(datasets.kind, "current"),
      ),
    )
    .innerJoin(
      applicantIdentities,
      and(
        eq(applicantIdentities.tenantId, applications.tenantId),
        eq(applicantIdentities.competitionId, applications.competitionId),
        eq(applicantIdentities.id, applications.identityId),
      ),
    )
    .where(
      and(
        eq(applications.tenantId, principal.organizationId),
        eq(applications.competitionId, principal.competitionId),
        ne(applications.status, "deleted"),
      ),
    )
    .orderBy(asc(applications.externalRef))
    .limit(10_000);

  const ids = rows.map((row) => row.application.id);
  const [decisionRows, reviewRows, resultRows] = ids.length
    ? await Promise.all([
        transaction
          .select()
          .from(finalDecisionRevisions)
          .where(
            and(
              eq(finalDecisionRevisions.tenantId, principal.organizationId),
              eq(finalDecisionRevisions.competitionId, principal.competitionId),
              inArray(finalDecisionRevisions.applicationId, ids),
            ),
          )
          .orderBy(desc(finalDecisionRevisions.revision)),
        transaction
          .select()
          .from(reviewerReviews)
          .where(
            and(
              eq(reviewerReviews.tenantId, principal.organizationId),
              eq(reviewerReviews.competitionId, principal.competitionId),
              eq(reviewerReviews.status, "submitted"),
              inArray(reviewerReviews.applicationId, ids),
            ),
          )
          .orderBy(desc(reviewerReviews.revision)),
        transaction
          .select()
          .from(assessmentResults)
          .where(
            and(
              eq(assessmentResults.tenantId, principal.organizationId),
              eq(assessmentResults.competitionId, principal.competitionId),
              inArray(assessmentResults.applicationId, ids),
            ),
          )
          .orderBy(desc(assessmentResults.createdAt)),
      ])
    : [[], [], []];

  const latestDecision = new Map<string, (typeof decisionRows)[number]>();
  for (const decision of decisionRows) {
    if (!latestDecision.has(decision.applicationId)) latestDecision.set(decision.applicationId, decision);
  }
  const latestAssessment = new Map<string, (typeof resultRows)[number]>();
  for (const result of resultRows) {
    if (!latestAssessment.has(result.applicationId)) latestAssessment.set(result.applicationId, result);
  }
  const latestReviewByReviewer = new Map<string, (typeof reviewRows)[number]>();
  for (const review of reviewRows) {
    const key = `${review.applicationId}:${review.reviewerUserId}`;
    if (!latestReviewByReviewer.has(key)) latestReviewByReviewer.set(key, review);
  }
  const reviewsByApplication = new Map<string, Array<(typeof reviewRows)[number]>>();
  for (const review of latestReviewByReviewer.values()) {
    const list = reviewsByApplication.get(review.applicationId) ?? [];
    list.push(review);
    reviewsByApplication.set(review.applicationId, list);
  }

  return rows.map(({ application, identity }) => {
    const latest = latestDecision.get(application.id);
    const assessment = latestAssessment.get(application.id);
    const reviews = reviewsByApplication.get(application.id) ?? [];
    return {
      id: application.id,
      competitionId: application.competitionId,
      externalId: application.externalRef,
      teamName: identityText(identity.identityData, ["teamName", "team_name", "name"]),
      track: identityText(identity.identityData, ["track", "category", "programme"]),
      applicationStatus: application.status,
      assessment: assessment
        ? {
            recommendation: assessment.recommendation,
            score: assessment.score === null ? null : Number(assessment.score),
          }
        : null,
      reviewerSummary: {
        submitted: reviews.length,
        progress: reviews.filter((review) => review.recommendation === "progress").length,
        doNotProgress: reviews.filter((review) => review.recommendation === "do_not_progress").length,
        humanReview: reviews.filter((review) => review.recommendation === "human_review").length,
      },
      finalDecision: latest
        ? {
            decision: decisionCode(latest.decision),
            rationale: latest.rationale,
            revision: latest.revision,
            decidedAt: latest.decidedAt.toISOString(),
          }
        : null,
      revision: latest?.revision ?? 0,
    };
  });
}

export async function saveFinalDecisionRevision(
  transaction: TenantTransaction,
  input: {
    principal: ServerPrincipal;
    applicationId: string;
    expectedRevision: number;
    decision: FinalDecisionCode;
    rationale: string;
    now: Date;
  },
): Promise<number | null> {
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${input.applicationId}, 0))
  `);
  const [application] = await transaction
    .select({ id: applications.id })
    .from(applications)
    .innerJoin(
      datasets,
      and(
        eq(datasets.tenantId, applications.tenantId),
        eq(datasets.competitionId, applications.competitionId),
        eq(datasets.id, applications.datasetId),
        eq(datasets.kind, "current"),
      ),
    )
    .where(
      and(
        eq(applications.tenantId, input.principal.organizationId),
        eq(applications.competitionId, input.principal.competitionId),
        eq(applications.id, input.applicationId),
        ne(applications.status, "deleted"),
      ),
    )
    .limit(1);
  if (!application) return null;

  const [latest] = await transaction
    .select()
    .from(finalDecisionRevisions)
    .where(
      and(
        eq(finalDecisionRevisions.tenantId, input.principal.organizationId),
        eq(finalDecisionRevisions.competitionId, input.principal.competitionId),
        eq(finalDecisionRevisions.applicationId, input.applicationId),
      ),
    )
    .orderBy(desc(finalDecisionRevisions.revision))
    .limit(1);
  const currentRevision = latest?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) throw new Error("revision_conflict");
  const revision = currentRevision + 1;
  const content = {
    applicationId: input.applicationId,
    revision,
    decision: input.decision,
    rationale: input.rationale,
    decidedByUserId: input.principal.actorUserId,
    decidedAt: input.now.toISOString(),
  };
  await transaction.insert(finalDecisionRevisions).values({
    tenantId: input.principal.organizationId,
    competitionId: input.principal.competitionId,
    applicationId: input.applicationId,
    revision,
    supersedesDecisionId: latest?.id ?? null,
    decision: input.decision,
    rationale: input.rationale,
    evidence: {},
    contentHash: await sha256(content),
    decidedByUserId: input.principal.actorUserId,
    decidedAt: input.now,
  });
  return revision;
}
