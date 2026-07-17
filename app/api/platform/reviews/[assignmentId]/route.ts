import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { assignments } from "../../../../../db/schema.ts";
import { withTenantTransaction } from "../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../lib/audit-postgres.ts";
import { authorizeReview } from "../../../../../lib/auth/guards.ts";
import { resolveRequestPlatformContext } from "../../../../../lib/auth/request-context.ts";
import {
  platformJson,
  readPlatformJson,
  requestId,
  sameOriginMutation,
} from "../../../../../lib/http-security.ts";
import {
  listReviewerAssignments,
  submitReviewerReview,
} from "../../../../../lib/platform-repository.ts";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["progress", "do_not_progress", "human_review"]),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().trim().min(10).max(10_000),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ assignmentId: string }> },
) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  const { assignmentId } = await context.params;
  if (!z.string().uuid().safeParse(assignmentId).success) {
    return platformJson({ error: { code: "invalid_request", message: "The assignment is invalid." } }, 400);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readPlatformJson(request));
  } catch {
    return platformJson({ error: { code: "invalid_request", message: "Complete the recommendation, confidence and evidence notes." } }, 400);
  }

  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson(
      { error: { code: resolution.reason, message: "Your review access could not be verified." } },
      resolution.reason === "unauthenticated" ? 401 : 503,
    );
  }

  for (const principal of resolution.principals) {
    try {
      const result = await withTenantTransaction(
        {
          tenantId: principal.organizationId,
          userId: principal.actorUserId,
          requestId: requestId(request),
        },
        async (transaction) => {
          const [assignment] = await transaction
            .select()
            .from(assignments)
            .where(
              and(
                eq(assignments.tenantId, principal.organizationId),
                eq(assignments.competitionId, principal.competitionId),
                eq(assignments.id, assignmentId),
              ),
            )
            .limit(1);
          if (!assignment) return null;

          const decision = authorizeReview(
            principal,
            "write",
            { organizationId: assignment.tenantId, competitionId: assignment.competitionId },
            {
              organizationId: assignment.tenantId,
              competitionId: assignment.competitionId,
              reviewerUserId: assignment.reviewerUserId,
              status: assignment.status,
            },
          );
          if (!decision.allowed || assignment.reviewerUserId !== principal.actorUserId) {
            throw new Error("permission_denied");
          }

          const submitted = await submitReviewerReview(transaction, {
            principal,
            assignmentId,
            expectedRevision: body.expectedRevision,
            decision: body.decision,
            confidence: body.confidence,
            notes: body.notes,
            now: new Date(),
          });
          if (!submitted) return null;
          await appendPostgresAuditEvent(transaction, {
            actor: principal,
            action: submitted.reviewRevision === 1 ? "review.submitted" : "review.revised",
            outcome: "success",
            targetType: "assignment",
            targetId: assignmentId,
            summaryCode: submitted.reviewRevision === 1 ? "review.submitted" : "review.revised",
            metadata: {
              applicationId: assignment.applicationId,
              revision: submitted.reviewRevision,
              decisionCode: body.decision,
            },
          });
          const updated = await listReviewerAssignments(transaction, principal);
          return updated.find((item) => item.id === assignmentId) ?? null;
        },
        { isolationLevel: "serializable" },
      );
      if (result) return platformJson({ assignment: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "revision_conflict") {
        return platformJson(
          { error: { code: "revision_conflict", message: "This review changed in another session. Reload the queue before submitting again." } },
          409,
        );
      }
      if (message === "permission_denied") {
        return platformJson({ error: { code: "permission_denied", message: "This application is not assigned to your account." } }, 403);
      }
      return platformJson({ error: { code: "review_failed", message: "The review could not be saved safely." } }, 500);
    }
  }

  return platformJson({ error: { code: "resource_not_found", message: "The assignment was not found." } }, 404);
}
