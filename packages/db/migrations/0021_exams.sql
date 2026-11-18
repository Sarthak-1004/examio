CREATE TYPE "public"."exam_attempt_status" AS ENUM('in_progress', 'submitted');
--> statement-breakpoint
CREATE TYPE "public"."exam_status" AS ENUM('draft', 'pending_approval', 'published', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."exam_submit_kind" AS ENUM('student', 'deadline', 'cancelled');
--> statement-breakpoint
CREATE TABLE "exam_accommodations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"extra_minutes" integer DEFAULT 0 NOT NULL,
	"extra_attempts" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_accommodations_values" CHECK ("exam_accommodations"."extra_minutes" between 0 and 240 and "exam_accommodations"."extra_attempts" between 0 and 3 and ("exam_accommodations"."extra_minutes" > 0 or "exam_accommodations"."extra_attempts" > 0)),
	CONSTRAINT "exam_accommodations_reason" CHECK (char_length("exam_accommodations"."reason") between 3 and 300)
);
--> statement-breakpoint
CREATE TABLE "exam_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"response" jsonb,
	"flagged" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_answers_revision" CHECK ("exam_answers"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exam_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "exam_attempt_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"submit_kind" "exam_submit_kind",
	"receipt" text,
	CONSTRAINT "exam_attempts_number" CHECK ("exam_attempts"."attempt_no" between 1 and 8),
	CONSTRAINT "exam_attempts_deadline" CHECK ("exam_attempts"."deadline_at" > "exam_attempts"."started_at"),
	CONSTRAINT "exam_attempts_submitted" CHECK (("exam_attempts"."status" = 'submitted') = ("exam_attempts"."submitted_at" is not null and "exam_attempts"."submit_kind" is not null and "exam_attempts"."receipt" is not null))
);
--> statement-breakpoint
CREATE TABLE "exam_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "exam_items_position" CHECK ("exam_items"."position" between 1 and 400)
);
--> statement-breakpoint
CREATE TABLE "exam_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"section_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"status" "exam_status" DEFAULT 'draft' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"attempt_limit" integer DEFAULT 1 NOT NULL,
	"negative_marking" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "exams_title_length" CHECK (char_length("exams"."title") between 1 and 150),
	CONSTRAINT "exams_instructions_length" CHECK ("exams"."instructions" is null or char_length("exams"."instructions") between 1 and 5000),
	CONSTRAINT "exams_duration" CHECK ("exams"."duration_minutes" between 5 and 600),
	CONSTRAINT "exams_attempt_limit" CHECK ("exams"."attempt_limit" between 1 and 5),
	CONSTRAINT "exams_window" CHECK ("exams"."opens_at" is null or "exams"."closes_at" is null or "exams"."closes_at" > "exams"."opens_at"),
	CONSTRAINT "exams_published" CHECK (("exams"."status" in ('published', 'cancelled')) = ("exams"."published_at" is not null and "exams"."published_by" is not null and "exams"."opens_at" is not null and "exams"."closes_at" is not null)),
	CONSTRAINT "exams_cancelled" CHECK (("exams"."status" = 'cancelled') = ("exams"."cancelled_at" is not null and "exams"."cancel_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "exam_accommodations" ADD CONSTRAINT "exam_accommodations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_accommodations" ADD CONSTRAINT "exam_accommodations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_items" ADD CONSTRAINT "exam_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_targets" ADD CONSTRAINT "exam_targets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_accommodations_unique" ON "exam_accommodations" USING btree ("school_id","exam_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_answers_one_per_item" ON "exam_answers" USING btree ("school_id","attempt_id","item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_attempts_school_id_unique" ON "exam_attempts" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_attempts_number_unique" ON "exam_attempts" USING btree ("school_id","exam_id","student_id","attempt_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_attempts_one_open" ON "exam_attempts" USING btree ("school_id","exam_id","student_id") WHERE "exam_attempts"."status" = 'in_progress';
--> statement-breakpoint
CREATE INDEX "exam_attempts_due_idx" ON "exam_attempts" USING btree ("deadline_at") WHERE "exam_attempts"."status" = 'in_progress';
--> statement-breakpoint
CREATE INDEX "exam_attempts_student_idx" ON "exam_attempts" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_items_school_id_unique" ON "exam_items" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_items_position_unique" ON "exam_items" USING btree ("school_id","exam_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_items_version_unique" ON "exam_items" USING btree ("school_id","exam_id","question_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_targets_unique" ON "exam_targets" USING btree ("school_id","exam_id","section_id");
--> statement-breakpoint
CREATE INDEX "exam_targets_section_idx" ON "exam_targets" USING btree ("school_id","section_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exams_school_id_unique" ON "exams" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "exams_school_status_idx" ON "exams" USING btree ("school_id","status","opens_at");
--> statement-breakpoint
ALTER TABLE "exam_accommodations" ADD CONSTRAINT "exam_accommodations_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_accommodations" ADD CONSTRAINT "exam_accommodations_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_attempt_fk" FOREIGN KEY ("school_id","attempt_id") REFERENCES "public"."exam_attempts"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_item_fk" FOREIGN KEY ("school_id","item_id") REFERENCES "public"."exam_items"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_items" ADD CONSTRAINT "exam_items_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_items" ADD CONSTRAINT "exam_items_version_fk" FOREIGN KEY ("school_id","question_version_id") REFERENCES "public"."question_versions"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_targets" ADD CONSTRAINT "exam_targets_exam_fk" FOREIGN KEY ("school_id","exam_id") REFERENCES "public"."exams"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_targets" ADD CONSTRAINT "exam_targets_section_fk" FOREIGN KEY ("school_id","section_id") REFERENCES "public"."sections"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 11: formal examinations.
--
-- Exams are drafted by administrators and teachers of the subject, submitted for approval and
-- published by a school administrator, which freezes questions, targets and timing (trigger
-- exams_guard). Students never write exam tables directly: exam_start allocates an attempt under
-- a lock with a deadline fixed from server time, exam_save_answer accepts a write only for the
-- owner's active attempt before its deadline and with the revision it last saw, exam_submit is
-- repeat-safe and returns the original receipt, and exam_finalize_due (worker) submits attempts
-- whose deadline has passed, so the deadline works without an open browser. Learners read
-- questions only during their own active attempt (exam_attempt_items), never answer keys.
--
-- Recovery: forward-fix. The previous files_select policy is in 0020_practice.sql.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_can_manage_exam(target_exam uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM exams e WHERE e.id = target_exam AND app_can_author_subject(e.school_id, e.subject_id))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_exam_status(target_exam uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT status::text FROM exams WHERE id = target_exam
$$;
--> statement-breakpoint

-- A published (or cancelled) exam aimed at the calling student's, or their linked child's, current section.
CREATE OR REPLACE FUNCTION app_exam_visible_to_learner(target_exam uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM exams e JOIN exam_targets t ON t.exam_id = e.id
    WHERE e.id = target_exam AND e.school_id = app_school_id() AND e.status IN ('published', 'cancelled')
      AND (app_student_in_section_now(t.section_id) OR app_guardian_child_in_section_now(t.section_id))
  )
$$;
--> statement-breakpoint

-- A question version that may go into an exam: published (locked) and of the exam's subject.
CREATE OR REPLACE FUNCTION app_exam_item_allowed(target_exam uuid, target_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM exams e JOIN question_versions v ON v.id = target_version JOIN questions q ON q.id = v.question_id
    WHERE e.id = target_exam AND e.status = 'draft' AND v.locked_at IS NOT NULL AND q.subject_id = e.subject_id AND q.school_id = e.school_id
  )
$$;
--> statement-breakpoint

-- A section that may be targeted: same academic year, and the caller administers or teaches it today.
CREATE OR REPLACE FUNCTION app_exam_target_allowed(target_exam uuid, target_section uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM exams e JOIN sections s ON s.id = target_section AND s.school_id = e.school_id AND s.academic_year_id = e.academic_year_id
    WHERE e.id = target_exam AND e.status = 'draft'
      AND (app_can_manage_setup(e.school_id) OR app_teaches_section(s.id, app_school_today(e.school_id)))
  )
$$;
--> statement-breakpoint

-- Status rules. Draft: freely edited by authors. Pending approval: frozen until sent back or
-- published. Published: only cancellation (administrator, with a reason). Cancelled: final.
CREATE OR REPLACE FUNCTION exams_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'exam_final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status <> 'cancelled'
       OR (NEW.title, NEW.instructions, NEW.opens_at, NEW.closes_at, NEW.duration_minutes, NEW.attempt_limit, NEW.negative_marking, NEW.subject_id, NEW.academic_year_id, NEW.published_by, NEW.published_at)
          IS DISTINCT FROM (OLD.title, OLD.instructions, OLD.opens_at, OLD.closes_at, OLD.duration_minutes, OLD.attempt_limit, OLD.negative_marking, OLD.subject_id, OLD.academic_year_id, OLD.published_by, OLD.published_at)
       OR NOT app_can_manage_setup(NEW.school_id) OR NEW.cancelled_by IS DISTINCT FROM app_user_id() THEN
      RAISE EXCEPTION 'exam_frozen' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'exam_not_published' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending_approval' AND NEW.status = 'pending_approval' THEN
    RAISE EXCEPTION 'exam_pending' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published' THEN
    IF NOT app_can_manage_setup(NEW.school_id) OR NEW.published_by IS DISTINCT FROM app_user_id() THEN
      RAISE EXCEPTION 'exam_publish_forbidden' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM exam_items WHERE exam_id = NEW.id) OR NOT EXISTS (SELECT 1 FROM exam_targets WHERE exam_id = NEW.id)
       OR NEW.opens_at IS NULL OR NEW.closes_at IS NULL OR NEW.closes_at <= now()
       OR NEW.duration_minutes * 60 > extract(epoch FROM NEW.closes_at - NEW.opens_at) THEN
      RAISE EXCEPTION 'exam_incomplete' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER exams_guard BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION exams_guard();
--> statement-breakpoint

-- Cancelling an exam ends every attempt in progress (kept, marked cancelled).
CREATE OR REPLACE FUNCTION exams_after_cancel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE exam_attempts SET status = 'submitted', submitted_at = least(now(), deadline_at), submit_kind = 'cancelled',
      receipt = upper(substr(md5(id::text || clock_timestamp()::text || random()::text), 1, 10))
    WHERE exam_id = NEW.id AND status = 'in_progress';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER exams_after_cancel AFTER UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION exams_after_cancel();
--> statement-breakpoint

-- Learner overview of a visible exam: number of questions and total marks (no content).
CREATE OR REPLACE FUNCTION app_exam_overview(target_exam uuid) RETURNS TABLE (item_count integer, total_marks_x100 integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int, coalesce(sum(v.marks_x100), 0)::int
  FROM exam_items i JOIN question_versions v ON v.id = i.question_version_id
  WHERE i.exam_id = target_exam AND (app_can_manage_exam(target_exam) OR app_exam_visible_to_learner(target_exam))
$$;
--> statement-breakpoint

-- Allocates an attempt (or returns the one in progress). Raises with a message key the service maps.
CREATE OR REPLACE FUNCTION exam_start(target_exam uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e exams%ROWTYPE;
  me uuid;
  open_id uuid;
  used integer;
  extra_min integer := 0;
  extra_att integer := 0;
  new_id uuid;
BEGIN
  SELECT p.id INTO me FROM student_profiles p
  WHERE p.school_id = app_school_id() AND p.user_id = app_user_id() AND p.status = 'active' AND app_has_school_role('student');
  SELECT * INTO e FROM exams WHERE id = target_exam AND school_id = app_school_id();
  IF me IS NULL OR NOT FOUND OR e.status NOT IN ('published', 'cancelled')
     OR NOT EXISTS (SELECT 1 FROM exam_targets t WHERE t.exam_id = e.id AND app_student_in_section_now(t.section_id)) THEN
    RAISE EXCEPTION 'exam_not_found' USING ERRCODE = 'P0001';
  END IF;
  -- One allocation at a time per student and exam: concurrent starts cannot exceed the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('exam-start:' || e.id::text || ':' || me::text, 0));
  SELECT id INTO open_id FROM exam_attempts WHERE exam_id = e.id AND student_id = me AND status = 'in_progress';
  IF open_id IS NOT NULL THEN
    RETURN open_id;
  END IF;
  IF e.status = 'cancelled' THEN RAISE EXCEPTION 'exam_cancelled' USING ERRCODE = 'P0001'; END IF;
  IF now() < e.opens_at THEN RAISE EXCEPTION 'exam_not_open' USING ERRCODE = 'P0001'; END IF;
  IF now() >= e.closes_at THEN RAISE EXCEPTION 'exam_closed' USING ERRCODE = 'P0001'; END IF;
  SELECT a.extra_minutes, a.extra_attempts INTO extra_min, extra_att FROM exam_accommodations a WHERE a.exam_id = e.id AND a.student_id = me;
  extra_min := coalesce(extra_min, 0);
  extra_att := coalesce(extra_att, 0);
  SELECT count(*) INTO used FROM exam_attempts WHERE exam_id = e.id AND student_id = me;
  IF used >= e.attempt_limit + extra_att THEN RAISE EXCEPTION 'exam_no_attempts_left' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO exam_attempts (school_id, exam_id, student_id, attempt_no, deadline_at)
  VALUES (e.school_id, e.id, me, used + 1,
          least(now() + make_interval(mins => e.duration_minutes + extra_min), e.closes_at + make_interval(mins => extra_min)))
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_exam_attempt_mine(target_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM exam_attempts a WHERE a.id = target_attempt AND a.school_id = app_school_id() AND app_is_student_self(a.student_id))
$$;
--> statement-breakpoint

-- The questions of the caller's own active attempt, as a learner sees them: no key, no explanation.
CREATE OR REPLACE FUNCTION exam_attempt_items(target_attempt uuid)
RETURNS TABLE (item_id uuid, "position" integer, type question_type, stem text, options jsonb, marks_x100 integer, negative_marks_x100 integer, image_file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.position, v.type, v.stem, v.options, v.marks_x100, CASE WHEN e.negative_marking THEN v.negative_marks_x100 ELSE 0 END, v.image_file_id
  FROM exam_attempts a JOIN exams e ON e.id = a.exam_id JOIN exam_items i ON i.exam_id = a.exam_id JOIN question_versions v ON v.id = i.question_version_id
  WHERE a.id = target_attempt AND a.status = 'in_progress' AND app_exam_attempt_mine(a.id)
  ORDER BY i.position
$$;
--> statement-breakpoint

-- Locks the caller's active attempt for a write; raises when it may not be written.
CREATE OR REPLACE FUNCTION exam_writable_attempt(target_attempt uuid) RETURNS exam_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  att exam_attempts%ROWTYPE;
BEGIN
  SELECT * INTO att FROM exam_attempts WHERE id = target_attempt FOR UPDATE;
  IF NOT FOUND OR att.school_id <> app_school_id() OR NOT app_is_student_self(att.student_id) THEN
    RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF att.status <> 'in_progress' THEN RAISE EXCEPTION 'attempt_submitted' USING ERRCODE = 'P0001'; END IF;
  IF now() >= att.deadline_at THEN RAISE EXCEPTION 'deadline_passed' USING ERRCODE = 'P0001'; END IF;
  RETURN att;
END
$$;
--> statement-breakpoint

-- Saves one answer if `expected_revision` is the current one (0 when nothing was saved). Returns the new revision.
CREATE OR REPLACE FUNCTION exam_save_answer(target_attempt uuid, target_item uuid, new_response jsonb, expected_revision integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  att exam_attempts%ROWTYPE;
  cur integer;
BEGIN
  att := exam_writable_attempt(target_attempt);
  IF NOT EXISTS (SELECT 1 FROM exam_items i WHERE i.id = target_item AND i.exam_id = att.exam_id) THEN
    RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF new_response IS NOT NULL AND (jsonb_typeof(new_response) <> 'object' OR length(new_response::text) > 12000) THEN
    RAISE EXCEPTION 'invalid_response' USING ERRCODE = 'P0001';
  END IF;
  SELECT revision INTO cur FROM exam_answers WHERE attempt_id = att.id AND item_id = target_item FOR UPDATE;
  IF coalesce(cur, 0) <> expected_revision THEN
    RAISE EXCEPTION 'stale_revision' USING ERRCODE = 'P0001';
  END IF;
  IF cur IS NULL THEN
    INSERT INTO exam_answers (school_id, attempt_id, item_id, response, revision) VALUES (att.school_id, att.id, target_item, new_response, 1);
    RETURN 1;
  END IF;
  UPDATE exam_answers SET response = new_response, revision = cur + 1, saved_at = now() WHERE attempt_id = att.id AND item_id = target_item;
  RETURN cur + 1;
END
$$;
--> statement-breakpoint

-- Marks a question for review (or clears it). Does not change the answer or its revision.
CREATE OR REPLACE FUNCTION exam_set_flag(target_attempt uuid, target_item uuid, flag boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  att exam_attempts%ROWTYPE;
BEGIN
  att := exam_writable_attempt(target_attempt);
  IF NOT EXISTS (SELECT 1 FROM exam_items i WHERE i.id = target_item AND i.exam_id = att.exam_id) THEN
    RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO exam_answers (school_id, attempt_id, item_id, response, flagged, revision) VALUES (att.school_id, att.id, target_item, NULL, flag, 0)
  ON CONFLICT (school_id, attempt_id, item_id) DO UPDATE SET flagged = excluded.flagged;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION exam_receipt_code(seed uuid) RETURNS text
LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  SELECT upper(substr(md5(seed::text || clock_timestamp()::text || random()::text), 1, 10))
$$;
--> statement-breakpoint

-- Submits the caller's attempt. Repeating it changes nothing and returns the original receipt.
-- After the deadline it is recorded as submitted by the deadline, at the deadline.
CREATE OR REPLACE FUNCTION exam_submit(target_attempt uuid)
RETURNS TABLE (receipt text, submitted_at timestamptz, submit_kind text, answered integer, question_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  att exam_attempts%ROWTYPE;
BEGIN
  SELECT * INTO att FROM exam_attempts a WHERE a.id = target_attempt FOR UPDATE;
  IF NOT FOUND OR att.school_id <> app_school_id() OR NOT app_is_student_self(att.student_id) THEN
    RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF att.status = 'in_progress' THEN
    UPDATE exam_attempts a SET status = 'submitted', submitted_at = least(now(), att.deadline_at),
      submit_kind = CASE WHEN now() >= att.deadline_at THEN 'deadline'::exam_submit_kind ELSE 'student'::exam_submit_kind END,
      receipt = exam_receipt_code(att.id)
    WHERE a.id = att.id;
  END IF;
  RETURN QUERY
    SELECT a.receipt, a.submitted_at, a.submit_kind::text,
           (SELECT count(*)::int FROM exam_answers x WHERE x.attempt_id = a.id AND x.response IS NOT NULL),
           (SELECT count(*)::int FROM exam_items i WHERE i.exam_id = a.exam_id)
    FROM exam_attempts a WHERE a.id = att.id;
END
$$;
--> statement-breakpoint

-- Worker: submits attempts whose deadline has passed, with the answers saved by then.
CREATE OR REPLACE FUNCTION exam_finalize_due(max_rows integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT app_is_worker() THEN RAISE EXCEPTION 'worker only' USING ERRCODE = '42501'; END IF;
  WITH due AS (
    SELECT id FROM exam_attempts WHERE status = 'in_progress' AND deadline_at <= now()
    ORDER BY deadline_at LIMIT greatest(1, least(max_rows, 5000)) FOR UPDATE SKIP LOCKED
  )
  UPDATE exam_attempts a SET status = 'submitted', submitted_at = a.deadline_at, submit_kind = 'deadline', receipt = exam_receipt_code(a.id)
  FROM due WHERE a.id = due.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint

-- Monitoring (worker and platform administrators): attempts in progress, and attempts whose
-- deadline passed more than five minutes ago without being finalised (worker not running).
CREATE OR REPLACE FUNCTION exam_stats() RETURNS TABLE (in_progress integer, overdue integer, oldest_overdue_seconds integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_is_worker() OR app_is_platform_admin()) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT count(*)::int,
           count(*) FILTER (WHERE deadline_at < now() - interval '5 minutes')::int,
           coalesce(extract(epoch FROM now() - min(deadline_at) FILTER (WHERE deadline_at < now() - interval '5 minutes')), 0)::int
    FROM exam_attempts WHERE status = 'in_progress';
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- policies
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exams_select ON exams FOR SELECT
  USING (app_can_author_subject(school_id, subject_id) OR app_exam_visible_to_learner(id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY exams_insert ON exams FOR INSERT
  WITH CHECK (app_can_author_subject(school_id, subject_id) AND created_by = app_user_id() AND status = 'draft');
--> statement-breakpoint
CREATE POLICY exams_update ON exams FOR UPDATE
  USING (app_can_author_subject(school_id, subject_id)) WITH CHECK (app_can_author_subject(school_id, subject_id));
--> statement-breakpoint
ALTER TABLE exam_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_items_select ON exam_items FOR SELECT USING (app_can_manage_exam(exam_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY exam_items_insert ON exam_items FOR INSERT
  WITH CHECK (app_can_manage_exam(exam_id) AND app_exam_item_allowed(exam_id, question_version_id));
--> statement-breakpoint
CREATE POLICY exam_items_delete ON exam_items FOR DELETE USING (app_can_manage_exam(exam_id) AND app_exam_status(exam_id) = 'draft');
--> statement-breakpoint
ALTER TABLE exam_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_targets_select ON exam_targets FOR SELECT
  USING (app_can_manage_exam(exam_id)
         OR (school_id = app_school_id() AND app_exam_status(exam_id) IN ('published', 'cancelled')
             AND (app_student_in_section_now(section_id) OR app_guardian_child_in_section_now(section_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY exam_targets_insert ON exam_targets FOR INSERT
  WITH CHECK (app_can_manage_exam(exam_id) AND app_exam_target_allowed(exam_id, section_id));
--> statement-breakpoint
CREATE POLICY exam_targets_delete ON exam_targets FOR DELETE USING (app_can_manage_exam(exam_id) AND app_exam_status(exam_id) = 'draft');
--> statement-breakpoint
ALTER TABLE exam_accommodations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_accommodations_select ON exam_accommodations FOR SELECT
  USING (app_can_manage_exam(exam_id)
         OR (school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY exam_accommodations_insert ON exam_accommodations FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id() AND app_exam_status(exam_id) <> 'cancelled');
--> statement-breakpoint
CREATE POLICY exam_accommodations_update ON exam_accommodations FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id))
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id() AND app_exam_status(exam_id) <> 'cancelled');
--> statement-breakpoint
ALTER TABLE exam_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_attempts_select ON exam_attempts FOR SELECT
  USING ((school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id) OR app_can_manage_exam(exam_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
ALTER TABLE exam_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Students read their own answers; staff of the subject read all. Parents do not read answers.
CREATE POLICY exam_answers_select ON exam_answers FOR SELECT
  USING (app_exam_attempt_mine(attempt_id)
         OR EXISTS (SELECT 1 FROM exam_attempts a WHERE a.id = attempt_id AND app_can_manage_exam(a.exam_id))
         OR app_has_support_access(school_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- files: exam images
-- A student sees an exam question's image only during their own active attempt.
CREATE OR REPLACE FUNCTION app_exam_image_visible(target_file uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM question_versions v JOIN exam_items i ON i.question_version_id = v.id
    JOIN exam_attempts a ON a.exam_id = i.exam_id AND a.status = 'in_progress' AND a.deadline_at > now()
    WHERE v.image_file_id = target_file AND a.school_id = app_school_id() AND app_is_student_self(a.student_id)
  )
$$;
--> statement-breakpoint
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
                      WHERE qv.image_file_id = files.id AND app_can_see_practice_set(pi.set_id))
           OR app_exam_image_visible(files.id)))
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
