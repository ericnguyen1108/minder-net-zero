import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";

import {
  applicantIdentities,
  applications,
  assignments,
  competitionRoleGrants,
  organizationInvitations,
  organizationMemberships,
  reviewerReviews,
  users,
} from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import { principalHasPermission, type ServerPrincipal } from "./auth/context.ts";
import { isPlatformRole, type PlatformRole } from "./auth/roles.ts";

export type PlatformMember = {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  roles: PlatformRole[];
  lastActiveAt: string | null;
};

export type PlatformInvitation = {
  id: string;
  email: string;
  roles: PlatformRole[];
  status: string;
  createdAt: string;
};

export type ReviewerAssignmentDto = {
  id: string;
  competitionId: string;
  revision: number;
  status: "assigned" | "in_progress" | "submitted";
  dueAt: string | null;
  application: {
    externalId: string;
    teamName: string;
    track: string;
    answers: Array<{ heading: string; value: string }>;
  };
  review: {
    decision: "progress" | "do_not_progress" | "human_review";
    confidence: "low" | "medium" | "high";
    notes: string;
    revision: number;
  } | null;
};

const MUTABLE_ROLES = [
  "competition_admin",
  "rubric_manager",
  "reviewer",
  "decision_approver",
  "auditor",
] as const satisfies readonly PlatformRole[];
type MutablePlatformRole = (typeof MUTABLE_ROLES)[number];

export function parseMutablePlatformRoles(value: unknown): MutablePlatformRole[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPlatformRole))].filter(
    (role): role is MutablePlatformRole =>
      (MUTABLE_ROLES as readonly PlatformRole[]).includes(role),
  );
}

export async function listCompetitionPeople(
  transaction: TenantTransaction,
  tenantId: string,
  competitionId: string,
): Promise<{ members: PlatformMember[]; invitations: PlatformInvitation[] }> {
  const rows = await transaction
    .select({
      id: users.id,
      name: users.displayName,
      email: users.email,
      membershipStatus: organizationMemberships.status,
      membershipRole: organizationMemberships.role,
      role: competitionRoleGrants.role,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .leftJoin(
      competitionRoleGrants,
      and(
        eq(competitionRoleGrants.tenantId, tenantId),
        eq(competitionRoleGrants.competitionId, competitionId),
        eq(competitionRoleGrants.userId, users.id),
        isNull(competitionRoleGrants.revokedAt),
      ),
    )
    .where(
      and(
        eq(organizationMemberships.tenantId, tenantId),
        inArray(organizationMemberships.status, ["active", "suspended"]),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(users.displayName), asc(users.email));

  const membersById = new Map<string, PlatformMember>();
  for (const row of rows) {
    let member = membersById.get(row.id);
    if (!member) {
      const inherited: PlatformRole[] =
        row.membershipRole === "owner"
          ? ["owner"]
          : row.membershipRole === "admin"
            ? ["competition_admin"]
            : row.membershipRole === "auditor"
              ? ["auditor"]
              : [];
      member = {
        id: row.id,
        name: row.name?.trim() || "Minder user",
        email: row.email,
        status: row.membershipStatus === "suspended" ? "suspended" : "active",
        roles: inherited,
        lastActiveAt: null,
      };
      membersById.set(row.id, member);
    }
    if (row.role && !member.roles.includes(row.role)) member.roles.push(row.role);
  }

  const invitationRows = await transaction
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.tenantId, tenantId),
        eq(organizationInvitations.competitionId, competitionId),
        eq(organizationInvitations.status, "pending"),
      ),
    )
    .orderBy(desc(organizationInvitations.invitedAt));

  return {
    members: [...membersById.values()],
    invitations: invitationRows.map((row) => ({
      id: row.id,
      email: row.email,
      roles: parseMutablePlatformRoles(row.roles),
      status: row.status,
      createdAt: row.invitedAt.toISOString(),
    })),
  };
}

export async function saveInvitationRecord(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    providerInvitationId: string;
    email: string;
    roles: PlatformRole[];
    invitedByUserId: string;
    expiresAt: Date;
  },
): Promise<PlatformInvitation> {
  const [row] = await transaction
    .insert(organizationInvitations)
    .values({ ...input, roles: parseMutablePlatformRoles(input.roles) })
    .returning();
  return {
    id: row.id,
    email: row.email,
    roles: parseMutablePlatformRoles(row.roles),
    status: row.status,
    createdAt: row.invitedAt.toISOString(),
  };
}

export async function replaceCompetitionRoles(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    competitionId: string;
    targetUserId: string;
    roles: PlatformRole[];
    actorUserId: string;
    now: Date;
  },
): Promise<PlatformMember | null> {
  const roles = parseMutablePlatformRoles(input.roles);
  if (roles.length === 0) throw new Error("at_least_one_role_required");
  const [membership] = await transaction
    .select({ status: organizationMemberships.status, organizationRole: organizationMemberships.role })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.tenantId, input.tenantId),
        eq(organizationMemberships.userId, input.targetUserId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return null;
  if (membership.organizationRole === "owner") throw new Error("owner_roles_managed_by_identity_provider");

  await transaction
    .update(competitionRoleGrants)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(competitionRoleGrants.tenantId, input.tenantId),
        eq(competitionRoleGrants.competitionId, input.competitionId),
        eq(competitionRoleGrants.userId, input.targetUserId),
        isNull(competitionRoleGrants.revokedAt),
        notInArray(competitionRoleGrants.role, roles),
      ),
    );

  for (const role of roles) {
    await transaction
      .insert(competitionRoleGrants)
      .values({
        tenantId: input.tenantId,
        competitionId: input.competitionId,
        userId: input.targetUserId,
        role,
        grantedByUserId: input.actorUserId,
        activeFrom: input.now,
      })
      .onConflictDoUpdate({
        target: [
          competitionRoleGrants.tenantId,
          competitionRoleGrants.competitionId,
          competitionRoleGrants.userId,
          competitionRoleGrants.role,
        ],
        set: {
          grantedByUserId: input.actorUserId,
          activeFrom: input.now,
          activeUntil: null,
          revokedAt: null,
        },
      });
  }

  const people = await listCompetitionPeople(transaction, input.tenantId, input.competitionId);
  return people.members.find((member) => member.id === input.targetUserId) ?? null;
}

function answerList(content: Record<string, unknown>): Array<{ heading: string; value: string }> {
  const raw = content.answers;
  if (Array.isArray(raw)) {
    return raw
      .slice(0, 100)
      .flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const candidate = item as Record<string, unknown>;
        const heading = typeof candidate.heading === "string" ? candidate.heading.trim() : "";
        const value = typeof candidate.value === "string" ? candidate.value.trim() : "";
        return heading && value ? [{ heading: heading.slice(0, 500), value: value.slice(0, 100_000) }] : [];
      });
  }
  return Object.entries(content)
    .slice(0, 100)
    .flatMap(([heading, value]) =>
      typeof value === "string" && value.trim()
        ? [{ heading: heading.slice(0, 500), value: value.trim().slice(0, 100_000) }]
        : [],
    );
}

function identityText(identity: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return "";
}

function reviewDecision(value: string): "progress" | "do_not_progress" | "human_review" {
  return value === "progress" || value === "do_not_progress" ? value : "human_review";
}

function reviewConfidence(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "high" ? value : "medium";
}

export async function listReviewerAssignments(
  transaction: TenantTransaction,
  principal: ServerPrincipal,
): Promise<ReviewerAssignmentDto[]> {
  const rows = await transaction
    .select({
      assignment: assignments,
      application: applications,
      identity: applicantIdentities,
    })
    .from(assignments)
    .innerJoin(
      applications,
      and(
        eq(applications.tenantId, assignments.tenantId),
        eq(applications.competitionId, assignments.competitionId),
        eq(applications.id, assignments.applicationId),
      ),
    )
    .innerJoin(
      applicantIdentities,
      and(
        eq(applicantIdentities.tenantId, assignments.tenantId),
        eq(applicantIdentities.competitionId, assignments.competitionId),
        eq(applicantIdentities.id, applications.identityId),
      ),
    )
    .where(
      and(
        eq(assignments.tenantId, principal.organizationId),
        eq(assignments.competitionId, principal.competitionId),
        eq(assignments.reviewerUserId, principal.actorUserId),
        inArray(assignments.status, ["assigned", "in_progress", "submitted"]),
      ),
    )
    .orderBy(asc(assignments.dueAt), asc(assignments.assignedAt))
    .limit(1000);

  const assignmentIds = rows.map((row) => row.assignment.id);
  const reviewRows = assignmentIds.length
    ? await transaction
        .select()
        .from(reviewerReviews)
        .where(
          and(
            eq(reviewerReviews.tenantId, principal.organizationId),
            eq(reviewerReviews.competitionId, principal.competitionId),
            eq(reviewerReviews.reviewerUserId, principal.actorUserId),
            inArray(reviewerReviews.assignmentId, assignmentIds),
          ),
        )
        .orderBy(desc(reviewerReviews.revision))
    : [];
  const latestByAssignment = new Map<string, (typeof reviewRows)[number]>();
  for (const review of reviewRows) {
    if (!latestByAssignment.has(review.assignmentId)) latestByAssignment.set(review.assignmentId, review);
  }

  return rows.map(({ assignment, application, identity }) => {
    const latest = latestByAssignment.get(assignment.id);
    const mayReadIdentity = !assignment.blind && principalHasPermission(principal, "application.read_identity");
    return {
      id: assignment.id,
      competitionId: assignment.competitionId,
      revision: assignment.revision,
      status: assignment.status as "assigned" | "in_progress" | "submitted",
      dueAt: assignment.dueAt?.toISOString() ?? null,
      application: {
        externalId: application.externalRef,
        teamName: mayReadIdentity
          ? identityText(identity.identityData, ["teamName", "team_name", "name"])
          : "",
        track: mayReadIdentity
          ? identityText(identity.identityData, ["track", "category", "programme"])
          : "",
        answers: answerList(application.content),
      },
      review: latest
        ? {
            decision: reviewDecision(latest.recommendation),
            confidence: reviewConfidence(latest.flags.confidence),
            notes: latest.rationale,
            revision: latest.revision,
          }
        : null,
    };
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function submitReviewerReview(
  transaction: TenantTransaction,
  input: {
    principal: ServerPrincipal;
    assignmentId: string;
    expectedRevision: number;
    decision: "progress" | "do_not_progress" | "human_review";
    confidence: "low" | "medium" | "high";
    notes: string;
    now: Date;
  },
): Promise<{ assignment: typeof assignments.$inferSelect; reviewRevision: number } | null> {
  const [assignment] = await transaction
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.tenantId, input.principal.organizationId),
        eq(assignments.competitionId, input.principal.competitionId),
        eq(assignments.id, input.assignmentId),
      ),
    )
    .limit(1);
  if (!assignment) return null;

  const [latest] = await transaction
    .select()
    .from(reviewerReviews)
    .where(
      and(
        eq(reviewerReviews.tenantId, input.principal.organizationId),
        eq(reviewerReviews.competitionId, input.principal.competitionId),
        eq(reviewerReviews.assignmentId, assignment.id),
        eq(reviewerReviews.reviewerUserId, input.principal.actorUserId),
      ),
    )
    .orderBy(desc(reviewerReviews.revision))
    .limit(1);
  const reviewRevision = (latest?.revision ?? 0) + 1;

  const [updated] = await transaction
    .update(assignments)
    .set({
      revision: sql`${assignments.revision} + 1`,
      status: "submitted",
      completedAt: input.now,
    })
    .where(
      and(
        eq(assignments.tenantId, input.principal.organizationId),
        eq(assignments.competitionId, input.principal.competitionId),
        eq(assignments.id, assignment.id),
        eq(assignments.reviewerUserId, input.principal.actorUserId),
        eq(assignments.revision, input.expectedRevision),
        inArray(assignments.status, ["assigned", "in_progress", "submitted"]),
      ),
    )
    .returning();
  if (!updated) throw new Error("revision_conflict");

  const content = {
    assignmentId: assignment.id,
    applicationId: assignment.applicationId,
    reviewerUserId: input.principal.actorUserId,
    revision: reviewRevision,
    recommendation: input.decision,
    rationale: input.notes,
    confidence: input.confidence,
  };
  await transaction.insert(reviewerReviews).values({
    tenantId: input.principal.organizationId,
    competitionId: input.principal.competitionId,
    assignmentId: assignment.id,
    applicationId: assignment.applicationId,
    reviewerUserId: input.principal.actorUserId,
    revision: reviewRevision,
    supersedesReviewId: latest?.id ?? null,
    status: "submitted",
    recommendation: input.decision,
    rationale: input.notes,
    rubricScores: {},
    flags: { confidence: input.confidence },
    contentHash: await sha256(content),
    submittedAt: input.now,
  });
  return { assignment: updated, reviewRevision };
}
