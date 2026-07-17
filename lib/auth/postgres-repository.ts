import { and, eq } from "drizzle-orm";

import { withTenantTransaction } from "../../db/tenant-transaction.ts";
import {
  competitionRoleGrants,
  competitions,
  organizationMemberships,
  organizations,
  users,
} from "../../db/schema.ts";
import {
  IdentityMappingMismatchError,
  type PlatformIdentityRepository,
} from "./context.ts";
import { projectPostgresIdentityRows } from "./postgres-projection.ts";

type RepositoryOptions = Readonly<{
  now?: () => Date;
}>;

/**
 * Tenant-scoped authentication lookup. The tenant UUID comes from server-only
 * Clerk organization private metadata, and the transaction activates RLS before
 * any organization, user, membership, competition, or role-grant row is read.
 */
export function createPostgresIdentityRepository(
  options: RepositoryOptions = {},
): PlatformIdentityRepository {
  return {
    async findIdentityRowsByProviderIdentity({
      provider,
      providerUserId,
      providerOrganizationId,
      tenantId,
    }) {
      return withTenantTransaction(
        { tenantId, userId: null },
        async (transaction) => {
          const mappedOrganizations = await transaction
            .select({
              id: organizations.id,
              authProvider: organizations.authProvider,
              authSubject: organizations.authSubject,
            })
            .from(organizations)
            .where(eq(organizations.id, tenantId))
            .limit(2);
          if (
            mappedOrganizations.length !== 1 ||
            mappedOrganizations[0].authProvider !== provider ||
            mappedOrganizations[0].authSubject !== providerOrganizationId
          ) {
            throw new IdentityMappingMismatchError();
          }

          const rawRows = await transaction
            .select({
              authSubject: users.authSubject,
              organizationAuthProvider: organizations.authProvider,
              organizationAuthSubject: organizations.authSubject,
              userId: users.id,
              userDisplayName: users.displayName,
              userDisabledAt: users.disabledAt,
              tenantId: organizations.id,
              organizationName: organizations.name,
              organizationSlug: organizations.slug,
              organizationArchivedAt: organizations.archivedAt,
              membershipRole: organizationMemberships.role,
              membershipStatus: organizationMemberships.status,
              competitionId: competitions.id,
              competitionName: competitions.name,
              competitionStatus: competitions.status,
              competitionArchivedAt: competitions.archivedAt,
              grantRole: competitionRoleGrants.role,
              grantActiveFrom: competitionRoleGrants.activeFrom,
              grantActiveUntil: competitionRoleGrants.activeUntil,
              grantRevokedAt: competitionRoleGrants.revokedAt,
            })
            .from(users)
            .innerJoin(organizationMemberships, eq(organizationMemberships.userId, users.id))
            .innerJoin(organizations, eq(organizations.id, organizationMemberships.tenantId))
            .innerJoin(competitions, eq(competitions.tenantId, organizations.id))
            .leftJoin(
              competitionRoleGrants,
              and(
                eq(competitionRoleGrants.tenantId, organizations.id),
                eq(competitionRoleGrants.competitionId, competitions.id),
                eq(competitionRoleGrants.userId, users.id),
              ),
            )
            .where(
              and(
                eq(users.authProvider, provider),
                eq(users.authSubject, providerUserId),
                eq(organizations.id, tenantId),
                eq(organizations.authProvider, provider),
                eq(organizations.authSubject, providerOrganizationId),
              ),
            );

          return projectPostgresIdentityRows(
            provider,
            rawRows,
            (options.now ?? (() => new Date()))(),
          );
        },
        { accessMode: "read only" },
      );
    },
  };
}
