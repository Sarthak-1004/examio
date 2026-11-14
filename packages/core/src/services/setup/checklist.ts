import { sql } from "drizzle-orm";
import type { Db, RequestContext } from "@examio/db";
import { withCapability } from "../../capabilities";

/**
 * Setup completeness for the school-admin dashboard. Required items must all be done before the
 * school is ready for daily use; recommended items improve later modules but do not block.
 * Each item links to the page that fixes it.
 */
export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  required: boolean;
  detail: string;
  href: string;
}

export interface SetupChecklist {
  items: ChecklistItem[];
  /** All required items are done. */
  ready: boolean;
  doneCount: number;
  currentYear: { id: string; name: string } | null;
}

interface Facts extends Record<string, unknown> {
  has_contact: boolean;
  has_address: boolean;
  current_year_id: string | null;
  current_year_name: string | null;
  active_classes: number;
  classes_without_sections: number;
  active_subjects: number;
  classes_with_sections_without_subjects: number;
  default_scheme: boolean;
  active_sessions: number;
  holidays: number;
}

export async function getSetupChecklist(db: Db, ctx: RequestContext, schoolId: string): Promise<SetupChecklist> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = (await tx.execute<Facts>(sql`
      with cy as (
        select id, name from academic_years where school_id = ${schoolId}::uuid and status = 'current'
      ),
      active_classes as (
        select id from classes where school_id = ${schoolId}::uuid and archived_at is null
      ),
      sectioned as (
        select distinct s.class_id from sections s join cy on cy.id = s.academic_year_id where s.archived_at is null
      ),
      mapped as (
        select distinct m.class_id from class_subjects m join cy on cy.id = m.academic_year_id
      )
      select
        (s.contact_email is not null or s.contact_phone is not null) as has_contact,
        (s.address is not null) as has_address,
        (select id from cy) as current_year_id,
        (select name from cy) as current_year_name,
        (select count(*)::int from active_classes) as active_classes,
        (select count(*)::int from active_classes c where c.id not in (select class_id from sectioned)) as classes_without_sections,
        (select count(*)::int from subjects where school_id = ${schoolId}::uuid and archived_at is null) as active_subjects,
        (select count(*)::int from sectioned x where x.class_id in (select id from active_classes) and x.class_id not in (select class_id from mapped)) as classes_with_sections_without_subjects,
        exists (select 1 from grading_schemes g where g.school_id = ${schoolId}::uuid and g.is_default and g.archived_at is null) as default_scheme,
        (select count(*)::int from attendance_sessions a where a.school_id = ${schoolId}::uuid and a.archived_at is null) as active_sessions,
        (select count(*)::int from calendar_events e join cy on cy.id = e.academic_year_id where e.kind = 'holiday') as holidays
      from schools s where s.id = ${schoolId}::uuid`)) as unknown as Facts[];
    const f = rows[0]!;
    const hasYear = f.current_year_id !== null;
    const items: ChecklistItem[] = [
      {
        key: "profile",
        label: "Complete the school profile",
        done: f.has_contact && f.has_address,
        required: true,
        detail: f.has_contact && f.has_address ? "Address and contact details recorded." : "Add the address and a contact email or phone.",
        href: "/school/setup/profile",
      },
      {
        key: "year",
        label: "Set the current academic year",
        done: hasYear,
        required: true,
        detail: hasYear ? `Current year: ${f.current_year_name}.` : "Create the academic year and make it current.",
        href: "/school/setup/years",
      },
      {
        key: "classes",
        label: "Add classes",
        done: f.active_classes > 0,
        required: true,
        detail: f.active_classes > 0 ? `${f.active_classes} class(es).` : "Add classes, for example Class 1 to Class 12.",
        href: "/school/setup/classes",
      },
      {
        key: "sections",
        label: "Create sections for this year",
        done: hasYear && f.active_classes > 0 && f.classes_without_sections === 0,
        required: true,
        detail: !hasYear ? "Needs a current academic year first." : f.classes_without_sections === 0 ? "Every class has at least one section." : `${f.classes_without_sections} class(es) have no section this year.`,
        href: "/school/setup/classes",
      },
      {
        key: "subjects",
        label: "Add subjects",
        done: f.active_subjects > 0,
        required: true,
        detail: f.active_subjects > 0 ? `${f.active_subjects} subject(s).` : "Add the subjects your school teaches.",
        href: "/school/setup/subjects",
      },
      {
        key: "class_subjects",
        label: "Assign subjects to classes",
        done: hasYear && f.active_classes > 0 && f.classes_without_sections === 0 && f.classes_with_sections_without_subjects === 0,
        required: true,
        detail: !hasYear ? "Needs a current academic year first." : f.classes_with_sections_without_subjects === 0 ? "Every class with sections has subjects." : `${f.classes_with_sections_without_subjects} class(es) have no subjects this year.`,
        href: "/school/setup/subjects",
      },
      {
        key: "grading",
        label: "Choose a grading scheme",
        done: f.default_scheme,
        required: true,
        detail: f.default_scheme ? "A default grading scheme is set." : "Create a grading scheme (a CBSE-style starter is available).",
        href: "/school/setup/grading",
      },
      {
        key: "sessions",
        label: "Confirm attendance sessions",
        done: f.active_sessions > 0,
        required: true,
        detail: `${f.active_sessions} session(s) per day.`,
        href: "/school/setup/calendar",
      },
      {
        key: "holidays",
        label: "Add this year's holidays",
        done: hasYear && f.holidays > 0,
        required: false,
        detail: !hasYear ? "Needs a current academic year first." : f.holidays > 0 ? `${f.holidays} holiday(s) recorded.` : "Recommended: attendance and timetables use them.",
        href: "/school/setup/calendar",
      },
    ];
    return {
      items,
      ready: items.every((i) => !i.required || i.done),
      doneCount: items.filter((i) => i.done).length,
      currentYear: hasYear ? { id: f.current_year_id!, name: f.current_year_name! } : null,
    };
  });
}
