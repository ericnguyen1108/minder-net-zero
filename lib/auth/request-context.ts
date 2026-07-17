import "server-only";

import { auth, clerkClient } from "@clerk/nextjs/server";

import {
  buildClerkServerSessionIdentity,
  resolvePlatformContextFromRepository,
  type PlatformContextResolution,
} from "./context.ts";
import { createPostgresIdentityRepository } from "./postgres-repository.ts";

/**
 * Single server-only entry point for API routes. It accepts no actor, tenant,
 * organization, or role from the request. The active Clerk session selects the
 * Clerk organization; private metadata selects the internal tenant; Postgres
 * then verifies both identities again inside an RLS-scoped transaction.
 */
export async function resolveRequestPlatformContext(): Promise<PlatformContextResolution> {
  if (process.env.AUTH_MODE !== "clerk") {
    return { ok: false, reason: "platform_not_configured" };
  }

  let clerkSession: Awaited<ReturnType<typeof auth>>;
  try {
    clerkSession = await auth();
  } catch {
    return { ok: false, reason: "identity_provider_unavailable" };
  }

  if (!clerkSession.userId || !clerkSession.sessionId) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (!clerkSession.orgId) {
    return { ok: false, reason: "organization_required" };
  }

  let clerkOrganization: Awaited<
    ReturnType<Awaited<ReturnType<typeof clerkClient>>["organizations"]["getOrganization"]>
  >;
  try {
    const client = await clerkClient();
    clerkOrganization = await client.organizations.getOrganization({
      organizationId: clerkSession.orgId,
    });
  } catch {
    return { ok: false, reason: "identity_provider_unavailable" };
  }

  const session = buildClerkServerSessionIdentity({
    providerUserId: clerkSession.userId,
    providerOrganizationId: clerkSession.orgId,
    fetchedOrganizationId: clerkOrganization.id,
    sessionId: clerkSession.sessionId,
    organizationPrivateMetadata: clerkOrganization.privateMetadata,
  });
  if (!session) return { ok: false, reason: "organization_mapping_invalid" };

  return resolvePlatformContextFromRepository(session, createPostgresIdentityRepository());
}
