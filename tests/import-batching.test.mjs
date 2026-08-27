import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Postgres.js bulk inserts let the values builder emit the column list", async () => {
  const source = await readFile(new URL("../db/pilot/import-repository.ts", import.meta.url), "utf8");
  for (const table of ["historical_rows", "current_cases", "current_identities"]) {
    assert.match(source, new RegExp(`INSERT INTO netzero\\.${table}\\s+\\$\\{tx\\(`));
  }
  assert.doesNotMatch(
    source,
    /INSERT INTO netzero\.(?:historical_rows|current_cases|current_identities)\s+\([^)]*\)\s+\$\{tx\(/,
    "an explicit column list duplicates the one emitted by Postgres.js and produces SQL 42601",
  );
});
