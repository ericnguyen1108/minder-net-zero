import { z } from "zod";

import { withTenantTransaction } from "../../../../../../db/tenant-transaction.ts";
import { authorizeCurrentImport } from "../../../../../../lib/current-import-http.ts";
import { loadCurrentImportSession } from "../../../../../../lib/current-import-repository.ts";
import { platformJson, requestId } from "../../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const uuid = z.string().uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  const { importId } = await context.params;
  const competitionId = new URL(request.url).searchParams.get("competitionId") ?? "";
  if (!uuid.safeParse(importId).success || !uuid.safeParse(competitionId).success) {
    return platformJson({ error: { code: "invalid_request", message: "The import reference is invalid." } }, 400);
  }
  const access = await authorizeCurrentImport(competitionId);
  if (!access.ok) return access.response;
  try {
    const session = await withTenantTransaction(
      {
        tenantId: access.principal.organizationId,
        userId: access.principal.actorUserId,
        requestId: requestId(request),
      },
      (transaction) =>
        loadCurrentImportSession(
          transaction,
          access.principal.organizationId,
          access.principal.competitionId,
          importId,
        ),
      { accessMode: "read only" },
    );
    return session
      ? platformJson({ import: session })
      : platformJson({ error: { code: "resource_not_found", message: "The import session was not found." } }, 404);
  } catch {
    return platformJson(
      { error: { code: "import_store_unavailable", message: "The import status is temporarily unavailable." } },
      503,
    );
  }
}

