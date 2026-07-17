import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createClerkClient } from "@clerk/backend";
import postgres from "postgres";

import {
  OperatorInputError,
  assertSeparateDatabaseRoles,
  inferNeonDataRegion,
  operationMode,
  requiredEnvironment,
  requireExactConfirmation,
  safeFailureMessage,
  validateClerkId,
  validateDatabaseUrl,
  validateDeploymentEnvironment,
  validateName,
  validateRegion,
  validateSecretKey,
  validateSlug,
  validateTimeZone,
} from "./operator-safety.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeStatus(message) {
  process.stdout.write(`${message}\n`);
}

function provisioningConfiguration(environment, mode) {
  const deploymentEnvironment = validateDeploymentEnvironment(
    requiredEnvironment(environment, "MINDER_DEPLOYMENT_ENV"),
  );
  const providerOrganizationId = validateClerkId(
    requiredEnvironment(environment, "CLERK_ORGANIZATION_ID"),
    "org",
    "CLERK_ORGANIZATION_ID",
  );
  const providerOwnerUserId = validateClerkId(
    requiredEnvironment(environment, "CLERK_OWNER_USER_ID"),
    "user",
    "CLERK_OWNER_USER_ID",
  );
  const competitionSlug = validateSlug(
    requiredEnvironment(environment, "MINDER_COMPETITION_SLUG"),
    "MINDER_COMPETITION_SLUG",
  );
  requireExactConfirmation(environment, "MINDER_DATA_REGION_APPROVED", "YES");
  if (mode === "apply") {
    requireExactConfirmation(
      environment,
      "MINDER_BOOTSTRAP_CONFIRM",
      `${providerOrganizationId}:${competitionSlug}`,
    );
  }
  return Object.freeze({
    deploymentEnvironment,
    providerOrganizationId,
    providerOwnerUserId,
    competitionName: validateName(
      requiredEnvironment(environment, "MINDER_COMPETITION_NAME"),
      "MINDER_COMPETITION_NAME",
    ),
    competitionSlug,
    competitionTimezone: validateTimeZone(
      requiredEnvironment(environment, "MINDER_COMPETITION_TIMEZONE"),
    ),
    dataRegion: validateRegion(requiredEnvironment(environment, "MINDER_DATA_REGION")),
    clerkSecretKey: validateSecretKey(
      requiredEnvironment(environment, "CLERK_SECRET_KEY"),
      deploymentEnvironment,
    ),
  });
}

function privateMetadataTenantId(privateMetadata) {
  if (!privateMetadata || typeof privateMetadata !== "object" || Array.isArray(privateMetadata)) {
    return null;
  }
  if (!("minderTenantId" in privateMetadata)) return null;
  const value = privateMetadata.minderTenantId;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OperatorInputError("The Clerk organization has an invalid minderTenantId mapping.");
  }
  return value.toLowerCase();
}

function primaryVerifiedEmail(user) {
  const email =
    user.emailAddresses.find((candidate) => candidate.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  if (
    !email ||
    email.verification?.status !== "verified" ||
    email.emailAddress.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.emailAddress)
  ) {
    throw new OperatorInputError("The Clerk owner must have a verified primary email address.");
  }
  return email.emailAddress.toLowerCase();
}

async function administratorCapabilities(sql) {
  const [row] = await sql`
    select
      role.rolsuper as superuser,
      role.rolbypassrls as "bypassRls",
      coalesce((
        select pg_has_role(current_user, granted.oid, 'member')
        from pg_roles granted
        where granted.rolname = 'neon_superuser'
      ), false) as "neonAdministrator"
    from pg_roles role
    where role.rolname = current_user
  `;
  return Boolean(row && (row.superuser || row.bypassRls || row.neonAdministrator));
}

async function assertFoundationPresent(sql) {
  const [row] = await sql`
    select
      to_regclass('public.users') is not null as users,
      to_regclass('public.organizations') is not null as organizations,
      to_regclass('public.organization_memberships') is not null as memberships,
      to_regclass('public.competitions') is not null as competitions,
      to_regclass('public.audit_events') is not null as audit_events
  `;
  if (!row?.users || !row.organizations || !row.memberships || !row.competitions || !row.audit_events) {
    throw new OperatorInputError("The production foundation migration must be applied before provisioning.");
  }
}

async function provisionDatabase(client, input, apply) {
  return client.begin("isolation level serializable", async (sql) => {
    if (apply) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.providerOrganizationId}, 0))`;
    }

    const [organizationByProvider] = await sql`
      select id, slug, name, data_region as "dataRegion", archived_at as "archivedAt"
      from organizations
      where auth_provider = 'clerk' and auth_subject = ${input.providerOrganizationId}
      limit 2
    `;
    const [organizationByMetadata] = input.metadataTenantId
      ? await sql`
          select id, auth_provider as "authProvider", auth_subject as "authSubject"
          from organizations
          where id = ${input.metadataTenantId}
          limit 2
        `
      : [];
    if (
      organizationByProvider &&
      input.metadataTenantId &&
      organizationByProvider.id !== input.metadataTenantId
    ) {
      throw new OperatorInputError("Clerk metadata and the existing provider mapping identify different tenants.");
    }
    if (
      organizationByMetadata &&
      (organizationByMetadata.authProvider !== "clerk" ||
        organizationByMetadata.authSubject !== input.providerOrganizationId)
    ) {
      throw new OperatorInputError("The Clerk tenant UUID is already mapped to a different organization.");
    }

    const tenantId = organizationByProvider?.id ?? input.metadataTenantId ?? randomUUID();
    const [slugOwner] = await sql`
      select id from organizations where lower(slug) = lower(${input.organizationSlug}) limit 2
    `;
    if (slugOwner && slugOwner.id !== tenantId) {
      throw new OperatorInputError("The Clerk organization slug is already used by another tenant.");
    }
    if (
      organizationByProvider &&
      (organizationByProvider.archivedAt ||
        organizationByProvider.slug !== input.organizationSlug ||
        organizationByProvider.name !== input.organizationName ||
        organizationByProvider.dataRegion !== input.dataRegion)
    ) {
      throw new OperatorInputError("The existing tenant differs from the approved name, slug, region, or archive state.");
    }

    const [userByProvider] = await sql`
      select id, email, display_name as "displayName", email_verified as "emailVerified",
             disabled_at as "disabledAt"
      from users
      where auth_provider = 'clerk' and auth_subject = ${input.providerOwnerUserId}
      limit 2
    `;
    const [userByEmail] = await sql`
      select id, auth_provider as "authProvider", auth_subject as "authSubject"
      from users
      where lower(email) = lower(${input.ownerEmail})
      limit 2
    `;
    if (
      userByEmail &&
      (!userByProvider || userByEmail.id !== userByProvider.id) &&
      (userByEmail.authProvider !== "clerk" || userByEmail.authSubject !== input.providerOwnerUserId)
    ) {
      throw new OperatorInputError("The verified owner email is already mapped to a different identity.");
    }
    const ownerUserId = userByProvider?.id ?? userByEmail?.id ?? randomUUID();

    const [membership] = await sql`
      select role, status
      from organization_memberships
      where tenant_id = ${tenantId} and user_id = ${ownerUserId}
      limit 1
    `;
    const [competition] = await sql`
      select id, name, timezone, archived_at as "archivedAt"
      from competitions
      where tenant_id = ${tenantId} and lower(slug) = lower(${input.competitionSlug})
      limit 2
    `;
    if (
      competition &&
      (competition.archivedAt ||
        competition.name !== input.competitionName ||
        competition.timezone !== input.competitionTimezone)
    ) {
      throw new OperatorInputError("The existing competition differs from the approved name, timezone, or archive state.");
    }
    const competitionId = competition?.id ?? randomUUID();

    const actions = [];
    if (!userByProvider) actions.push("create_owner_user");
    else if (
      userByProvider.email !== input.ownerEmail ||
      userByProvider.displayName !== input.ownerDisplayName ||
      !userByProvider.emailVerified ||
      userByProvider.disabledAt
    ) actions.push("sync_owner_user");
    if (!organizationByProvider) actions.push("create_tenant");
    if (!membership || membership.role !== "owner" || membership.status !== "active") {
      actions.push("activate_owner_membership");
    }
    if (!competition) actions.push("create_competition");

    if (apply) {
      if (!userByProvider) {
        await sql`
          insert into users (
            id, auth_provider, auth_subject, email, display_name, email_verified, disabled_at
          ) values (
            ${ownerUserId}, 'clerk', ${input.providerOwnerUserId}, ${input.ownerEmail},
            ${input.ownerDisplayName}, true, null
          )
        `;
      } else if (actions.includes("sync_owner_user")) {
        await sql`
          update users
          set email = ${input.ownerEmail}, display_name = ${input.ownerDisplayName},
              email_verified = true, disabled_at = null, updated_at = now()
          where id = ${ownerUserId} and auth_provider = 'clerk'
            and auth_subject = ${input.providerOwnerUserId}
        `;
      }

      if (!organizationByProvider) {
        await sql`
          insert into organizations (
            id, auth_provider, auth_subject, slug, name, data_region, settings, created_by_user_id
          ) values (
            ${tenantId}, 'clerk', ${input.providerOrganizationId}, ${input.organizationSlug},
            ${input.organizationName}, ${input.dataRegion},
            ${sql.json({ deploymentEnvironment: input.deploymentEnvironment })}, ${ownerUserId}
          )
        `;
      }

      await sql`
        insert into organization_memberships (
          tenant_id, user_id, role, status, invited_by_user_id, accepted_at, updated_at
        ) values (
          ${tenantId}, ${ownerUserId}, 'owner', 'active', ${ownerUserId}, now(), now()
        )
        on conflict (tenant_id, user_id) do update
        set role = 'owner', status = 'active', accepted_at = coalesce(organization_memberships.accepted_at, now()),
            updated_at = now()
      `;

      if (!competition) {
        await sql`
          insert into competitions (
            id, tenant_id, slug, name, status, timezone, created_by_user_id
          ) values (
            ${competitionId}, ${tenantId}, ${input.competitionSlug}, ${input.competitionName},
            'draft', ${input.competitionTimezone}, ${ownerUserId}
          )
        `;
      }

      if (actions.length > 0) {
        await sql`
          select set_config('app.tenant_id', ${tenantId}, true),
                 set_config('app.user_id', ${ownerUserId}, true),
                 set_config('app.request_id', 'operator_bootstrap', true)
        `;
        await sql`
          insert into audit_events (
            tenant_id, competition_id, actor_user_id, actor_role, outcome, action,
            summary, object_type, object_id, payload, request_id
          ) values (
            ${tenantId}, ${competitionId}, ${ownerUserId}, 'system', 'success',
            'platform.bootstrap_completed', 'platform.bootstrap_completed', 'organization',
            ${tenantId}, ${sql.json({ source: "operator_bootstrap", changedFields: actions })},
            'operator_bootstrap'
          )
        `;
      }
    }

    return Object.freeze({ tenantId, competitionId, actions: Object.freeze(actions) });
  });
}

export async function run(environment = process.env, argv = process.argv.slice(2)) {
  const mode = operationMode(argv);
  const config = provisioningConfiguration(environment, mode);
  const adminUrl = validateDatabaseUrl(
    requiredEnvironment(environment, "DATABASE_ADMIN_URL"),
    "DATABASE_ADMIN_URL",
  );
  assertSeparateDatabaseRoles(adminUrl, environment);
  const databaseRegion = inferNeonDataRegion(adminUrl.hostname);
  if (databaseRegion && databaseRegion !== config.dataRegion) {
    throw new OperatorInputError("MINDER_DATA_REGION does not match the Neon production database host.");
  }

  const clerk = createClerkClient({ secretKey: config.clerkSecretKey });
  const [providerOrganization, providerOwner] = await Promise.all([
    clerk.organizations.getOrganization({ organizationId: config.providerOrganizationId }),
    clerk.users.getUser(config.providerOwnerUserId),
  ]);
  if (providerOwner.banned || providerOwner.locked) {
    throw new OperatorInputError("The Clerk owner account is banned or locked.");
  }
  if (!providerOwner.twoFactorEnabled) {
    throw new OperatorInputError("The Clerk owner must enroll MFA before provisioning.");
  }
  const ownerEmail = primaryVerifiedEmail(providerOwner);
  const ownerDisplayName = validateName(
    [providerOwner.firstName, providerOwner.lastName].filter(Boolean).join(" ") || ownerEmail,
    "Clerk owner display name",
  );
  const organizationName = validateName(providerOrganization.name, "Clerk organization name");
  const organizationSlug = validateSlug(providerOrganization.slug, "Clerk organization slug");
  const metadataTenantId = privateMetadataTenantId(providerOrganization.privateMetadata);
  const memberships = await clerk.organizations.getOrganizationMembershipList({
    organizationId: config.providerOrganizationId,
    userId: [config.providerOwnerUserId],
    limit: 2,
  });
  if (memberships.data.length > 1) {
    throw new OperatorInputError("Clerk returned an ambiguous owner organization membership.");
  }
  const providerMembership = memberships.data[0] ?? null;

  const client = postgres(adminUrl.value, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  });
  let database;
  try {
    if (!(await administratorCapabilities(client))) {
      throw new OperatorInputError("DATABASE_ADMIN_URL must use the dedicated migration/administration role.");
    }
    await assertFoundationPresent(client);
    database = await provisionDatabase(
      client,
      {
        ...config,
        metadataTenantId,
        organizationName,
        organizationSlug,
        ownerEmail,
        ownerDisplayName,
      },
      mode === "apply",
    );
  } finally {
    await client.end({ timeout: 5 });
  }

  const clerkActions = [];
  if (metadataTenantId !== database.tenantId) clerkActions.push("set_clerk_tenant_mapping");
  if (!providerMembership) clerkActions.push("create_clerk_owner_membership");
  else if (providerMembership.role !== "org:admin") clerkActions.push("promote_clerk_owner_membership");

  if (mode === "apply") {
    if (metadataTenantId !== database.tenantId) {
      await clerk.organizations.updateOrganizationMetadata(config.providerOrganizationId, {
        privateMetadata: { minderTenantId: database.tenantId },
      });
    }
    if (!providerMembership) {
      await clerk.organizations.createOrganizationMembership({
        organizationId: config.providerOrganizationId,
        userId: config.providerOwnerUserId,
        role: "org:admin",
      });
    } else if (providerMembership.role !== "org:admin") {
      await clerk.organizations.updateOrganizationMembership({
        organizationId: config.providerOrganizationId,
        userId: config.providerOwnerUserId,
        role: "org:admin",
      });
    }
  }

  writeStatus(`Validated owner, tenant, and competition; ${database.actions.length + clerkActions.length} action(s) planned.`);
  writeStatus(
    mode === "dry-run" && database.actions.includes("create_tenant")
      ? "Tenant ID: generated only during apply."
      : `Tenant ID: ${database.tenantId}`,
  );
  writeStatus(
    mode === "dry-run" && database.actions.includes("create_competition")
      ? "Competition ID: generated only during apply."
      : `Competition ID: ${database.competitionId}`,
  );
  writeStatus(
    mode === "dry-run"
      ? "DRY RUN complete. Clerk and Postgres were not changed."
      : "APPLY complete. Clerk and Postgres mappings are consistent.",
  );
  return Object.freeze({ mode, ...database, clerkActions: Object.freeze(clerkActions) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${safeFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
