import type { PlatformIdentityRow } from "./context.ts";
import type { PlatformRole } from "./roles.ts";

export type PostgresIdentityProjectionRow = Readonly<{
  authSubject: string;
  organizationAuthProvider: string;
  organizationAuthSubject: string;
  userId: string;
  userDisplayName: string | null;
  userDisabledAt: Date | null;
  tenantId: string;
  organizationName: string;
  organizationSlug: string;
  organizationArchivedAt: Date | null;
  membershipRole: "owner" | "admin" | "member" | "auditor";
  membershipStatus: "invited" | "active" | "suspended" | "removed";
  competitionId: string;
  competitionName: string;
  competitionStatus: string;
  competitionArchivedAt: Date | null;
  grantRole: PlatformRole | null;
  grantActiveFrom: Date | null;
  grantActiveUntil: Date | null;
  grantRevokedAt: Date | null;
}>;

function activeGrant(row: PostgresIdentityProjectionRow, now: Date): PlatformRole | null {
  if (!row.grantRole || !row.grantActiveFrom || row.grantRevokedAt) return null;
  if (row.grantActiveFrom.getTime() > now.getTime()) return null;
  if (row.grantActiveUntil && row.grantActiveUntil.getTime() <= now.getTime()) return null;
  return row.grantRole;
}

function organizationRole(role: "owner" | "admin" | "member" | "auditor"): PlatformRole | null {
  if (role === "owner") return "owner";
  if (role === "admin") return "competition_admin";
  if (role === "auditor") return "auditor";
  return null;
}

export function projectPostgresIdentityRows(
  provider: "clerk",
  rawRows: readonly PostgresIdentityProjectionRow[],
  now: Date,
): readonly PlatformIdentityRow[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("repository clock returned an invalid date");
  }
  const result: PlatformIdentityRow[] = [];
  for (const row of rawRows) {
    const roles = new Set<PlatformRole>();
    const inheritedRole = organizationRole(row.membershipRole);
    if (inheritedRole) roles.add(inheritedRole);
    const grantedRole = activeGrant(row, now);
    if (grantedRole) roles.add(grantedRole);
    if (roles.size === 0) continue;

    for (const role of roles) {
      result.push({
        provider,
        authSubject: row.authSubject,
        organizationAuthProvider: provider,
        organizationAuthSubject: row.organizationAuthSubject,
        userId: row.userId,
        userDisplayName: row.userDisplayName?.trim() || "Minder user",
        userDisabledAt: row.userDisabledAt,
        tenantId: row.tenantId,
        organizationName: row.organizationName,
        organizationSlug: row.organizationSlug,
        organizationArchivedAt: row.organizationArchivedAt,
        membershipStatus: row.membershipStatus,
        competitionId: row.competitionId,
        competitionName: row.competitionName,
        competitionStatus: row.competitionStatus,
        competitionArchivedAt: row.competitionArchivedAt,
        role,
      });
    }
  }
  return result;
}
