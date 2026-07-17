import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OperatorInputError,
  assertSeparateDatabaseRoles,
  inferNeonDataRegion,
  operationMode,
  safeFailureMessage,
  validateDatabaseUrl,
  validateDeploymentEnvironment,
  validateSecretKey,
  validateSlug,
  validateTimeZone,
} from "../scripts/operator-safety.mjs";

test("operator scripts require an explicit dry-run or apply mode", () => {
  assert.equal(operationMode(["--dry-run"]), "dry-run");
  assert.equal(operationMode(["--apply"]), "apply");
  assert.throws(() => operationMode([]), /exactly one mode/);
  assert.throws(() => operationMode(["--apply", "--dry-run"]), /exactly one mode/);
  assert.throws(() => operationMode(["--force"]), /exactly one mode/);
});

test("remote database URLs require credentials, a database, and TLS", () => {
  const valid = validateDatabaseUrl(
    "postgresql://migration:long-secret@example.neon.tech/minder?sslmode=verify-full",
    "DATABASE_ADMIN_URL",
  );
  assert.equal(valid.role, "migration");
  assert.equal(valid.hostname, "example.neon.tech");
  assert.equal(valid.database, "minder");
  assert.throws(
    () => validateDatabaseUrl("postgresql://migration:secret@example.neon.tech/minder"),
    /must require TLS/,
  );
  assert.throws(() => validateDatabaseUrl("https://example.com/database"), /must use postgresql/);
  assert.throws(() => validateDatabaseUrl("postgresql://migration@example.neon.tech/minder?sslmode=require"), /role, password/);
  assert.doesNotThrow(() => validateDatabaseUrl("postgresql://local:secret@localhost/minder"));
});

test("runtime and identity connections cannot reuse the administration role", () => {
  const admin = validateDatabaseUrl(
    "postgresql://migration:admin-secret@example.neon.tech/minder?sslmode=require",
  );
  assert.throws(
    () =>
      assertSeparateDatabaseRoles(admin, {
        DATABASE_URL: "postgresql://migration:runtime-secret@example.neon.tech/minder?sslmode=require",
      }),
    /must not use the migration/,
  );
  assert.doesNotThrow(() =>
    assertSeparateDatabaseRoles(admin, {
      DATABASE_URL: "postgresql://minder_runtime:runtime-secret@example.neon.tech/minder?sslmode=require",
      IDENTITY_DATABASE_URL: "postgresql://minder_identity:identity-secret@example.neon.tech/minder?sslmode=require",
    }),
  );
});

test("Neon hostnames produce a comparable provider-region decision code", () => {
  assert.equal(
    inferNeonDataRegion("ep-example-pooler.ap-southeast-1.aws.neon.tech"),
    "aws-ap-southeast-1",
  );
  assert.equal(inferNeonDataRegion("database.internal.example.com"), null);
});

test("production Clerk inputs and stable identifiers fail closed", () => {
  assert.equal(validateDeploymentEnvironment("production"), "production");
  assert.equal(validateSlug("net-zero-2027", "slug"), "net-zero-2027");
  assert.equal(validateTimeZone("Asia/Ho_Chi_Minh"), "Asia/Ho_Chi_Minh");
  // Hyphenated dummies: the validator allows [A-Za-z0-9_-], and the hyphens
  // keep these obviously-fake fixtures from matching live-secret scanners.
  assert.equal(
    validateSecretKey("sk_live_NOT-A-REAL-KEY-000", "production"),
    "sk_live_NOT-A-REAL-KEY-000",
  );
  assert.throws(
    () => validateSecretKey("sk_test_NOT-A-REAL-KEY-000", "production"),
    /production secret key/,
  );
  assert.throws(() => validateSlug("Net Zero", "slug"), /lowercase/);
  assert.throws(() => validateTimeZone("Mars/Olympus"), /IANA timezone/);
});

test("unknown provider and database errors never echo their messages", () => {
  const secret = "postgresql://admin:do-not-print@example.neon.tech/minder";
  const output = safeFailureMessage(new Error(`connection failed: ${secret}`));
  assert.doesNotMatch(output, /do-not-print|postgresql/);
  assert.match(output, /stopped safely/);
  assert.equal(
    safeFailureMessage(new OperatorInputError("DATABASE_ADMIN_URL is required.")),
    "DATABASE_ADMIN_URL is required.",
  );
});

test("bootstrap implementation keeps secrets out of output and database roles separated", async () => {
  const [migrationSource, provisionSource, roleSql, runbook, packageJson] = await Promise.all([
    readFile(new URL("../scripts/apply-migrations.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/provision-platform.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/sql/least-privilege-roles.sql", import.meta.url), "utf8"),
    readFile(new URL("../docs/production-runbook.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  for (const source of [migrationSource, provisionSource]) {
    assert.doesNotMatch(source, /console\.(?:log|error)/);
    assert.doesNotMatch(source, /process\.stderr\.write\(`\$\{error\.message\}/);
  }
  assert.match(migrationSource, /pg_try_advisory_lock/);
  assert.match(migrationSource, /assertAppliedIntegrity/);
  assert.match(provisionSource, /twoFactorEnabled/);
  assert.match(provisionSource, /updateOrganizationMetadata/);
  assert.match(provisionSource, /platform\.bootstrap_completed/);

  assert.match(roleSql, /minder_runtime[\s\S]*NOBYPASSRLS/);
  assert.match(roleSql, /minder_identity[\s\S]*BYPASSRLS/);
  assert.match(roleSql, /REVOKE neon_superuser/);
  assert.doesNotMatch(roleSql, /PASSWORD\s+'/i);

  assert.match(runbook, /restore drill/i);
  assert.match(runbook, /data region/i);
  assert.match(runbook, /rollback/i);
  assert.match(runbook, /CLERK_WEBHOOK_SIGNING_SECRET/);
  assert.match(packageJson, /"db:migrate"/);
  assert.match(packageJson, /"platform:provision"/);
});
