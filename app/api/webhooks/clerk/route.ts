import { clerkClient } from "@clerk/nextjs/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type { WebhookEvent } from "@clerk/nextjs/server";

import {
  auditEvents,
  competitionRoleGrants,
  idempotencyKeys,
  organizationInvitations,
  organizationMemberships,
  organizations,
  users,
} from "../../../../db/schema.ts";
import { withIdentityTransaction } from "../../../../db/identity-transaction.ts";
import { parseMinderTenantId } from "../../../../lib/auth/context.ts";
import { platformJson } from "../../../../lib/http-security.ts";
import {
  parseMutablePlatformRoles,
  replaceCompetitionRoles,
} from "../../../../lib/platform-repository.ts";

export const dynamic = "force-dynamic";

type RelevantEvent = Extract<
  WebhookEvent,
  {
    type:
      | "organizationMembership.created"
      | "organizationMembership.updated"
      | "organizationMembership.deleted"
      | "organizationInvitation.accepted";
  }
> | (
  Extract<
    WebhookEvent,
    { type: "organizationInvitation.created" | "organizationInvitation.revoked" }
  > & { type: "organizationInvitation.revoked" }
);

function isRelevantEvent(event: WebhookEvent): event is RelevantEvent {
  return event.type === "organizationMembership.created" ||
    event.type === "organizationMembership.updated" ||
    event.type === "organizationMembership.deleted" ||
    event.type === "organizationInvitation.accepted" ||
    event.type === "organizationInvitation.revoked";
}

function organizationIdForEvent(event: RelevantEvent): string {
  if ("organization" in event.data) return event.data.organization.id;
  return event.data.organization_id;
}

function memberUserIdForEvent(event: RelevantEvent): string | null {
  if ("public_user_data" in event.data) {
    return event.data.public_user_data.user_id;
  }
  if (event.type === "organizationInvitation.accepted") return event.data.user_id;
  return null;
}

function membershipRole(value: string): "owner" | "admin" | "member" {
  if (value === "org:admin") return "admin";
  return "member";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: NextRequest) {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return platformJson({ error: { code: "webhook_not_configured", message: "Webhook verification is not configured." } }, 503);
  }

  const webhookId = request.headers.get("svix-id") ?? request.headers.get("webhook-id") ?? "";
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(webhookId)) {
    return platformJson({ error: { code: "invalid_webhook", message: "Webhook identifier is missing." } }, 400);
  }

  let verifiedEvent: WebhookEvent;
  try {
    verifiedEvent = await verifyWebhook(request, { signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch {
    return platformJson({ error: { code: "invalid_signature", message: "Webhook signature rejected." } }, 400);
  }
  if (!isRelevantEvent(verifiedEvent)) return platformJson({ received: true, ignored: true });
  const event = verifiedEvent;

  const providerOrganizationId = organizationIdForEvent(event);

  try {
    const client = await clerkClient();
    const providerOrganization = await client.organizations.getOrganization({
      organizationId: providerOrganizationId,
    });
    const tenantId = parseMinderTenantId(providerOrganization.privateMetadata);
    if (!tenantId) throw new Error("organization_mapping_invalid");

    const providerUserId = memberUserIdForEvent(event);
    let providerUser: Awaited<ReturnType<typeof client.users.getUser>> | null = null;
    if (providerUserId) {
      try {
        providerUser = await client.users.getUser(providerUserId);
      } catch {
        if (event.type !== "organizationMembership.deleted") throw new Error("provider_user_unavailable");
      }
    }
    const primaryEmail = providerUser
      ? providerUser.emailAddresses.find((email) => email.id === providerUser.primaryEmailAddressId) ??
        providerUser.emailAddresses[0]
      : null;
    if (
      event.type !== "organizationInvitation.revoked" &&
      event.type !== "organizationMembership.deleted" &&
      (!providerUser || !primaryEmail)
    ) {
      throw new Error("provider_user_incomplete");
    }
    const eventHash = await sha256(`${webhookId}\u001f${event.type}\u001f${event.data.id}`);

    await withIdentityTransaction(
      { tenantId, userId: null, requestId: webhookId },
      async (transaction) => {
        const [mappedOrganization] = await transaction
          .select()
          .from(organizations)
          .where(
            and(
              eq(organizations.id, tenantId),
              eq(organizations.authProvider, "clerk"),
              eq(organizations.authSubject, providerOrganizationId),
            ),
          )
          .limit(1);
        if (!mappedOrganization) throw new Error("organization_mapping_invalid");

        const inserted = await transaction
          .insert(idempotencyKeys)
          .values({
            tenantId,
            scope: "clerk_webhook",
            key: webhookId,
            requestHash: eventHash,
            status: "processing",
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          })
          .onConflictDoNothing()
          .returning({ id: idempotencyKeys.id });
        if (inserted.length === 0) {
          const [existing] = await transaction
            .select()
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.tenantId, tenantId),
                eq(idempotencyKeys.scope, "clerk_webhook"),
                eq(idempotencyKeys.key, webhookId),
              ),
            )
            .limit(1);
          if (existing?.requestHash !== eventHash) throw new Error("webhook_replay_mismatch");
          if (existing.status === "completed") return;
          throw new Error("webhook_in_progress");
        }

        let internalUserId: string | null = null;
        if (providerUser && primaryEmail) {
          const displayName =
            [providerUser.firstName, providerUser.lastName].filter(Boolean).join(" ").trim() ||
            primaryEmail.emailAddress;
          const [internalUser] = await transaction
            .insert(users)
            .values({
              authProvider: "clerk",
              authSubject: providerUser.id,
              email: primaryEmail.emailAddress.toLowerCase(),
              displayName,
              emailVerified: primaryEmail.verification?.status === "verified",
            })
            .onConflictDoUpdate({
              target: [users.authProvider, users.authSubject],
              set: {
                email: primaryEmail.emailAddress.toLowerCase(),
                displayName,
                emailVerified: primaryEmail.verification?.status === "verified",
                disabledAt: null,
                updatedAt: new Date(),
              },
            })
            .returning({ id: users.id });
          internalUserId = internalUser.id;
        } else if (providerUserId && event.type === "organizationMembership.deleted") {
          const [internalUser] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.authProvider, "clerk"),
                eq(users.authSubject, providerUserId),
              ),
            )
            .limit(1);
          internalUserId = internalUser?.id ?? null;
        }

        if (
          (event.type === "organizationMembership.created" ||
            event.type === "organizationMembership.updated" ||
            event.type === "organizationMembership.deleted") &&
          internalUserId
        ) {
          const removed = event.type === "organizationMembership.deleted";
          await transaction
            .insert(organizationMemberships)
            .values({
              tenantId,
              userId: internalUserId,
              role: membershipRole(event.data.role),
              status: removed ? "removed" : "active",
              acceptedAt: removed ? null : new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [organizationMemberships.tenantId, organizationMemberships.userId],
              set: {
                role: sql`case when ${organizationMemberships.role} = 'owner' then 'owner'::membership_role else ${membershipRole(event.data.role)}::membership_role end`,
                status: removed ? "removed" : "active",
                acceptedAt: removed ? null : new Date(),
                updatedAt: new Date(),
              },
            });
          if (removed) {
            await transaction
              .update(competitionRoleGrants)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(competitionRoleGrants.tenantId, tenantId),
                  eq(competitionRoleGrants.userId, internalUserId),
                  isNull(competitionRoleGrants.revokedAt),
                ),
              );
          }
        }

        if (event.type === "organizationInvitation.accepted" && internalUserId) {
          const [invitation] = await transaction
            .select()
            .from(organizationInvitations)
            .where(
              and(
                eq(organizationInvitations.tenantId, tenantId),
                eq(organizationInvitations.providerInvitationId, event.data.id),
              ),
            )
            .limit(1);
          if (!invitation) throw new Error("invitation_mapping_missing");
          if (!invitation.competitionId) throw new Error("invitation_competition_missing");
          await transaction
            .insert(organizationMemberships)
            .values({
              tenantId,
              userId: internalUserId,
              role: "member",
              status: "active",
              invitedByUserId: invitation.invitedByUserId,
              acceptedAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [organizationMemberships.tenantId, organizationMemberships.userId],
              set: { status: "active", acceptedAt: new Date(), updatedAt: new Date() },
            });
          await replaceCompetitionRoles(transaction, {
            tenantId,
            competitionId: invitation.competitionId,
            targetUserId: internalUserId,
            roles: parseMutablePlatformRoles(invitation.roles),
            actorUserId: invitation.invitedByUserId,
            now: new Date(),
          });
          await transaction
            .update(organizationInvitations)
            .set({
              status: "accepted",
              acceptedByUserId: internalUserId,
              acceptedAt: new Date(),
            })
            .where(eq(organizationInvitations.id, invitation.id));
        }

        if (event.type === "organizationInvitation.revoked") {
          await transaction
            .update(organizationInvitations)
            .set({ status: "revoked", revokedAt: new Date() })
            .where(
              and(
                eq(organizationInvitations.tenantId, tenantId),
                eq(organizationInvitations.providerInvitationId, event.data.id),
              ),
            );
        }

        await transaction.insert(auditEvents).values({
          tenantId,
          actorRole: "system",
          outcome: "success",
          action: "identity.webhook_processed",
          summary: "identity.webhook_processed",
          objectType: "identity_event",
          objectId: event.data.id,
          payload: { source: "clerk", reasonCode: event.type },
          requestId: webhookId,
        });
        await transaction
          .update(idempotencyKeys)
          .set({
            status: "completed",
            responseStatus: 200,
            responseBody: { received: true },
            completedAt: new Date(),
          })
          .where(
            and(
              eq(idempotencyKeys.tenantId, tenantId),
              eq(idempotencyKeys.scope, "clerk_webhook"),
              eq(idempotencyKeys.key, webhookId),
            ),
          );
      },
      { isolationLevel: "serializable" },
    );
    return platformJson({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "webhook_in_progress") {
      return platformJson({ error: { code: "webhook_in_progress", message: "Retry this webhook shortly." } }, 409);
    }
    return platformJson({ error: { code: "webhook_processing_failed", message: "Webhook processing failed safely and can be retried." } }, 503);
  }
}
