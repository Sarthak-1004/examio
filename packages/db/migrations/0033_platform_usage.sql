-- =====================================================================
-- Phase 15.2: platform usage.
--
-- platform_school_usage() returns per-school counts for platform administrators only: status,
-- plan, access state, active students and staff, attendance marks and exam attempts this month
-- (school time), stored file bytes, failed (dead) jobs, the last audit activity and unpaid
-- platform invoices. It returns counts, never records; anyone else gets an error.
--
-- Recovery: forward-fix (DROP FUNCTION platform_school_usage() to remove).
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_school_usage()
RETURNS TABLE (
  school_id uuid,
  name text,
  code text,
  status text,
  plan text,
  access text,
  active_students integer,
  active_staff integer,
  attendance_marks_month integer,
  exam_attempts_month integer,
  file_bytes bigint,
  dead_jobs integer,
  last_activity timestamptz,
  unpaid_invoices integer,
  unpaid_paise bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform administrators can see platform usage.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, s.name, s.code, s.status::text, p.name, app_school_access(s.id),
         (SELECT count(*)::int FROM student_profiles x WHERE x.school_id = s.id AND x.status = 'active'),
         (SELECT count(*)::int FROM staff_profiles x WHERE x.school_id = s.id AND x.status = 'active'),
         (SELECT count(*)::int FROM attendance_records x WHERE x.school_id = s.id
            AND x.attendance_date >= date_trunc('month', now() AT TIME ZONE s.timezone)::date),
         (SELECT count(*)::int FROM exam_attempts x WHERE x.school_id = s.id
            AND x.started_at >= date_trunc('month', now() AT TIME ZONE s.timezone) AT TIME ZONE s.timezone),
         (SELECT coalesce(sum(x.size_bytes), 0)::bigint FROM files x WHERE x.school_id = s.id AND x.deleted_at IS NULL),
         (SELECT count(*)::int FROM jobs x WHERE x.school_id = s.id AND x.status = 'dead'),
         (SELECT max(x.created_at) FROM audit_events x WHERE x.school_id = s.id),
         (SELECT count(*)::int FROM platform_invoices x WHERE x.school_id = s.id AND x.status = 'issued'),
         (SELECT coalesce(sum(x.amount_paise), 0)::bigint FROM platform_invoices x WHERE x.school_id = s.id AND x.status = 'issued')
  FROM schools s LEFT JOIN school_subscriptions sub ON sub.school_id = s.id LEFT JOIN platform_plans p ON p.id = sub.plan_id
  ORDER BY lower(s.name);
END
$$;
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
