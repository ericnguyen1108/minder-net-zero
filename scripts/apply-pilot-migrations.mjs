/**
 * Standalone migration runner for the Minder Net Zero PILOT schema
 * (migrations/pilot/*.sql -> schemas netzero + netzero_ai).
 *
 * Deliberately separate from scripts/apply-migrations.mjs, which runs the
 * Clerk-era drizzle/ platform (0000-0002). The pilot depends on none of that
 * and must not drag those 29 unused tables into a pilot database.
 *
 * Applies each pending .sql file once, in filename order, inside a transaction,
 * and records its SHA-256 in public.netzero_pilot_migrations. A previously
 * applied file whose contents changed is a hard error (no silent drift).
 *
 * Usage:
 *   PILOT_DATABASE_URL=postgres://owner:...@host/db node scripts/apply-pilot-migrations.mjs
 * (falls back to DATABASE_URL). Connect as a role that can create schemas,
 * roles, and set the ranking view's owner - on Supabase that is the `postgres`
 * role via the DIRECT (port 5432) connection, not the transaction pooler.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(projectRoot, "migrations", "pilot");

function databaseUrl() {
  const url = (process.env.PILOT_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new Error("PILOT_DATABASE_URL (or DATABASE_URL) is required.");
  }
  return url;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function pendingFiles() {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

async function run() {
  const sql = postgres(databaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS public.netzero_pilot_migrations (
        tag        text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;

    const applied = new Map(
      (await sql`SELECT tag, sha256 FROM public.netzero_pilot_migrations`).map((r) => [r.tag, r.sha256]),
    );

    const files = await pendingFiles();
    if (files.length === 0) throw new Error(`No .sql files found in ${migrationsDir}`);

    let appliedCount = 0;
    for (const file of files) {
      const tag = file.replace(/\.sql$/, "");
      const contents = await readFile(join(migrationsDir, file), "utf8");
      const hash = createHash("sha256").update(contents).digest("hex");

      const priorHash = applied.get(tag);
      if (priorHash) {
        if (priorHash !== hash) {
          throw new Error(
            `Migration ${tag} was already applied but its contents changed (` +
              `${priorHash.slice(0, 12)} -> ${hash.slice(0, 12)}). ` +
              `Add a NEW migration instead of editing an applied one.`,
          );
        }
        log(`= ${tag} (already applied)`);
        continue;
      }

      log(`+ ${tag} applying...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO public.netzero_pilot_migrations (tag, sha256) VALUES (${tag}, ${hash})`;
      });
      appliedCount += 1;
      log(`  done`);
    }

    log(appliedCount === 0 ? "Pilot schema already up to date." : `Applied ${appliedCount} migration(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

run().catch((error) => {
  process.stderr.write(`Pilot migration failed: ${error.message}\n`);
  process.exitCode = 1;
});
