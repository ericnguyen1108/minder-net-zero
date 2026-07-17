import { auditEvents } from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import {
  appendAuditEvent,
  type AppendAuditEventInput,
  type AuditTransaction,
  type CentralAuditEvent,
} from "./audit.ts";

function writer(transaction: TenantTransaction): AuditTransaction {
  return {
    async insertAuditEvent(event: CentralAuditEvent) {
      await transaction.insert(auditEvents).values({
        id: event.id,
        tenantId: event.organizationId,
        competitionId: event.competitionId,
        actorUserId: event.actorUserId,
        actorRole: event.actorRole,
        outcome: event.outcome,
        action: event.action,
        summary: event.summaryCode,
        objectType: event.targetType,
        objectId: event.targetId,
        payload: { ...event.metadata },
        occurredAt: new Date(event.occurredAt),
      });
    },
  };
}

/** Writes the audit event inside the caller's transaction. */
export async function appendPostgresAuditEvent(
  transaction: TenantTransaction,
  input: AppendAuditEventInput,
): Promise<CentralAuditEvent> {
  return appendAuditEvent(writer(transaction), input);
}
