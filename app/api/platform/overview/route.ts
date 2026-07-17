import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { principalHasPermission } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { platformJson, requestId } from "../../../../lib/http-security.ts";
import { loadCompetitionOverview } from "../../../../lib/overview-repository.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson(
      {
        error: {
          code: resolution.reason,
          message: resolution.reason === "unauthenticated"
            ? "Sign in to continue."
            : "The shared workspace is temporarily unavailable.",
        },
      },
      resolution.reason === "unauthenticated" ? 401 : 503,
    );
  }

  const principals = resolution.principals.filter((principal) =>
    principalHasPermission(principal, "competition.read"),
  );
  try {
    const overviews = await Promise.all(
      principals.map((principal) =>
        withTenantTransaction(
          {
            tenantId: principal.organizationId,
            userId: principal.actorUserId,
            requestId: requestId(request),
          },
          (transaction) => loadCompetitionOverview(transaction, principal),
          { accessMode: "read only", isolationLevel: "repeatable read" },
        ),
      ),
    );
    return platformJson({
      user: resolution.context.user,
      competitions: overviews.filter((item) => item !== null),
    });
  } catch {
    return platformJson(
      { error: { code: "workspace_unavailable", message: "The shared workspace is temporarily unavailable." } },
      503,
    );
  }
}
