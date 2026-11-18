CREATE TYPE "public"."library_copy_status" AS ENUM('available', 'issued', 'lost', 'withdrawn');
--> statement-breakpoint
CREATE TYPE "public"."library_loan_status" AS ENUM('open', 'returned', 'lost');
--> statement-breakpoint
CREATE TABLE "library_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"accession_no" text NOT NULL,
	"shelf" text,
	"status" "library_copy_status" DEFAULT 'available' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_copies_text" CHECK ("library_copies"."accession_no" ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$' and ("library_copies"."shelf" is null or char_length("library_copies"."shelf") <= 40) and ("library_copies"."note" is null or char_length("library_copies"."note") <= 300))
);
--> statement-breakpoint
CREATE TABLE "library_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"student_id" uuid,
	"staff_id" uuid,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" date NOT NULL,
	"renewals" integer DEFAULT 0 NOT NULL,
	"status" "library_loan_status" DEFAULT 'open' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_on" date,
	"charge_adjustment_id" uuid,
	CONSTRAINT "library_loans_borrower" CHECK (("library_loans"."student_id" is null) <> ("library_loans"."staff_id" is null)),
	CONSTRAINT "library_loans_closed" CHECK (("library_loans"."status" = 'open') = ("library_loans"."closed_at" is null and "library_loans"."closed_by" is null and "library_loans"."closed_on" is null)),
	CONSTRAINT "library_loans_renewals" CHECK ("library_loans"."renewals" between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "library_settings" (
	"school_id" uuid PRIMARY KEY NOT NULL,
	"loan_days" integer DEFAULT 14 NOT NULL,
	"max_renewals" integer DEFAULT 2 NOT NULL,
	"max_loans_student" integer DEFAULT 3 NOT NULL,
	"max_loans_staff" integer DEFAULT 10 NOT NULL,
	"fine_per_day_paise" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_settings_values" CHECK ("library_settings"."loan_days" between 1 and 120 and "library_settings"."max_renewals" between 0 and 10 and "library_settings"."max_loans_student" between 1 and 20 and "library_settings"."max_loans_staff" between 1 and 50 and "library_settings"."fine_per_day_paise" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "library_titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" text,
	"publisher" text,
	"category" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "library_titles_text" CHECK (char_length("library_titles"."title") between 1 and 200 and ("library_titles"."author" is null or char_length("library_titles"."author") <= 200) and ("library_titles"."isbn" is null or "library_titles"."isbn" ~ '^[0-9X-]{10,17}$') and ("library_titles"."publisher" is null or char_length("library_titles"."publisher") <= 200) and ("library_titles"."category" is null or char_length("library_titles"."category") <= 80))
);
--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_charge_fk" FOREIGN KEY ("charge_adjustment_id") REFERENCES "public"."fee_adjustments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_settings" ADD CONSTRAINT "library_settings_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_titles" ADD CONSTRAINT "library_titles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_titles" ADD CONSTRAINT "library_titles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "library_copies_school_id_unique" ON "library_copies" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "library_copies_accession_unique" ON "library_copies" USING btree ("school_id",lower("accession_no"));
--> statement-breakpoint
CREATE INDEX "library_copies_title_idx" ON "library_copies" USING btree ("title_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "library_loans_school_id_unique" ON "library_loans" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "library_loans_one_open_per_copy" ON "library_loans" USING btree ("copy_id") WHERE "library_loans"."status" = 'open';
--> statement-breakpoint
CREATE INDEX "library_loans_student_idx" ON "library_loans" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE INDEX "library_loans_staff_idx" ON "library_loans" USING btree ("school_id","staff_id");
--> statement-breakpoint
CREATE INDEX "library_loans_due_idx" ON "library_loans" USING btree ("school_id","due_on") WHERE "library_loans"."status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX "library_titles_school_id_unique" ON "library_titles" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "library_titles_search_idx" ON "library_titles" USING btree ("school_id",lower("title"));
--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_title_fk" FOREIGN KEY ("school_id","title_id") REFERENCES "public"."library_titles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_copy_fk" FOREIGN KEY ("school_id","copy_id") REFERENCES "public"."library_copies"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 13.2: library.
--
-- School administrators run the library: catalogue (titles and copies), lending rules, issue,
-- renewal, return and loss. The catalogue and the rules are readable by the school's members;
-- a loan is readable by administrators, the borrowing student or staff member, and the
-- student's linked parents. At most one open loan per copy (unique index
-- library_loans_one_open_per_copy). Late and lost-book charges for students are ordinary fee
-- adjustment requests (Phase 8), approved by another administrator.
--
-- Recovery: forward-fix.
-- =====================================================================

ALTER TABLE library_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_settings_select ON library_settings FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY library_settings_insert ON library_settings FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY library_settings_update ON library_settings FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE library_titles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_titles_select ON library_titles FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY library_titles_insert ON library_titles FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id());
--> statement-breakpoint
CREATE POLICY library_titles_update ON library_titles FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE library_copies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_copies_select ON library_copies FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY library_copies_insert ON library_copies FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND status = 'available');
--> statement-breakpoint
CREATE POLICY library_copies_update ON library_copies FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE library_loans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_loans_select ON library_loans FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id)
           OR (student_id IS NOT NULL AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
           OR (staff_id IS NOT NULL AND staff_id = app_my_staff_id(school_id))))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY library_loans_insert ON library_loans FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND issued_by = app_user_id() AND status = 'open');
--> statement-breakpoint
CREATE POLICY library_loans_update ON library_loans FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
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
