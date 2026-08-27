import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  applicantIdentities,
  applications,
  currentImportChunks,
  currentImportRows,
  currentImportSessions,
  datasets,
} from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import {
  CURRENT_IMPORT_SCHEMA_VERSION,
  MAX_CURRENT_IMPORT_CHUNKS,
  MAX_CURRENT_IMPORT_ROWS,
  MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
  currentImportSourceHash,
  prepareCurrentImportChunk,
  type PreparedCurrentImportChunk,
} from "./current-import-contract.ts";

export type CurrentImportRepositoryErrorCode =
  | "import_not_found"
  | "idempotency_conflict"
  | "revision_conflict"
  | "import_closed"
  | "import_expired"
  | "chunk_conflict"
  | "chunk_out_of_range"
  | "row_range_conflict"
  | "duplicate_external_ref"
  | "manifest_incomplete"
  | "chunk_hash_mismatch"
  | "source_hash_mismatch"
  | "staging_integrity_failure"
  | "source_dataset_conflict";

export class CurrentImportRepositoryError extends Error {
  readonly code: CurrentImportRepositoryErrorCode;

  constructor(code: CurrentImportRepositoryErrorCode) {
    super(code);
    this.name = "CurrentImportRepositoryError";
    this.code = code;
  }
}

export type CurrentImportSummary = Readonly<{
  id: string;
  competitionId: string;
  status: "staging" | "completed" | "cancelled" | "expired";
  revision: number;
  expectedRowCount: number;
  expectedChunkCount: number;
  receivedRowCount: number;
  receivedChunkCount: number;
  completedDatasetId: string | null;
  expiresAt: string;
}>;

function summary(row: typeof currentImportSessions.$inferSelect): CurrentImportSummary {
  return {
    id: row.id,
    competitionId: row.competitionId,
    status: row.status,
    revision: row.revision,
    expectedRowCount: row.expectedRowCount,
    expectedChunkCount: row.expectedChunkCount,
    receivedRowCount: row.receivedRowCount,
    receivedChunkCount: row.receivedChunkCount,
    completedDatasetId: row.completedDatasetId,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function sameManifest(
  existing: typeof currentImportSessions.$inferSelect,
  input: CreateCurrentImportSessionInput,
): boolean {
  return (
    existing.sourceFilename === input.sourceFilename &&
    existing.sourceHash === input.sourceHash &&
    existing.expectedRowCount === input.expectedRowCount &&
    existing.expectedChunkCount === input.expectedChunkCount &&
    existing.schemaVersion === input.schemaVersion
  );
}

export type CreateCurrentImportSessionInput = Readonly<{
  tenantId: string;
  competitionId: string;
  idempotencyKey: string;
  sourceFilename: string;
  sourceHash: string;
  expectedRowCount: number;
  expectedChunkCount: number;
  schemaVersion: number;
  actorUserId: string;
  now: Date;
}>;

export async function createCurrentImportSession(
  transaction: TenantTransaction,
  input: CreateCurrentImportSessionInput,
): Promise<{ session: CurrentImportSummary; created: boolean }> {
  if (
    input.schemaVersion !== CURRENT_IMPORT_SCHEMA_VERSION ||
    input.expectedRowCount < 1 ||
    input.expectedRowCount > MAX_CURRENT_IMPORT_ROWS ||
    input.expectedChunkCount < Math.ceil(input.expectedRowCount / MAX_CURRENT_IMPORT_ROWS_PER_CHUNK) ||
    input.expectedChunkCount > Math.min(MAX_CURRENT_IMPORT_CHUNKS, input.expectedRowCount)
  ) throw new CurrentImportRepositoryError("manifest_incomplete");

  const [inserted] = await transaction
    .insert(currentImportSessions)
    .values({
      tenantId: input.tenantId,
      competitionId: input.competitionId,
      idempotencyKey: input.idempotencyKey,
      sourceFilename: input.sourceFilename,
      sourceHash: input.sourceHash,
      expectedRowCount: input.expectedRowCount,
      expectedChunkCount: input.expectedChunkCount,
      schemaVersion: input.schemaVersion,
      createdByUserId: input.actorUserId,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1_000),
    })
    .onConflictDoNothing({
      target: [
        currentImportSessions.tenantId,
        currentImportSessions.competitionId,
        currentImportSessions.idempotencyKey,
      ],
    })
    .returning();

  if (inserted) return { session: summary(inserted), created: true };
  const [existing] = await transaction
    .select()
    .from(currentImportSessions)
    .where(
      and(
        eq(currentImportSessions.tenantId, input.tenantId),
        eq(currentImportSessions.competitionId, input.competitionId),
        eq(currentImportSessions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing || !sameManifest(existing, input)) {
    throw new CurrentImportRepositoryError("idempotency_conflict");
  }
  return { session: summary(existing), created: false };
}

export async function loadCurrentImportSession(
  transaction: TenantTransaction,
  tenantId: string,
  competitionId: string,
  importSessionId: string,
): Promise<CurrentImportSummary | null> {
  const [row] = await transaction
    .select()
    .from(currentImportSessions)
    .where(
      and(
        eq(currentImportSessions.tenantId, tenantId),
        eq(currentImportSessions.competitionId, competitionId),
        eq(currentImportSessions.id, importSessionId),
      ),
    )
    .limit(1);
  return row ? summary(row) : null;
}

export type StageCurrentImportChunkInput = Readonly<{
  tenantId: string;
  competitionId: string;
  importSessionId: string;
  chunkIndex: number;
  startRow: number;
  expectedRevision: number;
  suppliedChunkHash: string;
  prepared: PreparedCurrentImportChunk;
  actorUserId: string;
  now: Date;
}>;

export async function stageCurrentImportChunk(
  transaction: TenantTransaction,
  input: StageCurrentImportChunkInput,
): Promise<{ session: CurrentImportSummary; stored: boolean }> {
  const [session] = await transaction
    .select()
    .from(currentImportSessions)
    .where(
      and(
        eq(currentImportSessions.tenantId, input.tenantId),
        eq(currentImportSessions.competitionId, input.competitionId),
        eq(currentImportSessions.id, input.importSessionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!session) throw new CurrentImportRepositoryError("import_not_found");
  if (input.prepared.chunkHash !== input.suppliedChunkHash) {
    throw new CurrentImportRepositoryError("chunk_hash_mismatch");
  }

  const [existingChunk] = await transaction
    .select()
    .from(currentImportChunks)
    .where(
      and(
        eq(currentImportChunks.tenantId, input.tenantId),
        eq(currentImportChunks.competitionId, input.competitionId),
        eq(currentImportChunks.importSessionId, input.importSessionId),
        eq(currentImportChunks.chunkIndex, input.chunkIndex),
      ),
    )
    .limit(1);
  if (existingChunk) {
    if (
      existingChunk.chunkHash !== input.prepared.chunkHash ||
      existingChunk.startRow !== input.startRow ||
      existingChunk.rowCount !== input.prepared.rows.length ||
      existingChunk.canonicalBytes !== input.prepared.canonicalBytes
    ) throw new CurrentImportRepositoryError("chunk_conflict");
    return { session: summary(session), stored: false };
  }

  if (session.status !== "staging") throw new CurrentImportRepositoryError("import_closed");
  if (session.expiresAt.getTime() <= input.now.getTime()) {
    throw new CurrentImportRepositoryError("import_expired");
  }
  if (session.revision !== input.expectedRevision) {
    throw new CurrentImportRepositoryError("revision_conflict");
  }
  if (input.chunkIndex < 0 || input.chunkIndex >= session.expectedChunkCount) {
    throw new CurrentImportRepositoryError("chunk_out_of_range");
  }
  const lastRowExclusive = input.startRow + input.prepared.rows.length;
  if (input.startRow < 0 || lastRowExclusive > session.expectedRowCount) {
    throw new CurrentImportRepositoryError("row_range_conflict");
  }
  if (
    session.receivedChunkCount + 1 > session.expectedChunkCount ||
    session.receivedRowCount + input.prepared.rows.length > session.expectedRowCount
  ) throw new CurrentImportRepositoryError("manifest_incomplete");

  const externalRefs = input.prepared.rows.map((row) => row.canonical.externalRef);
  const ordinals = input.prepared.rows.map((_, index) => input.startRow + index);
  const [externalRefConflict, ordinalConflict] = await Promise.all([
    transaction
      .select({ id: currentImportRows.id })
      .from(currentImportRows)
      .where(
        and(
          eq(currentImportRows.tenantId, input.tenantId),
          eq(currentImportRows.competitionId, input.competitionId),
          eq(currentImportRows.importSessionId, input.importSessionId),
          inArray(currentImportRows.externalRef, externalRefs),
        ),
      )
      .limit(1),
    transaction
      .select({ id: currentImportRows.id })
      .from(currentImportRows)
      .where(
        and(
          eq(currentImportRows.tenantId, input.tenantId),
          eq(currentImportRows.competitionId, input.competitionId),
          eq(currentImportRows.importSessionId, input.importSessionId),
          inArray(currentImportRows.rowOrdinal, ordinals),
        ),
      )
      .limit(1),
  ]);
  if (externalRefConflict.length) throw new CurrentImportRepositoryError("duplicate_external_ref");
  if (ordinalConflict.length) throw new CurrentImportRepositoryError("row_range_conflict");

  const [chunk] = await transaction
    .insert(currentImportChunks)
    .values({
      tenantId: input.tenantId,
      competitionId: input.competitionId,
      importSessionId: input.importSessionId,
      chunkIndex: input.chunkIndex,
      startRow: input.startRow,
      rowCount: input.prepared.rows.length,
      chunkHash: input.prepared.chunkHash,
      canonicalBytes: input.prepared.canonicalBytes,
      uploadedByUserId: input.actorUserId,
      uploadedAt: input.now,
    })
    .returning();

  await transaction.insert(currentImportRows).values(
    input.prepared.rows.map((row, index) => ({
      tenantId: input.tenantId,
      competitionId: input.competitionId,
      importSessionId: input.importSessionId,
      importChunkId: chunk.id,
      chunkIndex: input.chunkIndex,
      rowOrdinal: input.startRow + index,
      externalRef: row.canonical.externalRef,
      identityData: { ...row.canonical.identityData },
      content: { ...row.canonical.content },
      submittedAt: row.canonical.submittedAt ? new Date(row.canonical.submittedAt) : null,
      identityHash: row.identityHash,
      contentHash: row.contentHash,
      rowHash: row.rowHash,
      canonicalBytes: row.canonicalBytes,
      stagedAt: input.now,
    })),
  );

  const [updated] = await transaction
    .update(currentImportSessions)
    .set({
      revision: sql`${currentImportSessions.revision} + 1`,
      receivedChunkCount: sql`${currentImportSessions.receivedChunkCount} + 1`,
      receivedRowCount: sql`${currentImportSessions.receivedRowCount} + ${input.prepared.rows.length}`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(currentImportSessions.tenantId, input.tenantId),
        eq(currentImportSessions.competitionId, input.competitionId),
        eq(currentImportSessions.id, input.importSessionId),
        eq(currentImportSessions.status, "staging"),
        eq(currentImportSessions.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!updated) throw new CurrentImportRepositoryError("revision_conflict");
  return { session: summary(updated), stored: true };
}

type FinalizeCurrentImportInput = Readonly<{
  tenantId: string;
  competitionId: string;
  importSessionId: string;
  expectedRevision: number;
  actorUserId: string;
  now: Date;
}>;

async function markCompleted(
  transaction: TenantTransaction,
  session: typeof currentImportSessions.$inferSelect,
  datasetId: string,
  expectedRevision: number,
  now: Date,
) {
  const [completed] = await transaction
    .update(currentImportSessions)
    .set({
      status: "completed",
      completedDatasetId: datasetId,
      completedAt: now,
      updatedAt: now,
      revision: sql`${currentImportSessions.revision} + 1`,
    })
    .where(
      and(
        eq(currentImportSessions.tenantId, session.tenantId),
        eq(currentImportSessions.competitionId, session.competitionId),
        eq(currentImportSessions.id, session.id),
        eq(currentImportSessions.status, "staging"),
        eq(currentImportSessions.revision, expectedRevision),
      ),
    )
    .returning();
  if (!completed) throw new CurrentImportRepositoryError("revision_conflict");
  return completed;
}

export async function finalizeCurrentImport(
  transaction: TenantTransaction,
  input: FinalizeCurrentImportInput,
): Promise<{
  session: CurrentImportSummary;
  datasetId: string;
  completedNow: boolean;
  reusedDataset: boolean;
}> {
  const [session] = await transaction
    .select()
    .from(currentImportSessions)
    .where(
      and(
        eq(currentImportSessions.tenantId, input.tenantId),
        eq(currentImportSessions.competitionId, input.competitionId),
        eq(currentImportSessions.id, input.importSessionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!session) throw new CurrentImportRepositoryError("import_not_found");
  if (session.status === "completed" && session.completedDatasetId) {
    return {
      session: summary(session),
      datasetId: session.completedDatasetId,
      completedNow: false,
      reusedDataset: true,
    };
  }
  if (session.status !== "staging") throw new CurrentImportRepositoryError("import_closed");
  if (session.expiresAt.getTime() <= input.now.getTime()) {
    throw new CurrentImportRepositoryError("import_expired");
  }
  if (session.revision !== input.expectedRevision) {
    throw new CurrentImportRepositoryError("revision_conflict");
  }
  if (
    session.receivedChunkCount !== session.expectedChunkCount ||
    session.receivedRowCount !== session.expectedRowCount
  ) throw new CurrentImportRepositoryError("manifest_incomplete");

  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${input.tenantId}:${input.competitionId}:current-cohort`}, 0)
    )
  `);

  const [chunks, stagedRows] = await Promise.all([
    transaction
      .select()
      .from(currentImportChunks)
      .where(
        and(
          eq(currentImportChunks.tenantId, input.tenantId),
          eq(currentImportChunks.competitionId, input.competitionId),
          eq(currentImportChunks.importSessionId, input.importSessionId),
        ),
      )
      .orderBy(asc(currentImportChunks.chunkIndex)),
    transaction
      .select()
      .from(currentImportRows)
      .where(
        and(
          eq(currentImportRows.tenantId, input.tenantId),
          eq(currentImportRows.competitionId, input.competitionId),
          eq(currentImportRows.importSessionId, input.importSessionId),
        ),
      )
      .orderBy(asc(currentImportRows.rowOrdinal)),
  ]);
  if (
    chunks.length !== session.expectedChunkCount ||
    stagedRows.length !== session.expectedRowCount
  ) throw new CurrentImportRepositoryError("manifest_incomplete");

  let nextOrdinal = 0;
  const canonicalRows = [];
  const externalRefs = new Set<string>();
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (chunk.chunkIndex !== chunkIndex || chunk.startRow !== nextOrdinal) {
      throw new CurrentImportRepositoryError("row_range_conflict");
    }
    const rows = stagedRows.filter((row) => row.chunkIndex === chunkIndex);
    if (rows.length !== chunk.rowCount) {
      throw new CurrentImportRepositoryError("manifest_incomplete");
    }
    const prepared = await prepareCurrentImportChunk(
      rows.map((row) => ({
        externalRef: row.externalRef,
        identityData: row.identityData,
        content: row.content,
        submittedAt: row.submittedAt?.toISOString() ?? null,
      })),
    );
    if (
      prepared.chunkHash !== chunk.chunkHash ||
      prepared.canonicalBytes !== chunk.canonicalBytes
    ) throw new CurrentImportRepositoryError("chunk_hash_mismatch");
    for (let localIndex = 0; localIndex < rows.length; localIndex += 1) {
      const row = rows[localIndex];
      const verified = prepared.rows[localIndex];
      if (
        row.importChunkId !== chunk.id ||
        row.rowOrdinal !== nextOrdinal ||
        row.identityHash !== verified.identityHash ||
        row.contentHash !== verified.contentHash ||
        row.rowHash !== verified.rowHash ||
        row.canonicalBytes !== verified.canonicalBytes
      ) throw new CurrentImportRepositoryError("staging_integrity_failure");
      if (externalRefs.has(row.externalRef)) {
        throw new CurrentImportRepositoryError("duplicate_external_ref");
      }
      externalRefs.add(row.externalRef);
      canonicalRows.push(verified.canonical);
      nextOrdinal += 1;
    }
  }
  if (nextOrdinal !== session.expectedRowCount) {
    throw new CurrentImportRepositoryError("manifest_incomplete");
  }
  const source = await currentImportSourceHash(canonicalRows);
  if (source.sourceHash !== session.sourceHash) {
    throw new CurrentImportRepositoryError("source_hash_mismatch");
  }

  // One competition must never expose two different current cohorts at once.
  // A deliberate replacement needs its own audited workflow; until then, fail
  // closed instead of mixing old and corrected applications downstream.
  const activeCurrentDatasets = await transaction
    .select({ id: datasets.id, sourceHash: datasets.sourceHash })
    .from(datasets)
    .where(
      and(
        eq(datasets.tenantId, input.tenantId),
        eq(datasets.competitionId, input.competitionId),
        eq(datasets.kind, "current"),
        inArray(datasets.status, ["ready", "locked"]),
      ),
    );
  if (activeCurrentDatasets.some((dataset) => dataset.sourceHash !== source.sourceHash)) {
    throw new CurrentImportRepositoryError("source_dataset_conflict");
  }

  const [existingDataset] = await transaction
    .select()
    .from(datasets)
    .where(
      and(
        eq(datasets.tenantId, input.tenantId),
        eq(datasets.competitionId, input.competitionId),
        eq(datasets.kind, "current"),
        eq(datasets.sourceHash, source.sourceHash),
      ),
    )
    .limit(1);

  if (existingDataset) {
    if (existingDataset.status !== "ready" || existingDataset.rowCount !== session.expectedRowCount) {
      throw new CurrentImportRepositoryError("source_dataset_conflict");
    }
    const publishedRows = await transaction
      .select({
        externalRef: applications.externalRef,
        contentHash: applications.contentHash,
        identityHash: applicantIdentities.identityHash,
      })
      .from(applications)
      .innerJoin(
        applicantIdentities,
        and(
          eq(applicantIdentities.tenantId, applications.tenantId),
          eq(applicantIdentities.competitionId, applications.competitionId),
          eq(applicantIdentities.datasetId, applications.datasetId),
          eq(applicantIdentities.id, applications.identityId),
        ),
      )
      .where(
        and(
          eq(applications.tenantId, input.tenantId),
          eq(applications.competitionId, input.competitionId),
          eq(applications.datasetId, existingDataset.id),
        ),
      );
    const publishedByRef = new Map(
      publishedRows.map((row) => [row.externalRef, row] as const),
    );
    if (
      publishedRows.length !== stagedRows.length ||
      stagedRows.some((row) => {
        const published = publishedByRef.get(row.externalRef);
        return (
          !published ||
          published.contentHash !== row.contentHash ||
          published.identityHash !== row.identityHash
        );
      })
    ) throw new CurrentImportRepositoryError("source_dataset_conflict");
    const completed = await markCompleted(
      transaction,
      session,
      existingDataset.id,
      input.expectedRevision,
      input.now,
    );
    await transaction
      .delete(currentImportRows)
      .where(
        and(
          eq(currentImportRows.tenantId, input.tenantId),
          eq(currentImportRows.competitionId, input.competitionId),
          eq(currentImportRows.importSessionId, input.importSessionId),
        ),
      );
    return {
      session: summary(completed),
      datasetId: existingDataset.id,
      completedNow: true,
      reusedDataset: true,
    };
  }

  const datasetId = crypto.randomUUID();
  const datasetName = `Current applications - ${session.sourceFilename}`.slice(0, 160);
  await transaction.insert(datasets).values({
    id: datasetId,
    tenantId: input.tenantId,
    competitionId: input.competitionId,
    kind: "current",
    name: datasetName,
    status: "ready",
    sourceFilename: session.sourceFilename,
    sourceHash: source.sourceHash,
    schemaVersion: session.schemaVersion,
    rowCount: session.expectedRowCount,
    importMetadata: {
      importSessionId: session.id,
      chunkCount: session.expectedChunkCount,
      canonicalFormat: "minder-current-v1",
      canonicalBytes: source.canonicalBytes,
    },
    importedByUserId: input.actorUserId,
    createdAt: input.now,
    readyAt: input.now,
  });

  const identityRows: Array<typeof applicantIdentities.$inferInsert> = [];
  const applicationRows: Array<typeof applications.$inferInsert> = [];
  for (const row of stagedRows) {
    const identityId = crypto.randomUUID();
    identityRows.push({
      id: identityId,
      tenantId: input.tenantId,
      competitionId: input.competitionId,
      datasetId,
      externalRef: row.externalRef,
      identityData: row.identityData,
      identityHash: row.identityHash,
      createdAt: input.now,
      updatedAt: input.now,
    });
    applicationRows.push({
      tenantId: input.tenantId,
      competitionId: input.competitionId,
      datasetId,
      identityId,
      externalRef: row.externalRef,
      content: row.content,
      contentHash: row.contentHash,
      status: "imported",
      submittedAt: row.submittedAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  for (let offset = 0; offset < identityRows.length; offset += 100) {
    await transaction.insert(applicantIdentities).values(identityRows.slice(offset, offset + 100));
    await transaction.insert(applications).values(applicationRows.slice(offset, offset + 100));
  }

  const completed = await markCompleted(
    transaction,
    session,
    datasetId,
    input.expectedRevision,
    input.now,
  );
  await transaction
    .delete(currentImportRows)
    .where(
      and(
        eq(currentImportRows.tenantId, input.tenantId),
        eq(currentImportRows.competitionId, input.competitionId),
        eq(currentImportRows.importSessionId, input.importSessionId),
      ),
    );
  return {
    session: summary(completed),
    datasetId,
    completedNow: true,
    reusedDataset: false,
  };
}
