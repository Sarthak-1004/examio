CREATE TYPE "public"."staff_status" AS ENUM('active', 'left');--> statement-breakpoint
CREATE TABLE "class_teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_teachers_dates" CHECK ("class_teachers"."ends_on" is null or "class_teachers"."ends_on" >= "class_teachers"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_no" text NOT NULL,
	"display_name" text NOT NULL,
	"job_title" text,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"joined_on" date,
	"left_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_profiles_employee_no_format" CHECK ("staff_profiles"."employee_no" ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$'),
	CONSTRAINT "staff_profiles_display_name_length" CHECK (char_length("staff_profiles"."display_name") between 2 and 120),
	CONSTRAINT "staff_profiles_job_title_length" CHECK ("staff_profiles"."job_title" is null or char_length("staff_profiles"."job_title") between 1 and 80),
	CONSTRAINT "staff_profiles_left_after_joined" CHECK ("staff_profiles"."left_on" is null or "staff_profiles"."joined_on" is null or "staff_profiles"."left_on" >= "staff_profiles"."joined_on"),
	CONSTRAINT "staff_profiles_left_has_date" CHECK (("staff_profiles"."status" = 'left') = ("staff_profiles"."left_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "teacher_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_assignments_dates" CHECK ("teacher_assignments"."ends_on" is null or "teacher_assignments"."ends_on" >= "teacher_assignments"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "class_teachers_one_open" ON "class_teachers" USING btree ("school_id","section_id") WHERE "class_teachers"."ends_on" is null;--> statement-breakpoint
CREATE INDEX "class_teachers_staff_idx" ON "class_teachers" USING btree ("school_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_school_id_unique" ON "staff_profiles" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_school_user_unique" ON "staff_profiles" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_school_employee_no_unique" ON "staff_profiles" USING btree ("school_id",lower("employee_no"));--> statement-breakpoint
CREATE INDEX "staff_profiles_user_idx" ON "staff_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_assignments_one_open" ON "teacher_assignments" USING btree ("school_id","staff_id","section_id","subject_id") WHERE "teacher_assignments"."ends_on" is null;--> statement-breakpoint
CREATE INDEX "teacher_assignments_staff_idx" ON "teacher_assignments" USING btree ("school_id","staff_id");--> statement-breakpoint
CREATE INDEX "teacher_assignments_section_idx" ON "teacher_assignments" USING btree ("school_id","section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_school_year_id_unique" ON "sections" USING btree ("school_id","academic_year_id","id");--> statement-breakpoint
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_section_fk" FOREIGN KEY ("school_id","academic_year_id","section_id") REFERENCES "public"."sections"("school_id","academic_year_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_section_fk" FOREIGN KEY ("school_id","academic_year_id","section_id") REFERENCES "public"."sections"("school_id","academic_year_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- =====================================================================
-- Phase 4: staff profiles, teacher assignments, class teachers, and
-- assignment-based access.
--
-- Staff records: school admins of the school read and write; a staff
-- member reads their own profile and assignments; platform support reads
-- under an open grant. Assignments are never deleted (no DELETE grant);
-- they are ended. Assignments in a closed academic year are read-only.
--
-- Visibility change for teachers: before this migration a teacher could
-- read every user and membership of the school, including students. Now
-- a teacher reads staff (admins, teachers, finance) only. Students become
-- visible to their teachers through enrollments in assigned sections
-- (Phase 5), using app_teaches_section().
--
-- Recovery: forward-fix. Earlier users/memberships SELECT policies are in
-- 0006_support_access.sql.
-- =====================================================================

-- The calling user's active staff profile id in a school, or NULL.
CREATE OR REPLACE FUNCTION app_my_staff_id(target_school uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id FROM staff_profiles p
  WHERE p.school_id = target_school AND p.user_id = app_user_id() AND p.status = 'active'
$$;
--> statement-breakpoint

-- True when the target user is a staff member (admin, teacher, finance) of the current school.
CREATE OR REPLACE FUNCTION app_user_is_staff_in_current_school(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id = app_school_id() AND m.user_id = target AND m.status = 'active'
      AND m.role IN ('school_admin', 'teacher', 'finance')
  )
$$;
--> statement-breakpoint

-- True when the calling user, as an active teacher of the current school, teaches the section
-- on the given date: through a subject assignment or as its class teacher.
CREATE OR REPLACE FUNCTION app_teaches_section(target_section uuid, on_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('teacher') AND (
    EXISTS (
      SELECT 1 FROM teacher_assignments a
      WHERE a.school_id = app_school_id() AND a.section_id = target_section
        AND a.staff_id = app_my_staff_id(app_school_id())
        AND a.starts_on <= on_date AND (a.ends_on IS NULL OR a.ends_on >= on_date)
    )
    OR EXISTS (
      SELECT 1 FROM class_teachers c
      WHERE c.school_id = app_school_id() AND c.section_id = target_section
        AND c.staff_id = app_my_staff_id(app_school_id())
        AND c.starts_on <= on_date AND (c.ends_on IS NULL OR c.ends_on >= on_date)
    )
  )
$$;
--> statement-breakpoint

-- True when the calling user teaches this subject to this section on the given date.
CREATE OR REPLACE FUNCTION app_teaches_subject(target_section uuid, target_subject uuid, on_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('teacher') AND EXISTS (
    SELECT 1 FROM teacher_assignments a
    WHERE a.school_id = app_school_id() AND a.section_id = target_section AND a.subject_id = target_subject
      AND a.staff_id = app_my_staff_id(app_school_id())
      AND a.starts_on <= on_date AND (a.ends_on IS NULL OR a.ends_on >= on_date)
  )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- staff_profiles
ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND user_id = app_user_id() AND app_is_member_of(school_id))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY staff_profiles_insert ON staff_profiles FOR INSERT WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY staff_profiles_update ON staff_profiles FOR UPDATE
  USING (app_can_manage_setup(school_id)) WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- assignments
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teacher_assignments', 'class_teachers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
        app_can_manage_setup(school_id)
        OR (school_id = app_school_id() AND staff_id = app_my_staff_id(school_id))
        OR app_has_support_access(school_id))$p$, t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_can_manage_setup(school_id) AND app_year_open(academic_year_id)) WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))', t || '_update', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- narrower teacher visibility
DROP POLICY users_select ON users;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_user_id()
    OR app_platform_can_see_user(id)
    OR (app_has_school_role('school_admin') AND app_user_in_current_school(id))
    OR (app_has_school_role('teacher') AND app_user_is_staff_in_current_school(id))
  );
--> statement-breakpoint
DROP POLICY memberships_select ON school_memberships;
--> statement-breakpoint
CREATE POLICY memberships_select ON school_memberships FOR SELECT
  USING (
    user_id = app_user_id()
    OR (app_is_platform_admin() AND (role = 'school_admin' OR app_has_support_access(school_id)))
    OR (school_id = app_school_id() AND app_has_school_role('school_admin'))
    OR (school_id = app_school_id() AND app_has_school_role('teacher') AND role IN ('school_admin', 'teacher', 'finance'))
  );
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
