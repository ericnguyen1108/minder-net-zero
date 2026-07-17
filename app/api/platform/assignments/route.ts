import { z } from "zod";

import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import {
  assignApplicationToReviewer,
  listAssignmentManagementData,
  unassignApplicationFromReviewer,
} from "../../../../lib/assignment-management.ts";
import { appendPostgresAuditEvent } from "../../../../lib/audit-postgres.ts";
import { principalForCompetition } from "../../../../lib/auth/context.ts";
import {
  authorizationErrorResponse,
  requirePermission,
  RouteAuthorizationError,
} from "../../../../lib/auth/guards.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import {
  platformJson,
  readPlatformJson,
  requestId,
  sameOriginMutation,
} from "../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const createBody = z.object({
  competitionId: uuid,
  applicationId: uuid,
  reviewerUserId: uuid,
  round: z.number().int().positive().max(100).default(1),
  blind: z.boolean().default(true),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  expectedRevision: z.number().int().positive().nullable().default(null),
});
const cancelBody = z.object({
  competitionId: uuid,
  assignmentId: uuid,
  expectedRevision: z.number().int().positive(),
  action: z.literal("unassign"),
});

async function authorizedPrincipal(competitionId: string) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) throw new Error(`context:${resolution.reason}`);
  const principal = principalForCompetition(resolution, competitionId);
  if (!principal) throw new Error("resource_not_found");
  return requirePermission(principal, "review.assign", {
    organizationId: principal.organizationId,
    competitionId,
  });
}

function routeError(error: unknown) {
  if (error instanceof RouteAuthorizationError) return authorizationErrorResponse(error);
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("context:unauthenticated")) {
    return platformJson(
      { error: { code: "not_authenticated", message: "Sign in to continue." } },
      401,
    );
  }
  if (message.startsWith("context:")) {
    return platformJson(
      {
        error: {
          code: "account_unavailable",
          message: "Assignment access is temporarily unavailable.",
        },
      },
      503,
    );
  }
  if (message === "permission_denied" || message === "self_assignment_forbidden") {
    return platformJson(
      {
        error: {
          code: message,
          message:
            message === "self_assignment_forbidden"
              ? "Reviewers cannot assign applications to themselves."
              : "You do not have permission to manage reviewer assignments.",
        },
      },
      403,
    );
  }
  if (
    message === "resource_not_found" ||
    message === "application_not_found" ||
    message === "assignment_not_found"
  ) {
    return platformJson(
      { error: { code: "resource_not_found", message: "The requested record was not found." } },
      404,
    );
  }
  if (message === "reviewer_not_eligible") {
    return platformJson(
      {
        error: {
          code: "reviewer_not_eligible",
          message: "That account is not an active reviewer for this competition.",
        },
      },
      409,
    );
  }
  if (message === "assignment_exists") {
    return platformJson(
      {
        error: {
          code: "assignment_exists",
          message: "This application is already assigned to that reviewer.",
        },
      },
      409,
    );
  }
  if (message === "submitted_assignment_locked") {
    return platformJson(
      {
        error: {
          code: "submitted_assignment_locked",
          message: "A submitted review cannot be unassigned. Its audit record must remain intact.",
        },
      },
      409,
    );
  }
  if (message === "revision_conflict") {
    return platformJson(
      {
        error: {
          code: "revision_conflict",
          message: "Assignments changed in another session. The latest shared state has been reloaded.",
        },
      },
      409,
    );
  }
  return platformJson(
    {
      error: {
        code: "assignment_store_unavailable",
        message: "The shared assignment board is temporarily unavailable.",
      },
    },
    503,
  );
}

export async function GET(request: Request) {
  const competitionId = new URL(request.url).searchParams.get("competitionId") ?? "";
  if (!uuid.safeParse(competitionId).success) {
    return platformJson(
      { error: { code: "invalid_request", message: "Choose a valid competition." } },
      400,
    );
  }
  try {
    const principal = await authorizedPrincipal(competitionId);
    const data = await withTenantTransaction(
      {
        tenantId: principal.organizationId,
        userId: principal.actorUserId,
        requestId: requestId(request),
      },
      (transaction) =>
        listAssignmentManagementData(transaction, {
          tenantId: principal.organizationId,
          competitionId,
          actorUserId: principal.actorUserId,
          now: new Date(),
        }),
      { accessMode: "read only" },
    );
    return platformJson({ ...data, generatedAt: new Date().toISOString() });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  let body: z.infer<typeof createBody>;
  try {
    body = createBody.parse(await readPlatformJson(request));
  } catch {
    return platformJson(
      { error: { code: "invalid_request", message: "Choose an application and reviewer." } },
      400,
    );
  }

  try {
    const principal = await authorizedPrincipal(body.competitionId);
    const now = new Date();
    const assignment = await withTenantTransaction(
      {
        tenantId: principal.organizationId,
        userId: principal.actorUserId,
        requestId: requestId(request),
      },
      async (transaction) => {
        const result = await assignApplicationToReviewer(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          applicationId: body.applicationId,
          reviewerUserId: body.reviewerUserId,
          actorUserId: principal.actorUserId,
          round: body.round,
          blind: body.blind,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          expectedRevision: body.expectedRevision,
          now,
        });
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: result.action,
          outcome: "success",
          targetType: "assignment",
          targetId: result.assignment.id,
          summaryCode: result.action,
          metadata: {
            applicationId: result.assignment.applicationId,
            revision: result.assignment.revision,
            nextStatus: result.assignment.status,
            sealed: result.assignment.blind,
            changedFields: ["reviewer", "status", "blind", "dueAt"],
          },
        });
        const data = await listAssignmentManagementData(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          actorUserId: principal.actorUserId,
          now,
        });
        return data.assignments.find((item) => item.id === result.assignment.id) ?? null;
      },
      { isolationLevel: "serializable" },
    );
    if (!assignment) throw new Error("assignment_not_found");
    return platformJson({ assignment }, 201);
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  let body: z.infer<typeof cancelBody>;
  try {
    body = cancelBody.parse(await readPlatformJson(request));
  } catch {
    return platformJson(
      { error: { code: "invalid_request", message: "Choose a valid assignment to remove." } },
      400,
    );
  }

  try {
    const principal = await authorizedPrincipal(body.competitionId);
    const assignment = await withTenantTransaction(
      {
        tenantId: principal.organizationId,
        userId: principal.actorUserId,
        requestId: requestId(request),
      },
      async (transaction) => {
        const result = await unassignApplicationFromReviewer(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          assignmentId: body.assignmentId,
          expectedRevision: body.expectedRevision,
        });
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: "assignment.cancelled",
          outcome: "success",
          targetType: "assignment",
          targetId: result.assignment.id,
          summaryCode: "assignment.cancelled",
          metadata: {
            applicationId: result.assignment.applicationId,
            expectedRevision: body.expectedRevision,
            revision: result.assignment.revision,
            previousStatus: result.previousStatus,
            nextStatus: result.assignment.status,
            changedFields: ["status"],
          },
        });
        const data = await listAssignmentManagementData(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          actorUserId: principal.actorUserId,
          now: new Date(),
        });
        return data.assignments.find((item) => item.id === result.assignment.id) ?? null;
      },
      { isolationLevel: "serializable" },
    );
    if (!assignment) throw new Error("assignment_not_found");
    return platformJson({ assignment });
  } catch (error) {
    return routeError(error);
  }
}
