CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('imported', 'eligible', 'ineligible', 'withdrawn', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."assessment_batch_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."assessment_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('assigned', 'in_progress', 'submitted', 'reassigned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."calibration_status" AS ENUM('draft', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."competition_role" AS ENUM('competition_admin', 'rubric_manager', 'reviewer', 'decision_approver', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."competition_status" AS ENUM('draft', 'calibrating', 'open', 'reviewing', 'decided', 'archived');--> statement-breakpoint
CREATE TYPE "public"."dataset_kind" AS ENUM('historical', 'current');--> statement-breakpoint
CREATE TYPE "public"."dataset_status" AS ENUM('importing', 'ready', 'locked', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "public"."guide_kind" AS ENUM('rules', 'rubric', 'selection', 'elimination', 'prompt', 'safeguards');--> statement-breakpoint
CREATE TYPE "public"."guide_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'suspended', 'removed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'publishing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('draft', 'submitted', 'superseded');--> statement-breakpoint
CREATE TABLE "applicant_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"identity_data" jsonb NOT NULL,
	"identity_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "applicant_identities_hash_ck" CHECK ("applicant_identities"."identity_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"historical_label" jsonb,
	"status" "application_status" DEFAULT 'imported' NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_content_hash_ck" CHECK ("applications"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "assessment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"assessment_run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" "assessment_batch_status" DEFAULT 'queued' NOT NULL,
	"application_count" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_request_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	CONSTRAINT "assessment_batches_ordinal_ck" CHECK ("assessment_batches"."ordinal" > 0),
	CONSTRAINT "assessment_batches_application_count_ck" CHECK ("assessment_batches"."application_count" > 0),
	CONSTRAINT "assessment_batches_attempt_count_ck" CHECK ("assessment_batches"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assessment_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"assessment_run_id" uuid NOT NULL,
	"assessment_batch_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"score" numeric(12, 4),
	"recommendation" text NOT NULL,
	"confidence" numeric(6, 5),
	"result" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"provider_response_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_results_input_hash_ck" CHECK ("assessment_results"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_results_output_hash_ck" CHECK ("assessment_results"."output_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_results_confidence_ck" CHECK ("assessment_results"."confidence" is null or ("assessment_results"."confidence" >= 0 and "assessment_results"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "assessment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"rubric_version_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"status" "assessment_run_status" DEFAULT 'queued' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_config" jsonb NOT NULL,
	"configuration_hash" text NOT NULL,
	"total_applications" integer DEFAULT 0 NOT NULL,
	"completed_applications" integer DEFAULT 0 NOT NULL,
	"failed_applications" integer DEFAULT 0 NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_summary" jsonb,
	CONSTRAINT "assessment_runs_configuration_hash_ck" CHECK ("assessment_runs"."configuration_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_runs_counts_ck" CHECK ("assessment_runs"."total_applications" >= 0 and "assessment_runs"."completed_applications" >= 0 and "assessment_runs"."failed_applications" >= 0 and "assessment_runs"."completed_applications" + "assessment_runs"."failed_applications" <= "assessment_runs"."total_applications")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"status" "assignment_status" DEFAULT 'assigned' NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "assignments_round_ck" CHECK ("assignments"."round" > 0),
	CONSTRAINT "assignments_revision_ck" CHECK ("assignments"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"previous_hash" text DEFAULT repeat('0', 64) NOT NULL,
	"event_hash" text DEFAULT repeat('0', 64) NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"outcome" "audit_outcome" NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"reason" text,
	"object_type" text NOT NULL,
	"object_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"correlation_id" text,
	"source_ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_previous_hash_ck" CHECK ("audit_events"."previous_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_events_event_hash_ck" CHECK ("audit_events"."event_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "calibration_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"calibration_session_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"reference_outcome" jsonb NOT NULL,
	"reference_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_cases_ordinal_ck" CHECK ("calibration_cases"."ordinal" > 0),
	CONSTRAINT "calibration_cases_reference_hash_ck" CHECK ("calibration_cases"."reference_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "calibration_reveal_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"calibration_session_id" uuid NOT NULL,
	"calibration_case_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"reveal_number" integer NOT NULL,
	"revealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "calibration_reveal_receipts_number_ck" CHECK ("calibration_reveal_receipts"."reveal_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "calibration_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"guide_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "calibration_status" DEFAULT 'draft' NOT NULL,
	"reveal_limit" integer DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "calibration_sessions_reveal_limit_ck" CHECK ("calibration_sessions"."reveal_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "competition_role_grants" (
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "competition_role" NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_role_grants_pk" PRIMARY KEY("tenant_id","competition_id","user_id","role"),
	CONSTRAINT "competition_role_grants_window_ck" CHECK ("competition_role_grants"."active_until" is null or "competition_role_grants"."active_from" < "competition_role_grants"."active_until")
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "competition_status" DEFAULT 'draft' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "competitions_dates_ck" CHECK ("competitions"."opens_at" is null or "competitions"."closes_at" is null or "competitions"."opens_at" < "competitions"."closes_at")
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"kind" "dataset_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "dataset_status" DEFAULT 'importing' NOT NULL,
	"source_filename" text,
	"source_hash" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"import_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	CONSTRAINT "datasets_schema_version_ck" CHECK ("datasets"."schema_version" > 0),
	CONSTRAINT "datasets_row_count_ck" CHECK ("datasets"."row_count" >= 0),
	CONSTRAINT "datasets_source_hash_ck" CHECK ("datasets"."source_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "final_decision_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_decision_id" uuid,
	"decision" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "final_decision_revisions_revision_ck" CHECK ("final_decision_revisions"."revision" > 0),
	CONSTRAINT "final_decision_revisions_hash_ck" CHECK ("final_decision_revisions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "guide_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"kind" "guide_kind" NOT NULL,
	"version" integer NOT NULL,
	"status" "guide_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"supersedes_version_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_versions_positive_version_ck" CHECK ("guide_versions"."version" > 0),
	CONSTRAINT "guide_versions_hash_ck" CHECK ("guide_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guide_versions_approval_ck" CHECK ("guide_versions"."status" <> 'approved' or ("guide_versions"."approved_by_user_id" is not null and "guide_versions"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_request_hash_ck" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid,
	"provider_invitation_id" text NOT NULL,
	"email" text NOT NULL,
	"roles" jsonb NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"accepted_by_user_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "organization_invitations_roles_array_ck" CHECK (jsonb_typeof("organization_invitations"."roles") = 'array'),
	CONSTRAINT "organization_invitations_expiry_ck" CHECK ("organization_invitations"."expires_at" > "organization_invitations"."invited_at"),
	CONSTRAINT "organization_invitations_acceptance_ck" CHECK ("organization_invitations"."status" <> 'accepted' or ("organization_invitations"."accepted_by_user_id" is not null and "organization_invitations"."accepted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"status" "membership_status" DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider" text NOT NULL,
	"auth_subject" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"data_region" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_format_ck" CHECK ("organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid,
	"topic" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_payload_hash_ck" CHECK ("outbox_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbox_events_attempt_count_ck" CHECK ("outbox_events"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reviewer_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_review_id" uuid,
	"status" "review_status" NOT NULL,
	"score" numeric(12, 4),
	"recommendation" text NOT NULL,
	"rationale" text NOT NULL,
	"rubric_scores" jsonb NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "reviewer_reviews_revision_ck" CHECK ("reviewer_reviews"."revision" > 0),
	CONSTRAINT "reviewer_reviews_hash_ck" CHECK ("reviewer_reviews"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reviewer_reviews_submission_ck" CHECK ("reviewer_reviews"."status" <> 'submitted' or "reviewer_reviews"."submitted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "safeguard_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"safeguard_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"supersedes_approval_id" uuid,
	"approved_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "safeguard_approvals_version_ck" CHECK ("safeguard_approvals"."version" > 0),
	CONSTRAINT "safeguard_approvals_evidence_hash_ck" CHECK ("safeguard_approvals"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider" text NOT NULL,
	"auth_subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- PostgreSQL requires the referenced composite keys to be unique before the
-- foreign keys below are created. Drizzle emits indexes after foreign keys, so
-- create the tenant-safe reference indexes early and make its later copies
-- idempotent.
CREATE UNIQUE INDEX "competitions_tenant_id_id_uq" ON "competitions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_tenant_comp_id_uq" ON "datasets" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "applicant_identities_tenant_comp_dataset_id_uq" ON "applicant_identities" USING btree ("tenant_id","competition_id","dataset_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_tenant_comp_id_uq" ON "applications" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "guide_versions_tenant_comp_id_uq" ON "guide_versions" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_runs_tenant_comp_id_uq" ON "assessment_runs" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_batches_tenant_comp_id_uq" ON "assessment_batches" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_tenant_comp_id_uq" ON "assignments" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_sessions_tenant_comp_id_uq" ON "calibration_sessions" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_cases_tenant_comp_id_uq" ON "calibration_cases" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
ALTER TABLE "applicant_identities" ADD CONSTRAINT "applicant_identities_dataset_fk" FOREIGN KEY ("tenant_id","competition_id","dataset_id") REFERENCES "public"."datasets"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_dataset_fk" FOREIGN KEY ("tenant_id","competition_id","dataset_id") REFERENCES "public"."datasets"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_identity_fk" FOREIGN KEY ("tenant_id","competition_id","dataset_id","identity_id") REFERENCES "public"."applicant_identities"("tenant_id","competition_id","dataset_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_batches" ADD CONSTRAINT "assessment_batches_run_fk" FOREIGN KEY ("tenant_id","competition_id","assessment_run_id") REFERENCES "public"."assessment_runs"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_run_fk" FOREIGN KEY ("tenant_id","competition_id","assessment_run_id") REFERENCES "public"."assessment_runs"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_batch_fk" FOREIGN KEY ("tenant_id","competition_id","assessment_batch_id") REFERENCES "public"."assessment_batches"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_application_fk" FOREIGN KEY ("tenant_id","competition_id","application_id") REFERENCES "public"."applications"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_dataset_fk" FOREIGN KEY ("tenant_id","competition_id","dataset_id") REFERENCES "public"."datasets"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_rubric_fk" FOREIGN KEY ("tenant_id","competition_id","rubric_version_id") REFERENCES "public"."guide_versions"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_prompt_fk" FOREIGN KEY ("tenant_id","competition_id","prompt_version_id") REFERENCES "public"."guide_versions"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_application_fk" FOREIGN KEY ("tenant_id","competition_id","application_id") REFERENCES "public"."applications"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_cases" ADD CONSTRAINT "calibration_cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_cases" ADD CONSTRAINT "calibration_cases_session_fk" FOREIGN KEY ("tenant_id","competition_id","calibration_session_id") REFERENCES "public"."calibration_sessions"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_cases" ADD CONSTRAINT "calibration_cases_application_fk" FOREIGN KEY ("tenant_id","competition_id","application_id") REFERENCES "public"."applications"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reveal_receipts" ADD CONSTRAINT "calibration_reveal_receipts_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reveal_receipts" ADD CONSTRAINT "calibration_reveal_receipts_session_fk" FOREIGN KEY ("tenant_id","competition_id","calibration_session_id") REFERENCES "public"."calibration_sessions"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_reveal_receipts" ADD CONSTRAINT "calibration_reveal_receipts_case_fk" FOREIGN KEY ("tenant_id","competition_id","calibration_case_id") REFERENCES "public"."calibration_cases"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_guide_version_fk" FOREIGN KEY ("tenant_id","competition_id","guide_version_id") REFERENCES "public"."guide_versions"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_role_grants" ADD CONSTRAINT "competition_role_grants_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_role_grants" ADD CONSTRAINT "competition_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_role_grants" ADD CONSTRAINT "competition_role_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_role_grants" ADD CONSTRAINT "competition_role_grants_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_decision_revisions" ADD CONSTRAINT "final_decision_revisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_decision_revisions" ADD CONSTRAINT "final_decision_revisions_application_fk" FOREIGN KEY ("tenant_id","competition_id","application_id") REFERENCES "public"."applications"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_versions" ADD CONSTRAINT "guide_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_versions" ADD CONSTRAINT "guide_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_versions" ADD CONSTRAINT "guide_versions_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_reviews" ADD CONSTRAINT "reviewer_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_reviews" ADD CONSTRAINT "reviewer_reviews_assignment_fk" FOREIGN KEY ("tenant_id","competition_id","assignment_id") REFERENCES "public"."assignments"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_reviews" ADD CONSTRAINT "reviewer_reviews_application_fk" FOREIGN KEY ("tenant_id","competition_id","application_id") REFERENCES "public"."applications"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_approvals" ADD CONSTRAINT "safeguard_approvals_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_approvals" ADD CONSTRAINT "safeguard_approvals_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applicant_identities_tenant_comp_dataset_id_uq" ON "applicant_identities" USING btree ("tenant_id","competition_id","dataset_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "applicant_identities_dataset_external_ref_uq" ON "applicant_identities" USING btree ("tenant_id","competition_id","dataset_id","external_ref");--> statement-breakpoint
CREATE INDEX "applicant_identities_hash_idx" ON "applicant_identities" USING btree ("tenant_id","competition_id","identity_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applications_tenant_comp_id_uq" ON "applications" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_dataset_external_ref_uq" ON "applications" USING btree ("tenant_id","competition_id","dataset_id","external_ref");--> statement-breakpoint
CREATE INDEX "applications_review_queue_idx" ON "applications" USING btree ("tenant_id","competition_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assessment_batches_tenant_comp_id_uq" ON "assessment_batches" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_batches_run_ordinal_uq" ON "assessment_batches" USING btree ("tenant_id","competition_id","assessment_run_id","ordinal");--> statement-breakpoint
CREATE INDEX "assessment_batches_work_idx" ON "assessment_batches" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_results_run_application_uq" ON "assessment_results" USING btree ("tenant_id","competition_id","assessment_run_id","application_id");--> statement-breakpoint
CREATE INDEX "assessment_results_recommendation_idx" ON "assessment_results" USING btree ("tenant_id","competition_id","assessment_run_id","recommendation");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assessment_runs_tenant_comp_id_uq" ON "assessment_runs" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE INDEX "assessment_runs_status_idx" ON "assessment_runs" USING btree ("tenant_id","competition_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assignments_tenant_comp_id_uq" ON "assignments" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_application_reviewer_round_uq" ON "assignments" USING btree ("tenant_id","competition_id","application_id","reviewer_user_id","round");--> statement-breakpoint
CREATE INDEX "assignments_reviewer_queue_idx" ON "assignments" USING btree ("tenant_id","competition_id","reviewer_user_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_tenant_sequence_uq" ON "audit_events" USING btree ("tenant_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_tenant_hash_uq" ON "audit_events" USING btree ("tenant_id","event_hash");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("tenant_id","competition_id","object_type","object_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("tenant_id","actor_user_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calibration_cases_tenant_comp_id_uq" ON "calibration_cases" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_cases_session_ordinal_uq" ON "calibration_cases" USING btree ("tenant_id","competition_id","calibration_session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_cases_session_application_uq" ON "calibration_cases" USING btree ("tenant_id","competition_id","calibration_session_id","application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reveal_receipts_once_uq" ON "calibration_reveal_receipts" USING btree ("tenant_id","competition_id","calibration_session_id","calibration_case_id","reviewer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reveal_receipts_number_uq" ON "calibration_reveal_receipts" USING btree ("tenant_id","competition_id","calibration_session_id","reviewer_user_id","reveal_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calibration_sessions_tenant_comp_id_uq" ON "calibration_sessions" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE INDEX "competition_role_grants_user_idx" ON "competition_role_grants" USING btree ("tenant_id","user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competitions_tenant_id_id_uq" ON "competitions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_tenant_slug_lower_uq" ON "competitions" USING btree ("tenant_id",lower("slug"));--> statement-breakpoint
CREATE INDEX "competitions_tenant_status_idx" ON "competitions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "datasets_tenant_comp_id_uq" ON "datasets" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_source_hash_uq" ON "datasets" USING btree ("tenant_id","competition_id","kind","source_hash");--> statement-breakpoint
CREATE INDEX "datasets_tenant_comp_kind_idx" ON "datasets" USING btree ("tenant_id","competition_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "final_decision_revisions_application_revision_uq" ON "final_decision_revisions" USING btree ("tenant_id","competition_id","application_id","revision");--> statement-breakpoint
CREATE INDEX "final_decision_revisions_latest_idx" ON "final_decision_revisions" USING btree ("tenant_id","competition_id","application_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "guide_versions_tenant_comp_kind_version_uq" ON "guide_versions" USING btree ("tenant_id","competition_id","kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guide_versions_tenant_comp_id_uq" ON "guide_versions" USING btree ("tenant_id","competition_id","id");--> statement-breakpoint
CREATE INDEX "guide_versions_status_idx" ON "guide_versions" USING btree ("tenant_id","competition_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_tenant_scope_key_uq" ON "idempotency_keys" USING btree ("tenant_id","scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_provider_id_uq" ON "organization_invitations" USING btree ("tenant_id","provider_invitation_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" USING btree ("tenant_id",lower("email"),"status");--> statement-breakpoint
CREATE INDEX "organization_memberships_user_idx" ON "organization_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_lower_uq" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_auth_identity_uq" ON "organizations" USING btree ("auth_provider","auth_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_tenant_id_uq" ON "outbox_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "outbox_events_delivery_idx" ON "outbox_events" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_reviews_assignment_revision_uq" ON "reviewer_reviews" USING btree ("tenant_id","competition_id","assignment_id","revision");--> statement-breakpoint
CREATE INDEX "reviewer_reviews_latest_idx" ON "reviewer_reviews" USING btree ("tenant_id","competition_id","application_id","reviewer_user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "safeguard_approvals_scope_version_uq" ON "safeguard_approvals" USING btree ("tenant_id","competition_id","safeguard_key","scope_type","scope_id","version");--> statement-breakpoint
CREATE INDEX "safeguard_approvals_current_idx" ON "safeguard_approvals" USING btree ("tenant_id","competition_id","safeguard_key","scope_type","scope_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_identity_uq" ON "users" USING btree ("auth_provider","auth_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint

-- Transaction-local helpers. They deliberately return NULL when context is
-- absent, causing every tenant policy below to fail closed.
CREATE OR REPLACE FUNCTION public.app_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;--> statement-breakpoint

-- The application identity is global, but a signed-in user may only see their
-- own row plus users who belong to the selected tenant. Writes are self-only;
-- privileged identity sync must use a separate, non-runtime database role.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY users_select_tenant
  ON public.users
  FOR SELECT
  USING (
    id = public.app_current_user_id()
    OR EXISTS (
      SELECT 1
      FROM public.organization_memberships membership
      WHERE membership.tenant_id = public.app_current_tenant_id()
        AND membership.user_id = users.id
        AND membership.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY users_insert_self
  ON public.users
  FOR INSERT
  WITH CHECK (id = public.app_current_user_id());--> statement-breakpoint
CREATE POLICY users_update_self
  ON public.users
  FOR UPDATE
  USING (id = public.app_current_user_id())
  WITH CHECK (id = public.app_current_user_id());--> statement-breakpoint

-- An organization row is its own tenant boundary. Hard deletion is omitted;
-- organizations are archived so legal/audit retention cannot be bypassed.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY organizations_select_current
  ON public.organizations
  FOR SELECT
  USING (id = public.app_current_tenant_id());--> statement-breakpoint
CREATE POLICY organizations_insert_current
  ON public.organizations
  FOR INSERT
  WITH CHECK (id = public.app_current_tenant_id());--> statement-breakpoint
CREATE POLICY organizations_update_current
  ON public.organizations
  FOR UPDATE
  USING (id = public.app_current_tenant_id())
  WITH CHECK (id = public.app_current_tenant_id());--> statement-breakpoint

-- Every business table carries tenant_id. A single generated policy shape
-- keeps isolation reviewable and prevents accidental policy drift.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'applicant_identities',
    'applications',
    'assessment_batches',
    'assessment_results',
    'assessment_runs',
    'assignments',
    'audit_events',
    'calibration_cases',
    'calibration_reveal_receipts',
    'calibration_sessions',
    'competition_role_grants',
    'competitions',
    'datasets',
    'final_decision_revisions',
    'guide_versions',
    'idempotency_keys',
    'organization_invitations',
    'organization_memberships',
    'outbox_events',
    'reviewer_reviews',
    'safeguard_approvals'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (tenant_id = public.app_current_tenant_id()) WITH CHECK (tenant_id = public.app_current_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- Immutable evidence is insert-only. Row and TRUNCATE triggers cover every
-- mutation path; operational DB roles must not own these tables or disable
-- triggers in normal application traffic.
CREATE OR REPLACE FUNCTION public.app_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$$;--> statement-breakpoint

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'guide_versions',
    'calibration_cases',
    'calibration_reveal_receipts',
    'safeguard_approvals',
    'assessment_results',
    'reviewer_reviews',
    'final_decision_revisions',
    'audit_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.app_reject_immutable_mutation()',
      'reject_' || table_name || '_mutation',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.app_reject_immutable_mutation()',
      'reject_' || table_name || '_truncate',
      table_name
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- Each tenant has one serialized audit chain. The trigger ignores caller-
-- supplied chain fields, locks the tenant chain, and hashes a canonical JSONB
-- rendering plus all searchable audit columns.
CREATE OR REPLACE FUNCTION public.app_prepare_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prior_sequence bigint;
  prior_hash text;
  canonical_event text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  SELECT event.sequence, event.event_hash
    INTO prior_sequence, prior_hash
  FROM public.audit_events AS event
  WHERE event.tenant_id = NEW.tenant_id
  ORDER BY event.sequence DESC
  LIMIT 1;

  NEW.sequence := coalesce(prior_sequence, 0) + 1;
  NEW.previous_hash := coalesce(prior_hash, repeat('0', 64));
  NEW.occurred_at := coalesce(NEW.occurred_at, clock_timestamp());
  NEW.actor_user_id := coalesce(NEW.actor_user_id, public.app_current_user_id());
  NEW.request_id := coalesce(
    NEW.request_id,
    nullif(current_setting('app.request_id', true), '')
  );

  canonical_event := concat_ws(E'\\x1f',
    NEW.tenant_id::text,
    coalesce(NEW.competition_id::text, ''),
    NEW.sequence::text,
    NEW.previous_hash,
    NEW.id::text,
    coalesce(NEW.actor_user_id::text, 'system'),
    coalesce(NEW.actor_role, ''),
    NEW.outcome::text,
    NEW.action,
    NEW.summary,
    coalesce(NEW.reason, ''),
    NEW.object_type,
    coalesce(NEW.object_id, ''),
    NEW.payload::text,
    coalesce(NEW.request_id, ''),
    coalesce(NEW.correlation_id, ''),
    coalesce(NEW.source_ip, ''),
    coalesce(NEW.user_agent, ''),
    NEW.occurred_at::text
  );

  NEW.event_hash := encode(digest(canonical_event, 'sha256'), 'hex');
  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.app_prepare_audit_event() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER prepare_audit_event_chain
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.app_prepare_audit_event();
