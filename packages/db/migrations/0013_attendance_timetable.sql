CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'late', 'excused');
--> statement-breakpoint
CREATE TABLE "attendance_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"old_status" "attendance_status" NOT NULL,
	"new_status" "attendance_status" NOT NULL,
	"reason" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_changes_reason_length" CHECK ("attendance_changes"."reason" is null or char_length("attendance_changes"."reason") between 3 and 200)
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"note" text,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "attendance_records_note_length" CHECK ("attendance_records"."note" is null or char_length("attendance_records"."note") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "timetable_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"staff_id" uuid,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"room" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "timetable_slots_weekday" CHECK ("timetable_slots"."weekday" between 1 and 7),
	CONSTRAINT "timetable_slots_times" CHECK ("timetable_slots"."start_minute" >= 0 and "timetable_slots"."end_minute" <= 1440 and "timetable_slots"."end_minute" > "timetable_slots"."start_minute"),
	CONSTRAINT "timetable_slots_room_length" CHECK ("timetable_slots"."room" is null or char_length("timetable_slots"."room") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "attendance_edit_days" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "weekly_off_days" integer[] DEFAULT '{7}'::integer[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "attendance_locked_through" date;
--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "attendance_changes_record_idx" ON "attendance_changes" USING btree ("school_id","record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_school_id_unique" ON "attendance_records" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_one_per_session" ON "attendance_records" USING btree ("school_id","enrollment_id","attendance_date","session_id");
--> statement-breakpoint
CREATE INDEX "attendance_records_section_date_idx" ON "attendance_records" USING btree ("school_id","section_id","attendance_date");
--> statement-breakpoint
CREATE INDEX "attendance_records_student_date_idx" ON "attendance_records" USING btree ("school_id","student_id","attendance_date");
--> statement-breakpoint
CREATE INDEX "timetable_slots_section_idx" ON "timetable_slots" USING btree ("school_id","section_id","weekday");
--> statement-breakpoint
CREATE INDEX "timetable_slots_staff_idx" ON "timetable_slots" USING btree ("school_id","staff_id","weekday");
--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_school_id_student_section_unique" ON "enrollments" USING btree ("school_id","id","student_id","section_id");
--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_attendance_edit_days" CHECK ("schools"."attendance_edit_days" between 0 and 31);
--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_weekly_off_days" CHECK ("schools"."weekly_off_days" <@ array[1,2,3,4,5,6,7] and cardinality("schools"."weekly_off_days") <= 6);
--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_record_fk" FOREIGN KEY ("school_id","record_id") REFERENCES "public"."attendance_records"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_enrollment_fk" FOREIGN KEY ("school_id","enrollment_id","student_id","section_id") REFERENCES "public"."enrollments"("school_id","id","student_id","section_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_fk" FOREIGN KEY ("school_id","session_id") REFERENCES "public"."attendance_sessions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_section_fk" FOREIGN KEY ("school_id","academic_year_id","section_id") REFERENCES "public"."sections"("school_id","academic_year_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 6: attendance and timetable.
--
-- Attendance records: read by the school's administrators, by a teacher who teaches the section
-- on that date, by the student and by a parent with an active guardian link. Written by
-- administrators (any date, including locked ones; the service requires a reason for changes)
-- and by a teacher who teaches the section on that date, only within the school's edit window,
-- never in the future and never on or before the lock date. Nothing is written in a closed
-- academic year. Changes after the first marking are appended to attendance_changes.
--
-- Timetable: read by every member of the school, written by administrators while the year is
-- open. Clashes are refused by exclusion constraints (btree_gist): one section, one teacher and
-- one room cannot have overlapping periods on the same weekday of the same academic year.
--
-- Recovery: forward-fix. The extension stays installed if the constraints are dropped.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_no_section_clash
  EXCLUDE USING gist (school_id WITH =, section_id WITH =, weekday WITH =, int4range(start_minute, end_minute) WITH &&)
  WHERE (removed_at IS NULL);
--> statement-breakpoint
ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_no_teacher_clash
  EXCLUDE USING gist (school_id WITH =, academic_year_id WITH =, staff_id WITH =, weekday WITH =, int4range(start_minute, end_minute) WITH &&)
  WHERE (removed_at IS NULL AND staff_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_no_room_clash
  EXCLUDE USING gist (school_id WITH =, academic_year_id WITH =, (lower(room)) WITH =, weekday WITH =, int4range(start_minute, end_minute) WITH &&)
  WHERE (removed_at IS NULL AND room IS NOT NULL);
--> statement-breakpoint

-- True when a teacher may still mark or change attendance for this date: not in the future, within
-- the school's edit window and after the lock date (all in the school's own time zone).
CREATE OR REPLACE FUNCTION app_attendance_editable(target_school uuid, on_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM schools s
    WHERE s.id = target_school
      AND on_date <= app_school_today(s.id)
      AND on_date >= app_school_today(s.id) - s.attendance_edit_days
      AND (s.attendance_locked_through IS NULL OR on_date > s.attendance_locked_through)
  )
$$;
--> statement-breakpoint

-- True when the section's academic year is not closed.
CREATE OR REPLACE FUNCTION app_section_year_open(target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM sections s JOIN academic_years y ON y.id = s.academic_year_id
    WHERE s.id = target_section AND y.status <> 'closed'
  )
$$;
--> statement-breakpoint

-- True when the calling user may write this section's attendance for this date.
CREATE OR REPLACE FUNCTION app_can_write_attendance(target_school uuid, target_section uuid, on_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_section_year_open(target_section) AND (
    app_can_manage_setup(target_school)
    OR (target_school = app_school_id() AND app_teaches_section(target_section, on_date) AND app_attendance_editable(target_school, on_date))
  )
$$;
--> statement-breakpoint

-- True when the calling user may change this record (used for its change history).
CREATE OR REPLACE FUNCTION app_can_write_attendance_record(target_record uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM attendance_records r
    WHERE r.id = target_record AND app_can_write_attendance(r.school_id, r.section_id, r.attendance_date)
  )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- attendance_records
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_records_select ON attendance_records FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND (
      app_teaches_section(section_id, attendance_date) OR app_is_student_self(student_id) OR app_is_guardian_of(student_id)
    ))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY attendance_records_insert ON attendance_records FOR INSERT
  WITH CHECK (app_can_write_attendance(school_id, section_id, attendance_date) AND marked_by = app_user_id());
--> statement-breakpoint
CREATE POLICY attendance_records_update ON attendance_records FOR UPDATE
  USING (app_can_write_attendance(school_id, section_id, attendance_date))
  WITH CHECK (app_can_write_attendance(school_id, section_id, attendance_date) AND updated_by = app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------- attendance_changes
ALTER TABLE attendance_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_changes_select ON attendance_changes FOR SELECT
  USING (app_can_manage_setup(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY attendance_changes_insert ON attendance_changes FOR INSERT
  WITH CHECK (school_id = app_school_id() AND changed_by = app_user_id() AND app_can_write_attendance_record(record_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- timetable_slots
ALTER TABLE timetable_slots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY timetable_slots_select ON timetable_slots FOR SELECT USING (app_can_read_school(school_id));
--> statement-breakpoint
CREATE POLICY timetable_slots_insert ON timetable_slots FOR INSERT
  WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id));
--> statement-breakpoint
CREATE POLICY timetable_slots_update ON timetable_slots FOR UPDATE
  USING (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))
  WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id));
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
