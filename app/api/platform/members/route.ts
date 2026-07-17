import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

import { withTenantTransaction } from "../../../../db/tenant-transaction.ts";
import { appendPostgresAuditEvent } from "../../../../lib/audit-postgres.ts";
import { principalForCompetition } from "../../../../lib/auth/context.ts";
import {
  authorizationErrorResponse,
  requirePermission,
  RouteAuthorizationError,
} from "../../../../lib/auth/guards.ts";
import { resolveRequestPlatformContext } from "../../../../lib/auth/request-context.ts";
import { isPlatformRole } from "../../../../lib/auth/roles.ts";
import {
  platformJson,
  readPlatformJson,
  requestId,
  sameOriginMutation,
} from "../../../../lib/http-security.ts";
import {
  listCompetitionPeople,
  replaceCompetitionRoles,
  saveInvitationRecord,
} from "../../../../lib/platform-repository.ts";

export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const mutableRole = z
  .string()
  .refine(
    (value) =>
      isPlatformRole(value) &&
      value !== "owner",
    "Unknown competition role.",
  );
const inviteBody = z.object({
  competitionId: uuid,
  email: z.string().trim().email().max(320),
  roles: z.array(mutableRole).min(1).max(5).transform((roles) => [...new Set(roles)]),
});
const updateBody = z.object({
  competitionId: uuid,
  userId: uuid,
  roles: z.array(mutableRole).min(1).max(5).transform((roles) => [...new Set(roles)]),
});

async function authorizedPrincipal(competitionId: string, permission: "membership.read" | "membership.manage") {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) throw new Error(`context:${resolution.reason}`);
  const principal = principalForCompetition(resolution, competitionId);
  if (!principal) throw new Error("not_found");
  requirePermission(principal, permission, {
    organizationId: principal.organizationId,
    competitionId,
  });
  return principal;
}

function routeError(error: unknown) {
  if (error instanceof RouteAuthorizationError) return authorizationErrorResponse(error);
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("context:unauthenticated")) {
    return platformJson({ error: { code: "not_authenticated", message: "Sign in to continue." } }, 401);
  }
  if (message.startsWith("context:")) {
    return platformJson({ error: { code: "account_unavailable", message: "Account access is temporarily unavailable." } }, 503);
  }
  if (message === "not_found") {
    return platformJson({ error: { code: "resource_not_found", message: "The competition was not found." } }, 404);
  }
  if (message === "owner_roles_managed_by_identity_provider") {
    return platformJson({ error: { code: "owner_role_locked", message: "Owner access is managed in the identity service and cannot be removed here." } }, 409);
  }
  return platformJson({ error: { code: "request_failed", message: "The team change could not be completed." } }, 500);
}

export async function GET(request: Request) {
  const competitionId = new URL(request.url).searchParams.get("competitionId") ?? "";
  if (!uuid.safeParse(competitionId).success) {
    return platformJson({ error: { code: "invalid_request", message: "Choose a valid competition." } }, 400);
  }
  try {
    const principal = await authorizedPrincipal(competitionId, "membership.read");
    const people = await withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      (transaction) => listCompetitionPeople(transaction, principal.organizationId, competitionId),
      { accessMode: "read only" },
    );
    return platformJson(people);
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  let body: z.infer<typeof inviteBody>;
  try {
    body = inviteBody.parse(await readPlatformJson(request));
  } catch {
    return platformJson({ error: { code: "invalid_request", message: "Enter a valid email and at least one role." } }, 400);
  }

  let providerInvitation: Awaited<ReturnType<Awaited<ReturnType<typeof clerkClient>>["organizations"]["createOrganizationInvitation"]>> | null = null;
  try {
    const principal = await authorizedPrincipal(body.competitionId, "membership.manage");
    const clerkSession = await auth();
    if (!clerkSession.orgId || clerkSession.userId !== principal.providerUserId) {
      return platformJson({ error: { code: "identity_mismatch", message: "Sign in again to continue." } }, 401);
    }
    const client = await clerkClient();
    providerInvitation = await client.organizations.createOrganizationInvitation({
      organizationId: clerkSession.orgId,
      emailAddress: body.email.toLowerCase(),
      role: "org:member",
      inviterUserId: clerkSession.userId,
      expiresInDays: 14,
      redirectUrl: `${new URL(request.url).origin}/review`,
      privateMetadata: {
        minderCompetitionId: body.competitionId,
        minderRoles: body.roles,
      },
    });

    const invitation = await withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      async (transaction) => {
        const stored = await saveInvitationRecord(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          providerInvitationId: providerInvitation!.id,
          email: body.email.toLowerCase(),
          roles: body.roles,
          invitedByUserId: principal.actorUserId,
          expiresAt: new Date(providerInvitation!.expiresAt),
        });
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: "membership.invited",
          outcome: "success",
          targetType: "organization_invitation",
          targetId: stored.id,
          summaryCode: "membership.invited",
          metadata: { changedFields: ["email", "roles"], role: body.roles.join("+") },
        });
        return stored;
      },
      { isolationLevel: "serializable" },
    );
    return platformJson({ invitation }, 201);
  } catch (error) {
    if (providerInvitation) {
      try {
        const clerkSession = await auth();
        if (clerkSession.orgId) {
          const client = await clerkClient();
          await client.organizations.revokeOrganizationInvitation({
            organizationId: clerkSession.orgId,
            invitationId: providerInvitation.id,
            requestingUserId: clerkSession.userId ?? undefined,
          });
        }
      } catch {
        // The signed webhook reconciler will detect an unmatched invitation.
      }
    }
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  if (!sameOriginMutation(request)) {
    return platformJson({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  let body: z.infer<typeof updateBody>;
  try {
    body = updateBody.parse(await readPlatformJson(request));
  } catch {
    return platformJson({ error: { code: "invalid_request", message: "Choose a valid member and role set." } }, 400);
  }
  try {
    const principal = await authorizedPrincipal(body.competitionId, "membership.manage");
    const member = await withTenantTransaction(
      { tenantId: principal.organizationId, userId: principal.actorUserId, requestId: requestId(request) },
      async (transaction) => {
        const updated = await replaceCompetitionRoles(transaction, {
          tenantId: principal.organizationId,
          competitionId: body.competitionId,
          targetUserId: body.userId,
          roles: body.roles,
          actorUserId: principal.actorUserId,
          now: new Date(),
        });
        if (!updated) throw new Error("not_found");
        await appendPostgresAuditEvent(transaction, {
          actor: principal,
          action: "membership.roles_changed",
          outcome: "success",
          targetType: "user",
          targetId: body.userId,
          summaryCode: "membership.roles_changed",
          metadata: { changedFields: ["roles"], role: body.roles.join("+") },
        });
        return updated;
      },
      { isolationLevel: "serializable" },
    );
    return platformJson({ member });
  } catch (error) {
    return routeError(error);
  }
}
