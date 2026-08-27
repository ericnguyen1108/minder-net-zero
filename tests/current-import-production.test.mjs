import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_CURRENT_IMPORT_ROWS_PER_CHUNK,
  CurrentImportContractError,
  currentImportSourceHash,
  normalizeCurrentImportRow,
  prepareCurrentImportChunk,
  stableStringify,
} from "../lib/current-import-contract.ts";

function row(externalRef, overrides = {}) {
  return {
    externalRef,
    identityData: { contactEmail: `${externalRef}@example.test`, teamName: `Team ${externalRef}` },
    content: {
      answers: [
        { heading: "Climate impact", value: `Evidence for ${externalRef}` },
        { heading: "Team", value: "Two founders" },
      ],
    },
    submittedAt: "2026-07-16T10:00:00+07:00",
    ...overrides,
  };
}

test("canonical import hashing is stable across object key order", async () => {
  const left = row("team-001");
  const right = {
    submittedAt: left.submittedAt,
    content: { answers: left.content.answers },
    identityData: { teamName: "Team team-001", contactEmail: "team-001@example.test" },
    externalRef: "team-001",
  };
  const [leftChunk, rightChunk] = await Promise.all([
    prepareCurrentImportChunk([left]),
    prepareCurrentImportChunk([right]),
  ]);
  assert.equal(leftChunk.chunkHash, rightChunk.chunkHash);
  assert.equal(leftChunk.rows[0].rowHash, rightChunk.rows[0].rowHash);
  assert.equal(leftChunk.rows[0].identityHash, rightChunk.rows[0].identityHash);
  assert.match(leftChunk.chunkHash, /^[0-9a-f]{64}$/);
});

test("normalization trims references and converts timestamps to UTC", () => {
  const normalized = normalizeCurrentImportRow(row("  team-002  "));
  assert.equal(normalized.externalRef, "team-002");
  assert.equal(normalized.submittedAt, "2026-07-16T03:00:00.000Z");
});

test("chunks reject duplicate references before any central write", async () => {
  await assert.rejects(
    () => prepareCurrentImportChunk([row("duplicate"), row(" duplicate ")]),
    (error) =>
      error instanceof CurrentImportContractError && error.code === "duplicate_external_ref",
  );
});

test("Vercel-sized chunks enforce the 25-row boundary", async () => {
  const accepted = await prepareCurrentImportChunk(
    Array.from({ length: MAX_CURRENT_IMPORT_ROWS_PER_CHUNK }, (_, index) => row(`team-${index}`)),
  );
  assert.equal(accepted.rows.length, 25);
  await assert.rejects(
    () =>
      prepareCurrentImportChunk(
        Array.from({ length: MAX_CURRENT_IMPORT_ROWS_PER_CHUNK + 1 }, (_, index) =>
          row(`overflow-${index}`),
        ),
      ),
    (error) => error instanceof CurrentImportContractError && error.code === "invalid_chunk_size",
  );
});

test("whole-source hash binds row order and all candidate content", async () => {
  const first = normalizeCurrentImportRow(row("team-a"));
  const second = normalizeCurrentImportRow(row("team-b"));
  const original = await currentImportSourceHash([first, second]);
  const reordered = await currentImportSourceHash([second, first]);
  const changed = await currentImportSourceHash([
    first,
    normalizeCurrentImportRow(row("team-b", { content: { answer: "Changed evidence" } })),
  ]);
  assert.notEqual(original.sourceHash, reordered.sourceHash);
  assert.notEqual(original.sourceHash, changed.sourceHash);
  assert.equal(
    stableStringify({ b: 2, a: 1 }),
    stableStringify({ a: 1, b: 2 }),
  );
});

test("production import routes are server-authorized, transactional and centrally audited", async () => {
  const [http, createRoute, chunkRoute, finalizeRoute, repository, migration] = await Promise.all([
    readFile(new URL("../lib/current-import-http.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/imports/current/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../app/api/platform/imports/current/[importId]/chunks/[chunkIndex]/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/api/platform/imports/current/[importId]/finalize/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/current-import-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_current_import_staging.sql", import.meta.url), "utf8"),
  ]);

  assert.match(http, /resolveRequestPlatformContext/);
  assert.match(http, /principalHasPermission\(principal, "application\.import"\)/);
  for (const route of [createRoute, chunkRoute, finalizeRoute]) {
    assert.match(route, /authorizeCurrentImport/);
    assert.match(route, /withTenantTransaction/);
    assert.match(route, /appendPostgresAuditEvent/);
    assert.match(route, /sameOriginMutation/);
    assert.doesNotMatch(route, /localStorage|indexedDB|historical-data|current-data/);
  }
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /current-cohort/);
  assert.match(repository, /inArray\(datasets\.status, \["ready", "locked"\]\)/);
  assert.match(repository, /dataset\.sourceHash !== source\.sourceHash/);
  assert.match(repository, /currentImportSourceHash/);
  assert.match(repository, /duplicate_external_ref/);
  assert.match(repository, /transaction\.insert\(applicantIdentities\)/);
  assert.match(repository, /transaction\.insert\(applications\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /app_current_tenant_id/);
});

test("the production import screen cannot reuse stale confirmations or mutate an active upload", async () => {
  const manager = await readFile(
    new URL("../app/applications/current-import-manager.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    manager,
    /function resetPublishedResult\(\)[\s\S]*setDatasetId\(null\)[\s\S]*setMessage\(""\)[\s\S]*setState\("ready"\)/,
  );
  assert.match(manager, /if \(state === "uploading"\) return;/);
  assert.match(manager, /disabled=\{state === "reading" \|\| state === "uploading"\}/);
  assert.match(manager, /central-response-picker" disabled=\{state === "uploading"\}/);
});

test("audit metadata contains identifiers, counts and hashes but no candidate payload", async () => {
  const [chunkRoute, finalizeRoute] = await Promise.all([
    readFile(
      new URL(
        "../app/api/platform/imports/current/[importId]/chunks/[chunkIndex]/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/api/platform/imports/current/[importId]/finalize/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const chunkAudit = chunkRoute.slice(chunkRoute.lastIndexOf("await appendPostgresAuditEvent"));
  const finalizeAudit = finalizeRoute.slice(finalizeRoute.lastIndexOf("await appendPostgresAuditEvent"));
  assert.doesNotMatch(chunkAudit, /identityData|\.content\b|sourceFilename|submittedAt/);
  assert.doesNotMatch(finalizeAudit, /identityData|\.content\b|sourceFilename|submittedAt/);
  assert.match(chunkAudit, /batchSize/);
  assert.match(chunkAudit, /importHash/);
  assert.match(finalizeAudit, /recordCount/);
  assert.match(finalizeAudit, /datasetId/);
});
