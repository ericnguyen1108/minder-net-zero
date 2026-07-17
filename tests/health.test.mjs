import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET as liveGet, HEAD as liveHead } from "../app/api/health/live/route.ts";
import {
  explicitProductionAuthConfigured,
  isPlatformAdministratorRoleSet,
  runReadinessChecks,
} from "../lib/readiness.ts";

test("public liveness reports only process state and is never cached", async () => {
  const response = liveGet();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const head = liveHead();
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("production authentication mode must be explicitly configured", () => {
  assert.equal(explicitProductionAuthConfigured("clerk"), true);
  assert.equal(explicitProductionAuthConfigured(" CLERK "), true);
  assert.equal(explicitProductionAuthConfigured(undefined), false);
  assert.equal(explicitProductionAuthConfigured(""), false);
  assert.equal(explicitProductionAuthConfigured("legacy"), false);
  assert.equal(explicitProductionAuthConfigured("anything-else"), false);
});

test("only owner and competition administrator roles qualify for readiness", () => {
  assert.equal(isPlatformAdministratorRoleSet(["owner"]), true);
  assert.equal(isPlatformAdministratorRoleSet(["reviewer", "competition_admin"]), true);
  assert.equal(isPlatformAdministratorRoleSet(["rubric_manager", "auditor"]), false);
  assert.equal(isPlatformAdministratorRoleSet([]), false);
});

test("readiness succeeds only after a real database probe", async () => {
  let probes = 0;
  const result = await runReadinessChecks({
    authMode: "clerk",
    databaseProbe: async () => {
      probes += 1;
      return 1;
    },
    identityDatabaseProbe: async () => {
      probes += 1;
      return 1;
    },
  });
  assert.equal(probes, 2);
  assert.deepEqual(result, {
    ready: true,
    checks: {
      authenticationConfiguration: "ok",
      databaseConnectivity: "ok",
      identitySyncConnectivity: "ok",
    },
  });
});

test("readiness skips the database for invalid auth configuration", async () => {
  let probes = 0;
  const result = await runReadinessChecks({
    authMode: "legacy",
    databaseProbe: async () => {
      probes += 1;
    },
    identityDatabaseProbe: async () => {
      probes += 1;
    },
  });
  assert.equal(probes, 0);
  assert.deepEqual(result, {
    ready: false,
    checks: {
      authenticationConfiguration: "failed",
      databaseConnectivity: "skipped",
      identitySyncConnectivity: "skipped",
    },
  });
});

test("database failures become categorical state without leaking error details", async () => {
  const result = await runReadinessChecks({
    authMode: "clerk",
    databaseProbe: async () => {
      throw new Error("postgres://username:secret@example.test/private_database");
    },
    identityDatabaseProbe: async () => undefined,
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.databaseConnectivity, "failed");
  assert.equal(result.checks.identitySyncConnectivity, "ok");
  assert.doesNotMatch(JSON.stringify(result), /username|secret|example\.test|private_database/);
});

test("readiness route is authenticated, admin-gated, and uses a metadata-free query", async () => {
  const source = await readFile(
    new URL("../app/api/health/ready/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /resolveRequestPlatformContext/);
  assert.match(source, /isPlatformAdministratorRoleSet\(principal\.roles\)/);
  assert.match(source, /select 1 as ready/);
  assert.match(source, /process\.env\.AUTH_MODE/);
  assert.doesNotMatch(source, /error\.message|DATABASE_URL|CLERK_SECRET_KEY|connectionString/);
});
