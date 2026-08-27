import assert from "node:assert/strict";
import test from "node:test";

import { optionalDatabaseUuid } from "../app/api/pilot/input.ts";

test("legacy browser dataset ids are never sent to PostgreSQL uuid comparisons", () => {
  assert.equal(optionalDatabaseUuid("history-510dc20e227ec754d2410663f11f799a"), null);
  assert.equal(optionalDatabaseUuid("current-local-dataset"), null);
  assert.equal(optionalDatabaseUuid(null), null);
});

test("valid database ids remain eligible for replacement", () => {
  assert.equal(
    optionalDatabaseUuid(" 550E8400-E29B-41D4-A716-446655440000 "),
    "550e8400-e29b-41d4-a716-446655440000",
  );
});
