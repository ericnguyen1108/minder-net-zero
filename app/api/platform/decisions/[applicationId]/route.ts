import { z } from "zod";

import { withTenantTransaction } from "../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../lib/audit-postgres.ts";
import { principalHasPermission } from "../../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../../lib/auth/request-context.ts";
import {
  listDecisionApplications,
  saveFinalDecisionRevision,
} from "../../../../../lib/decision-repository.ts";
import {
  platformJson,
  readPlatformJson,
  requestId,
  sameOriginMutation,
} from "../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().min(0),
  decision: z.enum(["shortlist", "reject", "waitlist", "needs_more_review"]),
  rationale: z.string().trim().min(10).max(10_000),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ applicationId: string }> },
) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  const { applicationId } = await context.params;
  if (!z.string().uuid().safeParse(applicationId).success) {
    return platformJson({ error: { code: "invalid_request", message: "The application is invalid." } }, 400);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readPlatformJson(request));
  } catch {
    return platformJson(
      { error: { code: "invalid_request", message: "Choose a decision and provide a clear rationale." } },
      400,
    );
  }

  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson(
      { error: { code: resolution.reason, message: "Decision access could not be verified." } },
      resolution.reason === "unauthenticated" ? 401 : 503,
    );
  }
  const principals = resolution.principals.filter((principal) =>
    principalHasPermission(principal, "decision.approve"),
  );
  if (principals.length === 0) {
    return platformJson(
      { error: { code: "permission_denied", message: "A decision approver account is required." } },
      403,
    );
  }

  for (const principal of principals) {
    try {
      const saved = await withTenantTransaction(
        { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
        async (transaction) => {
          const revision = await saveFinalDecisionRevision(transaction, {
            principal,
            applicationId,
            expectedRevision: body.expectedRevision,
            decision: body.decision,
            rationale: body.rationale,
            now: new Date(),
          });
          if (revision === null) return null;
          await appendPostgresAuditEvent(transaction, {
            actor: principal,
            action: revision === 1 ? "decision.recorded" : "decision.revised",
            outcome: "success",
            targetType: "application",
            targetId: applicationId,
            summaryCode: revision === 1 ? "decision.recorded" : "decision.revised",
            metadata: { decisionCode: body.decision, revision },
          });
          const applications = await listDecisionApplications(transaction, principal);
          return applications.find((item) => item.id === applicationId) ?? null;
        },
        { isolationLevel: "serializable" },
      );
      if (saved) return platformJson({ application: saved });
    } catch (error) {
      if (error instanceof Error && error.message === "revision_conflict") {
        return platformJson(
          { error: { code: "revision_conflict", message: "This decision changed in another session. Load the latest version before continuing." } },
          409,
        );
      }
      return platformJson(
        { error: { code: "decision_failed", message: "The decision could not be saved safely." } },
        500,
      );
    }
  }
  return platformJson({ error: { code: "resource_not_found", message: "The application was not found." } }, 404);
}
