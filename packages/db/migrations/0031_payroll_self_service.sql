-- =====================================================================
-- Phase 14.5: staff self-service for payroll.
--
-- A staff member reads only their own payslips, and only from approved or paid runs (never a
-- draft, never a colleague's), the runs those payslips belong to, the payments of those payslips
-- and their own salary payment details. All read-only; added beside the existing policies.
--
-- Recovery: forward-fix (drop the four policies and two functions to undo).
-- =====================================================================

CREATE OR REPLACE FUNCTION app_my_released_slip(target_slip uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
    WHERE s.id = target_slip AND s.included AND r.status <> 'draft'
      AND s.school_id = app_school_id() AND s.staff_id = app_my_staff_id(s.school_id)
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_my_released_run(target_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
    WHERE r.id = target_run AND s.included AND r.status <> 'draft'
      AND s.school_id = app_school_id() AND s.staff_id = app_my_staff_id(s.school_id)
  )
$$;
--> statement-breakpoint
CREATE POLICY payroll_slips_select_self ON payroll_slips FOR SELECT USING (app_my_released_slip(id));
--> statement-breakpoint
CREATE POLICY payroll_runs_select_self ON payroll_runs FOR SELECT USING (app_my_released_run(id));
--> statement-breakpoint
CREATE POLICY payroll_payments_select_self ON payroll_payments FOR SELECT USING (app_my_released_slip(slip_id));
--> statement-breakpoint
CREATE POLICY hr_payment_details_select_self ON hr_payment_details FOR SELECT
  USING (school_id = app_school_id() AND staff_id = app_my_staff_id(school_id));
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
