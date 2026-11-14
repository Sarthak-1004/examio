CREATE TYPE "public"."academic_year_status" AS ENUM('planned', 'current', 'closed');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_kind" AS ENUM('holiday', 'event', 'exam');--> statement-breakpoint
CREATE TABLE "academic_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "academic_year_status" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_years_name_length" CHECK (char_length("academic_years"."name") between 1 and 40),
	CONSTRAINT "academic_years_dates" CHECK ("academic_years"."starts_on" < "academic_years"."ends_on" and "academic_years"."ends_on" <= "academic_years"."starts_on" + 731)
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_sessions_name_length" CHECK (char_length("attendance_sessions"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "calendar_event_kind" NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_title_length" CHECK (char_length("calendar_events"."title") between 1 and 120),
	CONSTRAINT "calendar_events_dates" CHECK ("calendar_events"."starts_on" <= "calendar_events"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "class_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_name_length" CHECK (char_length("classes"."name") between 1 and 40),
	CONSTRAINT "classes_sort_order_range" CHECK ("classes"."sort_order" between -1000 and 1000)
);
--> statement-breakpoint
CREATE TABLE "grading_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"label" text NOT NULL,
	"min_bp" integer NOT NULL,
	"description" text,
	CONSTRAINT "grading_bands_label_length" CHECK (char_length("grading_bands"."label") between 1 and 10),
	CONSTRAINT "grading_bands_min_range" CHECK ("grading_bands"."min_bp" between 0 and 10000),
	CONSTRAINT "grading_bands_description_length" CHECK ("grading_bands"."description" is null or char_length("grading_bands"."description") <= 100)
);
--> statement-breakpoint
CREATE TABLE "grading_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pass_bp" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_schemes_name_length" CHECK (char_length("grading_schemes"."name") between 1 and 60),
	CONSTRAINT "grading_schemes_pass_range" CHECK ("grading_schemes"."pass_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sections_name_length" CHECK (char_length("sections"."name") between 1 and 20),
	CONSTRAINT "sections_capacity_range" CHECK ("sections"."capacity" is null or "sections"."capacity" between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_name_length" CHECK (char_length("subjects"."name") between 1 and 80),
	CONSTRAINT "subjects_code_format" CHECK ("subjects"."code" ~ '^[A-Z0-9][A-Z0-9-]{1,11}$')
);
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_bands" ADD CONSTRAINT "grading_bands_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_school_id_unique" ON "academic_years" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_school_name_unique" ON "academic_years" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_one_current" ON "academic_years" USING btree ("school_id") WHERE "academic_years"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_school_id_unique" ON "attendance_sessions" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_school_name_unique" ON "attendance_sessions" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE INDEX "calendar_events_year_idx" ON "calendar_events" USING btree ("school_id","academic_year_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "class_subjects_unique" ON "class_subjects" USING btree ("school_id","academic_year_id","class_id","subject_id");--> statement-breakpoint
CREATE INDEX "class_subjects_subject_idx" ON "class_subjects" USING btree ("school_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_school_id_unique" ON "classes" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_school_name_unique" ON "classes" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "grading_bands_scheme_min_unique" ON "grading_bands" USING btree ("scheme_id","min_bp");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_bands_scheme_label_unique" ON "grading_bands" USING btree ("scheme_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "grading_schemes_school_id_unique" ON "grading_schemes" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_schemes_school_name_unique" ON "grading_schemes" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "grading_schemes_one_default" ON "grading_schemes" USING btree ("school_id") WHERE "grading_schemes"."is_default" and "grading_schemes"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sections_school_id_unique" ON "sections" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_year_class_name_unique" ON "sections" USING btree ("school_id","academic_year_id","class_id",lower("name"));--> statement-breakpoint
CREATE INDEX "sections_year_idx" ON "sections" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_school_id_unique" ON "subjects" USING btree ("school_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_school_code_unique" ON "subjects" USING btree ("school_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_school_name_unique" ON "subjects" USING btree ("school_id",lower("name"));--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_short_name_length" CHECK ("schools"."short_name" is null or char_length("schools"."short_name") between 1 and 30);--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_brand_color_format" CHECK ("schools"."brand_color" is null or "schools"."brand_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_class_fk" FOREIGN KEY ("school_id","class_id") REFERENCES "public"."classes"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subject_fk" FOREIGN KEY ("school_id","subject_id") REFERENCES "public"."subjects"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_bands" ADD CONSTRAINT "grading_bands_scheme_fk" FOREIGN KEY ("school_id","scheme_id") REFERENCES "public"."grading_schemes"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_fk" FOREIGN KEY ("school_id","class_id") REFERENCES "public"."classes"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- =====================================================================
-- Phase 3: school and academic setup.
--
-- Read: members of the school (and platform support under an open grant).
-- Write: the school's administrators only. Setup that belongs to a
-- closed academic year (sections, subject mappings, calendar) is
-- read-only until the year is reopened.
-- Deleting is allowed only for rows nothing references (foreign keys
-- are RESTRICT); referenced rows are archived instead.
--
-- Backfill: every existing school gets a "Full day" attendance session;
-- new schools get one from a trigger.
-- Recovery: forward-fix. New tables only, plus two nullable columns on
-- schools; dropping them loses only setup entered after this migration.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_can_read_school(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (target_school = app_school_id() AND app_is_member_of(target_school)) OR app_has_support_access(target_school)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_can_manage_setup(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target_school = app_school_id() AND app_has_school_role('school_admin')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_year_open(target_year uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM academic_years y WHERE y.id = target_year AND y.status <> 'closed')
$$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['academic_years', 'classes', 'subjects', 'grading_schemes', 'grading_bands', 'attendance_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_can_read_school(school_id))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_manage_setup(school_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_can_manage_setup(school_id)) WITH CHECK (app_can_manage_setup(school_id))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_can_manage_setup(school_id))', t || '_delete', t);
  END LOOP;
  -- Year-scoped setup: also requires the year to be open.
  FOREACH t IN ARRAY ARRAY['sections', 'class_subjects', 'calendar_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_can_read_school(school_id))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_can_manage_setup(school_id) AND app_year_open(academic_year_id)) WITH CHECK (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_can_manage_setup(school_id) AND app_year_open(academic_year_id))', t || '_delete', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Default attendance session for every school, now and in future.
INSERT INTO attendance_sessions (school_id, name, sort_order)
SELECT s.id, 'Full day', 0 FROM schools s
WHERE NOT EXISTS (SELECT 1 FROM attendance_sessions a WHERE a.school_id = s.id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION schools_default_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO attendance_sessions (school_id, name, sort_order) VALUES (NEW.id, 'Full day', 0);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER schools_default_setup AFTER INSERT ON schools
  FOR EACH ROW EXECUTE FUNCTION schools_default_setup();
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
