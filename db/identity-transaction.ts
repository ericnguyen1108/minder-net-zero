import { sql } from "drizzle-orm";

import { getIdentityDatabase } from "./identity-client.ts";
import type {
  TenantContext,
  TenantTransaction,
  TenantTransactionOptions,
} from "./tenant-transaction.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(label: string, value: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a valid UUID.`);
}

/**
 * Signed Clerk webhooks are the sole caller. Keeping this transaction helper
 * separate makes accidental privileged-database use visible in code review.
 */
export async function withIdentityTransaction<T>(
  context: TenantContext,
  work: (transaction: TenantTransaction) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  assertUuid("tenantId", context.tenantId);
  if (context.userId !== null) assertUuid("userId", context.userId);

  return getIdentityDatabase().transaction(
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
