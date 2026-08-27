/**
 * Server-only Postgres client for the Minder Net Zero PILOT schema
 * (schemas netzero + netzero_ai, migrations/pilot/*). Distinct from
 * db/client.ts, which is the Clerk-era platform connection.
 *
 * The runtime role in PILOT_DATABASE_URL / DATABASE_URL must be a member of
 * netzero_app (never a superuser and never the migration owner), so the
 * privilege-based AI/human separation actually binds. Every query below
 * schema-qualifies its tables, so no search_path is assumed.
 */

import postgres from "postgres";

if (typeof window !== "undefined") {
  throw new Error("db/pilot/client is server-only and must not be imported in the browser.");
}

export type Sql = postgres.Sql<Record<string, never>>;

export const PILOT_DATABASE_NOT_CONFIGURED = "PILOT_DATABASE_NOT_CONFIGURED";

function connectionString(): string {
  const url = (process.env.PILOT_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw Object.assign(
      new Error("PILOT_DATABASE_URL (or DATABASE_URL) is required before using pilot storage."),
      { code: PILOT_DATABASE_NOT_CONFIGURED },
    );
  }
  return url;
}

function createClient(): Sql {
  return postgres(connectionString(), {
    max: Number(process.env.DB_POOL_MAX ?? 3),
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS ?? 20),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS ?? 10),
    // prepare:false is required behind Supabase's transaction pooler (Supavisor).
    prepare: false,
    onnotice: () => undefined,
  });
}

// One pool per process (Next.js route handlers reuse the module instance).
const globalForPilot = globalThis as typeof globalThis & { __minderPilotSql?: Sql };

export function pilotSql(): Sql {
  if (!globalForPilot.__minderPilotSql) {
    globalForPilot.__minderPilotSql = createClient();
  }
  return globalForPilot.__minderPilotSql;
}

/** Runs `fn` inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw). */
export function withPilotTransaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return pilotSql().begin((tx) => fn(tx as unknown as Sql)) as Promise<T>;
}
