import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { principalHasPermission } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { platformJson, requestId } from "../../../../lib/http-security.ts";
import { listReviewerAssignments } from "../../../../lib/platform-repository.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    const status = resolution.reason === "unauthenticated" ? 401 : 503;
    return platformJson(
      {
        error: {
          code: resolution.reason,
          message: status === 401 ? "Sign in to continue." : "Your review access is temporarily unavailable.",
        },
      },
      status,
    );
  }

  const eligiblePrincipals = resolution.principals.filter(
    (principal) =>
      principalHasPermission(principal, "review.read_assigned") ||
      principalHasPermission(principal, "review.read_all"),
  );
  try {
    const groups = await Promise.all(
      eligiblePrincipals.map((principal) =>
        withTenantTransaction(
          {
            tenantId: principal.organizationId,
            userId: principal.actorUserId,
            requestId: requestId(request),
          },
          (transaction) => listReviewerAssignments(transaction, principal),
          { accessMode: "read only" },
        ),
      ),
    );
    const assignments = groups
      .flat()
      .sort((left, right) =>
        (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") ||
        left.application.externalId.localeCompare(right.application.externalId),
      );
    return platformJson({ assignments });
  } catch {
    return platformJson(
      { error: { code: "review_store_unavailable", message: "The shared review queue is temporarily unavailable." } },
      503,
    );
  }
}
