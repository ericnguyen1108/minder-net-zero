import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  OperatorInputError,
  assertSeparateDatabaseRoles,
  operationMode,
  requiredEnvironment,
  safeFailureMessage,
  validateDatabaseUrl,
} from "./operator-safety.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsFolder = join(projectRoot, "drizzle");
const journalFile = join(migrationsFolder, "meta", "_journal.json");
const migrationConfig = Object.freeze({
  migrationsFolder,
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
});

function writeStatus(message) {
  process.stdout.write(`${message}\n`);
}

async function checkedInMigrations() {
  let journal;
  try {
    journal = JSON.parse(await readFile(journalFile, "utf8"));
  } catch {
    throw new OperatorInputError("The checked-in Drizzle migration journal is missing or invalid.");
  }
  const migrations = readMigrationFiles(migrationConfig);
  if (!Array.isArray(journal.entries) || migrations.length === 0 || journal.entries.length !== migrations.length) {
    throw new OperatorInputError("The checked-in migration journal and SQL files do not match.");
  }
  return migrations.map((migration, index) => {
    const entry = journal.entries[index];
    if (
      !entry ||
      !Number.isSafeInteger(entry.when) ||
      entry.when !== migration.folderMillis ||
      typeof entry.tag !== "string" ||
      !/^\d{4}_[a-z0-9_]{3,80}$/.test(entry.tag) ||
      !/^[a-f0-9]{64}$/.test(migration.hash)
    ) {
      throw new OperatorInputError("A checked-in migration has invalid journal metadata.");
    }
    return Object.freeze({ tag: entry.tag, when: entry.when, hash: migration.hash });
  });
}

async function administratorCapabilities(sql) {
  const [row] = await sql`
    select
      role.rolsuper as superuser,
      role.rolbypassrls as "bypassRls",
      coalesce((
        select pg_has_role(current_user, granted.oid, 'member')
        from pg_roles granted
        where granted.rolname = 'neon_superuser'
      ), false) as "neonAdministrator"
    from pg_roles role
    where role.rolname = current_user
  `;
  return Boolean(row && (row.superuser || row.bypassRls || row.neonAdministrator));
}

async function appliedMigrations(sql) {
  const [present] = await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (!present?.present) return [];
  return sql`
    select hash, created_at as "createdAt"
    from drizzle.__drizzle_migrations
    order by created_at asc
  `;
}

function assertAppliedIntegrity(expected, applied) {
  const expectedByTimestamp = new Map(expected.map((migration) => [migration.when, migration]));
  const byTimestamp = new Map();
  for (const migration of applied) {
    const timestamp = Number(migration.createdAt);
    if (!Number.isSafeInteger(timestamp) || !expectedByTimestamp.has(timestamp)) {
      throw new OperatorInputError("The database contains a migration not present in this release.");
    }
    if (byTimestamp.has(timestamp)) {
      throw new OperatorInputError("The database contains a duplicated migration record.");
    }
    byTimestamp.set(timestamp, migration.hash);
  }
  for (const migration of expected) {
    const hash = byTimestamp.get(migration.when);
    if (hash !== undefined && hash !== migration.hash) {
      throw new OperatorInputError(`Applied migration ${migration.tag} does not match the checked-in hash.`);
    }
  }
}

export async function run(environment = process.env, argv = process.argv.slice(2)) {
  const mode = operationMode(argv);
  const expected = await checkedInMigrations();
  const adminUrl = validateDatabaseUrl(
    requiredEnvironment(environment, "DATABASE_ADMIN_URL"),
    "DATABASE_ADMIN_URL",
  );
  assertSeparateDatabaseRoles(adminUrl, environment);

  const client = postgres(adminUrl.value, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    if (!(await administratorCapabilities(client))) {
      throw new OperatorInputError("DATABASE_ADMIN_URL must use the dedicated migration/administration role.");
    }
    const before = await appliedMigrations(client);
    assertAppliedIntegrity(expected, before);
    const pending = expected.filter(
      (migration) => !before.some((applied) => Number(applied.createdAt) === migration.when),
    );
    writeStatus(`Validated ${expected.length} checked-in migration(s); ${pending.length} pending.`);

    if (mode === "dry-run") {
      writeStatus("DRY RUN complete. The database was not changed.");
      return Object.freeze({ mode, pending: pending.length, applied: false });
    }

    const [lock] = await client`
      select pg_try_advisory_lock(hashtextextended('minder_net_zero_migrations', 0)) as acquired
    `;
    if (!lock?.acquired) {
      throw new OperatorInputError("Another migration is running. Wait for it to finish and retry.");
    }
    let applyPending = pending;
    try {
      const lockedState = await appliedMigrations(client);
      assertAppliedIntegrity(expected, lockedState);
      applyPending = expected.filter(
        (migration) => !lockedState.some((applied) => Number(applied.createdAt) === migration.when),
      );
      await migrate(drizzle(client), migrationConfig);
    } finally {
      await client`select pg_advisory_unlock(hashtextextended('minder_net_zero_migrations', 0))`;
    }

    const after = await appliedMigrations(client);
    assertAppliedIntegrity(expected, after);
    const missing = expected.filter(
      (migration) => !after.some((applied) => Number(applied.createdAt) === migration.when),
    );
    if (missing.length > 0) throw new OperatorInputError("One or more migrations were not recorded after apply.");
    writeStatus(`APPLY complete. ${applyPending.length} migration(s) applied; checked-in state verified.`);
    return Object.freeze({ mode, pending: applyPending.length, applied: true });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${safeFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
