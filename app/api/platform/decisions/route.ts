import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { principalHasPermission } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { listDecisionApplications } from "../../../../lib/decision-repository.ts";
import { platformJson, requestId } from "../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson(
      { error: { code: resolution.reason, message: "Decision access could not be verified." } },
      resolution.reason === "unauthenticated" ? 401 : 503,
    );
  }
  const principals = resolution.principals.filter((principal) =>
    principalHasPermission(principal, "decision.read"),
  );
  if (principals.length === 0) {
    return platformJson(
      { error: { code: "permission_denied", message: "You do not have permission to view final decisions." } },
      403,
    );
  }
  try {
    const groups = await Promise.all(
      principals.map((principal) =>
        withTenantTransaction(
          { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
          (transaction) => listDecisionApplications(transaction, principal),
          { accessMode: "read only", isolationLevel: "repeatable read" },
        ),
      ),
    );
    return platformJson({ applications: groups.flat() });
  } catch {
    return platformJson(
      { error: { code: "decision_store_unavailable", message: "The final-decision workspace is temporarily unavailable." } },
      503,
    );
  }
}
