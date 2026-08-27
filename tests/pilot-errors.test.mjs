import assert from "node:assert/strict";
import test from "node:test";

import {
  isDatabaseShapedError,
  pilotActionErrorResponse,
} from "../app/api/pilot/route.ts";

test("database errors become a generic 503 without leaking PostgreSQL details", async () => {
  const error = Object.assign(
    new Error('invalid input syntax for type uuid: "private-row-id"'),
    { name: "PostgresError", code: "22P02", severity: "ERROR", routine: "string_to_uuid" },
  );
  assert.equal(isDatabaseShapedError(error), true);

  const response = pilotActionErrorResponse(error);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "pilot_store_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /private-row-id|uuid|22P02|string_to_uuid/);
});

test("database connection failures become the same generic 503", async () => {
  const error = Object.assign(new Error("write CONNECT_TIMEOUT private-db.example:5432"), {
    code: "CONNECT_TIMEOUT",
    address: "private-db.example",
  });
  assert.equal(isDatabaseShapedError(error), true);

  const response = pilotActionErrorResponse(error);
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private-db\.example|5432/);
});

test("missing pilot database configuration is a generic 503", async () => {
  const error = Object.assign(
    new Error("PILOT_DATABASE_URL (or DATABASE_URL) is required before using pilot storage."),
    { code: "PILOT_DATABASE_NOT_CONFIGURED" },
  );
  assert.equal(isDatabaseShapedError(error), true);

  const response = pilotActionErrorResponse(error);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "pilot_store_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /PILOT_DATABASE_URL|DATABASE_URL/);
});

test("safe domain validation and conflict responses keep their existing behavior", async () => {
  const validation = pilotActionErrorResponse(new Error("Enter the reviewer's name."));
  assert.equal(validation.status, 400);
  assert.deepEqual(await validation.json(), {
    error: { code: "action_failed", message: "Enter the reviewer's name." },
  });

  const conflict = pilotActionErrorResponse(new Error("revision_conflict"));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: { code: "revision_conflict" } });
});
