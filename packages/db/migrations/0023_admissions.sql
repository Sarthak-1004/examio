CREATE TYPE "public"."admission_document_status" AS ENUM('missing', 'received', 'verified', 'waived');
--> statement-breakpoint
CREATE TYPE "public"."admission_status" AS ENUM('enquiry', 'applied', 'under_review', 'approved', 'rejected', 'withdrawn', 'enrolled');
--> statement-breakpoint
CREATE TABLE "admission_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"reference_no" text NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"applicant_name" text NOT NULL,
	"date_of_birth" date,
	"guardian_name" text NOT NULL,
	"guardian_phone" text,
	"guardian_email" text,
	"previous_school" text,
	"notes" text,
	"status" "admission_status" DEFAULT 'enquiry' NOT NULL,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"student_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admission_applications_names" CHECK (char_length("admission_applications"."applicant_name") between 2 and 120 and char_length("admission_applications"."guardian_name") between 2 and 120),
	CONSTRAINT "admission_applications_contact" CHECK ("admission_applications"."guardian_phone" is not null or "admission_applications"."guardian_email" is not null),
	CONSTRAINT "admission_applications_texts" CHECK (("admission_applications"."previous_school" is null or char_length("admission_applications"."previous_school") <= 200) and ("admission_applications"."notes" is null or char_length("admission_applications"."notes") <= 2000) and ("admission_applications"."decision_note" is null or char_length("admission_applications"."decision_note") <= 500)),
	CONSTRAINT "admission_applications_enrolled" CHECK (("admission_applications"."status" = 'enrolled') = ("admission_applications"."student_id" is not null)),
	CONSTRAINT "admission_applications_decided" CHECK (("admission_applications"."status" in ('approved', 'rejected', 'enrolled')) <= ("admission_applications"."decided_at" is not null and "admission_applications"."decided_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "admission_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "admission_document_status" DEFAULT 'missing' NOT NULL,
	"file_id" uuid,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admission_documents_kind" CHECK ("admission_documents"."kind" in ('birth_certificate', 'previous_report', 'transfer_certificate', 'photo', 'address_proof', 'other')),
	CONSTRAINT "admission_documents_note" CHECK ("admission_documents"."note" is null or char_length("admission_documents"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "admission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "admission_status",
	"to_status" "admission_status" NOT NULL,
	"note" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admission_events_note" CHECK ("admission_events"."note" is null or char_length("admission_events"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_events" ADD CONSTRAINT "admission_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_events" ADD CONSTRAINT "admission_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "admission_applications_school_id_unique" ON "admission_applications" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "admission_applications_reference_unique" ON "admission_applications" USING btree ("school_id","reference_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "admission_applications_student_unique" ON "admission_applications" USING btree ("school_id","student_id") WHERE "admission_applications"."student_id" is not null;
--> statement-breakpoint
CREATE INDEX "admission_applications_status_idx" ON "admission_applications" USING btree ("school_id","academic_year_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "admission_documents_kind_unique" ON "admission_documents" USING btree ("school_id","application_id","kind");
--> statement-breakpoint
CREATE INDEX "admission_events_application_idx" ON "admission_events" USING btree ("application_id","at");
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_class_fk" FOREIGN KEY ("school_id","class_id") REFERENCES "public"."classes"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_application_fk" FOREIGN KEY ("school_id","application_id") REFERENCES "public"."admission_applications"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_file_fk" FOREIGN KEY ("school_id","file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_events" ADD CONSTRAINT "admission_events_application_fk" FOREIGN KEY ("school_id","application_id") REFERENCES "public"."admission_applications"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 13.1: admissions.
--
-- The school office (school administrators) records enquiries and applications for an academic
-- year and class, keeps a document checklist, reviews, approves or rejects, and converts an
-- approved application into exactly one student record. Status changes follow
-- admission_applications_guard; every change is on the application's timeline. Documents are
-- private files (purpose admission_document), visible to the school's administrators.
--
-- Recovery: forward-fix.
-- =====================================================================

-- Allowed status changes. Rejected and withdrawn applications may be reopened for review; an
-- enrolled application is final and is reached only from approved, with the student linked.
CREATE OR REPLACE FUNCTION admission_applications_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'enrolled' THEN
    RAISE EXCEPTION 'admission_final' USING ERRCODE = '23514';
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id AND NOT (OLD.status = 'approved' AND NEW.status = 'enrolled') THEN
    RAISE EXCEPTION 'admission_student_link' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'enquiry' AND NEW.status IN ('applied', 'withdrawn'))
    OR (OLD.status = 'applied' AND NEW.status IN ('under_review', 'withdrawn'))
    OR (OLD.status = 'under_review' AND NEW.status IN ('approved', 'rejected', 'withdrawn'))
    OR (OLD.status = 'approved' AND NEW.status IN ('enrolled', 'withdrawn', 'under_review'))
    OR (OLD.status IN ('rejected', 'withdrawn') AND NEW.status = 'under_review')
  ) THEN
    RAISE EXCEPTION 'admission_transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER admission_applications_guard BEFORE UPDATE ON admission_applications FOR EACH ROW EXECUTE FUNCTION admission_applications_guard();
--> statement-breakpoint

ALTER TABLE admission_applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admission_applications_select ON admission_applications FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY admission_applications_insert ON admission_applications FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id() AND status IN ('enquiry', 'applied') AND student_id IS NULL);
--> statement-breakpoint
CREATE POLICY admission_applications_update ON admission_applications FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE admission_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admission_documents_select ON admission_documents FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY admission_documents_insert ON admission_documents FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY admission_documents_update ON admission_documents FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE admission_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admission_events_select ON admission_events FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY admission_events_insert ON admission_events FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND actor_user_id = app_user_id());
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
