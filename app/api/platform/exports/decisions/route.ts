import { z } from "zod";

import { withTenantTransaction } from "../../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../../lib/audit-postgres.ts";
import { principalForCompetition, principalHasPermission } from "../../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../../lib/auth/request-context.ts";
import { listDecisionApplications } from "../../../../../lib/decision-repository.ts";
import { platformJson, readPlatformJson, requestId, sameOriginMutation } from "../../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ competitionId: z.string().uuid() });

function spreadsheetSafe(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readPlatformJson(request));
  } catch {
    return platformJson({ error: { code: "invalid_request", message: "Choose a valid competition." } }, 400);
  }
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson({ error: { code: resolution.reason, message: "Export access could not be verified." } }, resolution.reason === "unauthenticated" ? 401 : 503);
  }
  const principal = principalForCompetition(resolution, body.competitionId);
  if (!principal || !principalHasPermission(principal, "export.create") || !principalHasPermission(principal, "decision.read")) {
    return platformJson({ error: { code: "permission_denied", message: "You do not have permission to export decisions." } }, 403);
  }

  try {
    const rows = await withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      async (transaction) => {
        const applications = await listDecisionApplications(transaction, principal);
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: "export.decisions_created",
          outcome: "success",
          targetType: "competition",
          targetId: principal.competitionId,
          summaryCode: "export.decisions_created",
          metadata: { recordCount: applications.length, exportFormat: "csv" },
        });
        return applications;
      },
      { isolationLevel: "repeatable read" },
    );

    const header = [
      "Application ID", "Team name", "Track", "Application status", "AI recommendation",
      "AI score", "Reviewer submissions", "Reviewer progress", "Reviewer do not progress",
      "Reviewer wider review", "Final decision", "Decision rationale", "Decision revision", "Decided at",
    ];
    const lines = [header.map(spreadsheetSafe).join(",")];
    for (const row of rows) {
      lines.push([
        row.externalId,
        row.teamName,
        row.track,
        row.applicationStatus,
        row.assessment?.recommendation ?? "",
        row.assessment?.score ?? "",
        row.reviewerSummary.submitted,
        row.reviewerSummary.progress,
        row.reviewerSummary.doNotProgress,
        row.reviewerSummary.humanReview,
        row.finalDecision?.decision ?? "",
        row.finalDecision?.rationale ?? "",
        row.finalDecision?.revision ?? "",
        row.finalDecision?.decidedAt ?? "",
      ].map(spreadsheetSafe).join(","));
    }
    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="minder-net-zero-decisions-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        Vary: "Cookie",
      },
    });
  } catch {
    return platformJson({ error: { code: "export_failed", message: "The audited decision export could not be created." } }, 500);
  }
}
