CREATE TYPE "public"."practice_attempt_status" AS ENUM('in_progress', 'submitted');
--> statement-breakpoint
CREATE TYPE "public"."practice_feedback" AS ENUM('immediate', 'after_close');
--> statement-breakpoint
CREATE TYPE "public"."practice_set_status" AS ENUM('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TABLE "practice_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score_x100" integer,
	"is_correct" boolean,
	CONSTRAINT "practice_answers_revision" CHECK ("practice_answers"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "practice_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "practice_assignments_window" CHECK ("practice_assignments"."opens_at" is null or "practice_assignments"."closes_at" is null or "practice_assignments"."closes_at" > "practice_assignments"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "practice_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "practice_attempt_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"score_x100" integer,
	"max_x100" integer,
	"correct_count" integer,
	"scored_count" integer,
	CONSTRAINT "practice_attempts_number" CHECK ("practice_attempts"."attempt_no" between 1 and 50),
	CONSTRAINT "practice_attempts_submitted" CHECK (("practice_attempts"."status" = 'submitted') = ("practice_attempts"."submitted_at" is not null and "practice_attempts"."max_x100" is not null))
);
--> statement-breakpoint
CREATE TABLE "practice_set_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "practice_set_items_position" CHECK ("practice_set_items"."position" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "practice_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"topic_id" uuid,
	"title" text NOT NULL,
	"instructions" text,
	"status" "practice_set_status" DEFAULT 'draft' NOT NULL,
	"attempt_limit" integer,
	"feedback" "practice_feedback" DEFAULT 'immediate' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "practice_sets_title_length" CHECK (char_length("practice_sets"."title") between 1 and 150),
	CONSTRAINT "practice_sets_instructions_length" CHECK ("practice_sets"."instructions" is null or char_length("practice_sets"."instructions") between 1 and 2000),
	CONSTRAINT "practice_sets_attempt_limit" CHECK ("practice_sets"."attempt_limit" is null or "practice_sets"."attempt_limit" between 1 and 50),
	CONSTRAINT "practice_sets_published" CHECK (("practice_sets"."status" = 'draft') = ("practice_sets"."published_at" is null))
);
--> statement-breakpoint
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_assignments" ADD CONSTRAINT "practice_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_assignments" ADD CONSTRAINT "practice_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_items" ADD CONSTRAINT "practice_set_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_answers_one_per_item" ON "practice_answers" USING btree ("school_id","attempt_id","item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_assignments_school_id_unique" ON "practice_assignments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_assignments_one_active" ON "practice_assignments" USING btree ("school_id","set_id","section_id") WHERE "practice_assignments"."removed_at" is null;
--> statement-breakpoint
CREATE INDEX "practice_assignments_section_idx" ON "practice_assignments" USING btree ("school_id","section_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_attempts_school_id_unique" ON "practice_attempts" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_attempts_number_unique" ON "practice_attempts" USING btree ("school_id","set_id","student_id","attempt_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_attempts_one_open" ON "practice_attempts" USING btree ("school_id","set_id","student_id") WHERE "practice_attempts"."status" = 'in_progress';
--> statement-breakpoint
CREATE INDEX "practice_attempts_student_idx" ON "practice_attempts" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_items_school_id_unique" ON "practice_set_items" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_items_school_id_set_unique" ON "practice_set_items" USING btree ("school_id","id","set_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_items_position_unique" ON "practice_set_items" USING btree ("school_id","set_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_items_version_unique" ON "practice_set_items" USING btree ("school_id","set_id","question_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_sets_school_id_unique" ON "practice_sets" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "practice_sets_subject_idx" ON "practice_sets" USING btree ("school_id","subject_id","status");
--> statement-breakpoint
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_attempt_fk" FOREIGN KEY ("school_id","attempt_id") REFERENCES "public"."practice_attempts"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_item_fk" FOREIGN KEY ("school_id","item_id") REFERENCES "public"."practice_set_items"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_assignments" ADD CONSTRAINT "practice_assignments_set_fk" FOREIGN KEY ("school_id","set_id") REFERENCES "public"."practice_sets"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_assignments" ADD CONSTRAINT "practice_assignments_section_fk" FOREIGN KEY ("school_id","section_id") REFERENCES "public"."sections"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_set_fk" FOREIGN KEY ("school_id","set_id") REFERENCES "public"."practice_sets"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_assignment_fk" FOREIGN KEY ("school_id","assignment_id") REFERENCES "public"."practice_assignments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_items" ADD CONSTRAINT "practice_set_items_set_fk" FOREIGN KEY ("school_id","set_id") REFERENCES "public"."practice_sets"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_items" ADD CONSTRAINT "practice_set_items_version_fk" FOREIGN KEY ("school_id","question_version_id") REFERENCES "public"."question_versions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_topic_fk" FOREIGN KEY ("school_id","subject_id","topic_id") REFERENCES "public"."topics"("school_id","subject_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 10: practice sets, assignments, attempts and answers.
--
-- Staff (administrators and teachers of the subject) build sets from published, locked question
-- versions; a published set's items are fixed. Sets are assigned to sections (teachers: sections
-- they teach). Students currently enrolled in an assigned section, and their linked parents, see
-- the published set. Students still never read question_versions: app_practice_items() returns
-- the learner fields only, and app_practice_feedback() returns answer keys and explanations only
-- after submission and only when the set's feedback rule allows (immediately, or after the
-- assignment closes). practice_submit() scores the attempt from the keys inside the database.
-- Practice never affects formal results.
--
-- Recovery: forward-fix. The previous files_select policy is in 0019_question_bank.sql.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_can_manage_practice_set(target_set uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM practice_sets s WHERE s.id = target_set AND app_can_author_subject(s.school_id, s.subject_id))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_question_version_locked(target_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM question_versions v WHERE v.id = target_version AND v.locked_at IS NOT NULL)
$$;
--> statement-breakpoint

-- The calling student's active assignment of a published set (through their current section).
CREATE OR REPLACE FUNCTION app_my_practice_assignment(target_set uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id FROM practice_assignments a JOIN practice_sets s ON s.id = a.set_id
  WHERE a.set_id = target_set AND a.removed_at IS NULL AND s.status = 'published' AND a.school_id = app_school_id()
    AND app_student_in_section_now(a.section_id)
  ORDER BY a.created_at DESC LIMIT 1
$$;
--> statement-breakpoint

-- True while an assignment is active and inside its window (server time).
CREATE OR REPLACE FUNCTION app_practice_assignment_open(target_assignment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_assignments a JOIN practice_sets s ON s.id = a.set_id
    WHERE a.id = target_assignment AND a.removed_at IS NULL AND s.status = 'published'
      AND (a.opens_at IS NULL OR a.opens_at <= now()) AND (a.closes_at IS NULL OR a.closes_at > now())
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_can_see_practice_set(target_set uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_can_manage_practice_set(target_set) OR EXISTS (
    SELECT 1 FROM practice_assignments a JOIN practice_sets s ON s.id = a.set_id
    WHERE a.set_id = target_set AND a.removed_at IS NULL AND s.status = 'published' AND a.school_id = app_school_id()
      AND (app_student_in_section_now(a.section_id) OR app_guardian_child_in_section_now(a.section_id))
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_can_see_practice_attempt(target_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_attempts t
    WHERE t.id = target_attempt AND t.school_id = app_school_id()
      AND (app_is_student_self(t.student_id) OR app_is_guardian_of(t.student_id) OR app_can_manage_practice_set(t.set_id))
  )
$$;
--> statement-breakpoint

-- Answers are saved only while the attempt is in progress and the assignment window is open;
-- submitting stays possible after the window closes (practice_submit), so no attempt is stuck.
CREATE OR REPLACE FUNCTION app_practice_attempt_mine_open(target_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_attempts t
    WHERE t.id = target_attempt AND t.school_id = app_school_id() AND t.status = 'in_progress' AND app_is_student_self(t.student_id)
      AND app_practice_assignment_open(t.assignment_id)
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_practice_item_in_attempt(target_attempt uuid, target_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_attempts t JOIN practice_set_items i ON i.set_id = t.set_id
    WHERE t.id = target_attempt AND i.id = target_item
  )
$$;
--> statement-breakpoint

-- The items of a set as a learner may see them: no answer key, no explanation.
CREATE OR REPLACE FUNCTION app_practice_items(target_set uuid)
RETURNS TABLE (item_id uuid, "position" integer, type question_type, stem text, options jsonb, marks_x100 integer, negative_marks_x100 integer, image_file_id uuid, topic_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.position, v.type, v.stem, v.options, v.marks_x100, v.negative_marks_x100, v.image_file_id, q.topic_id
  FROM practice_set_items i JOIN question_versions v ON v.id = i.question_version_id JOIN questions q ON q.id = v.question_id
  WHERE i.set_id = target_set AND app_can_see_practice_set(target_set)
  ORDER BY i.position
$$;
--> statement-breakpoint

-- Answer keys and explanations for a submitted attempt, when the feedback rule allows it.
CREATE OR REPLACE FUNCTION app_practice_feedback(target_attempt uuid)
RETURNS TABLE (item_id uuid, answer_key jsonb, explanation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, v.answer_key, v.explanation
  FROM practice_attempts t
  JOIN practice_sets s ON s.id = t.set_id
  JOIN practice_assignments a ON a.id = t.assignment_id
  JOIN practice_set_items i ON i.set_id = t.set_id
  JOIN question_versions v ON v.id = i.question_version_id
  WHERE t.id = target_attempt AND t.status = 'submitted' AND app_can_see_practice_attempt(t.id)
    AND (s.feedback = 'immediate' OR (a.closes_at IS NOT NULL AND a.closes_at <= now()) OR app_can_manage_practice_set(s.id))
  ORDER BY i.position
$$;
--> statement-breakpoint

-- Per-topic accuracy of a student's submitted practice, counting only attempts whose feedback has
-- been released (so a student cannot learn answers of an after-close set early). Unanswered scored
-- questions count as not correct. Readable by the student, linked parents and administrators.
CREATE OR REPLACE FUNCTION app_practice_progress(target_student uuid)
RETURNS TABLE (topic_id uuid, answered integer, correct integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.topic_id, count(*)::int, count(*) FILTER (WHERE pa.is_correct)::int
  FROM practice_attempts t
  JOIN practice_sets s ON s.id = t.set_id
  JOIN practice_assignments a ON a.id = t.assignment_id
  JOIN practice_set_items i ON i.set_id = t.set_id
  JOIN question_versions v ON v.id = i.question_version_id AND v.type <> 'descriptive'
  JOIN questions q ON q.id = v.question_id
  LEFT JOIN practice_answers pa ON pa.attempt_id = t.id AND pa.item_id = i.id
  WHERE t.student_id = target_student AND t.school_id = app_school_id() AND t.status = 'submitted'
    AND (app_is_student_self(target_student) OR app_is_guardian_of(target_student) OR app_can_manage_setup(t.school_id))
    AND (s.feedback = 'immediate' OR (a.closes_at IS NOT NULL AND a.closes_at <= now()))
  GROUP BY q.topic_id
$$;
--> statement-breakpoint

-- Submits the calling student's attempt and scores it from the answer keys. Single choice and
-- true/false: full marks when correct, minus the negative marks when wrong, nothing when blank.
-- Descriptive answers are not scored in practice. The total never goes below zero.
CREATE OR REPLACE FUNCTION practice_submit(target_attempt uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  att practice_attempts%ROWTYPE;
  total integer;
BEGIN
  SELECT * INTO att FROM practice_attempts WHERE id = target_attempt FOR UPDATE;
  IF NOT FOUND OR att.school_id <> app_school_id() OR NOT app_is_student_self(att.student_id) THEN
    RAISE EXCEPTION 'attempt not found' USING ERRCODE = '42501';
  END IF;
  IF att.status = 'submitted' THEN
    RETURN att.score_x100;
  END IF;

  UPDATE practice_answers p SET
    is_correct = CASE v.type
      WHEN 'single_choice' THEN (p.response->>'choice') = (v.answer_key->>'correct')
      WHEN 'true_false' THEN (p.response->>'value') = (v.answer_key->>'correct')
      ELSE NULL END,
    score_x100 = CASE
      WHEN v.type = 'descriptive' THEN NULL
      WHEN (v.type = 'single_choice' AND (p.response->>'choice') = (v.answer_key->>'correct'))
        OR (v.type = 'true_false' AND (p.response->>'value') = (v.answer_key->>'correct')) THEN v.marks_x100
      WHEN coalesce(p.response->>'choice', p.response->>'value') IS NULL THEN 0
      ELSE -v.negative_marks_x100 END
  FROM practice_set_items i JOIN question_versions v ON v.id = i.question_version_id
  WHERE p.attempt_id = att.id AND i.id = p.item_id;

  SELECT greatest(coalesce(sum(p.score_x100), 0), 0)::int INTO total FROM practice_answers p WHERE p.attempt_id = att.id;

  UPDATE practice_attempts t SET status = 'submitted', submitted_at = now(), score_x100 = total,
    max_x100 = (SELECT coalesce(sum(v.marks_x100), 0)::int FROM practice_set_items i JOIN question_versions v ON v.id = i.question_version_id
                WHERE i.set_id = att.set_id AND v.type <> 'descriptive'),
    scored_count = (SELECT count(*)::int FROM practice_set_items i JOIN question_versions v ON v.id = i.question_version_id
                    WHERE i.set_id = att.set_id AND v.type <> 'descriptive'),
    correct_count = (SELECT count(*)::int FROM practice_answers p WHERE p.attempt_id = att.id AND p.is_correct)
  WHERE t.id = att.id;
  RETURN total;
END
$$;
--> statement-breakpoint

-- A set only moves forward: draft -> published -> archived. Without this, an author could return a
-- published set to draft by a direct write and change questions students have already answered.
CREATE OR REPLACE FUNCTION practice_sets_status_forward() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'archived')) THEN
    RAISE EXCEPTION 'practice set status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published_at cannot change once set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER practice_sets_status_forward BEFORE UPDATE ON practice_sets FOR EACH ROW EXECUTE FUNCTION practice_sets_status_forward();
--> statement-breakpoint

-- ---------------------------------------------------------------- policies
ALTER TABLE practice_sets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The author check uses the row's own columns so INSERT ... RETURNING sees the new row.
CREATE POLICY practice_sets_select ON practice_sets FOR SELECT
  USING (app_can_author_subject(school_id, subject_id) OR app_can_see_practice_set(id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY practice_sets_insert ON practice_sets FOR INSERT
  WITH CHECK (app_can_author_subject(school_id, subject_id) AND created_by = app_user_id() AND status = 'draft');
--> statement-breakpoint
CREATE POLICY practice_sets_update ON practice_sets FOR UPDATE
  USING (app_can_author_subject(school_id, subject_id)) WITH CHECK (app_can_author_subject(school_id, subject_id));
--> statement-breakpoint
ALTER TABLE practice_set_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY practice_set_items_select ON practice_set_items FOR SELECT USING (app_can_manage_practice_set(set_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY practice_set_items_insert ON practice_set_items FOR INSERT
  WITH CHECK (app_can_manage_practice_set(set_id) AND app_question_version_locked(question_version_id)
              AND EXISTS (SELECT 1 FROM practice_sets s WHERE s.id = set_id AND s.status = 'draft'));
--> statement-breakpoint
CREATE POLICY practice_set_items_delete ON practice_set_items FOR DELETE
  USING (app_can_manage_practice_set(set_id) AND EXISTS (SELECT 1 FROM practice_sets s WHERE s.id = set_id AND s.status = 'draft'));
--> statement-breakpoint
ALTER TABLE practice_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY practice_assignments_select ON practice_assignments FOR SELECT
  USING (
    app_can_manage_practice_set(set_id)
    OR (school_id = app_school_id() AND removed_at IS NULL
        AND (app_student_in_section_now(section_id) OR app_guardian_child_in_section_now(section_id))
        AND EXISTS (SELECT 1 FROM practice_sets s WHERE s.id = set_id AND s.status = 'published'))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
CREATE POLICY practice_assignments_insert ON practice_assignments FOR INSERT
  WITH CHECK (
    app_can_manage_practice_set(set_id) AND created_by = app_user_id()
    AND EXISTS (SELECT 1 FROM practice_sets s WHERE s.id = set_id AND s.status = 'published')
    AND (app_can_manage_setup(school_id) OR app_teaches_section(section_id, app_school_today(school_id)))
  );
--> statement-breakpoint
CREATE POLICY practice_assignments_update ON practice_assignments FOR UPDATE
  USING (app_can_manage_practice_set(set_id)) WITH CHECK (app_can_manage_practice_set(set_id));
--> statement-breakpoint
ALTER TABLE practice_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY practice_attempts_select ON practice_attempts FOR SELECT
  USING ((school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id) OR app_can_manage_practice_set(set_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY practice_attempts_insert ON practice_attempts FOR INSERT
  WITH CHECK (
    school_id = app_school_id() AND app_is_student_self(student_id) AND status = 'in_progress'
    AND assignment_id = app_my_practice_assignment(set_id) AND app_practice_assignment_open(assignment_id)
    AND score_x100 IS NULL AND submitted_at IS NULL
  );
--> statement-breakpoint
ALTER TABLE practice_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY practice_answers_select ON practice_answers FOR SELECT USING (app_can_see_practice_attempt(attempt_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY practice_answers_insert ON practice_answers FOR INSERT
  WITH CHECK (app_practice_attempt_mine_open(attempt_id) AND app_practice_item_in_attempt(attempt_id, item_id) AND score_x100 IS NULL AND is_correct IS NULL);
--> statement-breakpoint
CREATE POLICY practice_answers_update ON practice_answers FOR UPDATE
  USING (app_practice_attempt_mine_open(attempt_id)) WITH CHECK (app_practice_attempt_mine_open(attempt_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- files: practice images
DROP POLICY files_select ON files;
--> statement-breakpoint
CREATE POLICY files_select ON files FOR SELECT
  USING (
    (school_id = app_school_id() AND app_is_member_of(school_id)
      AND (uploaded_by = app_user_id() OR app_has_school_role('school_admin')
           OR EXISTS (SELECT 1 FROM homework_files hf WHERE hf.file_id = files.id AND hf.removed_at IS NULL AND app_can_see_homework(hf.homework_id))
           OR EXISTS (SELECT 1 FROM submission_files sf WHERE sf.file_id = files.id AND sf.removed_at IS NULL AND app_can_see_submission(sf.submission_id))
           OR EXISTS (SELECT 1 FROM question_versions qv WHERE qv.image_file_id = files.id AND app_can_see_question(qv.question_id))
           OR EXISTS (SELECT 1 FROM practice_set_items pi JOIN question_versions qv ON qv.id = pi.question_version_id
                      WHERE qv.image_file_id = files.id AND app_can_see_practice_set(pi.set_id))))
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
