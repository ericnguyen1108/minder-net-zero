CREATE TYPE "public"."historical_import_status" AS ENUM('staging', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "historical_import_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"source_hash" text NOT NULL,
	"expected_row_count" integer NOT NULL,
	"expected_chunk_count" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" "historical_import_status" DEFAULT 'staging' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"received_row_count" integer DEFAULT 0 NOT NULL,
	"received_chunk_count" integer DEFAULT 0 NOT NULL,
	"completed_dataset_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "historical_import_sessions_tenant_comp_id_uq" UNIQUE("tenant_id","competition_id","id"),
	CONSTRAINT "historical_import_sessions_source_hash_ck" CHECK ("historical_import_sessions"."source_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_sessions_rows_ck" CHECK ("historical_import_sessions"."expected_row_count" > 0 and "historical_import_sessions"."expected_row_count" <= 1000),
	CONSTRAINT "historical_import_sessions_chunks_ck" CHECK ("historical_import_sessions"."expected_chunk_count" > 0 and "historical_import_sessions"."expected_chunk_count" <= 100),
	CONSTRAINT "historical_import_sessions_schema_ck" CHECK ("historical_import_sessions"."schema_version" > 0),
	CONSTRAINT "historical_import_sessions_revision_ck" CHECK ("historical_import_sessions"."revision" > 0),
	CONSTRAINT "historical_import_sessions_received_ck" CHECK ("historical_import_sessions"."received_row_count" >= 0 and "historical_import_sessions"."received_row_count" <= "historical_import_sessions"."expected_row_count" and "historical_import_sessions"."received_chunk_count" >= 0 and "historical_import_sessions"."received_chunk_count" <= "historical_import_sessions"."expected_chunk_count"),
	CONSTRAINT "historical_import_sessions_completed_ck" CHECK ("historical_import_sessions"."status" <> 'completed' or ("historical_import_sessions"."completed_dataset_id" is not null and "historical_import_sessions"."completed_at" is not null))
);--> statement-breakpoint
CREATE TABLE "historical_import_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"import_session_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_row" integer NOT NULL,
	"row_count" integer NOT NULL,
	"chunk_hash" text NOT NULL,
	"canonical_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_chunks_tenant_comp_session_id_uq" UNIQUE("tenant_id","competition_id","import_session_id","id"),
	CONSTRAINT "historical_import_chunks_index_ck" CHECK ("historical_import_chunks"."chunk_index" >= 0 and "historical_import_chunks"."chunk_index" < 100),
	CONSTRAINT "historical_import_chunks_start_ck" CHECK ("historical_import_chunks"."start_row" >= 0 and "historical_import_chunks"."start_row" < 1000),
	CONSTRAINT "historical_import_chunks_rows_ck" CHECK ("historical_import_chunks"."row_count" > 0 and "historical_import_chunks"."row_count" <= 25),
	CONSTRAINT "historical_import_chunks_hash_ck" CHECK ("historical_import_chunks"."chunk_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_chunks_bytes_ck" CHECK ("historical_import_chunks"."canonical_bytes" > 0 and "historical_import_chunks"."canonical_bytes" <= 750000)
);--> statement-breakpoint
CREATE TABLE "historical_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"import_session_id" uuid NOT NULL,
	"import_chunk_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"row_ordinal" integer NOT NULL,
	"external_ref" text NOT NULL,
	"content" jsonb NOT NULL,
	"historical_label" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"label_hash" text NOT NULL,
	"row_hash" text NOT NULL,
	"canonical_bytes" integer NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_rows_ordinal_ck" CHECK ("historical_import_rows"."row_ordinal" >= 0 and "historical_import_rows"."row_ordinal" < 1000),
	CONSTRAINT "historical_import_rows_chunk_index_ck" CHECK ("historical_import_rows"."chunk_index" >= 0 and "historical_import_rows"."chunk_index" < 100),
	CONSTRAINT "historical_import_rows_external_ref_ck" CHECK (length("historical_import_rows"."external_ref") between 1 and 200),
	CONSTRAINT "historical_import_rows_content_hash_ck" CHECK ("historical_import_rows"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_rows_label_hash_ck" CHECK ("historical_import_rows"."label_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_rows_row_hash_ck" CHECK ("historical_import_rows"."row_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_rows_bytes_ck" CHECK ("historical_import_rows"."canonical_bytes" > 0 and "historical_import_rows"."canonical_bytes" <= 250000)
);--> statement-breakpoint
ALTER TABLE "historical_import_sessions" ADD CONSTRAINT "historical_import_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_sessions" ADD CONSTRAINT "historical_import_sessions_competition_fk" FOREIGN KEY ("tenant_id","competition_id") REFERENCES "public"."competitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_sessions" ADD CONSTRAINT "historical_import_sessions_dataset_fk" FOREIGN KEY ("tenant_id","competition_id","completed_dataset_id") REFERENCES "public"."datasets"("tenant_id","competition_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_chunks" ADD CONSTRAINT "historical_import_chunks_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_chunks" ADD CONSTRAINT "historical_import_chunks_session_fk" FOREIGN KEY ("tenant_id","competition_id","import_session_id") REFERENCES "public"."historical_import_sessions"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_rows" ADD CONSTRAINT "historical_import_rows_session_fk" FOREIGN KEY ("tenant_id","competition_id","import_session_id") REFERENCES "public"."historical_import_sessions"("tenant_id","competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_rows" ADD CONSTRAINT "historical_import_rows_chunk_fk" FOREIGN KEY ("tenant_id","competition_id","import_session_id","import_chunk_id") REFERENCES "public"."historical_import_chunks"("tenant_id","competition_id","import_session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_sessions_idempotency_uq" ON "historical_import_sessions" USING btree ("tenant_id","competition_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "historical_import_sessions_expiry_idx" ON "historical_import_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_chunks_session_index_uq" ON "historical_import_chunks" USING btree ("tenant_id","competition_id","import_session_id","chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_rows_session_ordinal_uq" ON "historical_import_rows" USING btree ("tenant_id","competition_id","import_session_id","row_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_rows_session_external_ref_uq" ON "historical_import_rows" USING btree ("tenant_id","competition_id","import_session_id","external_ref");--> statement-breakpoint
CREATE INDEX "historical_import_rows_chunk_idx" ON "historical_import_rows" USING btree ("tenant_id","competition_id","import_session_id","chunk_index","row_ordinal");--> statement-breakpoint

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'historical_import_sessions',
    'historical_import_chunks',
    'historical_import_rows'
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

-- Accepted evidence may be deleted only by finalization/approved retention;
-- application traffic cannot rewrite a staged digest.
CREATE TRIGGER reject_historical_import_chunks_update
  BEFORE UPDATE ON public.historical_import_chunks
  FOR EACH ROW
  EXECUTE FUNCTION public.app_reject_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER reject_historical_import_rows_update
  BEFORE UPDATE ON public.historical_import_rows
  FOR EACH ROW
  EXECUTE FUNCTION public.app_reject_immutable_mutation();
