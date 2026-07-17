import { z } from "zod";

import { withTenantTransaction } from "../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../lib/audit-postgres.ts";
import {
  CURRENT_IMPORT_SCHEMA_VERSION,
  MAX_CURRENT_IMPORT_CHUNK_CANONICAL_BYTES,
  MAX_CURRENT_IMPORT_CHUNKS,
  MAX_CURRENT_IMPORT_REQUEST_BYTES,
  MAX_CURRENT_IMPORT_ROWS,
  MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
  isSafeImportIdempotencyKey,
  isSha256,
} from "../../../../../lib/current-import-contract.ts";
import {
  authorizeCurrentImport,
  currentImportErrorResponse,
  readBoundedImportJson,
} from "../../../../../lib/current-import-http.ts";
import { createCurrentImportSession } from "../../../../../lib/current-import-repository.ts";
import { platformJson, requestId, sameOriginMutation } from "../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createBody = z
  .object({
    competitionId: z.string().uuid(),
    idempotencyKey: z.string().refine(isSafeImportIdempotencyKey),
    sourceFilename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
      .transform((value) => value.normalize("NFC").split(/[\\/]/u).at(-1)!)
      .pipe(z.string().min(1).max(255)),
    sourceHash: z.string().refine(isSha256),
    expectedRowCount: z.number().int().min(1).max(MAX_CURRENT_IMPORT_ROWS),
    expectedChunkCount: z.number().int().min(1).max(MAX_CURRENT_IMPORT_CHUNKS),
    schemaVersion: z.literal(CURRENT_IMPORT_SCHEMA_VERSION),
  })
  .strict()
  .refine(
    (value) =>
      value.expectedChunkCount >=
        Math.ceil(value.expectedRowCount / MAX_CURRENT_IMPORT_ROWS_PER_CHUNK) &&
      value.expectedChunkCount <= value.expectedRowCount,
    { message: "The chunk manifest cannot contain the declared row count." },
  );

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  try {
    const body = createBody.parse(await readBoundedImportJson(request, 16_384));
    const access = await authorizeCurrentImport(body.competitionId);
    if (!access.ok) return access.response;
    const result = await withTenantTransaction(
      {
        tenantId: access.principal.organizationId,
        userId: access.principal.actorUserId,
        requestId: requestId(request),
      },
      async (transaction) => {
        const created = await createCurrentImportSession(transaction, {
          tenantId: access.principal.organizationId,
          competitionId: access.principal.competitionId,
          idempotencyKey: body.idempotencyKey,
          sourceFilename: body.sourceFilename,
          sourceHash: body.sourceHash,
          expectedRowCount: body.expectedRowCount,
          expectedChunkCount: body.expectedChunkCount,
          schemaVersion: body.schemaVersion,
          actorUserId: access.principal.actorUserId,
          now: new Date(),
        });
        if (created.created) {
          await appendPostgresAuditEvent(transaction, {
            actor: access.principal,
            action: "application.import_started",
            outcome: "success",
            targetType: "current_import",
            targetId: created.session.id,
            summaryCode: "application.import_started",
            metadata: {
              recordCount: body.expectedRowCount,
              importHash: body.sourceHash,
              idempotencyKey: body.idempotencyKey,
              revision: created.session.revision,
            },
          });
        }
        return created;
      },
      { isolationLevel: "serializable" },
    );
    return platformJson(
      {
        import: result.session,
        limits: {
          rowsPerChunk: MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
          chunkCanonicalBytes: MAX_CURRENT_IMPORT_CHUNK_CANONICAL_BYTES,
          requestBytes: MAX_CURRENT_IMPORT_REQUEST_BYTES,
        },
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    return currentImportErrorResponse(error);
  }
}
