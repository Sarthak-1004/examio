CREATE TYPE "public"."enrollment_end_reason" AS ENUM('promoted', 'section_changed', 'left', 'corrected');
--> statement-breakpoint
CREATE TYPE "public"."guardian_relationship" AS ENUM('mother', 'father', 'guardian', 'other');
--> statement-breakpoint
CREATE TYPE "public"."student_leave_reason" AS ENUM('withdrawn', 'transferred', 'graduated', 'other');
--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('active', 'left');
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"roll_no" integer,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"end_reason" "enrollment_end_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_dates" CHECK ("enrollments"."ends_on" is null or "enrollments"."ends_on" >= "enrollments"."starts_on"),
	CONSTRAINT "enrollments_end_reason" CHECK (("enrollments"."ends_on" is null) = ("enrollments"."end_reason" is null)),
	CONSTRAINT "enrollments_roll_range" CHECK ("enrollments"."roll_no" is null or "enrollments"."roll_no" between 1 and 9999)
);
--> statement-breakpoint
CREATE TABLE "guardian_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"guardian_user_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"relationship" "guardian_relationship" NOT NULL,
	"verified_by" uuid NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"added_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_documents_title_length" CHECK (char_length("student_documents"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"admission_no" text NOT NULL,
	"display_name" text NOT NULL,
	"date_of_birth" date,
	"admitted_on" date NOT NULL,
	"status" "student_status" DEFAULT 'active' NOT NULL,
	"left_on" date,
	"leave_reason" "student_leave_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_profiles_admission_format" CHECK ("student_profiles"."admission_no" ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$'),
	CONSTRAINT "student_profiles_display_name_length" CHECK (char_length("student_profiles"."display_name") between 2 and 120),
	CONSTRAINT "student_profiles_left_consistent" CHECK (("student_profiles"."status" = 'left') = ("student_profiles"."left_on" is not null and "student_profiles"."leave_reason" is not null)),
	CONSTRAINT "student_profiles_left_after_admitted" CHECK ("student_profiles"."left_on" is null or "student_profiles"."left_on" >= "student_profiles"."admitted_on"),
	CONSTRAINT "student_profiles_birth_before_admission" CHECK ("student_profiles"."date_of_birth" is null or "student_profiles"."date_of_birth" < "student_profiles"."admitted_on")
);
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD COLUMN "student_id" uuid;
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD COLUMN "relationship" text;
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_guardian_user_id_users_id_fk" FOREIGN KEY ("guardian_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_school_id_unique" ON "enrollments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_one_open_per_year" ON "enrollments" USING btree ("school_id","student_id","academic_year_id") WHERE "enrollments"."ends_on" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_roll_unique_open" ON "enrollments" USING btree ("school_id","section_id","roll_no") WHERE "enrollments"."ends_on" is null and "enrollments"."roll_no" is not null;
--> statement-breakpoint
CREATE INDEX "enrollments_section_idx" ON "enrollments" USING btree ("school_id","section_id");
--> statement-breakpoint
CREATE INDEX "enrollments_student_idx" ON "enrollments" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_links_one_active" ON "guardian_links" USING btree ("school_id","guardian_user_id","student_id") WHERE "guardian_links"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "guardian_links_guardian_idx" ON "guardian_links" USING btree ("guardian_user_id");
--> statement-breakpoint
CREATE INDEX "guardian_links_student_idx" ON "guardian_links" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "student_documents_file_unique" ON "student_documents" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "student_documents_student_idx" ON "student_documents" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "student_profiles_school_id_unique" ON "student_profiles" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "student_profiles_school_user_unique" ON "student_profiles" USING btree ("school_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "student_profiles_school_admission_unique" ON "student_profiles" USING btree ("school_id",lower("admission_no"));
--> statement-breakpoint
CREATE INDEX "student_profiles_user_idx" ON "student_profiles" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "student_profiles_school_name_idx" ON "student_profiles" USING btree ("school_id",lower("display_name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "files_school_id_unique" ON "files" USING btree ("school_id","id");
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_child_only_for_parent" CHECK ("membership_invitations"."student_id" is null or "membership_invitations"."role" = 'parent');
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_relationship" CHECK (("membership_invitations"."student_id" is null) = ("membership_invitations"."relationship" is null) and ("membership_invitations"."relationship" is null or "membership_invitations"."relationship" in ('mother', 'father', 'guardian', 'other')));
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_fk" FOREIGN KEY ("school_id","academic_year_id","section_id") REFERENCES "public"."sections"("school_id","academic_year_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_file_fk" FOREIGN KEY ("school_id","file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- New parent invitations must name the child. NOT VALID: parent invitations created before
-- Phase 5 (without a child) stay as history; a parent who joins through one sees no child.
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_parent_names_child" CHECK ("role" <> 'parent' OR "student_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint

-- =====================================================================
-- Phase 5: students, enrollments, guardian links and student documents.
--
-- Who reads a student's record (all within the selected school):
--   * the school's administrators (and platform support under an open grant);
--   * the student themself;
--   * a parent with an active guardian link to that student;
--   * a teacher who teaches the student's current section today (subject or class teacher).
-- Enrollments follow the same rule, limited for teachers to enrollments in force today.
-- Guardian links: administrators, and the guardian's own links. Documents: administrators only.
-- Writes: school administrators only; enrollments only while their academic year is open.
-- Nothing is deleted (no DELETE grant); rows are ended, revoked or removed by a timestamp.
--
-- Accepting a parent invitation that names a child creates the verified guardian link in the
-- same transaction as the membership.
--
-- Recovery: forward-fix. The previous auth_accept_membership_invitation is in
-- 0005_account_recovery.sql.
-- =====================================================================

-- The school's local date (attendance dates, "today" for assignments).
CREATE OR REPLACE FUNCTION app_school_today(target_school uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE COALESCE((SELECT s.timezone FROM schools s WHERE s.id = target_school), 'UTC'))::date
$$;
--> statement-breakpoint

-- True when the calling user is a parent in the current school with an active link to the student.
CREATE OR REPLACE FUNCTION app_is_guardian_of(target_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('parent') AND EXISTS (
    SELECT 1 FROM guardian_links g
    WHERE g.school_id = app_school_id() AND g.student_id = target_student
      AND g.guardian_user_id = app_user_id() AND g.revoked_at IS NULL
  )
$$;
--> statement-breakpoint

-- True when the calling user is the student, signed in to the current school as a student.
CREATE OR REPLACE FUNCTION app_is_student_self(target_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('student') AND EXISTS (
    SELECT 1 FROM student_profiles p
    WHERE p.id = target_student AND p.school_id = app_school_id() AND p.user_id = app_user_id()
  )
$$;
--> statement-breakpoint

-- True when the calling user teaches the student's current section today.
CREATE OR REPLACE FUNCTION app_teaches_student(target_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('teacher') AND EXISTS (
    SELECT 1 FROM enrollments e
    WHERE e.school_id = app_school_id() AND e.student_id = target_student
      AND e.starts_on <= app_school_today(e.school_id)
      AND (e.ends_on IS NULL OR e.ends_on >= app_school_today(e.school_id))
      AND app_teaches_section(e.section_id, app_school_today(e.school_id))
  )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- student_profiles
ALTER TABLE student_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_profiles_select ON student_profiles FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND (app_is_student_self(id) OR app_is_guardian_of(id) OR app_teaches_student(id)))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY student_profiles_insert ON student_profiles FOR INSERT WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY student_profiles_update ON student_profiles FOR UPDATE
  USING (app_can_manage_setup(school_id)) WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- enrollments
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY enrollments_select ON enrollments FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
    OR (school_id = app_school_id()
        AND starts_on <= app_school_today(school_id)
        AND (ends_on IS NULL OR ends_on >= app_school_today(school_id))
        AND app_teaches_section(section_id, app_school_today(school_id)))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY enrollments_insert ON enrollments FOR INSERT
  WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id));
--> statement-breakpoint
CREATE POLICY enrollments_update ON enrollments FOR UPDATE
  USING (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))
  WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- guardian_links
ALTER TABLE guardian_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY guardian_links_select ON guardian_links FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND guardian_user_id = app_user_id() AND app_has_school_role('parent'))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY guardian_links_insert ON guardian_links FOR INSERT WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY guardian_links_update ON guardian_links FOR UPDATE
  USING (app_can_manage_setup(school_id)) WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- student_documents
ALTER TABLE student_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_documents_select ON student_documents FOR SELECT
  USING (app_can_manage_setup(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY student_documents_insert ON student_documents FOR INSERT WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY student_documents_update ON student_documents FOR UPDATE
  USING (app_can_manage_setup(school_id)) WITH CHECK (app_can_manage_setup(school_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- invitations that name a child
CREATE OR REPLACE FUNCTION auth_accept_membership_invitation(candidate_hash text)
RETURNS TABLE (joined_school_id uuid, joined_role membership_role)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_user_id();
  inv record;
BEGIN
  IF me IS NULL OR NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = me AND u.status = 'active' AND NOT u.is_platform_admin
  ) THEN
    RAISE EXCEPTION 'not allowed to accept an invitation' USING ERRCODE = '42501';
  END IF;

  -- A code naming a child is valid only while that child is an active student of the school,
  -- and never for the child's own account.
  UPDATE membership_invitations i SET accepted_at = now(), accepted_by = me
  FROM schools s
  WHERE i.token_hash = candidate_hash
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    AND s.id = i.school_id AND s.status <> 'suspended'
    AND (i.student_id IS NULL OR EXISTS (
      SELECT 1 FROM student_profiles p
      WHERE p.school_id = i.school_id AND p.id = i.student_id AND p.status = 'active' AND p.user_id <> me
    ))
  RETURNING i.id, i.school_id, i.role, i.student_id, i.relationship, i.invited_by INTO inv;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO school_memberships AS m (school_id, user_id, role)
  VALUES (inv.school_id, me, inv.role)
  ON CONFLICT (school_id, user_id, role) DO UPDATE SET status = 'active';

  IF inv.student_id IS NOT NULL THEN
    INSERT INTO guardian_links (school_id, guardian_user_id, student_id, relationship, verified_by)
    VALUES (inv.school_id, me, inv.student_id, inv.relationship::guardian_relationship, inv.invited_by)
    ON CONFLICT (school_id, guardian_user_id, student_id) WHERE revoked_at IS NULL DO NOTHING;
  END IF;

  INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (inv.school_id, me, 'membership.invitation_accepted', 'membership_invitation', inv.id::text,
          jsonb_build_object('role', inv.role, 'studentId', inv.student_id));

  RETURN QUERY SELECT inv.school_id, inv.role;
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
