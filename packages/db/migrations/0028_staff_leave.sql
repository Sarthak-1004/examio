CREATE TYPE "public"."hr_leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."hr_staff_attendance_status" AS ENUM('present', 'absent', 'half_day', 'leave', 'half_leave');
--> statement-breakpoint
CREATE TABLE "hr_leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"days_halves" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "hr_leave_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_requests_values" CHECK ("hr_leave_requests"."from_on" <= "hr_leave_requests"."to_on" and (not "hr_leave_requests"."half_day" or "hr_leave_requests"."from_on" = "hr_leave_requests"."to_on") and "hr_leave_requests"."days_halves" between 1 and 730 and char_length("hr_leave_requests"."reason") between 3 and 300 and ("hr_leave_requests"."decision_note" is null or char_length("hr_leave_requests"."decision_note") <= 300)),
	CONSTRAINT "hr_leave_requests_decided" CHECK (("hr_leave_requests"."status" = 'pending') = ("hr_leave_requests"."decided_by" is null) and ("hr_leave_requests"."decided_by" is null) = ("hr_leave_requests"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "hr_leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"quota_halves" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_types_values" CHECK (char_length("hr_leave_types"."name") between 1 and 60 and ("hr_leave_types"."quota_halves" is null or "hr_leave_types"."quota_halves" between 0 and 730) and ("hr_leave_types"."paid" or "hr_leave_types"."quota_halves" is null))
);
--> statement-breakpoint
CREATE TABLE "hr_staff_attendance" (
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"on" date NOT NULL,
	"status" "hr_staff_attendance_status",
	"leave_request_id" uuid,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_staff_attendance_staff_id_on_pk" PRIMARY KEY("staff_id","on"),
	CONSTRAINT "hr_staff_attendance_leave" CHECK (coalesce("hr_staff_attendance"."status" in ('leave', 'half_leave'), false) = ("hr_staff_attendance"."leave_request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "hr_staff_attendance_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"on" date NOT NULL,
	"from_status" "hr_staff_attendance_status",
	"to_status" "hr_staff_attendance_status",
	"reason" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "hr_staff_attendance_changes_values" CHECK (char_length("hr_staff_attendance_changes"."reason") between 3 and 300 and ("hr_staff_attendance_changes"."from_status" is not null or "hr_staff_attendance_changes"."to_status" is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD CONSTRAINT "hr_leave_types_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance" ADD CONSTRAINT "hr_staff_attendance_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance" ADD CONSTRAINT "hr_staff_attendance_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance_changes" ADD CONSTRAINT "hr_staff_attendance_changes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance_changes" ADD CONSTRAINT "hr_staff_attendance_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_requests_school_id_unique" ON "hr_leave_requests" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "hr_leave_requests_staff_idx" ON "hr_leave_requests" USING btree ("staff_id","from_on");
--> statement-breakpoint
CREATE INDEX "hr_leave_requests_pending_idx" ON "hr_leave_requests" USING btree ("school_id") WHERE "hr_leave_requests"."status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_types_school_id_unique" ON "hr_leave_types" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_types_name_unique" ON "hr_leave_types" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "hr_staff_attendance_day_idx" ON "hr_staff_attendance" USING btree ("school_id","on");
--> statement-breakpoint
CREATE INDEX "hr_staff_attendance_changes_idx" ON "hr_staff_attendance_changes" USING btree ("staff_id","on");
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_type_fk" FOREIGN KEY ("school_id","leave_type_id") REFERENCES "public"."hr_leave_types"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance" ADD CONSTRAINT "hr_staff_attendance_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance" ADD CONSTRAINT "hr_staff_attendance_leave_fk" FOREIGN KEY ("school_id","leave_request_id") REFERENCES "public"."hr_leave_requests"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hr_staff_attendance_changes" ADD CONSTRAINT "hr_staff_attendance_changes_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 14.2: staff attendance and leave.
--
-- Leave types: readable by the school's members, written by administrators.
-- Leave requests: readable by administrators and the staff member. Staff insert their own
-- (pending) requests; administrators may insert for anyone. One staff member's pending and
-- approved requests never overlap (exclusion constraint hr_leave_requests_no_overlap).
-- Trigger hr_leave_requests_guard: only pending -> approved/rejected/cancelled and
-- approved -> cancelled; the decider must not be the staff member nor the requester (except a
-- staff member cancelling their own pending request); decided requests keep their dates.
-- Staff register and its changes: administrators write; administrators and the staff member
-- read; changes are append-only.
--
-- Recovery: forward-fix.
-- =====================================================================

ALTER TABLE hr_leave_requests ADD CONSTRAINT hr_leave_requests_no_overlap
  EXCLUDE USING gist (staff_id WITH =, daterange(from_on, to_on, '[]') WITH &&) WHERE (status IN ('pending', 'approved'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hr_leave_requests_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  staff_user uuid;
BEGIN
  IF NEW.staff_id <> OLD.staff_id OR NEW.leave_type_id <> OLD.leave_type_id OR NEW.from_on <> OLD.from_on OR NEW.to_on <> OLD.to_on
     OR NEW.half_day <> OLD.half_day OR NEW.days_halves <> OLD.days_halves OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'A leave request keeps its dates and type.' USING ERRCODE = 'check_violation', CONSTRAINT = 'hr_leave_requests_fixed';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled')) OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'A leave request cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'hr_leave_requests_status';
  END IF;
  SELECT user_id INTO staff_user FROM staff_profiles WHERE id = NEW.staff_id;
  IF NEW.status IN ('approved', 'rejected') AND (NEW.decided_by = staff_user OR NEW.decided_by = OLD.requested_by) THEN
    RAISE EXCEPTION 'Leave is decided by an administrator other than the staff member and the requester.' USING ERRCODE = 'check_violation', CONSTRAINT = 'hr_leave_requests_decider';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hr_leave_requests_guard BEFORE UPDATE ON hr_leave_requests FOR EACH ROW EXECUTE FUNCTION hr_leave_requests_guard();
--> statement-breakpoint

ALTER TABLE hr_leave_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_leave_types_select ON hr_leave_types FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_leave_types_insert ON hr_leave_types FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY hr_leave_types_update ON hr_leave_types FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE hr_leave_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_leave_requests_select ON hr_leave_requests FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR staff_id = app_my_staff_id(school_id))) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_leave_requests_insert ON hr_leave_requests FOR INSERT
  WITH CHECK (school_id = app_school_id() AND requested_by = app_user_id() AND status = 'pending'
              AND (app_can_manage_setup(school_id) OR staff_id = app_my_staff_id(school_id)));
--> statement-breakpoint
CREATE POLICY hr_leave_requests_update ON hr_leave_requests FOR UPDATE
  USING (school_id = app_school_id() AND (app_can_manage_setup(school_id) OR (staff_id = app_my_staff_id(school_id) AND status = 'pending')))
  WITH CHECK (school_id = app_school_id() AND decided_by = app_user_id()
              AND (app_can_manage_setup(school_id) OR (staff_id = app_my_staff_id(school_id) AND status = 'cancelled')));
--> statement-breakpoint
ALTER TABLE hr_staff_attendance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_select ON hr_staff_attendance FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR staff_id = app_my_staff_id(school_id))) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_insert ON hr_staff_attendance FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND marked_by = app_user_id());
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_update ON hr_staff_attendance FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND marked_by = app_user_id());
--> statement-breakpoint
ALTER TABLE hr_staff_attendance_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_changes_select ON hr_staff_attendance_changes FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR staff_id = app_my_staff_id(school_id))) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_changes_insert ON hr_staff_attendance_changes FOR INSERT
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
