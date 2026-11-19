CREATE TYPE "public"."payroll_adjustment_status" AS ENUM('pending', 'approved', 'rejected');
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" "payroll_component_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"source_run_id" uuid,
	"status" "payroll_adjustment_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_adjustments_values" CHECK ("payroll_adjustments"."amount_paise" between 1 and 100000000000 and char_length("payroll_adjustments"."reason") between 3 and 200 and ("payroll_adjustments"."decision_note" is null or char_length("payroll_adjustments"."decision_note") <= 300)),
	CONSTRAINT "payroll_adjustments_decided" CHECK (("payroll_adjustments"."status" = 'pending') = ("payroll_adjustments"."decided_by" is null) and ("payroll_adjustments"."decided_by" is null) = ("payroll_adjustments"."decided_at" is null) and ("payroll_adjustments"."applied_run_id" is null or "payroll_adjustments"."status" = 'approved'))
);
--> statement-breakpoint
CREATE TABLE "payroll_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"slip_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"reference" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "payroll_payments_values" CHECK (char_length("payroll_payments"."reference") between 1 and 80 and ("payroll_payments"."voided_at" is null) = ("payroll_payments"."voided_by" is null) and ("payroll_payments"."voided_at" is null) = ("payroll_payments"."void_reason" is null) and ("payroll_payments"."void_reason" is null or char_length("payroll_payments"."void_reason") between 3 and 300))
);
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "approved_by" uuid;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_adjustments_school_id_unique" ON "payroll_adjustments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE INDEX "payroll_adjustments_staff_idx" ON "payroll_adjustments" USING btree ("staff_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payments_school_id_unique" ON "payroll_payments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payments_one_active_per_slip" ON "payroll_payments" USING btree ("slip_id") WHERE "payroll_payments"."voided_at" is null;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_source_fk" FOREIGN KEY ("school_id","source_run_id") REFERENCES "public"."payroll_runs"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_applied_fk" FOREIGN KEY ("school_id","applied_run_id") REFERENCES "public"."payroll_runs"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_slip_fk" FOREIGN KEY ("school_id","slip_id") REFERENCES "public"."payroll_slips"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 14.4: payroll approval, payment and corrections.
--
-- payroll_runs_guard: the month and preparer never change; a run moves only draft -> approved
-- (by a school administrator who neither prepared nor last calculated it, after calculation),
-- approved -> paid and paid -> approved (when a payment is voided); after approval it is never
-- recalculated. Slips stay writable only while the run is a draft (Phase 14.3 policies), so an
-- approved run cannot be posted twice or changed.
-- payroll_payments_guard: payments only for included slips of approved or paid runs; one active
-- payment per slip (unique index); voided with a reason, never deleted.
-- payroll_adjustments_guard: amounts, staff and reasons are fixed; pending -> approved/rejected by
-- someone other than the requester; an adjustment already paid in an approved run stays there.
--
-- Recovery: forward-fix.
-- =====================================================================

CREATE OR REPLACE FUNCTION payroll_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.period_start <> OLD.period_start OR NEW.prepared_by <> OLD.prepared_by OR NEW.school_id <> OLD.school_id THEN
    RAISE EXCEPTION 'A payroll run keeps its month and preparer.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_fixed';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.calculated_at IS DISTINCT FROM OLD.calculated_at OR NEW.calculated_by IS DISTINCT FROM OLD.calculated_by) THEN
    RAISE EXCEPTION 'An approved payroll run cannot be recalculated.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_locked';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'Approval is recorded only when approving.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_status';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF NEW.calculated_at IS NULL OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'Calculate the run before approving it.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_status';
    END IF;
    IF NEW.approved_by = NEW.prepared_by OR NEW.approved_by = NEW.calculated_by OR NOT app_has_school_role('school_admin') THEN
      RAISE EXCEPTION 'A school administrator who did not prepare or calculate the run approves it.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_approver';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status = 'approved' AND NEW.status = 'paid') OR (OLD.status = 'paid' AND NEW.status = 'approved') THEN
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'Approval cannot change.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_status';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A payroll run cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_runs_status';
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payroll_payments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.slip_id <> OLD.slip_id OR NEW.paid_on <> OLD.paid_on OR NEW.reference <> OLD.reference OR NEW.recorded_by <> OLD.recorded_by OR OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'A payment is only ever voided.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_payments_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
                 WHERE s.id = NEW.slip_id AND s.included AND r.status IN ('approved', 'paid')) THEN
    RAISE EXCEPTION 'Payments are recorded only for approved payslips.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_payments_approved';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_payments_guard BEFORE INSERT OR UPDATE ON payroll_payments FOR EACH ROW EXECUTE FUNCTION payroll_payments_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payroll_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.staff_id <> OLD.staff_id OR NEW.kind <> OLD.kind OR NEW.amount_paise <> OLD.amount_paise OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id THEN
    RAISE EXCEPTION 'An adjustment keeps its amount and reason.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_adjustments_fixed';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')) THEN
      RAISE EXCEPTION 'An adjustment cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_adjustments_status';
    END IF;
    IF NEW.decided_by = OLD.requested_by THEN
      RAISE EXCEPTION 'Another person decides an adjustment.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_adjustments_decider';
    END IF;
  END IF;
  IF NEW.applied_run_id IS DISTINCT FROM OLD.applied_run_id THEN
    IF OLD.applied_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payroll_runs WHERE id = OLD.applied_run_id AND status = 'draft') THEN
      RAISE EXCEPTION 'An adjustment paid in an approved run stays there.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_adjustments_applied';
    END IF;
    IF NEW.applied_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payroll_runs WHERE id = NEW.applied_run_id AND status = 'draft') THEN
      RAISE EXCEPTION 'Adjustments go only into draft runs.' USING ERRCODE = 'check_violation', CONSTRAINT = 'payroll_adjustments_applied';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_adjustments_guard BEFORE UPDATE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_adjustments_guard();
--> statement-breakpoint

ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_payments_select ON payroll_payments FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY payroll_payments_insert ON payroll_payments FOR INSERT
  WITH CHECK (app_can_payroll(school_id) AND recorded_by = app_user_id() AND voided_at IS NULL);
--> statement-breakpoint
CREATE POLICY payroll_payments_update ON payroll_payments FOR UPDATE
  USING (app_can_payroll(school_id) AND voided_at IS NULL) WITH CHECK (app_can_payroll(school_id) AND voided_by = app_user_id());
--> statement-breakpoint
ALTER TABLE payroll_adjustments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_adjustments_select ON payroll_adjustments FOR SELECT USING (app_can_payroll(school_id));
--> statement-breakpoint
CREATE POLICY payroll_adjustments_insert ON payroll_adjustments FOR INSERT
  WITH CHECK (app_can_payroll(school_id) AND requested_by = app_user_id() AND status = 'pending' AND applied_run_id IS NULL);
--> statement-breakpoint
CREATE POLICY payroll_adjustments_update ON payroll_adjustments FOR UPDATE
  USING (app_can_payroll(school_id)) WITH CHECK (app_can_payroll(school_id));
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
