import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required before accessing the production database.");
  }
  return value;
}

function createResources() {
  const client = postgres(databaseUrl(), {
    max: Number(process.env.DB_POOL_MAX ?? 3),
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS ?? 20),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS ?? 10),
    max_lifetime: Number(process.env.DB_MAX_LIFETIME_SECONDS ?? 60 * 30),
    prepare: false,
    onnotice: process.env.NODE_ENV === "development" ? undefined : () => undefined,
  });

  return {
    client,
    database: drizzle(client, { schema }),
  };
}

type Resources = ReturnType<typeof createResources>;

const globalDatabase = globalThis as typeof globalThis & {
  __minderDatabaseResources?: Resources;
};

function resources(): Resources {
  if (!globalDatabase.__minderDatabaseResources) {
    globalDatabase.__minderDatabaseResources = createResources();
  }
  return globalDatabase.__minderDatabaseResources;
}

export function getDatabase() {
  return resources().database;
}

export function getSqlClient() {
  return resources().client;
}

export type Database = ReturnType<typeof getDatabase>;

export async function closeDatabase(): Promise<void> {
  const current = globalDatabase.__minderDatabaseResources;
  if (!current) return;
  delete globalDatabase.__minderDatabaseResources;
  await current.client.end({ timeout: 5 });
}
