import type { PlatformContextFailure } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";

export const dynamic = "force-dynamic";

function json(value: unknown, status: number) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
}

function mappingFailure(reason: PlatformContextFailure) {
  if (reason === "platform_not_configured") {
    return json(
      {
        error: {
          code: "platform_not_configured",
          message: "Multi-user authentication is not configured on this deployment.",
        },
      },
      503,
    );
  }
  if (reason === "unauthenticated") {
    return json({ error: { code: "not_authenticated", message: "Sign in to continue." } }, 401);
  }
  if (reason === "organization_required") {
    return json(
      {
        error: {
          code: "organization_required",
          message: "Select your competition organization to continue.",
        },
      },
      403,
    );
  }
  if (reason === "identity_provider_unavailable") {
    return json(
      {
        error: {
          code: "identity_provider_unavailable",
          message: "Sign-in verification is temporarily unavailable.",
        },
      },
      503,
    );
  }
  if (reason === "no_active_membership") {
    return json(
      {
        error: {
          code: "no_active_membership",
          message: "This account does not have active access to a competition.",
        },
      },
      403,
    );
  }
  if (reason === "identity_store_unavailable") {
    return json(
      {
        error: {
          code: "identity_store_unavailable",
          message: "Account access is temporarily unavailable.",
        },
      },
      503,
    );
  }
  // A mismatch, malformed role, or ambiguous tenant map is an operator issue.
  // Do not leak the bad row or silently select one of several identities.
  return json(
    {
      error: {
        code: "authorization_mapping_invalid",
        message: "This account's access configuration requires administrator attention.",
      },
    },
    503,
  );
}

export async function GET() {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) return mappingFailure(resolution.reason);

  // This DTO intentionally excludes Clerk ids, session ids, membership rows,
  // email addresses, grant timestamps, and every candidate-data field.
  return json(resolution.context, 200);
}
