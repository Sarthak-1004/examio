CREATE TYPE "public"."platform_invoice_status" AS ENUM('issued', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "platform_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"note" text,
	"status" "platform_invoice_status" DEFAULT 'issued' NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_on" date,
	"payment_reference" text,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone,
	"cancelled_reason" text,
	CONSTRAINT "platform_invoices_values" CHECK ("platform_invoices"."period_to" >= "platform_invoices"."period_from" and "platform_invoices"."amount_paise" between 1 and 100000000000 and ("platform_invoices"."note" is null or char_length("platform_invoices"."note") <= 300)),
	CONSTRAINT "platform_invoices_state" CHECK (("platform_invoices"."status" = 'paid') = ("platform_invoices"."paid_on" is not null) and ("platform_invoices"."paid_on" is null) = ("platform_invoices"."payment_reference" is null) and ("platform_invoices"."paid_on" is null) = ("platform_invoices"."recorded_by" is null) and ("platform_invoices"."status" = 'cancelled') = ("platform_invoices"."cancelled_reason" is not null) and ("platform_invoices"."payment_reference" is null or char_length("platform_invoices"."payment_reference") between 1 and 80) and ("platform_invoices"."cancelled_reason" is null or char_length("platform_invoices"."cancelled_reason") between 3 and 300))
);
--> statement-breakpoint
CREATE TABLE "platform_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"modules" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_students" integer,
	"price_paise" bigint,
	"period_months" integer DEFAULT 12 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_plans_values" CHECK ("platform_plans"."code" ~ '^[a-z0-9][a-z0-9-]{1,19}$' and char_length("platform_plans"."name") between 1 and 80 and "platform_plans"."modules" <@ array['exams','practice','fees','admissions','library','inventory','transport','hr','payroll']::text[] and ("platform_plans"."max_students" is null or "platform_plans"."max_students" between 1 and 100000) and ("platform_plans"."price_paise" is null or "platform_plans"."price_paise" between 0 and 100000000000) and "platform_plans"."period_months" between 1 and 36)
);
--> statement-breakpoint
CREATE TABLE "school_subscriptions" (
	"school_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"modules_added" text[] DEFAULT '{}'::text[] NOT NULL,
	"modules_removed" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_students_override" integer,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_subscriptions_values" CHECK ("school_subscriptions"."ends_on" >= "school_subscriptions"."starts_on" and "school_subscriptions"."modules_added" <@ array['exams','practice','fees','admissions','library','inventory','transport','hr','payroll']::text[] and "school_subscriptions"."modules_removed" <@ array['exams','practice','fees','admissions','library','inventory','transport','hr','payroll']::text[] and not ("school_subscriptions"."modules_added" && "school_subscriptions"."modules_removed") and ("school_subscriptions"."max_students_override" is null or "school_subscriptions"."max_students_override" between 1 and 100000))
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"reason" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "subscription_events_values" CHECK ("subscription_events"."kind" in ('assigned', 'changed', 'overridden', 'renewed') and ("subscription_events"."reason" is null or char_length("subscription_events"."reason") between 3 and 300))
);
--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_subscriptions" ADD CONSTRAINT "school_subscriptions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_subscriptions" ADD CONSTRAINT "school_subscriptions_plan_id_platform_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."platform_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_subscriptions" ADD CONSTRAINT "school_subscriptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_number_unique" ON "platform_invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "platform_invoices_school_idx" ON "platform_invoices" USING btree ("school_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_plans_code_unique" ON "platform_plans" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "school_subscriptions_plan_idx" ON "school_subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "subscription_events_school_idx" ON "subscription_events" USING btree ("school_id","at");
--> statement-breakpoint

-- =====================================================================
-- Phase 15.1: subscriptions, entitlements and platform billing.
--
-- app_school_access(school): 'active', 'due' (14 days before the end date), 'grace' (15 days
-- after it) or 'read_only', in the school's time zone; a school without a subscription is
-- 'active' with every module. app_school_modules(school): the plan's modules plus additions
-- minus removals. app_school_student_cap(school): the override or the plan's cap (NULL = none).
--
-- Read-only: school services set app.school_read_only = 'on' for a read-only school (except to
-- finish a started exam); trigger app_read_only_guard on every table with a school_id refuses
-- writes then (SQLSTATE 25006). Audit, jobs, notifications, sessions, rate limits and
-- idempotency records are exempt so reads, exports and sign-in keep working. Nothing is deleted.
-- school_student_cap_guard refuses an active student beyond the cap, serialised per school.
--
-- Recovery: forward-fix. To lift enforcement in an emergency, extend the subscription's end date
-- (platform administrator) rather than dropping triggers.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_school_access(target_school uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN sub.school_id IS NULL THEN 'active'
    WHEN (now() AT TIME ZONE sc.timezone)::date > sub.ends_on + 15 THEN 'read_only'
    WHEN (now() AT TIME ZONE sc.timezone)::date > sub.ends_on THEN 'grace'
    WHEN (now() AT TIME ZONE sc.timezone)::date >= sub.ends_on - 14 THEN 'due'
    ELSE 'active'
  END
  FROM schools sc LEFT JOIN school_subscriptions sub ON sub.school_id = sc.id
  WHERE sc.id = target_school
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_school_modules(target_school uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN sub.school_id IS NULL THEN array['admissions','exams','fees','hr','inventory','library','payroll','practice','transport']::text[]
    ELSE array(SELECT m FROM unnest(p.modules || sub.modules_added) m WHERE NOT (m = ANY(sub.modules_removed)) GROUP BY m ORDER BY m)
  END
  FROM schools sc LEFT JOIN school_subscriptions sub ON sub.school_id = sc.id LEFT JOIN platform_plans p ON p.id = sub.plan_id
  WHERE sc.id = target_school
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_school_student_cap(target_school uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sub.max_students_override, p.max_students)
  FROM school_subscriptions sub JOIN platform_plans p ON p.id = sub.plan_id WHERE sub.school_id = target_school
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_school_active_students(target_school uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- A count only (for plans and caps): platform administrators cannot otherwise read student records.
  SELECT count(*)::int FROM student_profiles WHERE school_id = target_school AND status = 'active'
    AND (app_is_platform_admin() OR app_can_read_school(target_school))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_read_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('app.school_read_only', true) = 'on' THEN
    RAISE EXCEPTION 'The school is read-only: its subscription has ended.' USING ERRCODE = '25006';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'school_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('audit_events', 'jobs', 'notifications', 'idempotency_records', 'sessions', 'rate_limit_buckets', 'worker_heartbeats',
                               'school_subscriptions', 'subscription_events', 'platform_invoices', 'support_access_grants')
  LOOP
    EXECUTE format('CREATE TRIGGER app_read_only_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_read_only_guard()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION school_student_cap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cap integer;
  active integer;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
    RETURN NEW;
  END IF;
  cap := app_school_student_cap(NEW.school_id);
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('school_student_cap:' || NEW.school_id::text));
  SELECT count(*) INTO active FROM student_profiles WHERE school_id = NEW.school_id AND status = 'active' AND id <> NEW.id;
  IF active >= cap THEN
    RAISE EXCEPTION 'The school''s plan allows % active students.', cap USING ERRCODE = 'check_violation', CONSTRAINT = 'school_student_cap';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER school_student_cap_guard BEFORE INSERT OR UPDATE OF status ON student_profiles FOR EACH ROW EXECUTE FUNCTION school_student_cap_guard();
--> statement-breakpoint

ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_plans_select ON platform_plans FOR SELECT USING (app_user_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY platform_plans_insert ON platform_plans FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY platform_plans_update ON platform_plans FOR UPDATE USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE school_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY school_subscriptions_select ON school_subscriptions FOR SELECT USING (app_is_platform_admin() OR app_can_read_school(school_id));
--> statement-breakpoint
CREATE POLICY school_subscriptions_insert ON school_subscriptions FOR INSERT WITH CHECK (app_is_platform_admin() AND updated_by = app_user_id());
--> statement-breakpoint
CREATE POLICY school_subscriptions_update ON school_subscriptions FOR UPDATE USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin() AND updated_by = app_user_id());
--> statement-breakpoint
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscription_events_select ON subscription_events FOR SELECT USING (app_is_platform_admin() OR app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY subscription_events_insert ON subscription_events FOR INSERT WITH CHECK (app_is_platform_admin() AND actor_user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_invoices_select ON platform_invoices FOR SELECT USING (app_is_platform_admin() OR app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY platform_invoices_insert ON platform_invoices FOR INSERT WITH CHECK (app_is_platform_admin() AND issued_by = app_user_id() AND status = 'issued');
--> statement-breakpoint
CREATE POLICY platform_invoices_update ON platform_invoices FOR UPDATE USING (app_is_platform_admin() AND status = 'issued') WITH CHECK (app_is_platform_admin());
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
