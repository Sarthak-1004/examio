CREATE TYPE "public"."hr_employment_type" AS ENUM('permanent', 'probation', 'contract', 'part_time', 'temporary');
--> statement-breakpoint
CREATE TABLE "hr_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_departments_name" CHECK (char_length("hr_departments"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "hr_designations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_designations_name" CHECK (char_length("hr_designations"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "hr_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid NOT NULL,
	"note" text,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "hr_documents_values" CHECK ("hr_documents"."kind" in ('appointment_letter', 'id_proof', 'qualification', 'experience_letter', 'address_proof', 'other') and ("hr_documents"."note" is null or char_length("hr_documents"."note") <= 300) and (("hr_documents"."removed_at" is null) = ("hr_documents"."removed_by" is null)))
);
--> statement-breakpoint
CREATE TABLE "hr_employment" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"employment_type" "hr_employment_type" DEFAULT 'permanent' NOT NULL,
	"department_id" uuid,
	"designation_id" uuid,
	"confirmed_on" date,
	"notice_days" integer,
	"emergency_name" text,
	"emergency_phone" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_employment_values" CHECK (("hr_employment"."notice_days" is null or "hr_employment"."notice_days" between 0 and 365) and ("hr_employment"."emergency_name" is null or char_length("hr_employment"."emergency_name") between 1 and 120) and ("hr_employment"."emergency_phone" is null or "hr_employment"."emergency_phone" ~ '^[0-9+][0-9 -]{5,19}$'))
);
--> statement-breakpoint
CREATE TABLE "hr_employment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_on" date NOT NULL,
	"from_value" text,
	"to_value" text,
	"note" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "hr_employment_events_values" CHECK ("hr_employment_events"."kind" in ('employment_type', 'department', 'designation', 'confirmed', 'left', 'rejoined') and ("hr_employment_events"."from_value" is null or char_length("hr_employment_events"."from_value") <= 120) and ("hr_employment_events"."to_value" is null or char_length("hr_employment_events"."to_value") <= 120) and ("hr_employment_events"."note" is null or char_length("hr_employment_events"."note") <= 300))
);
--> statement-breakpoint
CREATE TABLE "hr_payment_details" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"account_holder" text NOT NULL,
	"account_no" text NOT NULL,
	"ifsc" text NOT NULL,
	"pan" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payment_details_values" CHECK (char_length("hr_payment_details"."account_holder") between 1 and 120 and "hr_payment_details"."account_no" ~ '^[0-9]{6,18}$' and "hr_payment_details"."ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$' and ("hr_payment_details"."pan" is null or "hr_payment_details"."pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'))
);
--> statement-breakpoint
ALTER TABLE "hr_departments" ADD CONSTRAINT "hr_departments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_designations" ADD CONSTRAINT "hr_designations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment" ADD CONSTRAINT "hr_employment_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment" ADD CONSTRAINT "hr_employment_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment_events" ADD CONSTRAINT "hr_employment_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment_events" ADD CONSTRAINT "hr_employment_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_payment_details" ADD CONSTRAINT "hr_payment_details_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_payment_details" ADD CONSTRAINT "hr_payment_details_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_departments_school_id_unique" ON "hr_departments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_departments_name_unique" ON "hr_departments" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_designations_school_id_unique" ON "hr_designations" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_designations_name_unique" ON "hr_designations" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "hr_documents_staff_idx" ON "hr_documents" USING btree ("staff_id");
--> statement-breakpoint
CREATE INDEX "hr_employment_school_idx" ON "hr_employment" USING btree ("school_id");
--> statement-breakpoint
CREATE INDEX "hr_employment_events_staff_idx" ON "hr_employment_events" USING btree ("staff_id","at");
--> statement-breakpoint
CREATE INDEX "hr_payment_details_school_idx" ON "hr_payment_details" USING btree ("school_id");
--> statement-breakpoint
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_file_fk" FOREIGN KEY ("school_id","file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment" ADD CONSTRAINT "hr_employment_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment" ADD CONSTRAINT "hr_employment_department_fk" FOREIGN KEY ("school_id","department_id") REFERENCES "public"."hr_departments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment" ADD CONSTRAINT "hr_employment_designation_fk" FOREIGN KEY ("school_id","designation_id") REFERENCES "public"."hr_designations"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_employment_events" ADD CONSTRAINT "hr_employment_events_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_payment_details" ADD CONSTRAINT "hr_payment_details_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 14.1: HR records.
--
-- Departments and designations: readable by the school's members, written by administrators.
-- Employment terms: administrators, finance (payroll) and the staff member themselves read;
-- administrators write. Employment history: administrators and the staff member read;
-- append-only. Payment details: administrators and finance only (no platform support access).
-- HR documents: administrators only; removed by marking, never deleted.
--
-- Recovery: forward-fix.
-- =====================================================================

ALTER TABLE hr_departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_departments_select ON hr_departments FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_departments_insert ON hr_departments FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY hr_departments_update ON hr_departments FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE hr_designations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_designations_select ON hr_designations FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_designations_insert ON hr_designations FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY hr_designations_update ON hr_designations FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE hr_employment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_employment_select ON hr_employment FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR app_has_school_role('finance') OR staff_id = app_my_staff_id(school_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_employment_insert ON hr_employment FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND updated_by = app_user_id());
--> statement-breakpoint
CREATE POLICY hr_employment_update ON hr_employment FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND updated_by = app_user_id());
--> statement-breakpoint
ALTER TABLE hr_employment_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_employment_events_select ON hr_employment_events FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR staff_id = app_my_staff_id(school_id))) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_employment_events_insert ON hr_employment_events FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND actor_user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE hr_payment_details ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_payment_details_select ON hr_payment_details FOR SELECT
  USING (school_id = app_school_id() AND (app_can_manage_setup(school_id) OR app_has_school_role('finance')));
--> statement-breakpoint
CREATE POLICY hr_payment_details_insert ON hr_payment_details FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND updated_by = app_user_id());
--> statement-breakpoint
CREATE POLICY hr_payment_details_update ON hr_payment_details FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND updated_by = app_user_id());
--> statement-breakpoint
ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_documents_select ON hr_documents FOR SELECT USING (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY hr_documents_insert ON hr_documents FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND uploaded_by = app_user_id() AND removed_at IS NULL);
--> statement-breakpoint
CREATE POLICY hr_documents_update ON hr_documents FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id) AND removed_at IS NULL)
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND removed_by = app_user_id());
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
