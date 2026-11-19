CREATE TYPE "public"."payroll_component_calc" AS ENUM('fixed', 'percent_basic', 'percent_gross');
--> statement-breakpoint
CREATE TYPE "public"."payroll_component_kind" AS ENUM('earning', 'deduction');
--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'approved', 'paid');
--> statement-breakpoint
CREATE TABLE "payroll_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "payroll_component_kind" NOT NULL,
	"calc" "payroll_component_calc" NOT NULL,
	"prorate" boolean DEFAULT true NOT NULL,
	"cap_paise" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_components_values" CHECK (char_length("payroll_components"."name") between 1 and 60 and ("payroll_components"."calc" <> 'percent_gross' or "payroll_components"."kind" = 'deduction') and ("payroll_components"."cap_paise" is null or ("payroll_components"."calc" <> 'fixed' and "payroll_components"."cap_paise" between 0 and 100000000000)) and "payroll_components"."sort_order" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"prepared_by" uuid NOT NULL,
	"calculated_at" timestamp with time zone,
	"calculated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_period" CHECK (extract(day from "payroll_runs"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "payroll_slips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"salary_id" uuid NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"month_working_halves" integer NOT NULL,
	"working_halves" integer NOT NULL,
	"lop_halves" integer NOT NULL,
	"payable_halves" integer NOT NULL,
	"basic_paise" bigint NOT NULL,
	"earned_basic_paise" bigint NOT NULL,
	"gross_paise" bigint NOT NULL,
	"deductions_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_slips_values" CHECK ("payroll_slips"."month_working_halves" >= 0 and "payroll_slips"."working_halves" between 0 and "payroll_slips"."month_working_halves" and "payroll_slips"."lop_halves" >= 0 and "payroll_slips"."payable_halves" = greatest(0, "payroll_slips"."working_halves" - "payroll_slips"."lop_halves") and "payroll_slips"."gross_paise" >= "payroll_slips"."earned_basic_paise" and "payroll_slips"."net_paise" = "payroll_slips"."gross_paise" - "payroll_slips"."deductions_paise")
);
--> statement-breakpoint
CREATE TABLE "staff_salaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"basic_paise" bigint NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "staff_salaries_values" CHECK ("staff_salaries"."basic_paise" between 0 and 100000000000 and ("staff_salaries"."note" is null or char_length("staff_salaries"."note") <= 300))
);
--> statement-breakpoint
CREATE TABLE "staff_salary_lines" (
	"salary_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"school_id" uuid NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "staff_salary_lines_salary_id_component_id_pk" PRIMARY KEY("salary_id","component_id"),
	CONSTRAINT "staff_salary_lines_value" CHECK ("staff_salary_lines"."value" between 0 and 100000000000)
);
--> statement-breakpoint
ALTER TABLE "payroll_components" ADD CONSTRAINT "payroll_components_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_calculated_by_users_id_fk" FOREIGN KEY ("calculated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salaries" ADD CONSTRAINT "staff_salaries_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salaries" ADD CONSTRAINT "staff_salaries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salary_lines" ADD CONSTRAINT "staff_salary_lines_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_components_school_id_unique" ON "payroll_components" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_components_name_unique" ON "payroll_components" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_school_id_unique" ON "payroll_runs" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_one_per_month" ON "payroll_runs" USING btree ("school_id","period_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_slips_school_id_unique" ON "payroll_slips" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_slips_run_staff_unique" ON "payroll_slips" USING btree ("run_id","staff_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_salaries_school_id_unique" ON "staff_salaries" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "staff_salaries_staff_idx" ON "staff_salaries" USING btree ("staff_id","effective_from");
--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_run_fk" FOREIGN KEY ("school_id","run_id") REFERENCES "public"."payroll_runs"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_salary_fk" FOREIGN KEY ("school_id","salary_id") REFERENCES "public"."staff_salaries"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salaries" ADD CONSTRAINT "staff_salaries_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salary_lines" ADD CONSTRAINT "staff_salary_lines_salary_fk" FOREIGN KEY ("school_id","salary_id") REFERENCES "public"."staff_salaries"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_salary_lines" ADD CONSTRAINT "staff_salary_lines_component_fk" FOREIGN KEY ("school_id","component_id") REFERENCES "public"."payroll_components"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 14.3: payroll calculation.
--
-- Payroll data is readable by school administrators and finance only (no platform support
-- access: salaries are confidential). Components and salary versions are written by
-- administrators; salary versions and their lines are insert-only (no update grant). Runs are
-- created and calculated by administrators or finance; at most one run per school and month
-- (unique index payroll_runs_one_per_month). Slips can be written only while their run is a
-- draft (app_payroll_run_open). Approval and payment arrive in Phase 14.4.
--
-- Recovery: forward-fix.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_can_payroll(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target_school = app_school_id() AND app_has_school_role('school_admin', 'finance')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_payroll_run_open(target_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM payroll_runs r WHERE r.id = target_run AND r.status = 'draft')
$$;
--> statement-breakpoint

ALTER TABLE payroll_components ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_components_select ON payroll_components FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY payroll_components_insert ON payroll_components FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY payroll_components_update ON payroll_components FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE staff_salaries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_salaries_select ON staff_salaries FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY staff_salaries_insert ON staff_salaries FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id());
--> statement-breakpoint
ALTER TABLE staff_salary_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_salary_lines_select ON staff_salary_lines FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY staff_salary_lines_insert ON staff_salary_lines FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_runs_select ON payroll_runs FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY payroll_runs_insert ON payroll_runs FOR INSERT
  WITH CHECK (app_can_payroll(school_id) AND prepared_by = app_user_id() AND status = 'draft');
--> statement-breakpoint
CREATE POLICY payroll_runs_update ON payroll_runs FOR UPDATE
  USING (app_can_payroll(school_id)) WITH CHECK (app_can_payroll(school_id));
--> statement-breakpoint
ALTER TABLE payroll_slips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_slips_select ON payroll_slips FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY payroll_slips_insert ON payroll_slips FOR INSERT WITH CHECK (app_can_payroll(school_id) AND app_payroll_run_open(run_id));
--> statement-breakpoint
CREATE POLICY payroll_slips_update ON payroll_slips FOR UPDATE
  USING (app_can_payroll(school_id) AND app_payroll_run_open(run_id)) WITH CHECK (app_can_payroll(school_id) AND app_payroll_run_open(run_id));
--> statement-breakpoint

-- Payroll is prepared by finance as well as administrators: they read the staff list, the staff
-- register and leave requests (for loss of pay). Read-only, added beside the existing policies.
CREATE POLICY staff_profiles_select_payroll ON staff_profiles FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY hr_staff_attendance_select_payroll ON hr_staff_attendance FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY hr_leave_requests_select_payroll ON hr_leave_requests FOR SELECT USING (app_can_payroll(school_id));
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
