import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  applicantIdentities,
  applications,
  assignments,
  competitionRoleGrants,
  datasets,
  organizationMemberships,
  users,
} from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";

export type ManagedReviewer = {
  id: string;
  name: string;
  email: string;
};

export type ManagedApplication = {
  id: string;
  externalRef: string;
  teamName: string;
  track: string;
  status: "imported" | "eligible";
};

export type ManagedAssignment = {
  id: string;
  applicationId: string;
  reviewer: ManagedReviewer;
  round: number;
  status: "assigned" | "in_progress" | "submitted" | "reassigned" | "cancelled";
  blind: boolean;
  revision: number;
  assignedAt: string;
  dueAt: string | null;
};

export type AssignmentManagementData = {
  applications: ManagedApplication[];
  reviewers: ManagedReviewer[];
  assignments: ManagedAssignment[];
};

function identityText(identity: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return "";
}

function reviewerName(name: string | null, email: string): string {
  return name?.trim() || email;
}

export function assignmentCanBeReactivated(status: ManagedAssignment["status"]): boolean {
  return status === "cancelled" || status === "reassigned";
}

export function assignmentCanBeCancelled(status: ManagedAssignment["status"]): boolean {
  return status === "assigned" || status === "in_progress";
}

/**
 * Shared assignment-management projection. Every caller must run it inside a
 * tenant transaction; PostgreSQL RLS supplies a second tenant boundary.
 */
export async function listAssignmentManagementData(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    actorUserId: string;
    now: Date;
  },
): Promise<AssignmentManagementData> {
  const applicationRows = await transaction
    .select({
      id: applications.id,
      externalRef: applications.externalRef,
      status: applications.status,
      identityData: applicantIdentities.identityData,
    })
    .from(applications)
    .innerJoin(
      datasets,
      and(
        eq(datasets.tenantId, applications.tenantId),
        eq(datasets.competitionId, applications.competitionId),
        eq(datasets.id, applications.datasetId),
        eq(datasets.kind, "current"),
      ),
    )
    .innerJoin(
      applicantIdentities,
      and(
        eq(applicantIdentities.tenantId, applications.tenantId),
        eq(applicantIdentities.competitionId, applications.competitionId),
        eq(applicantIdentities.id, applications.identityId),
      ),
    )
    .where(
      and(
        eq(applications.tenantId, input.tenantId),
        eq(applications.competitionId, input.competitionId),
        inArray(applications.status, ["imported", "eligible"]),
        isNull(applicantIdentities.deletedAt),
      ),
    )
    .orderBy(asc(applications.externalRef), asc(applications.id))
    .limit(10_000);

  // Only active members with an active competition-level reviewer grant are
  // valid assignment targets. The actor is deliberately omitted: even an
  // administrator who is also a reviewer cannot assign work to themselves.
  const reviewerRows = await transaction
    .select({
      id: users.id,
      name: users.displayName,
      email: users.email,
    })
    .from(competitionRoleGrants)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.tenantId, competitionRoleGrants.tenantId),
        eq(organizationMemberships.userId, competitionRoleGrants.userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .innerJoin(users, eq(users.id, competitionRoleGrants.userId))
    .where(
      and(
        eq(competitionRoleGrants.tenantId, input.tenantId),
        eq(competitionRoleGrants.competitionId, input.competitionId),
        eq(competitionRoleGrants.role, "reviewer"),
        isNull(competitionRoleGrants.revokedAt),
        lte(competitionRoleGrants.activeFrom, input.now),
        or(
          isNull(competitionRoleGrants.activeUntil),
          gt(competitionRoleGrants.activeUntil, input.now),
        ),
        isNull(users.disabledAt),
        ne(users.id, input.actorUserId),
      ),
    )
    .orderBy(asc(users.displayName), asc(users.email), asc(users.id))
    .limit(1_000);

  const assignmentRows = await transaction
    .select({
      assignment: assignments,
      reviewerId: users.id,
      reviewerName: users.displayName,
      reviewerEmail: users.email,
    })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.reviewerUserId))
    .where(
      and(
        eq(assignments.tenantId, input.tenantId),
        eq(assignments.competitionId, input.competitionId),
      ),
    )
    .orderBy(asc(assignments.applicationId), asc(assignments.assignedAt), asc(assignments.id))
    .limit(20_000);

  return {
    applications: applicationRows.map((row) => ({
      id: row.id,
      externalRef: row.externalRef,
      teamName: identityText(row.identityData, ["teamName", "team_name", "name"]),
      track: identityText(row.identityData, ["track", "category", "programme"]),
      status: row.status as "imported" | "eligible",
    })),
    reviewers: reviewerRows.map((row) => ({
      id: row.id,
      name: reviewerName(row.name, row.email),
      email: row.email,
    })),
    assignments: assignmentRows.map(({ assignment, reviewerId, reviewerName: name, reviewerEmail }) => ({
      id: assignment.id,
      applicationId: assignment.applicationId,
      reviewer: {
        id: reviewerId,
        name: reviewerName(name, reviewerEmail),
        email: reviewerEmail,
      },
      round: assignment.round,
      status: assignment.status,
      blind: assignment.blind,
      revision: assignment.revision,
      assignedAt: assignment.assignedAt.toISOString(),
      dueAt: assignment.dueAt?.toISOString() ?? null,
    })),
  };
}

function uniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

async function requireAssignableApplication(
  transaction: TenantTransaction,
  input: { tenantId: string; competitionId: string; applicationId: string },
) {
  const [application] = await transaction
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.tenantId, input.tenantId),
        eq(applications.competitionId, input.competitionId),
        eq(applications.id, input.applicationId),
        inArray(applications.status, ["imported", "eligible"]),
      ),
    )
    .limit(1);
  if (!application) throw new Error("application_not_found");
}

async function requireEligibleReviewer(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    reviewerUserId: string;
    actorUserId: string;
    now: Date;
  },
) {
  if (input.reviewerUserId === input.actorUserId) {
    throw new Error("self_assignment_forbidden");
  }
  const [reviewer] = await transaction
    .select({ id: users.id })
    .from(competitionRoleGrants)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.tenantId, competitionRoleGrants.tenantId),
        eq(organizationMemberships.userId, competitionRoleGrants.userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .innerJoin(users, eq(users.id, competitionRoleGrants.userId))
    .where(
      and(
        eq(competitionRoleGrants.tenantId, input.tenantId),
        eq(competitionRoleGrants.competitionId, input.competitionId),
        eq(competitionRoleGrants.userId, input.reviewerUserId),
        eq(competitionRoleGrants.role, "reviewer"),
        isNull(competitionRoleGrants.revokedAt),
        lte(competitionRoleGrants.activeFrom, input.now),
        or(
          isNull(competitionRoleGrants.activeUntil),
          gt(competitionRoleGrants.activeUntil, input.now),
        ),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!reviewer) throw new Error("reviewer_not_eligible");
}

export async function assignApplicationToReviewer(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    applicationId: string;
    reviewerUserId: string;
    actorUserId: string;
    round: number;
    blind: boolean;
    dueAt: Date | null;
    expectedRevision: number | null;
    now: Date;
  },
): Promise<{
  assignment: typeof assignments.$inferSelect;
  action: "assignment.created" | "assignment.reactivated";
}> {
  await requireAssignableApplication(transaction, input);
  await requireEligibleReviewer(transaction, input);

  const [existing] = await transaction
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.tenantId, input.tenantId),
        eq(assignments.competitionId, input.competitionId),
        eq(assignments.applicationId, input.applicationId),
        eq(assignments.reviewerUserId, input.reviewerUserId),
        eq(assignments.round, input.round),
      ),
    )
    .limit(1);

  if (existing) {
    if (!assignmentCanBeReactivated(existing.status)) throw new Error("assignment_exists");
    if (input.expectedRevision === null || input.expectedRevision !== existing.revision) {
      throw new Error("revision_conflict");
    }
    const [reactivated] = await transaction
      .update(assignments)
      .set({
        status: "assigned",
        blind: input.blind,
        dueAt: input.dueAt,
        assignedByUserId: input.actorUserId,
        assignedAt: input.now,
        completedAt: null,
        revision: sql`${assignments.revision} + 1`,
      })
      .where(
        and(
          eq(assignments.tenantId, input.tenantId),
          eq(assignments.competitionId, input.competitionId),
          eq(assignments.id, existing.id),
          eq(assignments.revision, input.expectedRevision),
          inArray(assignments.status, ["cancelled", "reassigned"]),
        ),
      )
      .returning();
    if (!reactivated) throw new Error("revision_conflict");
    return { assignment: reactivated, action: "assignment.reactivated" };
  }

  if (input.expectedRevision !== null) throw new Error("revision_conflict");
  try {
    const [created] = await transaction
      .insert(assignments)
      .values({
        tenantId: input.tenantId,
        competitionId: input.competitionId,
        applicationId: input.applicationId,
        reviewerUserId: input.reviewerUserId,
        round: input.round,
        status: "assigned",
        blind: input.blind,
        revision: 1,
        assignedByUserId: input.actorUserId,
        assignedAt: input.now,
        dueAt: input.dueAt,
      })
      .returning();
    return { assignment: created, action: "assignment.created" };
  } catch (error) {
    if (uniqueViolation(error)) throw new Error("revision_conflict");
    throw error;
  }
}

export async function unassignApplicationFromReviewer(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    assignmentId: string;
    expectedRevision: number;
  },
): Promise<{
  assignment: typeof assignments.$inferSelect;
  previousStatus: "assigned" | "in_progress";
}> {
  const [existing] = await transaction
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.tenantId, input.tenantId),
        eq(assignments.competitionId, input.competitionId),
        eq(assignments.id, input.assignmentId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("assignment_not_found");
  if (existing.status === "submitted") throw new Error("submitted_assignment_locked");
  if (!assignmentCanBeCancelled(existing.status)) throw new Error("revision_conflict");

  const [cancelled] = await transaction
    .update(assignments)
    .set({
      status: "cancelled",
      revision: sql`${assignments.revision} + 1`,
    })
    .where(
      and(
        eq(assignments.tenantId, input.tenantId),
        eq(assignments.competitionId, input.competitionId),
        eq(assignments.id, input.assignmentId),
        eq(assignments.revision, input.expectedRevision),
        inArray(assignments.status, ["assigned", "in_progress"]),
      ),
    )
    .returning();
  if (!cancelled) throw new Error("revision_conflict");
  return {
    assignment: cancelled,
    previousStatus: existing.status as "assigned" | "in_progress",
  };
}
