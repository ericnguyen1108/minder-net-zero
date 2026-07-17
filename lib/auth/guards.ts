import {
  isServerPrincipal,
  principalHasPermission,
  type ServerPrincipal,
} from "./context.ts";
import type { PlatformPermission } from "./permissions.ts";

export type TenantScope = Readonly<{
  organizationId: string;
  competitionId: string;
}>;

export type ReviewAssignment = Readonly<{
  organizationId: string;
  competitionId: string;
  reviewerUserId: string;
  status: "assigned" | "in_progress" | "submitted" | "reassigned" | "cancelled";
}>;

export type AccessDenialCode =
  | "not_authenticated"
  | "resource_not_found"
  | "permission_denied"
  | "active_assignment_required";

export type AccessDecision =
  | Readonly<{ allowed: true; principal: ServerPrincipal }>
  | Readonly<{ allowed: false; status: 401 | 403 | 404; code: AccessDenialCode }>;

function tenantMatches(principal: ServerPrincipal, scope: TenantScope): boolean {
  return (
    principal.organizationId === scope.organizationId &&
    principal.competitionId === scope.competitionId
  );
}

/**
 * Route-level authorization. `scope` must come from the loaded server resource,
 * not from a client-supplied actor, organization, role, or membership value.
 */
export function authorizePermission(
  principal: ServerPrincipal | null | undefined,
  permission: PlatformPermission,
  scope: TenantScope,
): AccessDecision {
  if (!isServerPrincipal(principal)) {
    return { allowed: false, status: 401, code: "not_authenticated" };
  }
  if (!tenantMatches(principal, scope)) {
    // Do not confirm that another tenant's resource exists.
    return { allowed: false, status: 404, code: "resource_not_found" };
  }
  if (!principalHasPermission(principal, permission)) {
    return { allowed: false, status: 403, code: "permission_denied" };
  }
  return { allowed: true, principal };
}

export function authorizeReview(
  principal: ServerPrincipal | null | undefined,
  operation: "read" | "write",
  scope: TenantScope,
  assignment: ReviewAssignment | null,
): AccessDecision {
  const allPermission: PlatformPermission =
    operation === "read" ? "review.read_all" : "review.write_all";
  const assignedPermission: PlatformPermission =
    operation === "read" ? "review.read_assigned" : "review.write_assigned";

  if (!isServerPrincipal(principal)) {
    return { allowed: false, status: 401, code: "not_authenticated" };
  }
  if (!tenantMatches(principal, scope)) {
    return { allowed: false, status: 404, code: "resource_not_found" };
  }
  if (principalHasPermission(principal, allPermission)) return { allowed: true, principal };
  if (!principalHasPermission(principal, assignedPermission)) {
    return { allowed: false, status: 403, code: "permission_denied" };
  }
  if (
    !assignment ||
    (assignment.status !== "assigned" &&
      assignment.status !== "in_progress" &&
      assignment.status !== "submitted") ||
    assignment.reviewerUserId !== principal.actorUserId ||
    assignment.organizationId !== principal.organizationId ||
    assignment.competitionId !== principal.competitionId
  ) {
    return { allowed: false, status: 403, code: "active_assignment_required" };
  }
  return { allowed: true, principal };
}

export class RouteAuthorizationError extends Error {
  readonly status: 401 | 403 | 404;
  readonly code: AccessDenialCode;

  constructor(decision: Extract<AccessDecision, { allowed: false }>) {
    super(decision.code);
    this.name = "RouteAuthorizationError";
    this.status = decision.status;
    this.code = decision.code;
  }
}

export function requirePermission(
  principal: ServerPrincipal | null | undefined,
  permission: PlatformPermission,
  scope: TenantScope,
): ServerPrincipal {
  const decision = authorizePermission(principal, permission, scope);
  if (!decision.allowed) throw new RouteAuthorizationError(decision);
  return decision.principal;
}

export function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof RouteAuthorizationError)) {
    return Response.json(
      { error: { code: "internal_error", message: "The request could not be authorized." } },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message =
    error.status === 401
      ? "Sign in to continue."
      : error.status === 404
        ? "The requested resource was not found."
        : "You do not have permission to perform this action.";
  return Response.json(
    { error: { code: error.code, message } },
    {
      status: error.status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}
