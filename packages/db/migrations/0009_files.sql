CREATE TYPE "public"."file_status" AS ENUM('quarantined', 'clean', 'rejected', 'deleted');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"purpose" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" "file_status" DEFAULT 'quarantined' NOT NULL,
	"scan_result" text,
	"scanned_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_purpose_format" CHECK ("files"."purpose" ~ '^[a-z][a-z0-9_]{2,40}$'),
	CONSTRAINT "files_name_length" CHECK (char_length("files"."original_name") between 1 and 200),
	CONSTRAINT "files_size_range" CHECK ("files"."size_bytes" between 1 and 52428800),
	CONSTRAINT "files_sha256_format" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_storage_key_format" CHECK ("files"."storage_key" ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$')
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_unique" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_school_idx" ON "files" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "files_uploader_idx" ON "files" USING btree ("uploaded_by");--> statement-breakpoint

-- =====================================================================
-- Phase 2, task 02.3: private file storage.
--
-- Who can see a file: its uploader (while still a member of the school),
-- the school's administrators, and platform support with an open grant
-- for that school. Later modules widen this per purpose (for example a
-- teacher reading homework submitted to them) with their own policies.
-- Users can only create quarantined uploads in their own school and can
-- only mark a file deleted; scan results come from the worker.
--
-- Recovery: forward-fix. The table holds references to stored bytes;
-- restoring it without the matching storage leaves files unreadable,
-- so back up storage together with the database (OPERATIONS.md).
-- =====================================================================
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY files_select ON files FOR SELECT
  USING (
    (school_id = app_school_id() AND app_is_member_of(school_id)
      AND (uploaded_by = app_user_id() OR app_has_school_role('school_admin')))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY files_insert ON files FOR INSERT
  WITH CHECK (
    school_id = app_school_id() AND app_is_member_of(school_id)
    AND uploaded_by = app_user_id()
    AND status = 'quarantined' AND scanned_at IS NULL AND scan_result IS NULL
    AND deleted_at IS NULL AND purged_at IS NULL
    AND purpose <> 'export'
  );
--> statement-breakpoint
-- Only status and deleted_at are updatable by the runtime role (column
-- privileges), and the only allowed change is to mark a file deleted.
CREATE POLICY files_delete_mark ON files FOR UPDATE
  USING (
    school_id = app_school_id() AND app_is_member_of(school_id)
    AND (uploaded_by = app_user_id() OR app_has_school_role('school_admin'))
    AND status <> 'deleted'
  )
  WITH CHECK (status = 'deleted' AND deleted_at IS NOT NULL);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION file_for_scan(file_id uuid)
RETURNS TABLE (id uuid, storage_key text, sha256 text, size_bytes bigint, status file_status)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may scan files' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.id, f.storage_key, f.sha256, f.size_bytes, f.status FROM files f WHERE f.id = file_id;
END
$$;
--> statement-breakpoint
-- Records a scan outcome, once, for a file still in quarantine.
CREATE OR REPLACE FUNCTION file_record_scan(file_id uuid, outcome file_status, result_text text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f record;
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may record scan results' USING ERRCODE = '42501';
  END IF;
  IF outcome NOT IN ('clean', 'rejected') THEN
    RAISE EXCEPTION 'invalid scan outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE files SET status = outcome, scan_result = left(result_text, 300), scanned_at = now()
  WHERE id = file_id AND status = 'quarantined'
  RETURNING school_id, uploaded_by INTO f;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (f.school_id, NULL, CASE outcome WHEN 'clean' THEN 'file.scan_clean' ELSE 'file.scan_rejected' END,
          'file', file_id::text, jsonb_build_object('result', left(result_text, 300)));
  RETURN true;
END
$$;
--> statement-breakpoint
-- Stores a file the system generated (an export). Never scanned: its content
-- is produced by the application. Must expire within 7 days.
CREATE OR REPLACE FUNCTION file_create_export(
  target_school uuid, owner_user uuid, file_name text, file_type text, file_size bigint, file_sha256 text, file_key text, file_expires timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT (app_is_worker() OR (owner_user = app_user_id() AND target_school = app_school_id() AND app_is_member_of(target_school))) THEN
    RAISE EXCEPTION 'not allowed to create this export' USING ERRCODE = '42501';
  END IF;
  IF file_expires IS NULL OR file_expires <= now() OR file_expires > now() + interval '7 days' THEN
    RAISE EXCEPTION 'exports must expire within 7 days' USING ERRCODE = '22023';
  END IF;
  INSERT INTO files (school_id, uploaded_by, purpose, original_name, content_type, size_bytes, sha256, storage_key, status, scan_result, scanned_at, expires_at)
  VALUES (target_school, owner_user, 'export', file_name, file_type, file_size, file_sha256, file_key, 'clean', 'generated by the application', now(), file_expires)
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
--> statement-breakpoint
-- Files whose stored bytes should be removed: rejected, deleted, or expired.
CREATE OR REPLACE FUNCTION file_purge_candidates(max_rows integer)
RETURNS TABLE (id uuid, storage_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may purge files' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.id, f.storage_key FROM files f
  WHERE f.purged_at IS NULL
    AND (f.status IN ('rejected', 'deleted') OR (f.expires_at IS NOT NULL AND f.expires_at < now()))
  ORDER BY f.created_at LIMIT least(greatest(coalesce(max_rows, 100), 1), 1000);
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION file_mark_purged(file_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may purge files' USING ERRCODE = '42501';
  END IF;
  UPDATE files SET purged_at = now(),
    status = CASE WHEN status = 'clean' THEN 'deleted'::file_status ELSE status END,
    deleted_at = coalesce(deleted_at, now())
  WHERE id = file_id AND purged_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION file_stats()
RETURNS TABLE (quarantined bigint, oldest_quarantine_seconds integer, rejected bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_is_platform_admin() OR app_is_worker()) THEN
    RAISE EXCEPTION 'not allowed to read file statistics' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT
    count(*) FILTER (WHERE f.status = 'quarantined'),
    coalesce(extract(epoch FROM now() - min(f.created_at) FILTER (WHERE f.status = 'quarantined'))::integer, 0),
    count(*) FILTER (WHERE f.status = 'rejected')
  FROM files f;
END
$$;
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examio_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO examio_app;
  END IF;
END
$$;
