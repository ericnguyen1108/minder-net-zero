import { sql } from "drizzle-orm";

import { getDatabase } from "../../../../db/client.ts";
import { getIdentityDatabase } from "../../../../db/identity-client.ts";
import type { PlatformContextFailure } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import {
  isPlatformAdministratorRoleSet,
  runReadinessChecks,
} from "../../../../lib/readiness.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(value: unknown, status: number) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
}

function contextFailure(reason: PlatformContextFailure) {
  if (reason === "unauthenticated") {
    return response(
      { error: { code: "not_authenticated", message: "Sign in to continue." } },
      401,
    );
  }
  if (
    reason === "platform_not_configured" ||
    reason === "identity_provider_unavailable" ||
    reason === "identity_store_unavailable"
  ) {
    return response({ status: "not_ready" }, 503);
  }
  return response(
    { error: { code: "permission_denied", message: "Platform administrator access is required." } },
    403,
  );
}

async function probeDatabase(): Promise<void> {
  // This intentionally avoids tenant data, schema names, server versions, and
  // connection metadata. A successful round trip is the only signal required.
  await getDatabase().execute(sql`select 1 as ready`);
}

async function probeIdentityDatabase(): Promise<void> {
  await getIdentityDatabase().execute(sql`select 1 as ready`);
}

export async function GET() {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) return contextFailure(resolution.reason);

  const administrator = resolution.principals.some((principal) =>
    isPlatformAdministratorRoleSet(principal.roles),
  );
  if (!administrator) {
    return response(
      { error: { code: "permission_denied", message: "Platform administrator access is required." } },
      403,
    );
  }

  const result = await runReadinessChecks({
    authMode: process.env.AUTH_MODE,
    databaseProbe: probeDatabase,
    identityDatabaseProbe: probeIdentityDatabase,
  });
  return response(
    {
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
    },
    result.ready ? 200 : 503,
  );
}
