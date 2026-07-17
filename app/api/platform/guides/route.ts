import { z } from "zod";

import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../lib/audit-postgres.ts";
import { principalForCompetition, principalHasPermission } from "../../../../lib/auth/context.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { decisionGuideSchema } from "../../../../lib/decision-guide.ts";
import { appendGuideSnapshot, loadGuideState } from "../../../../lib/guide-repository.ts";
import { MAX_LARGE_PLATFORM_BODY_BYTES, platformJson, readPlatformJson, requestId, sameOriginMutation } from "../../../../lib/http-security.ts";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  competitionId: z.string().uuid(),
  action: z.enum(["save", "approve"]),
  expectedLatestVersion: z.number().int().min(0),
  title: z.string().trim().min(3).max(200),
  guide: decisionGuideSchema,
});

export async function GET(request: Request) {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    return platformJson({ error: { code: resolution.reason, message: "Decision Guide access could not be verified." } }, resolution.reason === "unauthenticated" ? 401 : 503);
  }
  const principals = resolution.principals.filter((principal) => principalHasPermission(principal, "rubric.read"));
  try {
    const guides = await Promise.all(principals.map((principal) => withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      (transaction) => loadGuideState(transaction, principal),
      { accessMode: "read only" },
    )));
    return platformJson({ competitions: resolution.context.competitions, guides });
  } catch {
    return platformJson({ error: { code: "guide_store_unavailable", message: "The shared Decision Guide is temporarily unavailable." } }, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readPlatformJson(request, { maxBytes: MAX_LARGE_PLATFORM_BODY_BYTES }));
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues[0]?.message : null;
    return platformJson({ error: { code: "invalid_guide", message: detail ?? "Complete every required Decision Guide field." } }, 400);
  }
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) return platformJson({ error: { code: resolution.reason, message: "Decision Guide access could not be verified." } }, resolution.reason === "unauthenticated" ? 401 : 503);
  const principal = principalForCompetition(resolution, body.competitionId);
  const permission = body.action === "approve" ? "rubric.approve" : "rubric.write";
  if (!principal || !principalHasPermission(principal, permission)) {
    return platformJson({ error: { code: "permission_denied", message: body.action === "approve" ? "A rubric approver account is required." : "You do not have permission to edit this guide." } }, 403);
  }
  try {
    const result = await withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      async (transaction) => {
        const snapshot = await appendGuideSnapshot(transaction, {
          principal,
          expectedLatestVersion: body.expectedLatestVersion,
          status: body.action === "approve" ? "approved" : "draft",
          title: body.title,
          guide: body.guide,
          now: new Date(),
        });
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: body.action === "approve" ? "guide.approved" : "guide.snapshot_saved",
          outcome: "success",
          targetType: "guide_version",
          targetId: snapshot.id,
          summaryCode: body.action === "approve" ? "guide.approved" : "guide.snapshot_saved",
          metadata: { guideVersionId: snapshot.id, revision: snapshot.version },
        });
        return { snapshot, state: await loadGuideState(transaction, principal) };
      },
      { isolationLevel: "serializable" },
    );
    return platformJson(result, body.action === "approve" ? 201 : 200);
  } catch (error) {
    if (error instanceof Error && error.message === "revision_conflict") {
      return platformJson({ error: { code: "revision_conflict", message: "The guide changed in another session. Load the latest version before continuing." } }, 409);
    }
    return platformJson({ error: { code: "guide_save_failed", message: "The guide could not be saved safely." } }, 500);
  }
}
