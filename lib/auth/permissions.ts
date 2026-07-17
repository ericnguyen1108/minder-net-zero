import { isPlatformRole, type PlatformRole } from "./roles.ts";

export const PLATFORM_PERMISSIONS = [
  "organization.read",
  "organization.manage",
  "competition.read",
  "competition.manage",
  "membership.read",
  "membership.manage",
  "rubric.read",
  "rubric.write",
  "rubric.approve",
  "historical.read",
  "historical.import",
  "calibration.run",
  "sealed_outcome.reveal",
  "application.import",
  "application.read_content",
  "application.read_identity",
  "assessment.run",
  "assessment.read",
  "review.read_assigned",
  "review.write_assigned",
  "review.read_all",
  "review.write_all",
  "review.assign",
  "decision.read",
  "decision.approve",
  "export.create",
  "audit.read",
  "audit.export",
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PLATFORM_PERMISSIONS);

const ALL_PERMISSIONS = Object.freeze([...PLATFORM_PERMISSIONS]) as readonly PlatformPermission[];

/**
 * Least-privilege matrix. Keep this explicit so a newly introduced permission
 * is denied to every non-owner role until it is consciously assigned.
 */
export const ROLE_PERMISSIONS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> =
  Object.freeze({
    owner: ALL_PERMISSIONS,
    competition_admin: Object.freeze([
      "organization.read",
      "competition.read",
      "competition.manage",
      "membership.read",
      "membership.manage",
      "rubric.read",
      "rubric.write",
      "rubric.approve",
      "historical.read",
      "historical.import",
      "calibration.run",
      "sealed_outcome.reveal",
      "application.import",
      "application.read_content",
      "application.read_identity",
      "assessment.run",
      "assessment.read",
      "review.read_all",
      "review.write_all",
      "review.assign",
      "decision.read",
      "decision.approve",
      "export.create",
      "audit.read",
      "audit.export",
    ]),
    rubric_manager: Object.freeze([
      "organization.read",
      "competition.read",
      "rubric.read",
      "rubric.write",
      "rubric.approve",
      "historical.read",
      "historical.import",
      "calibration.run",
      "sealed_outcome.reveal",
      "application.read_content",
      "assessment.run",
      "assessment.read",
    ]),
    reviewer: Object.freeze([
      "organization.read",
      "competition.read",
      "rubric.read",
      "application.read_content",
      "assessment.read",
      "review.read_assigned",
      "review.write_assigned",
    ]),
    decision_approver: Object.freeze([
      "organization.read",
      "competition.read",
      "rubric.read",
      "application.read_content",
      "application.read_identity",
      "assessment.read",
      "review.read_all",
      "decision.read",
      "decision.approve",
      "export.create",
    ]),
    auditor: Object.freeze([
      "organization.read",
      "competition.read",
      "rubric.read",
      "historical.read",
      "assessment.read",
      "review.read_all",
      "decision.read",
      "export.create",
      "audit.read",
      "audit.export",
    ]),
  } satisfies Record<PlatformRole, readonly PlatformPermission[]>);

const ROLE_PERMISSION_SETS: Readonly<Record<PlatformRole, ReadonlySet<PlatformPermission>>> =
  Object.freeze({
    owner: new Set(ROLE_PERMISSIONS.owner),
    competition_admin: new Set(ROLE_PERMISSIONS.competition_admin),
    rubric_manager: new Set(ROLE_PERMISSIONS.rubric_manager),
    reviewer: new Set(ROLE_PERMISSIONS.reviewer),
    decision_approver: new Set(ROLE_PERMISSIONS.decision_approver),
    auditor: new Set(ROLE_PERMISSIONS.auditor),
  });

export function isPlatformPermission(value: unknown): value is PlatformPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function permissionsForRole(role: unknown): readonly PlatformPermission[] {
  if (!isPlatformRole(role)) return Object.freeze([]);
  return ROLE_PERMISSIONS[role];
}

/** Invalid role and permission values always deny. */
export function hasPermission(role: unknown, permission: unknown): boolean {
  if (!isPlatformRole(role) || !isPlatformPermission(permission)) return false;
  return ROLE_PERMISSION_SETS[role].has(permission);
}
