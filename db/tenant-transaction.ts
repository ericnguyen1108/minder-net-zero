import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";

import { getDatabase } from "./client.ts";
import * as schema from "./schema.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TenantContext {
  tenantId: string;
  userId: string | null;
  requestId?: string;
}

export interface TenantTransactionOptions {
  isolationLevel?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  accessMode?: "read only" | "read write";
  deferrable?: boolean;
}

export type TenantTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

function assertUuid(label: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a valid UUID.`);
  }
}

/**
 * The only supported entry point for tenant-scoped application queries.
 * PostgreSQL RLS reads these transaction-local settings and fails closed when
 * they are absent. Never accept tenantId/userId directly from an untrusted body;
 * derive them from the authenticated session and authorized competition route.
 */
export async function withTenantTransaction<T>(
  context: TenantContext,
  work: (transaction: TenantTransaction) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  assertUuid("tenantId", context.tenantId);
  if (context.userId !== null) assertUuid("userId", context.userId);

  const database = getDatabase();
  return database.transaction(
    async (transaction) => {
      await transaction.execute(sql`
        select
          set_config('app.tenant_id', ${context.tenantId}, true),
          set_config('app.user_id', ${context.userId ?? ""}, true),
          set_config('app.request_id', ${context.requestId ?? ""}, true)
      `);

      return work(transaction);
    },
    {
      isolationLevel: options.isolationLevel ?? "read committed",
      accessMode: options.accessMode ?? "read write",
      deferrable: options.deferrable ?? false,
    },
  );
}
