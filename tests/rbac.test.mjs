import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  IdentityMappingMismatchError,
  RouteAuthorizationError,
  authorizationErrorResponse,
  authorizePermission,
  authorizeReview,
  buildClerkServerSessionIdentity,
  hasPermission,
  isServerPrincipal,
  parsePlatformRole,
  parseMinderTenantId,
  permissionsForRole,
  principalForCompetition,
  principalHasPermission,
  projectPostgresIdentityRows,
  requirePermission,
  resolvePlatformContext,
  resolvePlatformContextFromRepository,
} from "../lib/auth/index.ts";
import {
  appendAuditEvent,
  buildAuditEvent,
  sanitizeAuditMetadata,
} from "../lib/audit.ts";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CLERK_ORGANIZATION_ID = "org_clerk_1";

const SESSION = Object.freeze({
  provider: "clerk",
  providerUserId: "user_clerk_1",
  providerOrganizationId: CLERK_ORGANIZATION_ID,
  sessionId: "sess_clerk_1",
  tenantId: TENANT_ID,
});

function identityRow(overrides = {}) {
  return {
    provider: "clerk",
    authSubject: "user_clerk_1",
    organizationAuthProvider: "clerk",
    organizationAuthSubject: CLERK_ORGANIZATION_ID,
    userId: "usr_1",
    userDisplayName: "Ada Reviewer",
    userDisabledAt: null,
    tenantId: TENANT_ID,
    organizationName: "Net Zero Foundation",
    organizationSlug: "net-zero-foundation",
    organizationArchivedAt: null,
    membershipStatus: "active",
    competitionId: "competition_1",
    competitionName: "2027 Net Zero Challenge",
    competitionStatus: "reviewing",
    competitionArchivedAt: null,
    role: "reviewer",
    ...overrides,
  };
}

function resolvedPrincipal(role = "reviewer") {
  const resolution = resolvePlatformContext(SESSION, [identityRow({ role })]);
  assert.equal(resolution.ok, true);
  return resolution.principals[0];
}

test("role and permission definitions are complete, explicit, and fail closed", () => {
  assert.deepEqual(PLATFORM_ROLES, [
    "owner",
    "competition_admin",
    "rubric_manager",
    "reviewer",
    "decision_approver",
    "auditor",
  ]);
  assert.equal(parsePlatformRole("decision_approver"), "decision_approver");
  assert.equal(parsePlatformRole("admin"), null);
  assert.equal(parsePlatformRole("OWNER"), null);

  for (const permission of PLATFORM_PERMISSIONS) {
    assert.equal(hasPermission("owner", permission), true, `owner lacks ${permission}`);
  }
  assert.equal(permissionsForRole("not_a_role").length, 0);
  assert.equal(hasPermission("owner", "invented.permission"), false);
  assert.equal(hasPermission("invented_role", "competition.read"), false);
});

test("least-privilege role boundaries keep identity, decisions, writes, and audit separate", () => {
  assert.equal(hasPermission("reviewer", "application.read_content"), true);
  assert.equal(hasPermission("reviewer", "application.read_identity"), false);
  assert.equal(hasPermission("reviewer", "review.write_assigned"), true);
  assert.equal(hasPermission("reviewer", "decision.approve"), false);
  assert.equal(hasPermission("reviewer", "audit.read"), false);

  assert.equal(hasPermission("rubric_manager", "rubric.approve"), true);
  assert.equal(hasPermission("rubric_manager", "assessment.run"), true);
  assert.equal(hasPermission("rubric_manager", "application.read_identity"), false);
  assert.equal(hasPermission("rubric_manager", "decision.approve"), false);

  assert.equal(hasPermission("decision_approver", "application.read_identity"), true);
  assert.equal(hasPermission("decision_approver", "decision.approve"), true);
  assert.equal(hasPermission("decision_approver", "rubric.write"), false);
  assert.equal(hasPermission("decision_approver", "assessment.run"), false);

  assert.equal(hasPermission("auditor", "audit.read"), true);
  assert.equal(hasPermission("auditor", "audit.export"), true);
  assert.equal(hasPermission("auditor", "application.read_identity"), false);
  assert.equal(hasPermission("auditor", "decision.approve"), false);
});

test("server session and Postgres rows resolve to a minimal, deterministic safe context", () => {
  const result = resolvePlatformContext(SESSION, [
    identityRow({
      competitionId: "competition_2",
      competitionName: "Zulu Challenge",
      role: "auditor",
    }),
    identityRow(),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.principals.length, 2);
  assert.equal(result.principals.every(isServerPrincipal), true);
  assert.deepEqual(result.context.user, { id: "usr_1", displayName: "Ada Reviewer" });
  assert.deepEqual(
    result.context.organizations.map((organization) => organization.id),
    [TENANT_ID],
  );
  assert.deepEqual(
    result.context.competitions.map((competition) => competition.id),
    ["competition_1", "competition_2"],
  );
  assert.equal(result.context.competitions[0].primaryRole, "reviewer");
  assert.deepEqual(result.context.competitions[0].roles, ["reviewer"]);
  assert.equal(result.context.competitions[0].permissions.includes("review.write_assigned"), true);

  const serialized = JSON.stringify(result.context);
  assert.doesNotMatch(serialized, /user_clerk_1|org_clerk_1|sess_clerk_1/);
  assert.doesNotMatch(
    serialized,
    /providerUserId|providerOrganizationId|sessionId|membershipId|userStatus/,
  );
});

test("Clerk organization private metadata creates a tenant-bound session or fails closed", () => {
  assert.equal(parseMinderTenantId({ minderTenantId: TENANT_ID.toUpperCase() }), TENANT_ID);
  assert.equal(parseMinderTenantId({ minderTenantId: "not-a-uuid" }), null);
  assert.equal(parseMinderTenantId({ minderTenantId: ` ${TENANT_ID}` }), null);
  assert.equal(parseMinderTenantId(null), null);

  assert.deepEqual(
    buildClerkServerSessionIdentity({
      providerUserId: "user_clerk_1",
      providerOrganizationId: CLERK_ORGANIZATION_ID,
      fetchedOrganizationId: CLERK_ORGANIZATION_ID,
      sessionId: "sess_clerk_1",
      organizationPrivateMetadata: { minderTenantId: TENANT_ID },
    }),
    SESSION,
  );
  assert.equal(
    buildClerkServerSessionIdentity({
      providerUserId: "user_clerk_1",
      providerOrganizationId: CLERK_ORGANIZATION_ID,
      fetchedOrganizationId: "org_different",
      sessionId: "sess_clerk_1",
      organizationPrivateMetadata: { minderTenantId: TENANT_ID },
    }),
    null,
  );
  assert.equal(
    buildClerkServerSessionIdentity({
      providerUserId: "user_clerk_1",
      providerOrganizationId: null,
      fetchedOrganizationId: CLERK_ORGANIZATION_ID,
      sessionId: "sess_clerk_1",
      organizationPrivateMetadata: { minderTenantId: TENANT_ID },
    }),
    null,
  );
  assert.equal(
    buildClerkServerSessionIdentity({
      providerUserId: "user_clerk_1",
      providerOrganizationId: CLERK_ORGANIZATION_ID,
      fetchedOrganizationId: CLERK_ORGANIZATION_ID,
      sessionId: "sess_clerk_1",
      organizationPrivateMetadata: {},
    }),
    null,
  );
});

test("multiple roles on one competition aggregate into a deterministic permission union", () => {
  const rows = [
    identityRow({ role: "decision_approver" }),
    identityRow({ role: "reviewer" }),
    identityRow({ role: "decision_approver" }),
  ];
  const result = resolvePlatformContext(SESSION, rows);
  assert.equal(result.ok, true);
  assert.equal(result.context.competitions.length, 1);
  assert.deepEqual(result.context.competitions[0].roles, ["reviewer", "decision_approver"]);
  assert.equal(result.context.competitions[0].primaryRole, "reviewer");
  assert.deepEqual(
    result.context.competitions[0].permissions,
    PLATFORM_PERMISSIONS.filter(
      (permission) =>
        hasPermission("reviewer", permission) || hasPermission("decision_approver", permission),
    ),
  );
  assert.deepEqual(result.principals[0].roles, ["reviewer", "decision_approver"]);
  assert.equal(principalHasPermission(result.principals[0], "review.write_assigned"), true);
  assert.equal(principalHasPermission(result.principals[0], "decision.approve"), true);
  assert.equal(principalHasPermission(result.principals[0], "audit.read"), false);

  const scope = { organizationId: TENANT_ID, competitionId: "competition_1" };
  assert.equal(authorizePermission(result.principals[0], "decision.approve", scope).allowed, true);
  assert.deepEqual(authorizePermission(result.principals[0], "audit.read", scope), {
    allowed: false,
    status: 403,
    code: "permission_denied",
  });

  const reversed = resolvePlatformContext(SESSION, [...rows].reverse());
  assert.equal(reversed.ok, true);
  assert.deepEqual(reversed.context.competitions[0], result.context.competitions[0]);
  assert.deepEqual(reversed.principals[0].roles, result.principals[0].roles);
});

test("Postgres projection combines inherited and time-bounded direct roles without trusting email", () => {
  const base = {
    authSubject: "user_clerk_1",
    organizationAuthProvider: "clerk",
    organizationAuthSubject: CLERK_ORGANIZATION_ID,
    userId: "usr_1",
    userDisplayName: null,
    userDisabledAt: null,
    tenantId: TENANT_ID,
    organizationName: "Net Zero Foundation",
    organizationSlug: "net-zero-foundation",
    organizationArchivedAt: null,
    membershipRole: "admin",
    membershipStatus: "active",
    competitionId: "competition_1",
    competitionName: "2027 Net Zero Challenge",
    competitionStatus: "reviewing",
    competitionArchivedAt: null,
    grantRole: "decision_approver",
    grantActiveFrom: new Date("2027-01-01T00:00:00.000Z"),
    grantActiveUntil: null,
    grantRevokedAt: null,
  };
  const rows = projectPostgresIdentityRows(
    "clerk",
    [base],
    new Date("2027-03-01T00:00:00.000Z"),
  );
  assert.deepEqual(rows.map((row) => row.role), ["competition_admin", "decision_approver"]);
  assert.equal(rows[0].userDisplayName, "Minder user");

  const expired = projectPostgresIdentityRows(
    "clerk",
    [
      {
        ...base,
        membershipRole: "member",
        grantActiveUntil: new Date("2027-02-01T00:00:00.000Z"),
      },
    ],
    new Date("2027-03-01T00:00:00.000Z"),
  );
  assert.deepEqual(expired, []);

  const owner = projectPostgresIdentityRows(
    "clerk",
    [{ ...base, membershipRole: "owner", grantRole: null, grantActiveFrom: null }],
    new Date("2027-03-01T00:00:00.000Z"),
  );
  assert.deepEqual(owner.map((row) => row.role), ["owner"]);
});

test("identity resolution rejects spoofing, invalid grants, inactive access, and ambiguity", () => {
  assert.deepEqual(resolvePlatformContext(null, [identityRow()]), {
    ok: false,
    reason: "unauthenticated",
  });
  assert.deepEqual(resolvePlatformContext(SESSION, []), {
    ok: false,
    reason: "no_active_membership",
  });
  assert.deepEqual(
    resolvePlatformContext(SESSION, [identityRow({ authSubject: "user_attacker" })]),
    { ok: false, reason: "identity_mismatch" },
  );
  assert.deepEqual(
    resolvePlatformContext(SESSION, [
      identityRow({ organizationAuthSubject: "org_attacker" }),
    ]),
    { ok: false, reason: "identity_mismatch" },
  );
  assert.deepEqual(
    resolvePlatformContext(SESSION, [identityRow({ tenantId: OTHER_TENANT_ID })]),
    { ok: false, reason: "identity_mismatch" },
  );
  assert.deepEqual(
    resolvePlatformContext({ ...SESSION, tenantId: "not-a-uuid" }, [identityRow()]),
    { ok: false, reason: "unauthenticated" },
  );
  assert.deepEqual(resolvePlatformContext(SESSION, [identityRow({ role: "super_admin" })]), {
    ok: false,
    reason: "invalid_mapping",
  });
  assert.deepEqual(
    resolvePlatformContext(SESSION, [identityRow({ membershipStatus: "suspended" })]),
    { ok: false, reason: "no_active_membership" },
  );
  assert.deepEqual(
    resolvePlatformContext(SESSION, [
      identityRow(),
      identityRow({ competitionName: "Conflicting challenge name" }),
    ]),
    { ok: false, reason: "ambiguous_mapping" },
  );
  assert.deepEqual(
    resolvePlatformContext(SESSION, [identityRow({ organizationSlug: "Not A Safe Slug" })]),
    { ok: false, reason: "invalid_mapping" },
  );
});

test("repository lookup is pinned to user, provider organization, and tenant", async () => {
  let lookup = null;
  const repository = {
    async findIdentityRowsByProviderIdentity(args) {
      lookup = args;
      return [identityRow()];
    },
  };
  const result = await resolvePlatformContextFromRepository(SESSION, repository);
  assert.equal(result.ok, true);
  assert.deepEqual(lookup, {
    provider: "clerk",
    providerUserId: "user_clerk_1",
    providerOrganizationId: CLERK_ORGANIZATION_ID,
    tenantId: TENANT_ID,
  });

  const unavailable = await resolvePlatformContextFromRepository(SESSION, {
    async findIdentityRowsByProviderIdentity() {
      throw new Error("database offline");
    },
  });
  assert.deepEqual(unavailable, { ok: false, reason: "identity_store_unavailable" });

  const mismatch = await resolvePlatformContextFromRepository(SESSION, {
    async findIdentityRowsByProviderIdentity() {
      throw new IdentityMappingMismatchError();
    },
  });
  assert.deepEqual(mismatch, { ok: false, reason: "identity_mismatch" });
});

test("runtime identity bootstrap is server-only, Clerk-org-bound, and RLS-scoped", async () => {
  const [requestContextSource, repositorySource] = await Promise.all([
    readFile(new URL("../lib/auth/request-context.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth/postgres-repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(requestContextSource, /import "server-only"/);
  assert.match(requestContextSource, /resolveRequestPlatformContext\(\)/);
  assert.match(requestContextSource, /clerkSession\.orgId/);
  assert.match(requestContextSource, /organizations\.getOrganization/);
  assert.match(requestContextSource, /clerkOrganization\.privateMetadata/);

  assert.match(repositorySource, /withTenantTransaction/);
  assert.match(repositorySource, /\{ tenantId, userId: null \}/);
  assert.match(repositorySource, /organizations\.authProvider/);
  assert.match(repositorySource, /organizations\.authSubject/);
  assert.doesNotMatch(repositorySource, /getDatabase/);
});

test("competition principal selection only returns server-branded memberships", () => {
  const result = resolvePlatformContext(SESSION, [identityRow()]);
  const principal = principalForCompetition(result, "competition_1");
  assert.equal(isServerPrincipal(principal), true);
  assert.equal(principalForCompetition(result, "competition_other"), null);
  assert.equal(principalForCompetition(result, "unsafe id with spaces"), null);
  assert.equal(isServerPrincipal({ ...principal }), false, "JSON-like copies lose the server brand");
});

test("route permission guard enforces both tenant scope and role permission", () => {
  const reviewer = resolvedPrincipal("reviewer");
  const correctScope = { organizationId: TENANT_ID, competitionId: "competition_1" };

  assert.equal(authorizePermission(reviewer, "application.read_content", correctScope).allowed, true);
  assert.deepEqual(authorizePermission(reviewer, "application.read_identity", correctScope), {
    allowed: false,
    status: 403,
    code: "permission_denied",
  });
  assert.deepEqual(
    authorizePermission(reviewer, "application.read_content", {
      organizationId: "org_other",
      competitionId: "competition_other",
    }),
    { allowed: false, status: 404, code: "resource_not_found" },
  );
  assert.deepEqual(
    authorizePermission({ ...reviewer }, "application.read_content", correctScope),
    { allowed: false, status: 401, code: "not_authenticated" },
  );
});

test("review guard requires an active server-loaded assignment for reviewers", () => {
  const reviewer = resolvedPrincipal("reviewer");
  const scope = { organizationId: TENANT_ID, competitionId: "competition_1" };
  const assignment = {
    ...scope,
    reviewerUserId: "usr_1",
    status: "assigned",
  };

  assert.equal(authorizeReview(reviewer, "read", scope, assignment).allowed, true);
  assert.equal(authorizeReview(reviewer, "write", scope, assignment).allowed, true);
  assert.equal(
    authorizeReview(reviewer, "read", scope, { ...assignment, status: "submitted" }).allowed,
    true,
  );
  assert.equal(
    authorizeReview(reviewer, "write", scope, { ...assignment, status: "submitted" }).allowed,
    true,
  );
  assert.deepEqual(authorizeReview(reviewer, "write", scope, { ...assignment, status: "reassigned" }), {
    allowed: false,
    status: 403,
    code: "active_assignment_required",
  });
  assert.deepEqual(authorizeReview(reviewer, "write", scope, { ...assignment, status: "cancelled" }), {
    allowed: false,
    status: 403,
    code: "active_assignment_required",
  });
  assert.deepEqual(
    authorizeReview(reviewer, "read", scope, { ...assignment, reviewerUserId: "usr_other" }),
    { allowed: false, status: 403, code: "active_assignment_required" },
  );

  const admin = resolvedPrincipal("competition_admin");
  assert.equal(authorizeReview(admin, "read", scope, null).allowed, true);
  assert.equal(authorizeReview(admin, "write", scope, null).allowed, true);
  const approver = resolvedPrincipal("decision_approver");
  assert.equal(authorizeReview(approver, "read", scope, null).allowed, true);
  assert.equal(authorizeReview(approver, "write", scope, null).allowed, false);
});

test("throwing route guard and error response expose no internal authorization details", async () => {
  const reviewer = resolvedPrincipal("reviewer");
  const scope = { organizationId: TENANT_ID, competitionId: "competition_1" };
  assert.equal(requirePermission(reviewer, "application.read_content", scope), reviewer);

  let caught;
  try {
    requirePermission(reviewer, "application.read_identity", scope);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof RouteAuthorizationError, true);
  const response = authorizationErrorResponse(caught);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: "permission_denied",
      message: "You do not have permission to perform this action.",
    },
  });
});

test("audit metadata keeps only structured operational fields and drops candidate prose", () => {
  const metadata = sanitizeAuditMetadata({
    requestId: "request_123",
    recordCount: 700,
    durationMs: 1234,
    conflict: false,
    previousStatus: "draft",
    nextStatus: "approved",
    changedFields: ["status", "review_score"],
    importHash: "0123456789abcdef0123456789abcdef",
    candidateText: "Our team invented a secret carbon capture process.",
    answer: "This is the full application response.",
    prompt: "Private model prompt",
    email: "candidate@example.com",
    freeFormNote: "A human reviewer wrote this sensitive note.",
    errorCode: "a sentence with spaces is not a machine code",
    nested: { raw: "never persist recursive objects" },
  });

  assert.equal(metadata.requestId, "request_123");
  assert.equal(metadata.recordCount, 700);
  assert.deepEqual(metadata.changedFields, ["status", "review_score"]);
  assert.deepEqual(metadata.redactedFields, [
    "answer",
    "candidateText",
    "email",
    "errorCode",
    "freeFormNote",
    "nested",
    "prompt",
  ]);
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /secret carbon|full application|candidate@example|human reviewer/i);
});

test("audit metadata validates numeric ranges, role sets, and machine-code lists strictly", () => {
  const tooManyReasons = Array.from({ length: 51 }, (_, index) => `reason_${index}`);
  const metadata = sanitizeAuditMetadata({
    role: "reviewer+decision_approver",
    recordCount: 0,
    revision: 1,
    httpStatus: 599,
    changedFields: ["status", "review_score"],
    reasonCodes: ["review_complete", "needs_follow_up"],
    durationMs: -1,
    attempt: 1.5,
    expectedRevision: 0,
    actualRevision: Number.MAX_SAFE_INTEGER + 1,
    invalidHttpStatus: 200,
    unsafeRole: "owner+super_admin",
    invalidChangedFields: ["status", "review notes"],
    tooManyReasons,
  });

  assert.equal(metadata.role, "reviewer+decision_approver");
  assert.equal(metadata.recordCount, 0);
  assert.equal(metadata.revision, 1);
  assert.equal(metadata.httpStatus, 599);
  assert.deepEqual(metadata.changedFields, ["status", "review_score"]);
  assert.deepEqual(metadata.reasonCodes, ["review_complete", "needs_follow_up"]);
  assert.deepEqual(metadata.redactedFields, [
    "actualRevision",
    "attempt",
    "durationMs",
    "expectedRevision",
    "invalidChangedFields",
    "invalidHttpStatus",
    "tooManyReasons",
    "unsafeRole",
  ]);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.changedFields), true);
  assert.doesNotMatch(JSON.stringify(metadata), /super_admin|review notes|reason_50/);
});

test("audit event derives actor and tenant only from the branded server principal", () => {
  const actor = resolvedPrincipal("reviewer");
  const event = buildAuditEvent(
    {
      actor,
      action: "review.updated",
      outcome: "success",
      targetType: "application",
      targetId: "application_42",
      summaryCode: "review_saved",
      metadata: { revision: 4, reasonCode: "review_complete" },
      // Runtime callers cannot override these even if an untyped client object contains them.
      organizationId: "org_attacker",
      actorUserId: "usr_attacker",
    },
    {
      now: () => new Date("2027-01-02T03:04:05.000Z"),
      createId: () => "audit_1",
    },
  );

  assert.equal(event.organizationId, TENANT_ID);
  assert.equal(event.competitionId, "competition_1");
  assert.equal(event.actorUserId, "usr_1");
  assert.equal(event.actorRole, "reviewer");
  assert.deepEqual(event.actorRoles, ["reviewer"]);
  assert.equal(event.occurredAt, "2027-01-02T03:04:05.000Z");
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
});

test("audit builder rejects fake actors, free-form summaries, and unsafe target IDs", () => {
  const actor = resolvedPrincipal("reviewer");
  const base = {
    actor,
    action: "review.updated",
    outcome: "success",
    targetType: "application",
    targetId: "application_42",
    summaryCode: "review_saved",
  };
  assert.throws(() => buildAuditEvent({ ...base, actor: { ...actor } }), /verified server identity/);
  assert.throws(
    () => buildAuditEvent({ ...base, summaryCode: "Reviewer saved a long free-form note" }),
    /machine-readable code/,
  );
  assert.throws(
    () => buildAuditEvent({ ...base, targetId: "candidate text must not live here" }),
    /safe identifier/,
  );
});

test("audit append uses the supplied transaction and propagates insert failure", async () => {
  const actor = resolvedPrincipal("competition_admin");
  const input = {
    actor,
    action: "competition.updated",
    outcome: "success",
    targetType: "competition",
    targetId: "competition_1",
    summaryCode: "settings_saved",
    metadata: { changedFields: ["deadline"], revision: 8 },
  };
  const inserted = [];
  const event = await appendAuditEvent(
    { async insertAuditEvent(record) { inserted.push(record); } },
    input,
    { now: () => new Date("2027-02-03T00:00:00.000Z"), createId: () => "audit_2" },
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0], event);

  await assert.rejects(
    appendAuditEvent(
      { async insertAuditEvent() { throw new Error("transaction aborted"); } },
      input,
      { createId: () => "audit_3" },
    ),
    /transaction aborted/,
  );
  await assert.rejects(appendAuditEvent(null, input), /transaction-scoped audit writer/);
});
