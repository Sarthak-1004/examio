CREATE TYPE "public"."question_difficulty" AS ENUM('easy', 'medium', 'hard');
--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('draft', 'in_review', 'published', 'archived');
--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('single_choice', 'true_false', 'descriptive');
--> statement-breakpoint
CREATE TYPE "public"."topic_level" AS ENUM('chapter', 'topic');
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"type" "question_type" NOT NULL,
	"difficulty" "question_difficulty" DEFAULT 'medium' NOT NULL,
	"stem" text NOT NULL,
	"options" jsonb,
	"answer_key" jsonb NOT NULL,
	"explanation" text,
	"marks_x100" integer DEFAULT 100 NOT NULL,
	"negative_marks_x100" integer DEFAULT 0 NOT NULL,
	"image_file_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	CONSTRAINT "question_versions_stem_length" CHECK (char_length("question_versions"."stem") between 1 and 5000),
	CONSTRAINT "question_versions_explanation_length" CHECK ("question_versions"."explanation" is null or char_length("question_versions"."explanation") between 1 and 5000),
	CONSTRAINT "question_versions_marks" CHECK ("question_versions"."marks_x100" between 1 and 10000 and "question_versions"."negative_marks_x100" between 0 and "question_versions"."marks_x100"),
	CONSTRAINT "question_versions_options" CHECK (("question_versions"."type" = 'single_choice') = ("question_versions"."options" is not null)),
	CONSTRAINT "question_versions_descriptive_no_penalty" CHECK ("question_versions"."type" <> 'descriptive' or "question_versions"."negative_marks_x100" = 0)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"topic_id" uuid,
	"author_user_id" uuid NOT NULL,
	"status" "question_status" DEFAULT 'draft' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_revision" CHECK ("questions"."current_revision" >= 1),
	CONSTRAINT "questions_published" CHECK ("questions"."status" <> 'published' or "questions"."published_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"level" "topic_level" NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_name_length" CHECK (char_length("topics"."name") between 1 and 120),
	CONSTRAINT "topics_level_parent" CHECK (("topics"."level" = 'chapter') = ("topics"."parent_id" is null)),
	CONSTRAINT "topics_sort_order" CHECK ("topics"."sort_order" between -1000 and 1000)
);
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_school_id_unique" ON "question_versions" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_revision_unique" ON "question_versions" USING btree ("school_id","question_id","revision");
--> statement-breakpoint
CREATE INDEX "question_versions_question_idx" ON "question_versions" USING btree ("school_id","question_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "questions_school_id_unique" ON "questions" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "questions_subject_status_idx" ON "questions" USING btree ("school_id","subject_id","status");
--> statement-breakpoint
CREATE INDEX "questions_topic_idx" ON "questions" USING btree ("school_id","topic_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "topics_school_id_unique" ON "topics" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "topics_school_subject_id_unique" ON "topics" USING btree ("school_id","subject_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "topics_unique_name" ON "topics" USING btree ("school_id","subject_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));
--> statement-breakpoint
CREATE INDEX "topics_subject_idx" ON "topics" USING btree ("school_id","subject_id");
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_fk" FOREIGN KEY ("school_id","question_id") REFERENCES "public"."questions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_image_fk" FOREIGN KEY ("school_id","image_file_id") REFERENCES "public"."files"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_fk" FOREIGN KEY ("school_id","subject_id","topic_id") REFERENCES "public"."topics"("school_id","subject_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_fk" FOREIGN KEY ("school_id","subject_id","parent_id") REFERENCES "public"."topics"("school_id","subject_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
-- A question's published version must be one of its own versions.
CREATE UNIQUE INDEX "question_versions_question_id_unique" ON "question_versions" USING btree ("school_id","question_id","id");
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_published_version_fk" FOREIGN KEY ("school_id","id","published_version_id") REFERENCES "public"."question_versions"("school_id","question_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- =====================================================================
-- Phase 9: curriculum (chapters and topics) and the question bank.
--
-- Topics are readable by every member of the school and written by administrators and by
-- teachers who teach the subject. Questions, their versions and their images are readable and
-- writable only by administrators and by teachers who currently teach the subject: students and
-- parents have no access at all, so answer keys never reach a learner through the database.
-- Teachers keep questions in draft or review; publishing (and archiving) is for administrators.
-- A version can be changed only until it is locked (on publication); editing after that creates
-- a new version. Nothing is deleted.
--
-- Recovery: forward-fix. The previous files_select policy is in 0015_homework_announcements.sql.
-- =====================================================================

-- The calling teacher has an open assignment for the subject (any section) in the current school.
CREATE OR REPLACE FUNCTION app_teaches_subject_any(target_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('teacher') AND EXISTS (
    SELECT 1 FROM teacher_assignments a
    WHERE a.school_id = app_school_id() AND a.subject_id = target_subject
      AND a.staff_id = app_my_staff_id(app_school_id())
      AND a.starts_on <= app_school_today(a.school_id)
      AND (a.ends_on IS NULL OR a.ends_on >= app_school_today(a.school_id))
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_can_author_subject(target_school uuid, target_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_can_manage_setup(target_school) OR (target_school = app_school_id() AND app_teaches_subject_any(target_subject))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_can_see_question(target_question uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM questions q WHERE q.id = target_question AND app_can_author_subject(q.school_id, q.subject_id))
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- topics
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY topics_select ON topics FOR SELECT USING (app_can_read_school(school_id));
--> statement-breakpoint
CREATE POLICY topics_insert ON topics FOR INSERT WITH CHECK (app_can_author_subject(school_id, subject_id));
--> statement-breakpoint
CREATE POLICY topics_update ON topics FOR UPDATE USING (app_can_author_subject(school_id, subject_id)) WITH CHECK (app_can_author_subject(school_id, subject_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- questions
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY questions_select ON questions FOR SELECT USING (app_can_author_subject(school_id, subject_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY questions_insert ON questions FOR INSERT
  WITH CHECK (app_can_author_subject(school_id, subject_id) AND author_user_id = app_user_id() AND status IN ('draft', 'in_review') AND published_version_id IS NULL);
--> statement-breakpoint
-- Teachers move questions between draft and review; only administrators publish or archive.
CREATE POLICY questions_update ON questions FOR UPDATE
  USING (app_can_author_subject(school_id, subject_id))
  WITH CHECK (app_can_author_subject(school_id, subject_id) AND (status IN ('draft', 'in_review') OR app_can_manage_setup(school_id)));
--> statement-breakpoint

-- ---------------------------------------------------------------- versions
ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY question_versions_select ON question_versions FOR SELECT USING (app_can_see_question(question_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY question_versions_insert ON question_versions FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_see_question(question_id) AND created_by = app_user_id() AND locked_at IS NULL);
--> statement-breakpoint
CREATE POLICY question_versions_update ON question_versions FOR UPDATE
  USING (locked_at IS NULL AND app_can_see_question(question_id))
  WITH CHECK (app_can_see_question(question_id) AND (locked_at IS NULL OR app_can_manage_setup(school_id)));
--> statement-breakpoint

-- ---------------------------------------------------------------- files: question images
DROP POLICY files_select ON files;
--> statement-breakpoint
CREATE POLICY files_select ON files FOR SELECT
  USING (
    (school_id = app_school_id() AND app_is_member_of(school_id)
      AND (uploaded_by = app_user_id() OR app_has_school_role('school_admin')
           OR EXISTS (SELECT 1 FROM homework_files hf WHERE hf.file_id = files.id AND hf.removed_at IS NULL AND app_can_see_homework(hf.homework_id))
           OR EXISTS (SELECT 1 FROM submission_files sf WHERE sf.file_id = files.id AND sf.removed_at IS NULL AND app_can_see_submission(sf.submission_id))
           OR EXISTS (SELECT 1 FROM question_versions qv WHERE qv.image_file_id = files.id AND app_can_see_question(qv.question_id))))
    OR app_has_support_access(school_id)
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
