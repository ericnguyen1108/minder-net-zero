\set ON_ERROR_STOP on

-- Run with the same dedicated administration role used by DATABASE_ADMIN_URL.
-- This file contains no passwords. Set passwords interactively with psql's
-- \password command, then enable LOGIN as described in docs/production-runbook.md.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minder_runtime') THEN
    CREATE ROLE minder_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minder_identity') THEN
    CREATE ROLE minder_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;

ALTER ROLE minder_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE minder_identity NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser') THEN
    EXECUTE 'REVOKE neon_superuser FROM minder_runtime, minder_identity';
  END IF;
END
$$;

SELECT format('GRANT CONNECT ON DATABASE %I TO minder_runtime, minder_identity', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO minder_runtime, minder_identity;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM minder_runtime, minder_identity;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM minder_runtime, minder_identity;
REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM minder_runtime, minder_identity;

-- Runtime routes can use application tables but cannot perform DDL or bypass
-- row-level security. Immutable-table triggers still reject update/delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO minder_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO minder_runtime;
GRANT EXECUTE ON FUNCTION public.app_current_tenant_id() TO minder_runtime;
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO minder_runtime;

-- Signed Clerk webhooks use this role. BYPASSRLS is necessary because a create
-- event has no internal app.user_id yet; table grants deliberately constrain
-- the otherwise-powerful role to identity synchronization only.
GRANT SELECT ON TABLE
  public.users,
  public.organizations,
  public.organization_memberships,
  public.organization_invitations,
  public.competitions,
  public.competition_role_grants,
  public.idempotency_keys
TO minder_identity;

GRANT INSERT ON TABLE
  public.users,
  public.organization_memberships,
  public.competition_role_grants,
  public.idempotency_keys,
  public.audit_events
TO minder_identity;

GRANT UPDATE ON TABLE
  public.users,
  public.organization_memberships,
  public.organization_invitations,
  public.competition_role_grants,
  public.idempotency_keys
TO minder_identity;

GRANT EXECUTE ON FUNCTION public.app_current_tenant_id() TO minder_identity;
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO minder_identity;

-- Future migrations run under the administration role. Runtime grants are
-- inherited automatically; identity-sync access must remain an explicit review.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO minder_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO minder_runtime;
