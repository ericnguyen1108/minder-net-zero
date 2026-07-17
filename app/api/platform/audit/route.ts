import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
} from "drizzle-orm";
import { z } from "zod";

import { auditEvents, users } from "../../../../db/schema.ts";
import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { principalHasPermission, type ServerPrincipal } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { platformJson, requestId } from "../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

type Cursor = { occurredAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value || value.length > 500) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.occurredAt !== "string" ||
      !Number.isFinite(new Date(record.occurredAt).getTime()) ||
      typeof record.id !== "string" ||
      !z.string().uuid().safeParse(record.id).success
    ) return null;
    return { occurredAt: record.occurredAt, id: record.id };
  } catch {
    return null;
  }
}

function safeSearch(value: string | null, max: number): string {
  return (value ?? "").trim().slice(0, max).replace(/[\\%_]/g, "");
}

async function loadCompetitionAudit(
  principal: ServerPrincipal,
  request: Request,
  filters: { cursor: Cursor | null; action: string; actor: string; from: Date | null; to: Date | null },
) {
  return withTenantTransaction(
    { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
    async (transaction) => {
      const conditions = [
        eq(auditEvents.tenantId, principal.organizationId),
        eq(auditEvents.competitionId, principal.competitionId),
      ];
      if (filters.cursor) {
        const at = new Date(filters.cursor.occurredAt);
        conditions.push(
          or(
            lt(auditEvents.occurredAt, at),
            and(eq(auditEvents.occurredAt, at), lt(auditEvents.id, filters.cursor.id)),
          )!,
        );
      }
      if (filters.action) conditions.push(ilike(auditEvents.action, `%${filters.action}%`));
      if (filters.actor) {
        conditions.push(
          or(ilike(users.displayName, `%${filters.actor}%`), ilike(users.email, `%${filters.actor}%`))!,
        );
      }
      if (filters.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
      if (filters.to) conditions.push(lte(auditEvents.occurredAt, filters.to));

      const rows = await transaction
        .select({ event: auditEvents, actorName: users.displayName, actorEmail: users.email })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(and(...conditions))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .limit(51);

      const needed = rows
        .map((row) => row.event.sequence - BigInt(1))
        .filter((sequence) => sequence > BigInt(0));
      const previousRows = needed.length
        ? await transaction
            .select({ sequence: auditEvents.sequence, eventHash: auditEvents.eventHash })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.tenantId, principal.organizationId),
                inArray(auditEvents.sequence, [...new Set(needed)]),
              ),
            )
        : [];
      const previousBySequence = new Map(previousRows.map((row) => [row.sequence.toString(), row.eventHash]));
      return rows.map(({ event, actorName, actorEmail }) => ({
        id: event.id,
        createdAt: event.occurredAt.toISOString(),
        actorName: actorName?.trim() || "Minder system",
        actorEmail: actorEmail ?? "system",
        actorRole: event.actorRole ?? "system",
        action: event.action,
        resourceType: event.objectType,
        resourceLabel: event.summary,
        reason: event.reason,
        requestId: event.requestId ?? "—",
        outcome: event.outcome,
        chainVerified:
          event.sequence === BigInt(1)
            ? event.previousHash === "0".repeat(64)
            : previousBySequence.get((event.sequence - BigInt(1)).toString()) === event.previousHash,
      }));
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

export async function GET(request: Request) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson(
      { error: { code: resolution.reason, message: "Audit access could not be verified." } },
      resolution.reason === "unauthenticated" ? 401 : 503,
    );
  }
  const principals = resolution.principals.filter((principal) => principalHasPermission(principal, "audit.read"));
  if (principals.length === 0) {
    return platformJson({ error: { code: "permission_denied", message: "You do not have permission to view the audit log." } }, 403);
  }

  const url = new URL(request.url);
  const cursorValue = url.searchParams.get("cursor");
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) {
    return platformJson({ error: { code: "invalid_cursor", message: "The audit page cursor is invalid." } }, 400);
  }
  const fromValue = url.searchParams.get("from");
  const toValue = url.searchParams.get("to");
  const from = fromValue ? new Date(`${fromValue}T00:00:00.000Z`) : null;
  const to = toValue ? new Date(`${toValue}T23:59:59.999Z`) : null;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) {
    return platformJson({ error: { code: "invalid_date", message: "Choose valid audit dates." } }, 400);
  }

  try {
    const groups = await Promise.all(
      principals.map((principal) =>
        loadCompetitionAudit(principal, request, {
          cursor,
          action: safeSearch(url.searchParams.get("action"), 80),
          actor: safeSearch(url.searchParams.get("actor"), 160),
          from,
          to,
        }),
      ),
    );
    const all = groups
      .flat()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const events = all.slice(0, 50);
    const last = events.at(-1);
    return platformJson({
      events,
      nextCursor: all.length > 50 && last ? encodeCursor({ occurredAt: last.createdAt, id: last.id }) : null,
    });
  } catch {
    return platformJson({ error: { code: "audit_store_unavailable", message: "The central audit history is temporarily unavailable." } }, 503);
  }
}
