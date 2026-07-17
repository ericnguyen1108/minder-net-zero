/**
 * Competition roles are deliberately application-owned. Authentication
 * providers prove who a person is; they are not the source of authorization.
 */
export const PLATFORM_ROLES = [
  "owner",
  "competition_admin",
  "rubric_manager",
  "reviewer",
  "decision_approver",
  "auditor",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(PLATFORM_ROLES);

export const PLATFORM_ROLE_LABELS: Readonly<Record<PlatformRole, string>> = Object.freeze({
  owner: "Owner",
  competition_admin: "Competition admin",
  rubric_manager: "Rubric manager",
  reviewer: "Reviewer",
  decision_approver: "Decision approver",
  auditor: "Auditor",
});

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

/** Unknown or malformed database values never fall back to a privileged role. */
export function parsePlatformRole(value: unknown): PlatformRole | null {
  return isPlatformRole(value) ? value : null;
}
