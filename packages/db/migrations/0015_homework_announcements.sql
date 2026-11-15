CREATE TYPE "public"."announcement_audience" AS ENUM('everyone', 'staff', 'students', 'parents', 'section');
--> statement-breakpoint
CREATE TYPE "public"."homework_status" AS ENUM('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" "announcement_audience" NOT NULL,
	"section_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_title_length" CHECK (char_length("announcements"."title") between 1 and 150),
	CONSTRAINT "announcements_body_length" CHECK (char_length("announcements"."body") between 1 and 5000),
	CONSTRAINT "announcements_section_audience" CHECK (("announcements"."audience" = 'section') = ("announcements"."section_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "homework" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"due_at" timestamp with time zone NOT NULL,
	"allow_late" boolean DEFAULT false NOT NULL,
	"status" "homework_status" DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homework_title_length" CHECK (char_length("homework"."title") between 1 and 150),
	CONSTRAINT "homework_instructions_length" CHECK ("homework"."instructions" is null or char_length("homework"."instructions") between 1 and 5000),
	CONSTRAINT "homework_published_at" CHECK (("homework"."status" = 'draft') = ("homework"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "homework_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"homework_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homework_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"homework_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"body" text,
	"late" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homework_submissions_body_length" CHECK ("homework_submissions"."body" is null or char_length("homework_submissions"."body") between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "submission_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"feedback" text NOT NULL,
	"returned_by" uuid NOT NULL,
	"returned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_feedback_length" CHECK (char_length("submission_feedback"."feedback") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "submission_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_files" ADD CONSTRAINT "homework_files_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_feedback" ADD CONSTRAINT "submission_feedback_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_feedback" ADD CONSTRAINT "submission_feedback_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "announcements_school_published_idx" ON "announcements" USING btree ("school_id","published_at");
--> statement-breakpoint
CREATE INDEX "announcements_section_idx" ON "announcements" USING btree ("school_id","section_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "homework_school_id_unique" ON "homework" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "homework_section_due_idx" ON "homework" USING btree ("school_id","section_id","due_at");
--> statement-breakpoint
CREATE INDEX "homework_author_idx" ON "homework" USING btree ("school_id","author_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "homework_files_file_unique" ON "homework_files" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "homework_files_homework_idx" ON "homework_files" USING btree ("school_id","homework_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "homework_submissions_school_id_unique" ON "homework_submissions" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "homework_submissions_one_per_student" ON "homework_submissions" USING btree ("school_id","homework_id","student_id");
--> statement-breakpoint
CREATE INDEX "homework_submissions_student_idx" ON "homework_submissions" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "submission_feedback_one_per_submission" ON "submission_feedback" USING btree ("submission_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "submission_files_file_unique" ON "submission_files" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "submission_files_submission_idx" ON "submission_files" USING btree ("school_id","submission_id");
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_section_fk" FOREIGN KEY ("school_id","section_id") REFERENCES "public"."sections"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_section_fk" FOREIGN KEY ("school_id","academic_year_id","section_id") REFERENCES "public"."sections"("school_id","academic_year_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_files" ADD CONSTRAINT "homework_files_homework_fk" FOREIGN KEY ("school_id","homework_id") REFERENCES "public"."homework"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_files" ADD CONSTRAINT "homework_files_file_fk" FOREIGN KEY ("school_id","file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_homework_fk" FOREIGN KEY ("school_id","homework_id") REFERENCES "public"."homework"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_feedback" ADD CONSTRAINT "submission_feedback_submission_fk" FOREIGN KEY ("school_id","submission_id") REFERENCES "public"."homework_submissions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_fk" FOREIGN KEY ("school_id","submission_id") REFERENCES "public"."homework_submissions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_file_fk" FOREIGN KEY ("school_id","file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 7: homework, submissions, feedback and announcements.
--
-- Homework: read by the school's administrators, its author, teachers of the section today and,
-- once published, the section's current students and their linked parents. Written by
-- administrators and by teachers of the section (as author) while the year is open.
-- Submissions: written only by the student themself; read by the student, their linked parents,
-- the author, teachers of the section and administrators. A submission is locked once feedback
-- is returned. Feedback is written by the author, teachers of the section or administrators.
-- Files attached to homework or submissions become readable by exactly the people who can read
-- that homework or submission (files_select is replaced below).
-- Announcements: administrators write any audience; teachers only "section" for a section they
-- teach. Recipients read published, unarchived notices addressed to them.
-- Notifications for these are queued by app_notify_audience(), set-based, with dedupe keys, so a
-- retried request never notifies anyone twice.
--
-- Recovery: forward-fix. The previous files_select policy is in 0009_files.sql.
-- =====================================================================

-- The calling student is enrolled in the section now (open enrollment that has started).
CREATE OR REPLACE FUNCTION app_student_in_section_now(target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('student') AND EXISTS (
    SELECT 1 FROM enrollments e JOIN student_profiles p ON p.id = e.student_id
    WHERE e.section_id = target_section AND e.school_id = app_school_id() AND p.user_id = app_user_id()
      AND e.ends_on IS NULL AND e.starts_on <= app_school_today(e.school_id)
  )
$$;
--> statement-breakpoint

-- The calling parent has an active link to a student enrolled in the section now.
CREATE OR REPLACE FUNCTION app_guardian_child_in_section_now(target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('parent') AND EXISTS (
    SELECT 1 FROM enrollments e JOIN guardian_links g ON g.student_id = e.student_id AND g.school_id = e.school_id
    WHERE e.section_id = target_section AND e.school_id = app_school_id() AND g.guardian_user_id = app_user_id()
      AND g.revoked_at IS NULL AND e.ends_on IS NULL AND e.starts_on <= app_school_today(e.school_id)
  )
$$;
--> statement-breakpoint

-- Staff who may manage a homework item: administrators, its author, teachers of the section today.
CREATE OR REPLACE FUNCTION app_can_review_homework(target_homework uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM homework h
    WHERE h.id = target_homework AND h.school_id = app_school_id()
      AND (app_can_manage_setup(h.school_id)
           OR (app_has_school_role('teacher') AND (h.author_user_id = app_user_id() OR app_teaches_section(h.section_id, app_school_today(h.school_id)))))
  )
$$;
--> statement-breakpoint

-- Anyone who may read a homework item.
CREATE OR REPLACE FUNCTION app_can_see_homework(target_homework uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_can_review_homework(target_homework) OR EXISTS (
    SELECT 1 FROM homework h
    WHERE h.id = target_homework AND h.school_id = app_school_id() AND h.status = 'published'
      AND (app_student_in_section_now(h.section_id) OR app_guardian_child_in_section_now(h.section_id))
  )
$$;
--> statement-breakpoint

-- Anyone who may read a submission: the student, their parents, and staff who review the homework.
CREATE OR REPLACE FUNCTION app_can_see_submission(target_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM homework_submissions s
    WHERE s.id = target_submission AND s.school_id = app_school_id()
      AND (app_is_student_self(s.student_id) OR app_is_guardian_of(s.student_id) OR app_can_review_homework(s.homework_id))
  )
$$;
--> statement-breakpoint

-- True when feedback has been returned (the submission is then locked).
CREATE OR REPLACE FUNCTION app_submission_returned(target_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM submission_feedback f WHERE f.submission_id = target_submission)
$$;
--> statement-breakpoint

-- Whether a published announcement is addressed to the calling user.
CREATE OR REPLACE FUNCTION app_announcement_for_me(target_school uuid, aud announcement_audience, target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target_school = app_school_id() AND app_is_member_of(target_school) AND CASE aud
    WHEN 'everyone' THEN true
    WHEN 'staff' THEN app_has_school_role('school_admin') OR app_has_school_role('teacher') OR app_has_school_role('finance')
    WHEN 'students' THEN app_has_school_role('student')
    WHEN 'parents' THEN app_has_school_role('parent')
    WHEN 'section' THEN app_student_in_section_now(target_section) OR app_guardian_child_in_section_now(target_section)
      OR app_teaches_section(target_section, app_school_today(target_school))
  END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- homework
ALTER TABLE homework ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY homework_select ON homework FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND (
      (app_has_school_role('teacher') AND (author_user_id = app_user_id() OR app_teaches_section(section_id, app_school_today(school_id))))
      OR (status = 'published' AND (app_student_in_section_now(section_id) OR app_guardian_child_in_section_now(section_id)))
    ))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY homework_insert ON homework FOR INSERT
  WITH CHECK (
    author_user_id = app_user_id() AND app_year_open(academic_year_id)
    AND (app_can_manage_setup(school_id)
         OR (school_id = app_school_id() AND app_has_school_role('teacher') AND app_teaches_section(section_id, app_school_today(school_id))))
  );
--> statement-breakpoint
CREATE POLICY homework_update ON homework FOR UPDATE
  USING (app_can_review_homework(id) AND app_year_open(academic_year_id))
  WITH CHECK (app_can_review_homework(id) AND app_year_open(academic_year_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- homework_files
ALTER TABLE homework_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY homework_files_select ON homework_files FOR SELECT USING (app_can_see_homework(homework_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY homework_files_insert ON homework_files FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_review_homework(homework_id));
--> statement-breakpoint
CREATE POLICY homework_files_update ON homework_files FOR UPDATE USING (app_can_review_homework(homework_id)) WITH CHECK (app_can_review_homework(homework_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- submissions
ALTER TABLE homework_submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY homework_submissions_select ON homework_submissions FOR SELECT
  USING (
    (school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id) OR app_can_review_homework(homework_id)))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY homework_submissions_insert ON homework_submissions FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_is_student_self(student_id) AND app_can_see_homework(homework_id));
--> statement-breakpoint
CREATE POLICY homework_submissions_update ON homework_submissions FOR UPDATE
  USING (school_id = app_school_id() AND app_is_student_self(student_id) AND app_can_see_homework(homework_id) AND NOT app_submission_returned(id))
  WITH CHECK (school_id = app_school_id() AND app_is_student_self(student_id) AND app_can_see_homework(homework_id));
--> statement-breakpoint

ALTER TABLE submission_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY submission_files_select ON submission_files FOR SELECT USING (app_can_see_submission(submission_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY submission_files_insert ON submission_files FOR INSERT
  WITH CHECK (school_id = app_school_id() AND NOT app_submission_returned(submission_id) AND EXISTS (
    SELECT 1 FROM homework_submissions s WHERE s.id = submission_id AND app_is_student_self(s.student_id)
  ));
--> statement-breakpoint
CREATE POLICY submission_files_update ON submission_files FOR UPDATE
  USING (NOT app_submission_returned(submission_id) AND EXISTS (SELECT 1 FROM homework_submissions s WHERE s.id = submission_id AND app_is_student_self(s.student_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM homework_submissions s WHERE s.id = submission_id AND app_is_student_self(s.student_id)));
--> statement-breakpoint

ALTER TABLE submission_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY submission_feedback_select ON submission_feedback FOR SELECT USING (app_can_see_submission(submission_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY submission_feedback_insert ON submission_feedback FOR INSERT
  WITH CHECK (school_id = app_school_id() AND returned_by = app_user_id() AND EXISTS (
    SELECT 1 FROM homework_submissions s WHERE s.id = submission_id AND app_can_review_homework(s.homework_id)
  ));
--> statement-breakpoint
CREATE POLICY submission_feedback_update ON submission_feedback FOR UPDATE
  USING (EXISTS (SELECT 1 FROM homework_submissions s WHERE s.id = submission_id AND app_can_review_homework(s.homework_id)))
  WITH CHECK (returned_by = app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------- files: module visibility
DROP POLICY files_select ON files;
--> statement-breakpoint
CREATE POLICY files_select ON files FOR SELECT
  USING (
    (school_id = app_school_id() AND app_is_member_of(school_id)
      AND (uploaded_by = app_user_id() OR app_has_school_role('school_admin')
           OR EXISTS (SELECT 1 FROM homework_files hf WHERE hf.file_id = files.id AND hf.removed_at IS NULL AND app_can_see_homework(hf.homework_id))
           OR EXISTS (SELECT 1 FROM submission_files sf WHERE sf.file_id = files.id AND sf.removed_at IS NULL AND app_can_see_submission(sf.submission_id))))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint

-- ---------------------------------------------------------------- announcements
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY announcements_select ON announcements FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR (school_id = app_school_id() AND author_user_id = app_user_id())
    OR (archived_at IS NULL AND app_announcement_for_me(school_id, audience, section_id))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY announcements_insert ON announcements FOR INSERT
  WITH CHECK (
    author_user_id = app_user_id() AND (
      app_can_manage_setup(school_id)
      OR (school_id = app_school_id() AND app_has_school_role('teacher') AND audience = 'section'
          AND app_teaches_section(section_id, app_school_today(school_id)))
    )
  );
--> statement-breakpoint
CREATE POLICY announcements_update ON announcements FOR UPDATE
  USING (app_can_manage_setup(school_id) OR (school_id = app_school_id() AND author_user_id = app_user_id()))
  WITH CHECK (app_can_manage_setup(school_id) OR (school_id = app_school_id() AND author_user_id = app_user_id()));
--> statement-breakpoint

-- ---------------------------------------------------------------- notifications for these modules
-- Queues one template for everyone a homework item, a submission or an announcement addresses,
-- after checking that the caller may notify them. kind:
--   'homework'          students of the section now and their linked parents
--   'homework_reminder' the same, only for students who have not submitted (and their parents)
--   'feedback'          the submission's student and their linked parents
--   'announcement'      the announcement's audience
-- Notifications are deduplicated per recipient and channel by dedupe_key (notification_queue).
CREATE OR REPLACE FUNCTION app_notify_audience(kind text, target uuid, template_name text, template_params jsonb, dedupe text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sch uuid := app_school_id();
  sec uuid;
  hw uuid;
  aud announcement_audience;
  stu uuid;
  recipient uuid;
  total integer := 0;
BEGIN
  IF kind IN ('homework', 'homework_reminder') THEN
    IF NOT app_can_review_homework(target) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    SELECT h.section_id INTO sec FROM homework h WHERE h.id = target;
  ELSIF kind = 'feedback' THEN
    SELECT s.homework_id, s.student_id INTO hw, stu FROM homework_submissions s WHERE s.id = target AND s.school_id = sch;
    IF hw IS NULL OR NOT app_can_review_homework(hw) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  ELSIF kind = 'announcement' THEN
    SELECT a.audience, a.section_id INTO aud, sec FROM announcements a
    WHERE a.id = target AND a.school_id = sch AND a.archived_at IS NULL
      AND (a.author_user_id = app_user_id() OR app_can_manage_setup(a.school_id));
    IF aud IS NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  ELSE
    RAISE EXCEPTION 'unknown audience kind' USING ERRCODE = '22023';
  END IF;

  FOR recipient IN
    SELECT DISTINCT r.uid FROM (
      -- students of a section now (homework, reminders, section notices)
      SELECT p.user_id AS uid, p.id AS sid FROM enrollments e JOIN student_profiles p ON p.id = e.student_id
      WHERE (kind IN ('homework', 'homework_reminder') OR (kind = 'announcement' AND aud = 'section'))
        AND e.school_id = sch AND e.section_id = sec AND e.ends_on IS NULL AND p.status = 'active'
      UNION ALL
      SELECT g.guardian_user_id, p.id FROM enrollments e JOIN student_profiles p ON p.id = e.student_id
      JOIN guardian_links g ON g.student_id = p.id AND g.revoked_at IS NULL
      WHERE (kind IN ('homework', 'homework_reminder') OR (kind = 'announcement' AND aud = 'section'))
        AND e.school_id = sch AND e.section_id = sec AND e.ends_on IS NULL AND p.status = 'active'
      UNION ALL
      -- one submission's student and parents
      SELECT p.user_id, p.id FROM student_profiles p WHERE kind = 'feedback' AND p.id = stu
      UNION ALL
      SELECT g.guardian_user_id, g.student_id FROM guardian_links g WHERE kind = 'feedback' AND g.student_id = stu AND g.revoked_at IS NULL
      UNION ALL
      -- school-wide audiences by role
      SELECT m.user_id, NULL FROM school_memberships m
      WHERE kind = 'announcement' AND aud <> 'section' AND m.school_id = sch AND m.status = 'active'
        AND (aud = 'everyone'
             OR (aud = 'staff' AND m.role IN ('school_admin', 'teacher', 'finance'))
             OR (aud = 'students' AND m.role = 'student')
             OR (aud = 'parents' AND m.role = 'parent'))
    ) r
    WHERE r.uid IS NOT NULL AND r.uid <> app_user_id()
      AND (kind <> 'homework_reminder' OR NOT EXISTS (
        SELECT 1 FROM homework_submissions s WHERE s.homework_id = target AND s.student_id = r.sid
      ))
      AND EXISTS (SELECT 1 FROM school_memberships m2 JOIN users u ON u.id = m2.user_id
                  WHERE m2.user_id = r.uid AND m2.school_id = sch AND m2.status = 'active' AND u.status = 'active')
  LOOP
    total := total + notification_queue(recipient, sch, ARRAY['in_app', 'email']::notification_channel[], template_name, template_params, dedupe);
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint

-- Delivery counts of an announcement's notifications, for administrators and the author.
CREATE OR REPLACE FUNCTION app_announcement_delivery(target uuid)
RETURNS TABLE (recipients integer, delivered integer, pending integer, failed integer, read integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(DISTINCT n.recipient_user_id)::int,
         count(*) FILTER (WHERE n.status IN ('delivered', 'sandboxed'))::int,
         count(*) FILTER (WHERE n.status = 'pending')::int,
         count(*) FILTER (WHERE n.status = 'failed')::int,
         count(*) FILTER (WHERE n.channel = 'in_app' AND n.read_at IS NOT NULL)::int
  FROM notifications n
  WHERE n.dedupe_key = 'announcement:' || target::text
    AND EXISTS (SELECT 1 FROM announcements a WHERE a.id = target AND a.school_id = app_school_id()
                AND (a.author_user_id = app_user_id() OR app_can_manage_setup(a.school_id)))
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
