import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type JsonObject = Record<string, unknown>;

export const membershipRoleEnum = pgEnum("membership_role", [
  "owner",
  "admin",
  "member",
  "auditor",
]);
export const membershipStatusEnum = pgEnum("membership_status", [
  "invited",
  "active",
  "suspended",
  "removed",
]);
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const competitionRoleEnum = pgEnum("competition_role", [
  "competition_admin",
  "rubric_manager",
  "reviewer",
  "decision_approver",
  "auditor",
]);
export const competitionStatusEnum = pgEnum("competition_status", [
  "draft",
  "calibrating",
  "open",
  "reviewing",
  "decided",
  "archived",
]);
export const guideKindEnum = pgEnum("guide_kind", [
  "rules",
  "rubric",
  "selection",
  "elimination",
  "prompt",
  "safeguards",
]);
export const guideStatusEnum = pgEnum("guide_status", [
  "draft",
  "approved",
  "retired",
]);
export const datasetKindEnum = pgEnum("dataset_kind", ["historical", "current"]);
export const datasetStatusEnum = pgEnum("dataset_status", [
  "importing",
  "ready",
  "locked",
  "archived",
  "failed",
]);
export const applicationStatusEnum = pgEnum("application_status", [
  "imported",
  "eligible",
  "ineligible",
  "withdrawn",
  "deleted",
]);
export const assignmentStatusEnum = pgEnum("assignment_status", [
  "assigned",
  "in_progress",
  "submitted",
  "reassigned",
  "cancelled",
]);
export const calibrationStatusEnum = pgEnum("calibration_status", [
  "draft",
  "active",
  "completed",
  "cancelled",
]);
export const approvalDecisionEnum = pgEnum("approval_decision", [
  "approved",
  "rejected",
  "revoked",
]);
export const assessmentRunStatusEnum = pgEnum("assessment_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const assessmentBatchStatusEnum = pgEnum("assessment_batch_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);
export const reviewStatusEnum = pgEnum("review_status", [
  "draft",
  "submitted",
  "superseded",
]);
export const idempotencyStatusEnum = pgEnum("idempotency_status", [
  "processing",
  "completed",
  "failed",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "publishing",
  "published",
  "failed",
]);
export const auditOutcomeEnum = pgEnum("audit_outcome", ["success", "denied", "failed"]);
export const currentImportStatusEnum = pgEnum("current_import_status", [
  "staging",
  "completed",
  "cancelled",
  "expired",
]);
export const historicalImportStatusEnum = pgEnum("historical_import_status", [
  "staging",
  "completed",
  "cancelled",
  "expired",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authProvider: text("auth_provider").notNull(),
    authSubject: text("auth_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    emailVerified: boolean("email_verified").notNull().default(false),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_auth_identity_uq").on(table.authProvider, table.authSubject),
    uniqueIndex("users_email_lower_uq").on(sql`lower(${table.email})`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authProvider: text("auth_provider").notNull(),
    authSubject: text("auth_subject").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    dataRegion: text("data_region").notNull(),
    settings: jsonb("settings").$type<JsonObject>().notNull().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("organizations_slug_lower_uq").on(sql`lower(${table.slug})`),
    uniqueIndex("organizations_auth_identity_uq").on(table.authProvider, table.authSubject),
    check("organizations_slug_format_ck", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull().default("member"),
    status: membershipStatusEnum("status").notNull().default("invited"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId], name: "organization_memberships_pk" }),
    index("organization_memberships_user_idx").on(table.userId, table.status),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    competitionId: uuid("competition_id"),
    providerInvitationId: text("provider_invitation_id").notNull(),
    email: text("email").notNull(),
    roles: jsonb("roles").$type<string[]>().notNull(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("organization_invitations_provider_id_uq").on(
      table.tenantId,
      table.providerInvitationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "organization_invitations_competition_fk",
    }).onDelete("cascade"),
    index("organization_invitations_email_idx").on(
      table.tenantId,
      sql`lower(${table.email})`,
      table.status,
    ),
    check("organization_invitations_roles_array_ck", sql`jsonb_typeof(${table.roles}) = 'array'`),
    check("organization_invitations_expiry_ck", sql`${table.expiresAt} > ${table.invitedAt}`),
    check(
      "organization_invitations_acceptance_ck",
      sql`${table.status} <> 'accepted' or (${table.acceptedByUserId} is not null and ${table.acceptedAt} is not null)`,
    ),
  ],
);

export const competitions = pgTable(
  "competitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: competitionStatusEnum("status").notNull().default("draft"),
    timezone: text("timezone").notNull().default("UTC"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("competitions_tenant_id_id_uq").on(table.tenantId, table.id),
    uniqueIndex("competitions_tenant_slug_lower_uq").on(table.tenantId, sql`lower(${table.slug})`),
    index("competitions_tenant_status_idx").on(table.tenantId, table.status),
    check(
      "competitions_dates_ck",
      sql`${table.opensAt} is null or ${table.closesAt} is null or ${table.opensAt} < ${table.closesAt}`,
    ),
  ],
);

export const competitionRoleGrants = pgTable(
  "competition_role_grants",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    competitionId: uuid("competition_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: competitionRoleEnum("role").notNull(),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeUntil: timestamp("active_until", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.competitionId, table.userId, table.role],
      name: "competition_role_grants_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "competition_role_grants_competition_fk",
    }).onDelete("cascade"),
    index("competition_role_grants_user_idx").on(table.tenantId, table.userId, table.revokedAt),
    check(
      "competition_role_grants_window_ck",
      sql`${table.activeUntil} is null or ${table.activeFrom} < ${table.activeUntil}`,
    ),
  ],
);

export const guideVersions = pgTable(
  "guide_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    kind: guideKindEnum("kind").notNull(),
    version: integer("version").notNull(),
    status: guideStatusEnum("status").notNull().default("draft"),
    title: text("title").notNull(),
    body: jsonb("body").$type<JsonObject>().notNull(),
    contentHash: text("content_hash").notNull(),
    supersedesVersionId: uuid("supersedes_version_id"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("guide_versions_tenant_comp_kind_version_uq").on(
      table.tenantId,
      table.competitionId,
      table.kind,
      table.version,
    ),
    uniqueIndex("guide_versions_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "guide_versions_competition_fk",
    }).onDelete("cascade"),
    index("guide_versions_status_idx").on(table.tenantId, table.competitionId, table.kind, table.status),
    check("guide_versions_positive_version_ck", sql`${table.version} > 0`),
    check("guide_versions_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "guide_versions_approval_ck",
      sql`${table.status} <> 'approved' or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)`,
    ),
  ],
);

export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    kind: datasetKindEnum("kind").notNull(),
    name: text("name").notNull(),
    status: datasetStatusEnum("status").notNull().default("importing"),
    sourceFilename: text("source_filename"),
    sourceHash: text("source_hash").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    rowCount: integer("row_count").notNull().default(0),
    importMetadata: jsonb("import_metadata").$type<JsonObject>().notNull().default({}),
    importedByUserId: uuid("imported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("datasets_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    uniqueIndex("datasets_source_hash_uq").on(
      table.tenantId,
      table.competitionId,
      table.kind,
      table.sourceHash,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "datasets_competition_fk",
    }).onDelete("cascade"),
    index("datasets_tenant_comp_kind_idx").on(table.tenantId, table.competitionId, table.kind, table.status),
    check("datasets_schema_version_ck", sql`${table.schemaVersion} > 0`),
    check("datasets_row_count_ck", sql`${table.rowCount} >= 0`),
    check("datasets_source_hash_ck", sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const applicantIdentities = pgTable(
  "applicant_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    datasetId: uuid("dataset_id").notNull(),
    externalRef: text("external_ref").notNull(),
    identityData: jsonb("identity_data").$type<JsonObject>().notNull(),
    identityHash: text("identity_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("applicant_identities_tenant_comp_dataset_id_uq").on(
      table.tenantId,
      table.competitionId,
      table.datasetId,
      table.id,
    ),
    uniqueIndex("applicant_identities_dataset_external_ref_uq").on(
      table.tenantId,
      table.competitionId,
      table.datasetId,
      table.externalRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.datasetId],
      foreignColumns: [datasets.tenantId, datasets.competitionId, datasets.id],
      name: "applicant_identities_dataset_fk",
    }).onDelete("cascade"),
    index("applicant_identities_hash_idx").on(table.tenantId, table.competitionId, table.identityHash),
    check("applicant_identities_hash_ck", sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    datasetId: uuid("dataset_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    externalRef: text("external_ref").notNull(),
    content: jsonb("content").$type<JsonObject>().notNull(),
    contentHash: text("content_hash").notNull(),
    historicalLabel: jsonb("historical_label").$type<JsonObject>(),
    status: applicationStatusEnum("status").notNull().default("imported"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("applications_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    uniqueIndex("applications_dataset_external_ref_uq").on(
      table.tenantId,
      table.competitionId,
      table.datasetId,
      table.externalRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.datasetId],
      foreignColumns: [datasets.tenantId, datasets.competitionId, datasets.id],
      name: "applications_dataset_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.datasetId, table.identityId],
      foreignColumns: [
        applicantIdentities.tenantId,
        applicantIdentities.competitionId,
        applicantIdentities.datasetId,
        applicantIdentities.id,
      ],
      name: "applications_identity_fk",
    }).onDelete("restrict"),
    index("applications_review_queue_idx").on(table.tenantId, table.competitionId, table.status, table.id),
    check("applications_content_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    round: integer("round").notNull().default(1),
    status: assignmentStatusEnum("status").notNull().default("assigned"),
    blind: boolean("blind").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("assignments_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    uniqueIndex("assignments_application_reviewer_round_uq").on(
      table.tenantId,
      table.competitionId,
      table.applicationId,
      table.reviewerUserId,
      table.round,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.competitionId, applications.id],
      name: "assignments_application_fk",
    }).onDelete("cascade"),
    index("assignments_reviewer_queue_idx").on(
      table.tenantId,
      table.competitionId,
      table.reviewerUserId,
      table.status,
      table.dueAt,
    ),
    check("assignments_round_ck", sql`${table.round} > 0`),
    check("assignments_revision_ck", sql`${table.revision} > 0`),
  ],
);

export const calibrationSessions = pgTable(
  "calibration_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    guideVersionId: uuid("guide_version_id").notNull(),
    name: text("name").notNull(),
    status: calibrationStatusEnum("status").notNull().default("draft"),
    revealLimit: integer("reveal_limit").notNull().default(1),
    settings: jsonb("settings").$type<JsonObject>().notNull().default({}),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("calibration_sessions_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "calibration_sessions_competition_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.guideVersionId],
      foreignColumns: [guideVersions.tenantId, guideVersions.competitionId, guideVersions.id],
      name: "calibration_sessions_guide_version_fk",
    }).onDelete("restrict"),
    check("calibration_sessions_reveal_limit_ck", sql`${table.revealLimit} >= 0`),
  ],
);

export const calibrationCases = pgTable(
  "calibration_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    calibrationSessionId: uuid("calibration_session_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    referenceOutcome: jsonb("reference_outcome").$type<JsonObject>().notNull(),
    referenceHash: text("reference_hash").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("calibration_cases_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    uniqueIndex("calibration_cases_session_ordinal_uq").on(
      table.tenantId,
      table.competitionId,
      table.calibrationSessionId,
      table.ordinal,
    ),
    uniqueIndex("calibration_cases_session_application_uq").on(
      table.tenantId,
      table.competitionId,
      table.calibrationSessionId,
      table.applicationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.calibrationSessionId],
      foreignColumns: [calibrationSessions.tenantId, calibrationSessions.competitionId, calibrationSessions.id],
      name: "calibration_cases_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.competitionId, applications.id],
      name: "calibration_cases_application_fk",
    }).onDelete("restrict"),
    check("calibration_cases_ordinal_ck", sql`${table.ordinal} > 0`),
    check("calibration_cases_reference_hash_ck", sql`${table.referenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const calibrationRevealReceipts = pgTable(
  "calibration_reveal_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    calibrationSessionId: uuid("calibration_session_id").notNull(),
    calibrationCaseId: uuid("calibration_case_id").notNull(),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revealNumber: integer("reveal_number").notNull(),
    revealedAt: timestamp("revealed_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (table) => [
    uniqueIndex("calibration_reveal_receipts_once_uq").on(
      table.tenantId,
      table.competitionId,
      table.calibrationSessionId,
      table.calibrationCaseId,
      table.reviewerUserId,
    ),
    uniqueIndex("calibration_reveal_receipts_number_uq").on(
      table.tenantId,
      table.competitionId,
      table.calibrationSessionId,
      table.reviewerUserId,
      table.revealNumber,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.calibrationSessionId],
      foreignColumns: [calibrationSessions.tenantId, calibrationSessions.competitionId, calibrationSessions.id],
      name: "calibration_reveal_receipts_session_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.calibrationCaseId],
      foreignColumns: [calibrationCases.tenantId, calibrationCases.competitionId, calibrationCases.id],
      name: "calibration_reveal_receipts_case_fk",
    }).onDelete("restrict"),
    check("calibration_reveal_receipts_number_ck", sql`${table.revealNumber} > 0`),
  ],
);

export const safeguardApprovals = pgTable(
  "safeguard_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    safeguardKey: text("safeguard_key").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    version: integer("version").notNull(),
    decision: approvalDecisionEnum("decision").notNull(),
    evidence: jsonb("evidence").$type<JsonObject>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    supersedesApprovalId: uuid("supersedes_approval_id"),
    approvedByUserId: uuid("approved_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("safeguard_approvals_scope_version_uq").on(
      table.tenantId,
      table.competitionId,
      table.safeguardKey,
      table.scopeType,
      table.scopeId,
      table.version,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "safeguard_approvals_competition_fk",
    }).onDelete("cascade"),
    index("safeguard_approvals_current_idx").on(
      table.tenantId,
      table.competitionId,
      table.safeguardKey,
      table.scopeType,
      table.scopeId,
      table.version,
    ),
    check("safeguard_approvals_version_ck", sql`${table.version} > 0`),
    check("safeguard_approvals_evidence_hash_ck", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const assessmentRuns = pgTable(
  "assessment_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    datasetId: uuid("dataset_id").notNull(),
    rubricVersionId: uuid("rubric_version_id").notNull(),
    promptVersionId: uuid("prompt_version_id").notNull(),
    status: assessmentRunStatusEnum("status").notNull().default("queued"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelConfig: jsonb("model_config").$type<JsonObject>().notNull(),
    configurationHash: text("configuration_hash").notNull(),
    totalApplications: integer("total_applications").notNull().default(0),
    completedApplications: integer("completed_applications").notNull().default(0),
    failedApplications: integer("failed_applications").notNull().default(0),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureSummary: jsonb("failure_summary").$type<JsonObject>(),
  },
  (table) => [
    uniqueIndex("assessment_runs_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.datasetId],
      foreignColumns: [datasets.tenantId, datasets.competitionId, datasets.id],
      name: "assessment_runs_dataset_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.rubricVersionId],
      foreignColumns: [guideVersions.tenantId, guideVersions.competitionId, guideVersions.id],
      name: "assessment_runs_rubric_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.promptVersionId],
      foreignColumns: [guideVersions.tenantId, guideVersions.competitionId, guideVersions.id],
      name: "assessment_runs_prompt_fk",
    }).onDelete("restrict"),
    index("assessment_runs_status_idx").on(table.tenantId, table.competitionId, table.status, table.createdAt),
    check("assessment_runs_configuration_hash_ck", sql`${table.configurationHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "assessment_runs_counts_ck",
      sql`${table.totalApplications} >= 0 and ${table.completedApplications} >= 0 and ${table.failedApplications} >= 0 and ${table.completedApplications} + ${table.failedApplications} <= ${table.totalApplications}`,
    ),
  ],
);

export const assessmentBatches = pgTable(
  "assessment_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    assessmentRunId: uuid("assessment_run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: assessmentBatchStatusEnum("status").notNull().default("queued"),
    applicationCount: integer("application_count").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerRequestId: text("provider_request_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error").$type<JsonObject>(),
  },
  (table) => [
    uniqueIndex("assessment_batches_tenant_comp_id_uq").on(table.tenantId, table.competitionId, table.id),
    uniqueIndex("assessment_batches_run_ordinal_uq").on(
      table.tenantId,
      table.competitionId,
      table.assessmentRunId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.assessmentRunId],
      foreignColumns: [assessmentRuns.tenantId, assessmentRuns.competitionId, assessmentRuns.id],
      name: "assessment_batches_run_fk",
    }).onDelete("cascade"),
    index("assessment_batches_work_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
    check("assessment_batches_ordinal_ck", sql`${table.ordinal} > 0`),
    check("assessment_batches_application_count_ck", sql`${table.applicationCount} > 0`),
    check("assessment_batches_attempt_count_ck", sql`${table.attemptCount} >= 0`),
  ],
);

export const assessmentResults = pgTable(
  "assessment_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    assessmentRunId: uuid("assessment_run_id").notNull(),
    assessmentBatchId: uuid("assessment_batch_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    score: numeric("score", { precision: 12, scale: 4 }),
    recommendation: text("recommendation").notNull(),
    confidence: numeric("confidence", { precision: 6, scale: 5 }),
    result: jsonb("result").$type<JsonObject>().notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    providerResponseId: text("provider_response_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("assessment_results_run_application_uq").on(
      table.tenantId,
      table.competitionId,
      table.assessmentRunId,
      table.applicationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.assessmentRunId],
      foreignColumns: [assessmentRuns.tenantId, assessmentRuns.competitionId, assessmentRuns.id],
      name: "assessment_results_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.assessmentBatchId],
      foreignColumns: [assessmentBatches.tenantId, assessmentBatches.competitionId, assessmentBatches.id],
      name: "assessment_results_batch_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.competitionId, applications.id],
      name: "assessment_results_application_fk",
    }).onDelete("restrict"),
    index("assessment_results_recommendation_idx").on(
      table.tenantId,
      table.competitionId,
      table.assessmentRunId,
      table.recommendation,
    ),
    check("assessment_results_input_hash_ck", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_results_output_hash_ck", sql`${table.outputHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_results_confidence_ck", sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`),
  ],
);

export const reviewerReviews = pgTable(
  "reviewer_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    supersedesReviewId: uuid("supersedes_review_id"),
    status: reviewStatusEnum("status").notNull(),
    score: numeric("score", { precision: 12, scale: 4 }),
    recommendation: text("recommendation").notNull(),
    rationale: text("rationale").notNull(),
    rubricScores: jsonb("rubric_scores").$type<JsonObject>().notNull(),
    flags: jsonb("flags").$type<JsonObject>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("reviewer_reviews_assignment_revision_uq").on(
      table.tenantId,
      table.competitionId,
      table.assignmentId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.assignmentId],
      foreignColumns: [assignments.tenantId, assignments.competitionId, assignments.id],
      name: "reviewer_reviews_assignment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.competitionId, applications.id],
      name: "reviewer_reviews_application_fk",
    }).onDelete("restrict"),
    index("reviewer_reviews_latest_idx").on(
      table.tenantId,
      table.competitionId,
      table.applicationId,
      table.reviewerUserId,
      table.revision,
    ),
    check("reviewer_reviews_revision_ck", sql`${table.revision} > 0`),
    check("reviewer_reviews_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "reviewer_reviews_submission_ck",
      sql`${table.status} <> 'submitted' or ${table.submittedAt} is not null`,
    ),
  ],
);

export const finalDecisionRevisions = pgTable(
  "final_decision_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    revision: integer("revision").notNull(),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<JsonObject>().notNull(),
    contentHash: text("content_hash").notNull(),
    decidedByUserId: uuid("decided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("final_decision_revisions_application_revision_uq").on(
      table.tenantId,
      table.competitionId,
      table.applicationId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.competitionId, applications.id],
      name: "final_decision_revisions_application_fk",
    }).onDelete("restrict"),
    index("final_decision_revisions_latest_idx").on(
      table.tenantId,
      table.competitionId,
      table.applicationId,
      table.revision,
    ),
    check("final_decision_revisions_revision_ck", sql`${table.revision} > 0`),
    check("final_decision_revisions_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id"),
    sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
    previousHash: text("previous_hash").notNull().default(sql`repeat('0', 64)`),
    eventHash: text("event_hash").notNull().default(sql`repeat('0', 64)`),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    actorRole: text("actor_role"),
    outcome: auditOutcomeEnum("outcome").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason"),
    objectType: text("object_type").notNull(),
    objectId: text("object_id"),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_events_tenant_sequence_uq").on(table.tenantId, table.sequence),
    uniqueIndex("audit_events_tenant_hash_uq").on(table.tenantId, table.eventHash),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "audit_events_competition_fk",
    }).onDelete("restrict"),
    index("audit_events_object_idx").on(
      table.tenantId,
      table.competitionId,
      table.objectType,
      table.objectId,
      table.sequence,
    ),
    index("audit_events_actor_idx").on(table.tenantId, table.actorUserId, table.sequence),
    check("audit_events_previous_hash_ck", sql`${table.previousHash} ~ '^[0-9a-f]{64}$'`),
    check("audit_events_event_hash_ck", sql`${table.eventHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id"),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: idempotencyStatusEnum("status").notNull().default("processing"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<JsonObject>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_tenant_scope_key_uq").on(table.tenantId, table.scope, table.key),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "idempotency_keys_competition_fk",
    }).onDelete("cascade"),
    index("idempotency_keys_expiry_idx").on(table.status, table.expiresAt),
    check("idempotency_keys_request_hash_ck", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id"),
    topic: text("topic").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("outbox_events_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "outbox_events_competition_fk",
    }).onDelete("cascade"),
    index("outbox_events_delivery_idx").on(table.status, table.availableAt, table.createdAt),
    check("outbox_events_payload_hash_ck", sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check("outbox_events_attempt_count_ck", sql`${table.attemptCount} >= 0`),
  ],
);

export const currentImportSessions = pgTable(
  "current_import_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    sourceHash: text("source_hash").notNull(),
    expectedRowCount: integer("expected_row_count").notNull(),
    expectedChunkCount: integer("expected_chunk_count").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: currentImportStatusEnum("status").notNull().default("staging"),
    revision: integer("revision").notNull().default(1),
    receivedRowCount: integer("received_row_count").notNull().default(0),
    receivedChunkCount: integer("received_chunk_count").notNull().default(0),
    completedDatasetId: uuid("completed_dataset_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("current_import_sessions_tenant_comp_id_uq").on(
      table.tenantId,
      table.competitionId,
      table.id,
    ),
    uniqueIndex("current_import_sessions_idempotency_uq").on(
      table.tenantId,
      table.competitionId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "current_import_sessions_competition_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.completedDatasetId],
      foreignColumns: [datasets.tenantId, datasets.competitionId, datasets.id],
      name: "current_import_sessions_dataset_fk",
    }).onDelete("restrict"),
    index("current_import_sessions_expiry_idx").on(table.status, table.expiresAt),
    check("current_import_sessions_source_hash_ck", sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
    check("current_import_sessions_rows_ck", sql`${table.expectedRowCount} > 0 and ${table.expectedRowCount} <= 1000`),
    check("current_import_sessions_chunks_ck", sql`${table.expectedChunkCount} > 0 and ${table.expectedChunkCount} <= 100`),
    check("current_import_sessions_schema_ck", sql`${table.schemaVersion} > 0`),
    check("current_import_sessions_revision_ck", sql`${table.revision} > 0`),
    check(
      "current_import_sessions_received_ck",
      sql`${table.receivedRowCount} >= 0 and ${table.receivedRowCount} <= ${table.expectedRowCount} and ${table.receivedChunkCount} >= 0 and ${table.receivedChunkCount} <= ${table.expectedChunkCount}`,
    ),
    check(
      "current_import_sessions_completed_ck",
      sql`${table.status} <> 'completed' or (${table.completedDatasetId} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export const currentImportChunks = pgTable(
  "current_import_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    importSessionId: uuid("import_session_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startRow: integer("start_row").notNull(),
    rowCount: integer("row_count").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    canonicalBytes: integer("canonical_bytes").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("current_import_chunks_tenant_comp_session_id_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.id,
    ),
    uniqueIndex("current_import_chunks_session_index_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.chunkIndex,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.importSessionId],
      foreignColumns: [
        currentImportSessions.tenantId,
        currentImportSessions.competitionId,
        currentImportSessions.id,
      ],
      name: "current_import_chunks_session_fk",
    }).onDelete("cascade"),
    check("current_import_chunks_index_ck", sql`${table.chunkIndex} >= 0 and ${table.chunkIndex} < 100`),
    check("current_import_chunks_start_ck", sql`${table.startRow} >= 0 and ${table.startRow} < 1000`),
    check("current_import_chunks_rows_ck", sql`${table.rowCount} > 0 and ${table.rowCount} <= 25`),
    check("current_import_chunks_hash_ck", sql`${table.chunkHash} ~ '^[0-9a-f]{64}$'`),
    check("current_import_chunks_bytes_ck", sql`${table.canonicalBytes} > 0 and ${table.canonicalBytes} <= 750000`),
  ],
);

export const currentImportRows = pgTable(
  "current_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    importSessionId: uuid("import_session_id").notNull(),
    importChunkId: uuid("import_chunk_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowOrdinal: integer("row_ordinal").notNull(),
    externalRef: text("external_ref").notNull(),
    identityData: jsonb("identity_data").$type<JsonObject>().notNull(),
    content: jsonb("content").$type<JsonObject>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    identityHash: text("identity_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    rowHash: text("row_hash").notNull(),
    canonicalBytes: integer("canonical_bytes").notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("current_import_rows_session_ordinal_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.rowOrdinal,
    ),
    uniqueIndex("current_import_rows_session_external_ref_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.externalRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.importSessionId],
      foreignColumns: [
        currentImportSessions.tenantId,
        currentImportSessions.competitionId,
        currentImportSessions.id,
      ],
      name: "current_import_rows_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.tenantId,
        table.competitionId,
        table.importSessionId,
        table.importChunkId,
      ],
      foreignColumns: [
        currentImportChunks.tenantId,
        currentImportChunks.competitionId,
        currentImportChunks.importSessionId,
        currentImportChunks.id,
      ],
      name: "current_import_rows_chunk_fk",
    }).onDelete("cascade"),
    index("current_import_rows_chunk_idx").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.chunkIndex,
      table.rowOrdinal,
    ),
    check("current_import_rows_ordinal_ck", sql`${table.rowOrdinal} >= 0 and ${table.rowOrdinal} < 1000`),
    check("current_import_rows_chunk_index_ck", sql`${table.chunkIndex} >= 0 and ${table.chunkIndex} < 100`),
    check("current_import_rows_external_ref_ck", sql`length(${table.externalRef}) between 1 and 200`),
    check("current_import_rows_identity_hash_ck", sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`),
    check("current_import_rows_content_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("current_import_rows_row_hash_ck", sql`${table.rowHash} ~ '^[0-9a-f]{64}$'`),
    check("current_import_rows_bytes_ck", sql`${table.canonicalBytes} > 0 and ${table.canonicalBytes} <= 250000`),
  ],
);

export const historicalImportSessions = pgTable(
  "historical_import_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    sourceHash: text("source_hash").notNull(),
    expectedRowCount: integer("expected_row_count").notNull(),
    expectedChunkCount: integer("expected_chunk_count").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: historicalImportStatusEnum("status").notNull().default("staging"),
    revision: integer("revision").notNull().default(1),
    receivedRowCount: integer("received_row_count").notNull().default(0),
    receivedChunkCount: integer("received_chunk_count").notNull().default(0),
    completedDatasetId: uuid("completed_dataset_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("historical_import_sessions_tenant_comp_id_uq").on(
      table.tenantId,
      table.competitionId,
      table.id,
    ),
    uniqueIndex("historical_import_sessions_idempotency_uq").on(
      table.tenantId,
      table.competitionId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId],
      foreignColumns: [competitions.tenantId, competitions.id],
      name: "historical_import_sessions_competition_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.completedDatasetId],
      foreignColumns: [datasets.tenantId, datasets.competitionId, datasets.id],
      name: "historical_import_sessions_dataset_fk",
    }).onDelete("restrict"),
    index("historical_import_sessions_expiry_idx").on(table.status, table.expiresAt),
    check("historical_import_sessions_source_hash_ck", sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
    check("historical_import_sessions_rows_ck", sql`${table.expectedRowCount} > 0 and ${table.expectedRowCount} <= 1000`),
    check("historical_import_sessions_chunks_ck", sql`${table.expectedChunkCount} > 0 and ${table.expectedChunkCount} <= 100`),
    check("historical_import_sessions_schema_ck", sql`${table.schemaVersion} > 0`),
    check("historical_import_sessions_revision_ck", sql`${table.revision} > 0`),
    check(
      "historical_import_sessions_received_ck",
      sql`${table.receivedRowCount} >= 0 and ${table.receivedRowCount} <= ${table.expectedRowCount} and ${table.receivedChunkCount} >= 0 and ${table.receivedChunkCount} <= ${table.expectedChunkCount}`,
    ),
    check(
      "historical_import_sessions_completed_ck",
      sql`${table.status} <> 'completed' or (${table.completedDatasetId} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export const historicalImportChunks = pgTable(
  "historical_import_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    importSessionId: uuid("import_session_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startRow: integer("start_row").notNull(),
    rowCount: integer("row_count").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    canonicalBytes: integer("canonical_bytes").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("historical_import_chunks_tenant_comp_session_id_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.id,
    ),
    uniqueIndex("historical_import_chunks_session_index_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.chunkIndex,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.importSessionId],
      foreignColumns: [
        historicalImportSessions.tenantId,
        historicalImportSessions.competitionId,
        historicalImportSessions.id,
      ],
      name: "historical_import_chunks_session_fk",
    }).onDelete("cascade"),
    check("historical_import_chunks_index_ck", sql`${table.chunkIndex} >= 0 and ${table.chunkIndex} < 100`),
    check("historical_import_chunks_start_ck", sql`${table.startRow} >= 0 and ${table.startRow} < 1000`),
    check("historical_import_chunks_rows_ck", sql`${table.rowCount} > 0 and ${table.rowCount} <= 25`),
    check("historical_import_chunks_hash_ck", sql`${table.chunkHash} ~ '^[0-9a-f]{64}$'`),
    check("historical_import_chunks_bytes_ck", sql`${table.canonicalBytes} > 0 and ${table.canonicalBytes} <= 750000`),
  ],
);

export const historicalImportRows = pgTable(
  "historical_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    competitionId: uuid("competition_id").notNull(),
    importSessionId: uuid("import_session_id").notNull(),
    importChunkId: uuid("import_chunk_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowOrdinal: integer("row_ordinal").notNull(),
    externalRef: text("external_ref").notNull(),
    content: jsonb("content").$type<JsonObject>().notNull(),
    historicalLabel: jsonb("historical_label").$type<JsonObject>().notNull(),
    contentHash: text("content_hash").notNull(),
    labelHash: text("label_hash").notNull(),
    rowHash: text("row_hash").notNull(),
    canonicalBytes: integer("canonical_bytes").notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("historical_import_rows_session_ordinal_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.rowOrdinal,
    ),
    uniqueIndex("historical_import_rows_session_external_ref_uq").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.externalRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.importSessionId],
      foreignColumns: [
        historicalImportSessions.tenantId,
        historicalImportSessions.competitionId,
        historicalImportSessions.id,
      ],
      name: "historical_import_rows_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.competitionId, table.importSessionId, table.importChunkId],
      foreignColumns: [
        historicalImportChunks.tenantId,
        historicalImportChunks.competitionId,
        historicalImportChunks.importSessionId,
        historicalImportChunks.id,
      ],
      name: "historical_import_rows_chunk_fk",
    }).onDelete("cascade"),
    index("historical_import_rows_chunk_idx").on(
      table.tenantId,
      table.competitionId,
      table.importSessionId,
      table.chunkIndex,
      table.rowOrdinal,
    ),
    check("historical_import_rows_ordinal_ck", sql`${table.rowOrdinal} >= 0 and ${table.rowOrdinal} < 1000`),
    check("historical_import_rows_chunk_index_ck", sql`${table.chunkIndex} >= 0 and ${table.chunkIndex} < 100`),
    check("historical_import_rows_external_ref_ck", sql`length(${table.externalRef}) between 1 and 200`),
    check("historical_import_rows_content_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("historical_import_rows_label_hash_ck", sql`${table.labelHash} ~ '^[0-9a-f]{64}$'`),
    check("historical_import_rows_row_hash_ck", sql`${table.rowHash} ~ '^[0-9a-f]{64}$'`),
    check("historical_import_rows_bytes_ck", sql`${table.canonicalBytes} > 0 and ${table.canonicalBytes} <= 250000`),
  ],
);
