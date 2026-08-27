import assert from "node:assert/strict";
import test from "node:test";

import { importBatches } from "../db/pilot/import-repository.ts";

test("large imports are split into bounded database batches without losing rows", () => {
  const rows = Array.from({ length: 700 }, (_, index) => index);
  const batches = importBatches(rows);

  assert.equal(batches.length, 7);
  assert.ok(batches.every((batch) => batch.length <= 100));
  assert.deepEqual(batches.flat(), rows);
});

test("empty imports create no insert batches", () => {
  assert.deepEqual(importBatches([]), []);
});
