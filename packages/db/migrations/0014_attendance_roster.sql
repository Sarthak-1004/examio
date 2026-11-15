-- =====================================================================
-- Phase 6: the attendance register's student list for a section and date.
--
-- A teacher may take a register for a past date within the school's edit window, but the
-- Phase 5 policies show a teacher only the students of sections they teach *today*. This
-- function returns exactly the students enrolled in the section on the given date (excluding
-- enrollments undone as corrections), and only to the school's administrators or to a teacher
-- who teaches that section on that date. It exposes name, admission number and roll number only.
--
-- Recovery: forward-fix (DROP FUNCTION app_attendance_roster).
-- =====================================================================

CREATE OR REPLACE FUNCTION app_attendance_roster(target_section uuid, on_date date)
RETURNS TABLE (enrollment_id uuid, student_id uuid, display_name text, admission_no text, roll_no integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, p.id, p.display_name, p.admission_no, e.roll_no
  FROM enrollments e
  JOIN student_profiles p ON p.id = e.student_id
  WHERE e.section_id = target_section
    AND e.school_id = app_school_id()
    AND e.starts_on <= on_date
    AND (e.ends_on IS NULL OR e.ends_on >= on_date)
    AND (e.end_reason IS NULL OR e.end_reason <> 'corrected')
    AND (app_can_manage_setup(e.school_id) OR app_teaches_section(target_section, on_date))
  ORDER BY e.roll_no NULLS LAST, lower(p.display_name), p.id
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
