import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

function identityDatabaseUrl(): string {
  const value = process.env.IDENTITY_DATABASE_URL;
  if (!value) {
    throw new Error("IDENTITY_DATABASE_URL is required for signed identity synchronization.");
  }
  return value;
}

function createResources() {
  const client = postgres(identityDatabaseUrl(), {
    max: 1,
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS ?? 20),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS ?? 10),
    max_lifetime: Number(process.env.DB_MAX_LIFETIME_SECONDS ?? 60 * 30),
    prepare: false,
    onnotice: process.env.NODE_ENV === "development" ? undefined : () => undefined,
  });
  return { client, database: drizzle(client, { schema }) };
}

type Resources = ReturnType<typeof createResources>;
const globalIdentityDatabase = globalThis as typeof globalThis & {
  __minderIdentityDatabaseResources?: Resources;
};

function resources(): Resources {
  if (!globalIdentityDatabase.__minderIdentityDatabaseResources) {
    globalIdentityDatabase.__minderIdentityDatabaseResources = createResources();
  }
  return globalIdentityDatabase.__minderIdentityDatabaseResources;
}

/**
 * This connection must use a dedicated, least-privilege PostgreSQL role that
 * may bypass RLS only for the identity-sync tables documented in the runbook.
 * It must never be used by ordinary application routes.
 */
export function getIdentityDatabase() {
  return resources().database;
}

export async function closeIdentityDatabase(): Promise<void> {
  const current = globalIdentityDatabase.__minderIdentityDatabaseResources;
  if (!current) return;
  delete globalIdentityDatabase.__minderIdentityDatabaseResources;
  await current.client.end({ timeout: 5 });
}
