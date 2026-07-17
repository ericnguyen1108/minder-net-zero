import { z } from "zod";

import { withTenantTransaction } from "../../../../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../../../../lib/audit-postgres.ts";
import {
  MAX_CURRENT_IMPORT_REQUEST_BYTES,
  MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
  isSha256,
  prepareCurrentImportChunk,
} from "../../../../../../../../lib/current-import-contract.ts";
import {
  authorizeCurrentImport,
  currentImportErrorResponse,
  readBoundedImportJson,
} from "../../../../../../../../lib/current-import-http.ts";
import { stageCurrentImportChunk } from "../../../../../../../../lib/current-import-repository.ts";
import {
  platformJson,
  requestId,
  sameOriginMutation,
} from "../../../../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const uuid = z.string().uuid();
const row = z
  .object({
    externalRef: z.string(),
    identityData: z.record(z.string(), z.unknown()),
    content: z.record(z.string(), z.unknown()),
    submittedAt: z.string().max(64).nullable().optional(),
  })
  .strict();
const chunkBody = z
  .object({
    expectedRevision: z.number().int().positive(),
    startRow: z.number().int().nonnegative().max(999),
    chunkHash: z.string().refine(isSha256),
    rows: z.array(row).min(1).max(MAX_CURRENT_IMPORT_ROWS_PER_CHUNK),
  })
  .strict();

export async function PUT(
  request: Request,
  context: { params: Promise<{ importId: string; chunkIndex: string }> },
) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  const { importId, chunkIndex: rawChunkIndex } = await context.params;
  const competitionId = new URL(request.url).searchParams.get("competitionId") ?? "";
  const chunkIndex = Number(rawChunkIndex);
  if (
    !uuid.safeParse(importId).success ||
    !uuid.safeParse(competitionId).success ||
    !/^(?:0|[1-9]\d?)$/.test(rawChunkIndex) ||
    !Number.isSafeInteger(chunkIndex)
  ) {
    return platformJson({ error: { code: "invalid_request", message: "The import chunk is invalid." } }, 400);
  }
  const access = await authorizeCurrentImport(competitionId);
  if (!access.ok) return access.response;
  try {
    const body = chunkBody.parse(
      await readBoundedImportJson(request, MAX_CURRENT_IMPORT_REQUEST_BYTES),
    );
    const prepared = await prepareCurrentImportChunk(body.rows);
    const result = await withTenantTransaction(
      {
        tenantId: access.principal.organizationId,
        userId: access.principal.actorUserId,
        requestId: requestId(request),
      },
      async (transaction) => {
        const stored = await stageCurrentImportChunk(transaction, {
          tenantId: access.principal.organizationId,
          competitionId: access.principal.competitionId,
          importSessionId: importId,
          chunkIndex,
          startRow: body.startRow,
          expectedRevision: body.expectedRevision,
          suppliedChunkHash: body.chunkHash,
          prepared,
          actorUserId: access.principal.actorUserId,
          now: new Date(),
        });
        if (stored.stored) {
          await appendPostgresAuditEvent(transaction, {
            actor: access.principal,
            action: "application.import_chunk_staged",
            outcome: "success",
            targetType: "current_import",
            targetId: importId,
            summaryCode: "application.import_chunk_staged",
            metadata: {
              batchId: `chunk-${chunkIndex}`,
              batchSize: prepared.rows.length,
              importHash: prepared.chunkHash,
              revision: stored.session.revision,
            },
          });
        }
        return stored;
      },
      { isolationLevel: "serializable" },
    );
    return platformJson(
      { import: result.session, chunk: { index: chunkIndex, hash: prepared.chunkHash } },
      result.stored ? 201 : 200,
    );
  } catch (error) {
    return currentImportErrorResponse(error);
  }
}
