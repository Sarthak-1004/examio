CREATE TYPE "public"."offline_assessment_status" AS ENUM('draft', 'submitted', 'locked', 'released');
--> statement-breakpoint
CREATE TYPE "public"."offline_mark_status" AS ENUM('present', 'absent', 'exempt');
--> statement-breakpoint
CREATE TYPE "public"."result_set_status" AS ENUM('grading', 'released');
--> statement-breakpoint
CREATE TABLE "exam_graders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"marks_x100" integer NOT NULL,
	"auto" boolean NOT NULL,
	"comment" text,
	"graded_by" uuid,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "exam_marks_range" CHECK ("exam_marks"."marks_x100" between -10000 and 10000),
	CONSTRAINT "exam_marks_comment" CHECK ("exam_marks"."comment" is null or char_length("exam_marks"."comment") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "exam_result_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"status" "result_set_status" DEFAULT 'grading' NOT NULL,
	"grading_scheme_id" uuid,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	CONSTRAINT "exam_result_sets_released" CHECK (("exam_result_sets"."status" = 'released') = ("exam_result_sets"."released_at" is not null and "exam_result_sets"."released_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "exam_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"attempt_id" uuid,
	"score_x100" integer,
	"max_x100" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_results_max" CHECK ("exam_results"."max_x100" > 0),
	CONSTRAINT "exam_results_score" CHECK ("exam_results"."score_x100" is null or "exam_results"."score_x100" between 0 and "exam_results"."max_x100")
);
--> statement-breakpoint
CREATE TABLE "offline_assessment_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"section_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offline_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"title" text NOT NULL,
	"held_on" date,
	"max_marks_x100" integer NOT NULL,
	"status" "offline_assessment_status" DEFAULT 'draft' NOT NULL,
	"grading_scheme_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" uuid,
	"locked_at" timestamp with time zone,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	CONSTRAINT "offline_assessments_title" CHECK (char_length("offline_assessments"."title") between 1 and 150),
	CONSTRAINT "offline_assessments_max" CHECK ("offline_assessments"."max_marks_x100" between 1 and 100000),
	CONSTRAINT "offline_assessments_locked" CHECK (("offline_assessments"."status" in ('locked', 'released')) = ("offline_assessments"."locked_at" is not null and "offline_assessments"."locked_by" is not null)),
	CONSTRAINT "offline_assessments_released" CHECK (("offline_assessments"."status" = 'released') = ("offline_assessments"."released_at" is not null and "offline_assessments"."released_by" is not null and "offline_assessments"."grading_scheme_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "offline_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"status" "offline_mark_status" NOT NULL,
	"marks_x100" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"entered_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_marks_value" CHECK (("offline_marks"."status" = 'present') = ("offline_marks"."marks_x100" is not null) and ("offline_marks"."marks_x100" is null or "offline_marks"."marks_x100" >= 0))
);
--> statement-breakpoint
CREATE TABLE "result_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"exam_id" uuid,
	"assessment_id" uuid,
	"student_id" uuid NOT NULL,
	"item_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_changes_kind" CHECK ("result_changes"."kind" in ('exam_mark', 'exam_attempt', 'offline_mark')),
	CONSTRAINT "result_changes_reason" CHECK (char_length("result_changes"."reason") between 3 and 300)
);
--> statement-breakpoint
ALTER TABLE "exam_graders" ADD CONSTRAINT "exam_graders_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_graders" ADD CONSTRAINT "exam_graders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_graders" ADD CONSTRAINT "exam_graders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_graded_by_users_id_fk" FOREIGN KEY ("graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_result_sets" ADD CONSTRAINT "exam_result_sets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_result_sets" ADD CONSTRAINT "exam_result_sets_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_result_sets" ADD CONSTRAINT "exam_result_sets_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessment_targets" ADD CONSTRAINT "offline_assessment_targets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_marks" ADD CONSTRAINT "offline_marks_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_marks" ADD CONSTRAINT "offline_marks_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_graders_unique" ON "exam_graders" USING btree ("school_id","exam_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_marks_one_per_item" ON "exam_marks" USING btree ("school_id","attempt_id","item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_result_sets_exam_unique" ON "exam_result_sets" USING btree ("school_id","exam_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_results_unique" ON "exam_results" USING btree ("school_id","exam_id","student_id");
--> statement-breakpoint
CREATE INDEX "exam_results_student_idx" ON "exam_results" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "offline_targets_unique" ON "offline_assessment_targets" USING btree ("school_id","assessment_id","section_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "offline_assessments_school_id_unique" ON "offline_assessments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "offline_assessments_year_idx" ON "offline_assessments" USING btree ("school_id","academic_year_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "offline_marks_one_per_student" ON "offline_marks" USING btree ("school_id","assessment_id","student_id");
--> statement-breakpoint
CREATE INDEX "result_changes_student_idx" ON "result_changes" USING btree ("school_id","student_id");
--> statement-breakpoint
ALTER TABLE "exam_graders" ADD CONSTRAINT "exam_graders_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_attempt_fk" FOREIGN KEY ("school_id","attempt_id") REFERENCES "public"."exam_attempts"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_item_fk" FOREIGN KEY ("school_id","item_id") REFERENCES "public"."exam_items"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_result_sets" ADD CONSTRAINT "exam_result_sets_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_result_sets" ADD CONSTRAINT "exam_result_sets_scheme_fk" FOREIGN KEY ("school_id","grading_scheme_id") REFERENCES "public"."grading_schemes"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_attempt_fk" FOREIGN KEY ("school_id","attempt_id") REFERENCES "public"."exam_attempts"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessment_targets" ADD CONSTRAINT "offline_targets_assessment_fk" FOREIGN KEY ("school_id","assessment_id") REFERENCES "public"."offline_assessments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessment_targets" ADD CONSTRAINT "offline_targets_section_fk" FOREIGN KEY ("school_id","section_id") REFERENCES "public"."sections"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_assessments" ADD CONSTRAINT "offline_assessments_scheme_fk" FOREIGN KEY ("school_id","grading_scheme_id") REFERENCES "public"."grading_schemes"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_marks" ADD CONSTRAINT "offline_marks_assessment_fk" FOREIGN KEY ("school_id","assessment_id") REFERENCES "public"."offline_assessments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_marks" ADD CONSTRAINT "offline_marks_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "offline_marks" ADD CONSTRAINT "offline_marks_section_fk" FOREIGN KEY ("school_id","section_id") REFERENCES "public"."sections"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 12: grading, offline marks and results.
--
-- Online exams: exam_start_grading (after closing) fixes which attempt counts for each student
-- (the first submitted one; an administrator may designate another, recorded) and scores single
-- choice and true/false deterministically; graders mark written answers (exam_set_mark);
-- exam_release_results refuses while any counted written answer is unmarked, then fixes the
-- totals (floored at zero). Corrections after release (exam_correct_mark) keep the earlier marks
-- in result_changes and raise the result's revision.
-- Offline assessments: marks or absent/exempt per student, saved by the subject's teacher of the
-- student's section or an administrator (offline_save_mark: bounded, one entry per student, the
-- student must be in a target section); submitted, locked by an administrator (complete register
-- required) and released; changes after locking need a reason (offline_correct_mark).
-- Students and parents read results and marks only once released; staff of the subject read them.
--
-- Recovery: forward-fix.
-- =====================================================================

-- A teacher assigned to this subject in this section today (not merely the class teacher).
CREATE OR REPLACE FUNCTION app_teaches_subject_section(target_subject uuid, target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('teacher') AND EXISTS (
    SELECT 1 FROM teacher_assignments a
    WHERE a.school_id = app_school_id() AND a.subject_id = target_subject AND a.section_id = target_section
      AND a.staff_id = app_my_staff_id(app_school_id())
      AND a.starts_on <= app_school_today(a.school_id) AND (a.ends_on IS NULL OR a.ends_on >= app_school_today(a.school_id))
  )
$$;
--> statement-breakpoint

-- Administrators, the exam's subject authors, and assigned graders.
CREATE OR REPLACE FUNCTION app_can_grade_exam(target_exam uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_can_manage_exam(target_exam) OR EXISTS (
    SELECT 1 FROM exam_graders g
    WHERE g.exam_id = target_exam AND g.user_id = app_user_id() AND g.school_id = app_school_id() AND app_has_school_role('teacher')
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_exam_results_released(target_exam uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM exam_result_sets r WHERE r.exam_id = target_exam AND r.status = 'released')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_offline_status(target_assessment uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT status::text FROM offline_assessments WHERE id = target_assessment
$$;
--> statement-breakpoint

-- Staff who may see an offline assessment: administrators and teachers of its subject.
CREATE OR REPLACE FUNCTION app_can_view_offline(target_assessment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM offline_assessments o
    WHERE o.id = target_assessment AND o.school_id = app_school_id()
      AND (app_can_manage_setup(o.school_id) OR app_teaches_subject_any(o.subject_id))
  )
$$;
--> statement-breakpoint

-- A released assessment in which the caller (or their linked child) has an entry.
CREATE OR REPLACE FUNCTION app_offline_visible_to_learner(target_assessment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM offline_assessments o JOIN offline_marks m ON m.assessment_id = o.id
    WHERE o.id = target_assessment AND o.school_id = app_school_id() AND o.status = 'released'
      AND (app_is_student_self(m.student_id) OR app_is_guardian_of(m.student_id))
  )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- online exam grading

-- Scores single choice and true/false questions of one attempt (internal; called by the functions below).
CREATE OR REPLACE FUNCTION exam_score_objective(target_attempt uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO exam_marks (school_id, attempt_id, item_id, marks_x100, auto)
  SELECT a.school_id, a.id, i.id,
    CASE
      WHEN coalesce(x.response->>'choice', x.response->>'value') IS NULL THEN 0
      WHEN (v.type = 'single_choice' AND x.response->>'choice' = v.answer_key->>'correct')
        OR (v.type = 'true_false' AND x.response->>'value' = v.answer_key->>'correct') THEN v.marks_x100
      WHEN e.negative_marking THEN -v.negative_marks_x100
      ELSE 0
    END,
    true
  FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
  JOIN exam_items i ON i.exam_id = a.exam_id JOIN question_versions v ON v.id = i.question_version_id
  LEFT JOIN exam_answers x ON x.attempt_id = a.id AND x.item_id = i.id
  WHERE a.id = target_attempt AND a.status = 'submitted' AND v.type <> 'descriptive'
  ON CONFLICT (school_id, attempt_id, item_id) DO NOTHING
$$;
--> statement-breakpoint

-- Recomputes one student's totals from the counted attempt's marks (floored at zero; absent: null).
CREATE OR REPLACE FUNCTION exam_recompute_result(target_exam uuid, target_student uuid, bump boolean) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE exam_results r SET
    score_x100 = CASE WHEN r.attempt_id IS NULL THEN NULL
                      ELSE least(r.max_x100, greatest(0, (SELECT coalesce(sum(m.marks_x100), 0) FROM exam_marks m WHERE m.attempt_id = r.attempt_id)))::int END,
    revision = CASE WHEN bump THEN r.revision + 1 ELSE r.revision END,
    updated_at = now()
  WHERE r.exam_id = target_exam AND r.student_id = target_student
$$;
--> statement-breakpoint

-- After the exam closes: fixes the counted attempts and scores the objective questions. Repeat-safe.
CREATE OR REPLACE FUNCTION exam_start_grading(target_exam uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e exams%ROWTYPE;
  total_max integer;
  r record;
  n integer;
BEGIN
  SELECT * INTO e FROM exams WHERE id = target_exam AND school_id = app_school_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_can_manage_exam(target_exam) THEN RAISE EXCEPTION 'exam_not_found' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM exam_result_sets WHERE exam_id = e.id) THEN
    SELECT count(*) INTO n FROM exam_results WHERE exam_id = e.id;
    RETURN n;
  END IF;
  IF e.status <> 'published' THEN RAISE EXCEPTION 'exam_not_gradable' USING ERRCODE = 'P0001'; END IF;
  IF now() < e.closes_at THEN RAISE EXCEPTION 'exam_still_open' USING ERRCODE = 'P0001'; END IF;
  UPDATE exam_attempts SET status = 'submitted', submitted_at = deadline_at, submit_kind = 'deadline', receipt = exam_receipt_code(id)
  WHERE exam_id = e.id AND status = 'in_progress' AND deadline_at <= now();
  IF EXISTS (SELECT 1 FROM exam_attempts WHERE exam_id = e.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'attempts_in_progress' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(v.marks_x100), 0) INTO total_max FROM exam_items i JOIN question_versions v ON v.id = i.question_version_id WHERE i.exam_id = e.id;
  INSERT INTO exam_result_sets (school_id, exam_id, status, grading_scheme_id, started_by)
  VALUES (e.school_id, e.id, 'grading', (SELECT id FROM grading_schemes WHERE school_id = e.school_id AND is_default AND archived_at IS NULL), app_user_id());
  -- Every student now in a target section, and anyone who attempted it; the first submitted attempt counts.
  INSERT INTO exam_results (school_id, exam_id, student_id, attempt_id, max_x100)
  SELECT e.school_id, e.id, s.student_id,
         (SELECT a.id FROM exam_attempts a WHERE a.exam_id = e.id AND a.student_id = s.student_id AND a.status = 'submitted' ORDER BY a.attempt_no LIMIT 1),
         total_max
  FROM (
    SELECT en.student_id FROM enrollments en JOIN exam_targets t ON t.section_id = en.section_id AND t.exam_id = e.id WHERE en.ends_on IS NULL
    UNION SELECT a.student_id FROM exam_attempts a WHERE a.exam_id = e.id
  ) s;
  FOR r IN SELECT attempt_id FROM exam_results WHERE exam_id = e.id AND attempt_id IS NOT NULL LOOP
    PERFORM exam_score_objective(r.attempt_id);
  END LOOP;
  SELECT count(*) INTO n FROM exam_results WHERE exam_id = e.id;
  RETURN n;
END
$$;
--> statement-breakpoint

-- A grader marks a written answer of a counted attempt (0..the question's marks) while grading is open.
CREATE OR REPLACE FUNCTION exam_set_mark(target_attempt uuid, target_item uuid, new_marks integer, note text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a exam_attempts%ROWTYPE;
  st text;
  v question_versions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM exam_attempts WHERE id = target_attempt AND school_id = app_school_id();
  IF NOT FOUND OR NOT app_can_grade_exam(a.exam_id) THEN RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0001'; END IF;
  SELECT status::text INTO st FROM exam_result_sets WHERE exam_id = a.exam_id;
  IF st IS NULL THEN RAISE EXCEPTION 'grading_not_started' USING ERRCODE = 'P0001'; END IF;
  IF st = 'released' THEN RAISE EXCEPTION 'results_released' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM exam_results r WHERE r.exam_id = a.exam_id AND r.attempt_id = a.id) THEN
    RAISE EXCEPTION 'attempt_not_counted' USING ERRCODE = 'P0001';
  END IF;
  SELECT v2.* INTO v FROM exam_items i JOIN question_versions v2 ON v2.id = i.question_version_id WHERE i.id = target_item AND i.exam_id = a.exam_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0001'; END IF;
  IF v.type <> 'descriptive' THEN RAISE EXCEPTION 'item_computed' USING ERRCODE = 'P0001'; END IF;
  IF new_marks IS NULL OR new_marks < 0 OR new_marks > v.marks_x100 THEN RAISE EXCEPTION 'marks_out_of_range' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO exam_marks (school_id, attempt_id, item_id, marks_x100, auto, comment, graded_by)
  VALUES (a.school_id, a.id, target_item, new_marks, false, nullif(btrim(note), ''), app_user_id())
  ON CONFLICT (school_id, attempt_id, item_id) DO UPDATE
    SET marks_x100 = excluded.marks_x100, comment = excluded.comment, graded_by = excluded.graded_by, graded_at = now(), revision = exam_marks.revision + 1;
END
$$;
--> statement-breakpoint

-- An administrator chooses which submitted attempt counts for a student (a retake), with a reason.
CREATE OR REPLACE FUNCTION exam_designate_attempt(target_exam uuid, target_student uuid, target_attempt uuid, why text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  res exam_results%ROWTYPE;
  st text;
BEGIN
  SELECT * INTO res FROM exam_results WHERE exam_id = target_exam AND student_id = target_student AND school_id = app_school_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_can_manage_setup(app_school_id()) THEN RAISE EXCEPTION 'result_not_found' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM exam_attempts WHERE id = target_attempt AND exam_id = target_exam AND student_id = target_student AND status = 'submitted') THEN
    RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF res.attempt_id = target_attempt THEN RETURN; END IF;
  IF why IS NULL OR char_length(btrim(why)) < 3 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  SELECT status::text INTO st FROM exam_result_sets WHERE exam_id = target_exam;
  PERFORM exam_score_objective(target_attempt);
  IF st = 'released' AND EXISTS (
    SELECT 1 FROM exam_items i JOIN question_versions v ON v.id = i.question_version_id
    WHERE i.exam_id = target_exam AND v.type = 'descriptive'
      AND NOT EXISTS (SELECT 1 FROM exam_marks m WHERE m.attempt_id = target_attempt AND m.item_id = i.id)
  ) THEN
    RAISE EXCEPTION 'grading_incomplete' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO result_changes (school_id, kind, exam_id, student_id, old_value, new_value, reason, changed_by)
  VALUES (res.school_id, 'exam_attempt', target_exam, target_student, jsonb_build_object('attemptId', res.attempt_id, 'score', res.score_x100),
          jsonb_build_object('attemptId', target_attempt), btrim(why), app_user_id());
  UPDATE exam_results SET attempt_id = target_attempt WHERE id = res.id;
  IF st = 'released' THEN PERFORM exam_recompute_result(target_exam, target_student, true); END IF;
END
$$;
--> statement-breakpoint

-- An administrator releases results once every counted written answer is marked.
CREATE OR REPLACE FUNCTION exam_release_results(target_exam uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rs exam_result_sets%ROWTYPE;
  scheme uuid;
  r record;
  n integer;
BEGIN
  SELECT * INTO rs FROM exam_result_sets WHERE exam_id = target_exam AND school_id = app_school_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_can_manage_setup(app_school_id()) THEN RAISE EXCEPTION 'grading_not_started' USING ERRCODE = 'P0001'; END IF;
  IF rs.status = 'released' THEN RAISE EXCEPTION 'results_released' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (
    SELECT 1 FROM exam_results res JOIN exam_items i ON i.exam_id = res.exam_id JOIN question_versions v ON v.id = i.question_version_id
    WHERE res.exam_id = target_exam AND res.attempt_id IS NOT NULL AND v.type = 'descriptive'
      AND NOT EXISTS (SELECT 1 FROM exam_marks m WHERE m.attempt_id = res.attempt_id AND m.item_id = i.id)
  ) THEN
    RAISE EXCEPTION 'grading_incomplete' USING ERRCODE = 'P0001';
  END IF;
  scheme := coalesce(rs.grading_scheme_id, (SELECT id FROM grading_schemes WHERE school_id = rs.school_id AND is_default AND archived_at IS NULL));
  IF scheme IS NULL THEN RAISE EXCEPTION 'no_grading_scheme' USING ERRCODE = 'P0001'; END IF;
  FOR r IN SELECT student_id FROM exam_results WHERE exam_id = target_exam LOOP
    PERFORM exam_recompute_result(target_exam, r.student_id, false);
  END LOOP;
  UPDATE exam_results SET revision = 1 WHERE exam_id = target_exam;
  UPDATE exam_result_sets SET status = 'released', released_by = app_user_id(), released_at = now(), grading_scheme_id = scheme WHERE id = rs.id;
  SELECT count(*) INTO n FROM exam_results WHERE exam_id = target_exam;
  RETURN n;
END
$$;
--> statement-breakpoint

-- After release: an administrator corrects one question's marks, with a reason; history kept.
CREATE OR REPLACE FUNCTION exam_correct_mark(target_attempt uuid, target_item uuid, new_marks integer, why text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a exam_attempts%ROWTYPE;
  e exams%ROWTYPE;
  v question_versions%ROWTYPE;
  old_marks integer;
BEGIN
  SELECT * INTO a FROM exam_attempts WHERE id = target_attempt AND school_id = app_school_id();
  IF NOT FOUND OR NOT app_can_manage_setup(app_school_id()) THEN RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0001'; END IF;
  IF NOT app_exam_results_released(a.exam_id) THEN RAISE EXCEPTION 'results_not_released' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM exam_results r WHERE r.exam_id = a.exam_id AND r.attempt_id = a.id) THEN RAISE EXCEPTION 'attempt_not_counted' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM exams WHERE id = a.exam_id;
  SELECT v2.* INTO v FROM exam_items i JOIN question_versions v2 ON v2.id = i.question_version_id WHERE i.id = target_item AND i.exam_id = a.exam_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0001'; END IF;
  IF new_marks IS NULL OR new_marks > v.marks_x100 OR new_marks < (CASE WHEN v.type <> 'descriptive' AND e.negative_marking THEN -v.negative_marks_x100 ELSE 0 END) THEN
    RAISE EXCEPTION 'marks_out_of_range' USING ERRCODE = 'P0001';
  END IF;
  IF why IS NULL OR char_length(btrim(why)) < 3 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  SELECT marks_x100 INTO old_marks FROM exam_marks WHERE attempt_id = a.id AND item_id = target_item FOR UPDATE;
  IF old_marks = new_marks THEN RETURN; END IF;
  INSERT INTO result_changes (school_id, kind, exam_id, student_id, item_id, old_value, new_value, reason, changed_by)
  VALUES (a.school_id, 'exam_mark', a.exam_id, a.student_id, target_item, to_jsonb(old_marks), to_jsonb(new_marks), btrim(why), app_user_id());
  INSERT INTO exam_marks (school_id, attempt_id, item_id, marks_x100, auto, graded_by)
  VALUES (a.school_id, a.id, target_item, new_marks, false, app_user_id())
  ON CONFLICT (school_id, attempt_id, item_id) DO UPDATE
    SET marks_x100 = excluded.marks_x100, auto = false, graded_by = excluded.graded_by, graded_at = now(), revision = exam_marks.revision + 1;
  PERFORM exam_recompute_result(a.exam_id, a.student_id, true);
END
$$;
--> statement-breakpoint

-- What a student sees of their counted attempt once results are released: questions, their
-- answers, marks, comments, and the answer key with explanations.
CREATE OR REPLACE FUNCTION exam_result_review(target_exam uuid, target_student uuid)
RETURNS TABLE (item_id uuid, "position" integer, type question_type, stem text, options jsonb, max_x100 integer, response jsonb, marks_x100 integer, comment text, answer_key jsonb, explanation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.position, v.type, v.stem, v.options, v.marks_x100, x.response, m.marks_x100, m.comment, v.answer_key, v.explanation
  FROM exam_results r JOIN exam_items i ON i.exam_id = r.exam_id JOIN question_versions v ON v.id = i.question_version_id
  LEFT JOIN exam_answers x ON x.attempt_id = r.attempt_id AND x.item_id = i.id
  LEFT JOIN exam_marks m ON m.attempt_id = r.attempt_id AND m.item_id = i.id
  WHERE r.exam_id = target_exam AND r.student_id = target_student AND r.school_id = app_school_id()
    AND ((app_exam_results_released(r.exam_id) AND app_is_student_self(r.student_id)) OR app_can_grade_exam(r.exam_id))
  ORDER BY i.position
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- offline assessments

-- Saves one student's entry while the assessment is a draft or submitted. Repeat-safe (one entry
-- per student). Returns the entry's revision.
CREATE OR REPLACE FUNCTION offline_save_mark(target_assessment uuid, target_student uuid, new_status text, new_marks integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o offline_assessments%ROWTYPE;
  sec uuid;
  rev integer;
BEGIN
  SELECT * INTO o FROM offline_assessments WHERE id = target_assessment AND school_id = app_school_id();
  IF NOT FOUND OR NOT app_can_view_offline(target_assessment) THEN RAISE EXCEPTION 'assessment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF o.status NOT IN ('draft', 'submitted') THEN RAISE EXCEPTION 'assessment_locked' USING ERRCODE = 'P0001'; END IF;
  SELECT en.section_id INTO sec FROM enrollments en JOIN offline_assessment_targets t ON t.section_id = en.section_id AND t.assessment_id = o.id
  WHERE en.student_id = target_student AND en.school_id = o.school_id AND en.ends_on IS NULL LIMIT 1;
  IF sec IS NULL THEN RAISE EXCEPTION 'student_not_in_assessment' USING ERRCODE = 'P0001'; END IF;
  IF NOT (app_can_manage_setup(o.school_id) OR app_teaches_subject_section(o.subject_id, sec)) THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'P0001'; END IF;
  IF new_status NOT IN ('present', 'absent', 'exempt') THEN RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001'; END IF;
  IF new_status = 'present' AND (new_marks IS NULL OR new_marks < 0 OR new_marks > o.max_marks_x100) THEN RAISE EXCEPTION 'marks_out_of_range' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO offline_marks (school_id, assessment_id, student_id, section_id, status, marks_x100, entered_by)
  VALUES (o.school_id, o.id, target_student, sec, new_status::offline_mark_status, CASE WHEN new_status = 'present' THEN new_marks END, app_user_id())
  ON CONFLICT (school_id, assessment_id, student_id) DO UPDATE
    SET status = excluded.status, marks_x100 = excluded.marks_x100, section_id = excluded.section_id, entered_by = excluded.entered_by, updated_at = now(),
        revision = CASE WHEN (offline_marks.status, offline_marks.marks_x100) IS DISTINCT FROM (excluded.status, excluded.marks_x100) THEN offline_marks.revision + 1 ELSE offline_marks.revision END
  RETURNING revision INTO rev;
  RETURN rev;
END
$$;
--> statement-breakpoint

-- After locking: an administrator changes an entry with a reason; the earlier value is kept.
CREATE OR REPLACE FUNCTION offline_correct_mark(target_assessment uuid, target_student uuid, new_status text, new_marks integer, why text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o offline_assessments%ROWTYPE;
  m offline_marks%ROWTYPE;
BEGIN
  SELECT * INTO o FROM offline_assessments WHERE id = target_assessment AND school_id = app_school_id();
  IF NOT FOUND OR NOT app_can_manage_setup(app_school_id()) THEN RAISE EXCEPTION 'assessment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF o.status NOT IN ('locked', 'released') THEN RAISE EXCEPTION 'assessment_not_locked' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO m FROM offline_marks WHERE assessment_id = o.id AND student_id = target_student FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'student_not_in_assessment' USING ERRCODE = 'P0001'; END IF;
  IF new_status NOT IN ('present', 'absent', 'exempt') THEN RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001'; END IF;
  IF new_status = 'present' AND (new_marks IS NULL OR new_marks < 0 OR new_marks > o.max_marks_x100) THEN RAISE EXCEPTION 'marks_out_of_range' USING ERRCODE = 'P0001'; END IF;
  IF why IS NULL OR char_length(btrim(why)) < 3 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  IF m.status::text = new_status AND m.marks_x100 IS NOT DISTINCT FROM (CASE WHEN new_status = 'present' THEN new_marks END) THEN RETURN m.revision; END IF;
  INSERT INTO result_changes (school_id, kind, assessment_id, student_id, old_value, new_value, reason, changed_by)
  VALUES (o.school_id, 'offline_mark', o.id, target_student, jsonb_build_object('status', m.status, 'marks', m.marks_x100),
          jsonb_build_object('status', new_status, 'marks', CASE WHEN new_status = 'present' THEN new_marks END), btrim(why), app_user_id());
  UPDATE offline_marks SET status = new_status::offline_mark_status, marks_x100 = CASE WHEN new_status = 'present' THEN new_marks END,
    entered_by = app_user_id(), updated_at = now(), revision = revision + 1
  WHERE id = m.id;
  RETURN m.revision + 1;
END
$$;
--> statement-breakpoint

-- Lifecycle: draft <-> submitted (administrators and the subject's teachers of a target section);
-- locked (administrators; every current student of the target sections has an entry); released
-- (administrators, with the school's default grading scheme).
CREATE OR REPLACE FUNCTION offline_transition(target_assessment uuid, to_status text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o offline_assessments%ROWTYPE;
  is_admin boolean := app_can_manage_setup(app_school_id());
  teaches boolean;
  scheme uuid;
BEGIN
  SELECT * INTO o FROM offline_assessments WHERE id = target_assessment AND school_id = app_school_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_can_view_offline(target_assessment) THEN RAISE EXCEPTION 'assessment_not_found' USING ERRCODE = 'P0001'; END IF;
  teaches := EXISTS (SELECT 1 FROM offline_assessment_targets t WHERE t.assessment_id = o.id AND app_teaches_subject_section(o.subject_id, t.section_id));
  IF to_status = 'submitted' AND o.status = 'draft' AND (is_admin OR teaches) THEN
    UPDATE offline_assessments SET status = 'submitted', updated_at = now() WHERE id = o.id;
  ELSIF to_status = 'draft' AND o.status = 'submitted' AND (is_admin OR teaches) THEN
    UPDATE offline_assessments SET status = 'draft', updated_at = now() WHERE id = o.id;
  ELSIF to_status = 'locked' AND o.status IN ('draft', 'submitted') AND is_admin THEN
    IF NOT EXISTS (SELECT 1 FROM offline_assessment_targets WHERE assessment_id = o.id) OR EXISTS (
      SELECT 1 FROM enrollments en JOIN offline_assessment_targets t ON t.section_id = en.section_id AND t.assessment_id = o.id
      WHERE en.ends_on IS NULL AND NOT EXISTS (SELECT 1 FROM offline_marks m WHERE m.assessment_id = o.id AND m.student_id = en.student_id)
    ) THEN
      RAISE EXCEPTION 'register_incomplete' USING ERRCODE = 'P0001';
    END IF;
    UPDATE offline_assessments SET status = 'locked', locked_by = app_user_id(), locked_at = now(), updated_at = now() WHERE id = o.id;
  ELSIF to_status = 'released' AND o.status = 'locked' AND is_admin THEN
    scheme := (SELECT id FROM grading_schemes WHERE school_id = o.school_id AND is_default AND archived_at IS NULL);
    IF scheme IS NULL THEN RAISE EXCEPTION 'no_grading_scheme' USING ERRCODE = 'P0001'; END IF;
    UPDATE offline_assessments SET status = 'released', released_by = app_user_id(), released_at = now(), grading_scheme_id = scheme, updated_at = now() WHERE id = o.id;
  ELSE
    RAISE EXCEPTION 'transition_not_allowed' USING ERRCODE = 'P0001';
  END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- policies
ALTER TABLE exam_result_sets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_result_sets_select ON exam_result_sets FOR SELECT
  USING (app_can_grade_exam(exam_id) OR app_exam_visible_to_learner(exam_id) OR app_has_support_access(school_id));
--> statement-breakpoint
ALTER TABLE exam_graders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_graders_select ON exam_graders FOR SELECT USING (app_can_grade_exam(exam_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY exam_graders_insert ON exam_graders FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_exam(exam_id) AND created_by = app_user_id());
--> statement-breakpoint
CREATE POLICY exam_graders_delete ON exam_graders FOR DELETE USING (school_id = app_school_id() AND app_can_manage_exam(exam_id));
--> statement-breakpoint
ALTER TABLE exam_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_marks_select ON exam_marks FOR SELECT
  USING (EXISTS (SELECT 1 FROM exam_attempts a WHERE a.id = attempt_id
                 AND (app_can_grade_exam(a.exam_id) OR (app_exam_results_released(a.exam_id) AND app_exam_attempt_mine(a.id))))
         OR app_has_support_access(school_id));
--> statement-breakpoint
ALTER TABLE exam_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_results_select ON exam_results FOR SELECT
  USING (app_can_grade_exam(exam_id)
         OR (school_id = app_school_id() AND app_exam_results_released(exam_id) AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
ALTER TABLE offline_assessments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offline_assessments_select ON offline_assessments FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR app_teaches_subject_any(subject_id)))
         OR app_offline_visible_to_learner(id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY offline_assessments_insert ON offline_assessments FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id() AND status = 'draft');
--> statement-breakpoint
CREATE POLICY offline_assessments_update ON offline_assessments FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id) AND status = 'draft')
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND status = 'draft');
--> statement-breakpoint
ALTER TABLE offline_assessment_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offline_targets_select ON offline_assessment_targets FOR SELECT
  USING (app_can_view_offline(assessment_id) OR app_offline_visible_to_learner(assessment_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY offline_targets_insert ON offline_assessment_targets FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND app_offline_status(assessment_id) = 'draft'
              AND EXISTS (SELECT 1 FROM sections s JOIN offline_assessments o ON o.id = assessment_id WHERE s.id = section_id AND s.academic_year_id = o.academic_year_id));
--> statement-breakpoint
CREATE POLICY offline_targets_delete ON offline_assessment_targets FOR DELETE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id) AND app_offline_status(assessment_id) = 'draft');
--> statement-breakpoint
ALTER TABLE offline_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offline_marks_select ON offline_marks FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id)
           OR EXISTS (SELECT 1 FROM offline_assessments o WHERE o.id = assessment_id AND app_teaches_subject_section(o.subject_id, section_id))))
         OR (school_id = app_school_id() AND app_offline_status(assessment_id) = 'released' AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
ALTER TABLE result_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY result_changes_select ON result_changes FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR (exam_id IS NOT NULL AND app_can_grade_exam(exam_id))))
         OR app_has_support_access(school_id));
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
