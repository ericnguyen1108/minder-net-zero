import {
  hasPermission,
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from "./permissions.ts";
import {
  isPlatformRole,
  parsePlatformRole,
  PLATFORM_ROLES,
  PLATFORM_ROLE_LABELS,
  type PlatformRole,
} from "./roles.ts";

const SERVER_PRINCIPAL_BRAND: unique symbol = Symbol("minder.server-principal");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SAFE_STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ServerSessionIdentity = Readonly<{
  provider: "clerk";
  providerUserId: string;
  providerOrganizationId: string;
  sessionId: string;
  tenantId: string;
}>;

export function parseMinderTenantId(privateMetadata: unknown): string | null {
  if (!privateMetadata || typeof privateMetadata !== "object" || Array.isArray(privateMetadata)) {
    return null;
  }
  const value = (privateMetadata as Record<string, unknown>).minderTenantId;
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function buildClerkServerSessionIdentity(args: {
  providerUserId: unknown;
  providerOrganizationId: unknown;
  fetchedOrganizationId: unknown;
  sessionId: unknown;
  organizationPrivateMetadata: unknown;
}): ServerSessionIdentity | null {
  const tenantId = parseMinderTenantId(args.organizationPrivateMetadata);
  if (
    !isSafeId(args.providerUserId) ||
    !isSafeId(args.providerOrganizationId) ||
    !isSafeId(args.fetchedOrganizationId) ||
    args.providerOrganizationId !== args.fetchedOrganizationId ||
    !isSafeId(args.sessionId) ||
    !tenantId
  ) {
    return null;
  }
  return Object.freeze({
    provider: "clerk" as const,
    providerUserId: args.providerUserId,
    providerOrganizationId: args.providerOrganizationId,
    sessionId: args.sessionId,
    tenantId,
  });
}

/**
 * Schema-aligned projection returned by the Postgres identity repository.
 * `tenantId` is the organization id. Owners/admins may be projected into a
 * competition role row by the repository; direct grants may return many rows
 * for one competition and are aggregated here.
 */
export type PlatformIdentityRow = Readonly<{
  provider: "clerk";
  authSubject: string;
  organizationAuthProvider: "clerk";
  organizationAuthSubject: string;
  userId: string;
  userDisplayName: string;
  userDisabledAt: Date | string | null;
  tenantId: string;
  organizationName: string;
  organizationSlug: string;
  organizationArchivedAt: Date | string | null;
  membershipStatus: string;
  competitionId: string;
  competitionName: string;
  competitionStatus: string;
  competitionArchivedAt: Date | string | null;
  role: string;
}>;

export interface PlatformIdentityRepository {
  findIdentityRowsByProviderIdentity(args: {
    provider: "clerk";
    providerUserId: string;
    providerOrganizationId: string;
    tenantId: string;
  }): Promise<readonly PlatformIdentityRow[]>;
}

export class IdentityMappingMismatchError extends Error {
  constructor() {
    super("The provider organization does not match the selected tenant.");
    this.name = "IdentityMappingMismatchError";
  }
}

/**
 * The `role` alias is the deterministic primary role for display/audit only.
 * Every authorization decision checks the complete `roles` array.
 */
export type ServerPrincipal = Readonly<{
  actorUserId: string;
  provider: "clerk";
  providerUserId: string;
  sessionId: string;
  organizationId: string;
  competitionId: string;
  roles: readonly PlatformRole[];
  primaryRole: PlatformRole;
  role: PlatformRole;
  readonly [SERVER_PRINCIPAL_BRAND]: true;
}>;

export type SafePlatformContext = Readonly<{
  authenticated: true;
  user: Readonly<{
    id: string;
    displayName: string;
  }>;
  organizations: readonly Readonly<{
    id: string;
    name: string;
    slug: string;
  }>[];
  competitions: readonly Readonly<{
    id: string;
    organizationId: string;
    name: string;
    roles: readonly PlatformRole[];
    primaryRole: PlatformRole;
    roleLabel: string;
    permissions: readonly PlatformPermission[];
  }>[];
}>;

export type PlatformContextFailure =
  | "unauthenticated"
  | "platform_not_configured"
  | "organization_required"
  | "organization_mapping_invalid"
  | "identity_provider_unavailable"
  | "no_active_membership"
  | "identity_mismatch"
  | "invalid_mapping"
  | "ambiguous_mapping"
  | "identity_store_unavailable";

export type PlatformContextResolution =
  | Readonly<{
      ok: true;
      context: SafePlatformContext;
      principals: readonly ServerPrincipal[];
    }>
  | Readonly<{
      ok: false;
      reason: PlatformContextFailure;
    }>;

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSafeName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160;
}

function validDateMarker(value: unknown): value is Date | string | null {
  if (value === null) return true;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function markerKey(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function validSession(session: ServerSessionIdentity | null | undefined): session is ServerSessionIdentity {
  return Boolean(
    session &&
      session.provider === "clerk" &&
      isSafeId(session.providerUserId) &&
      isSafeId(session.providerOrganizationId) &&
      isSafeId(session.sessionId) &&
      UUID_PATTERN.test(session.tenantId),
  );
}

function validateRowShape(row: PlatformIdentityRow): boolean {
  return (
    row.provider === "clerk" &&
    isSafeId(row.authSubject) &&
    row.organizationAuthProvider === "clerk" &&
    isSafeId(row.organizationAuthSubject) &&
    isSafeId(row.userId) &&
    isSafeName(row.userDisplayName) &&
    validDateMarker(row.userDisabledAt) &&
    UUID_PATTERN.test(row.tenantId) &&
    isSafeName(row.organizationName) &&
    SAFE_SLUG.test(row.organizationSlug) &&
    validDateMarker(row.organizationArchivedAt) &&
    SAFE_STATUS.test(row.membershipStatus) &&
    isSafeId(row.competitionId) &&
    isSafeName(row.competitionName) &&
    SAFE_STATUS.test(row.competitionStatus) &&
    validDateMarker(row.competitionArchivedAt)
  );
}

function sortedRoles(roles: Iterable<PlatformRole>): readonly PlatformRole[] {
  const values = [...new Set(roles)].sort(
    (left, right) => PLATFORM_ROLES.indexOf(left) - PLATFORM_ROLES.indexOf(right),
  );
  return Object.freeze(values);
}

function unionPermissions(roles: readonly PlatformRole[]): readonly PlatformPermission[] {
  return Object.freeze(
    PLATFORM_PERMISSIONS.filter((permission) =>
      roles.some((role) => hasPermission(role, permission)),
    ),
  );
}

function createPrincipal(
  session: ServerSessionIdentity,
  row: PlatformIdentityRow,
  roles: readonly PlatformRole[],
) {
  const primaryRole = roles[0];
  const principal = {
    actorUserId: row.userId,
    provider: session.provider,
    providerUserId: session.providerUserId,
    sessionId: session.sessionId,
    organizationId: row.tenantId,
    competitionId: row.competitionId,
    roles,
    primaryRole,
    role: primaryRole,
  } as Omit<ServerPrincipal, typeof SERVER_PRINCIPAL_BRAND> & {
    readonly [SERVER_PRINCIPAL_BRAND]?: true;
  };
  Object.defineProperty(principal, SERVER_PRINCIPAL_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(principal) as ServerPrincipal;
}

export function isServerPrincipal(value: unknown): value is ServerPrincipal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ServerPrincipal> & { [SERVER_PRINCIPAL_BRAND]?: unknown };
  return (
    candidate[SERVER_PRINCIPAL_BRAND] === true &&
    isSafeId(candidate.actorUserId) &&
    candidate.provider === "clerk" &&
    isSafeId(candidate.providerUserId) &&
    isSafeId(candidate.sessionId) &&
    isSafeId(candidate.organizationId) &&
    isSafeId(candidate.competitionId) &&
    Array.isArray(candidate.roles) &&
    candidate.roles.length > 0 &&
    candidate.roles.every(isPlatformRole) &&
    isPlatformRole(candidate.primaryRole) &&
    candidate.roles.includes(candidate.primaryRole) &&
    candidate.role === candidate.primaryRole
  );
}

export function principalHasPermission(
  principal: ServerPrincipal | null | undefined,
  permission: PlatformPermission,
): boolean {
  return Boolean(
    isServerPrincipal(principal) &&
      principal.roles.some((role) => hasPermission(role, permission)),
  );
}

export function permissionsForPrincipal(
  principal: ServerPrincipal | null | undefined,
): readonly PlatformPermission[] {
  return isServerPrincipal(principal) ? unionPermissions(principal.roles) : Object.freeze([]);
}

/**
 * Joins Clerk's server session to active Postgres mappings. It intentionally
 * does not accept an organization, role, actor ID, or membership from a request.
 */
export function resolvePlatformContext(
  session: ServerSessionIdentity | null | undefined,
  rows: readonly PlatformIdentityRow[],
): PlatformContextResolution {
  if (!validSession(session)) return { ok: false, reason: "unauthenticated" };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: "no_active_membership" };
  }

  for (const row of rows) {
    if (
      row.provider !== session.provider ||
      row.authSubject !== session.providerUserId ||
      row.organizationAuthProvider !== session.provider ||
      row.organizationAuthSubject !== session.providerOrganizationId ||
      row.tenantId !== session.tenantId
    ) {
      return { ok: false, reason: "identity_mismatch" };
    }
    if (!validateRowShape(row)) return { ok: false, reason: "invalid_mapping" };
  }

  const first = rows[0];
  for (const row of rows) {
    if (
      row.userId !== first.userId ||
      row.userDisplayName.trim() !== first.userDisplayName.trim() ||
      markerKey(row.userDisabledAt) !== markerKey(first.userDisabledAt)
    ) {
      return { ok: false, reason: "ambiguous_mapping" };
    }
  }

  if (first.userDisabledAt !== null) return { ok: false, reason: "no_active_membership" };

  const activeRows = rows.filter(
    (row) =>
      row.userDisabledAt === null &&
      row.organizationArchivedAt === null &&
      row.membershipStatus === "active" &&
      row.competitionArchivedAt === null &&
      row.competitionStatus !== "archived",
  );
  if (activeRows.length === 0) return { ok: false, reason: "no_active_membership" };

  const organizations = new Map<string, { id: string; name: string; slug: string }>();
  const competitions = new Map<
    string,
    {
      id: string;
      organizationId: string;
      name: string;
      roles: Set<PlatformRole>;
      row: PlatformIdentityRow;
    }
  >();

  for (const row of activeRows) {
    const role = parsePlatformRole(row.role);
    if (!role) return { ok: false, reason: "invalid_mapping" };

    const existingOrganization = organizations.get(row.tenantId);
    if (
      existingOrganization &&
      (existingOrganization.name !== row.organizationName.trim() ||
        existingOrganization.slug !== row.organizationSlug)
    ) {
      return { ok: false, reason: "ambiguous_mapping" };
    }
    organizations.set(row.tenantId, {
      id: row.tenantId,
      name: row.organizationName.trim(),
      slug: row.organizationSlug,
    });

    const existingCompetition = competitions.get(row.competitionId);
    if (
      existingCompetition &&
      (existingCompetition.organizationId !== row.tenantId ||
        existingCompetition.name !== row.competitionName.trim())
    ) {
      return { ok: false, reason: "ambiguous_mapping" };
    }
    if (existingCompetition) {
      existingCompetition.roles.add(role);
    } else {
      competitions.set(row.competitionId, {
        id: row.competitionId,
        organizationId: row.tenantId,
        name: row.competitionName.trim(),
        roles: new Set([role]),
        row,
      });
    }
  }

  const orderedOrganizations = [...organizations.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((organization) => Object.freeze(organization));
  const orderedCompetitions = [...competitions.values()]
    .map((competition) => ({ ...competition, orderedRoles: sortedRoles(competition.roles) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const principals = orderedCompetitions.map((competition) =>
    createPrincipal(session, competition.row, competition.orderedRoles),
  );

  const safeCompetitions = orderedCompetitions.map((competition) => {
    const primaryRole = competition.orderedRoles[0];
    return Object.freeze({
      id: competition.id,
      organizationId: competition.organizationId,
      name: competition.name,
      roles: competition.orderedRoles,
      primaryRole,
      roleLabel: PLATFORM_ROLE_LABELS[primaryRole],
      permissions: unionPermissions(competition.orderedRoles),
    });
  });

  return {
    ok: true,
    context: Object.freeze({
      authenticated: true as const,
      user: Object.freeze({ id: first.userId, displayName: first.userDisplayName.trim() }),
      organizations: Object.freeze(orderedOrganizations),
      competitions: Object.freeze(safeCompetitions),
    }),
    principals: Object.freeze(principals),
  };
}

export async function resolvePlatformContextFromRepository(
  session: ServerSessionIdentity | null | undefined,
  repository: PlatformIdentityRepository,
): Promise<PlatformContextResolution> {
  if (!validSession(session)) return { ok: false, reason: "unauthenticated" };
  try {
    const rows = await repository.findIdentityRowsByProviderIdentity({
      provider: session.provider,
      providerUserId: session.providerUserId,
      providerOrganizationId: session.providerOrganizationId,
      tenantId: session.tenantId,
    });
    return resolvePlatformContext(session, rows);
  } catch (error) {
    if (error instanceof IdentityMappingMismatchError) {
      return { ok: false, reason: "identity_mismatch" };
    }
    return { ok: false, reason: "identity_store_unavailable" };
  }
}

export function principalForCompetition(
  resolution: PlatformContextResolution,
  competitionId: string,
): ServerPrincipal | null {
  if (!resolution.ok || !isSafeId(competitionId)) return null;
  return resolution.principals.find((principal) => principal.competitionId === competitionId) ?? null;
}
