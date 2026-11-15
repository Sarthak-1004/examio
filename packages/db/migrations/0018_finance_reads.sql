-- =====================================================================
-- Phase 8: what finance staff may read outside the fee tables.
--
-- Billing needs a student's name, admission number and current class (to issue invoices to a
-- class), and the student's linked parents (to send overdue reminders). Finance staff therefore
-- read student records, enrollments and guardian links of their school. They still cannot read
-- documents, attendance, homework or notices addressed to others, and they write none of these.
-- Matches ROLES_PERMISSIONS.md ("Finance: billing minimum fields").
--
-- Recovery: forward-fix. Earlier definitions are in 0012_students.sql.
-- =====================================================================

DROP POLICY student_profiles_select ON student_profiles;
--> statement-breakpoint
CREATE POLICY student_profiles_select ON student_profiles FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR app_can_finance(school_id)
    OR (school_id = app_school_id() AND (app_is_student_self(id) OR app_is_guardian_of(id) OR app_teaches_student(id)))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
DROP POLICY enrollments_select ON enrollments;
--> statement-breakpoint
CREATE POLICY enrollments_select ON enrollments FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR app_can_finance(school_id)
    OR (school_id = app_school_id() AND (app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
    OR (school_id = app_school_id()
        AND starts_on <= app_school_today(school_id)
        AND (ends_on IS NULL OR ends_on >= app_school_today(school_id))
        AND app_teaches_section(section_id, app_school_today(school_id)))
    OR app_has_support_access(school_id)
  );
--> statement-breakpoint
DROP POLICY guardian_links_select ON guardian_links;
--> statement-breakpoint
CREATE POLICY guardian_links_select ON guardian_links FOR SELECT
  USING (
    app_can_manage_setup(school_id)
    OR app_can_finance(school_id)
    OR (school_id = app_school_id() AND guardian_user_id = app_user_id() AND app_has_school_role('parent'))
    OR app_has_support_access(school_id)
  );
