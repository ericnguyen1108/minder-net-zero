import { z } from "zod";

import { withTenantTransaction } from "../../../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../../../lib/audit-postgres.ts";
import {
  authorizeCurrentImport,
  currentImportErrorResponse,
  readBoundedImportJson,
} from "../../../../../../../lib/current-import-http.ts";
import { finalizeCurrentImport } from "../../../../../../../lib/current-import-repository.ts";
import {
  platformJson,
  requestId,
  sameOriginMutation,
} from "../../../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const uuid = z.string().uuid();
const finalizeBody = z.object({ expectedRevision: z.number().int().positive() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  const { importId } = await context.params;
  const competitionId = new URL(request.url).searchParams.get("competitionId") ?? "";
  if (!uuid.safeParse(importId).success || !uuid.safeParse(competitionId).success) {
    return platformJson({ error: { code: "invalid_request", message: "The import reference is invalid." } }, 400);
  }
  const access = await authorizeCurrentImport(competitionId);
  if (!access.ok) return access.response;
  try {
    const body = finalizeBody.parse(await readBoundedImportJson(request, 8_192));
    const result = await withTenantTransaction(
      {
        tenantId: access.principal.organizationId,
        userId: access.principal.actorUserId,
        requestId: requestId(request),
      },
      async (transaction) => {
        const finalized = await finalizeCurrentImport(transaction, {
          tenantId: access.principal.organizationId,
          competitionId: access.principal.competitionId,
          importSessionId: importId,
          expectedRevision: body.expectedRevision,
          actorUserId: access.principal.actorUserId,
          now: new Date(),
        });
        if (finalized.completedNow) {
          await appendPostgresAuditEvent(transaction, {
            actor: access.principal,
            action: "application.import_completed",
            outcome: "success",
            targetType: "dataset",
            targetId: finalized.datasetId,
            summaryCode: "application.import_completed",
            metadata: {
              datasetId: finalized.datasetId,
              recordCount: finalized.session.expectedRowCount,
              revision: finalized.session.revision,
              source: finalized.reusedDataset ? "existing_dataset" : "new_dataset",
            },
          });
        }
        return finalized;
      },
      { isolationLevel: "serializable" },
    );
    return platformJson({
      import: result.session,
      datasetId: result.datasetId,
      reusedDataset: result.reusedDataset,
    });
  } catch (error) {
    return currentImportErrorResponse(error);
  }
}

