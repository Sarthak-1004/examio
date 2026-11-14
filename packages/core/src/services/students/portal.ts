import { sql } from "drizzle-orm";
import type { Db, RequestContext, Tx } from "@examio/db";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { parse, uuidField } from "../setup/common";
import { schoolInfo } from "./common";
import { rosterQuery, type RosterRow } from "./enrollments";
import { enrollmentHistory, type EnrollmentHistoryRow } from "./profiles";

/**
 * What parents, students and teachers see of student records (Phase 5). Every query runs under
 * the database policies: a parent reads only children with an active guardian link, a student
 * only themself, a teacher only the current students of sections they teach today. These
 * services add no access of their own; they shape what the policies return.
 */

export interface ChildSummary {
  studentId: string;
  displayName: string;
  admissionNo: string;
  relationship: string;
  status: "active" | "left";
  sectionLabel: string | null;
  rollNo: number | null;
  yearName: string | null;
}

async function childSummaries(tx: Tx, schoolId: string): Promise<ChildSummary[]> {
  return (await tx.execute(sql`
    select p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo", g.relationship::text as relationship,
           p.status::text as status, case when s.id is null then null else c.name || ' ' || s.name end as "sectionLabel", e.roll_no as "rollNo", y.name as "yearName"
    from guardian_links g
    join student_profiles p on p.id = g.student_id
    left join academic_years y on y.school_id = p.school_id and y.status = 'current'
    left join enrollments e on e.student_id = p.id and e.academic_year_id = y.id and e.ends_on is null
    left join sections s on s.id = e.section_id left join classes c on c.id = s.class_id
    where g.school_id = ${schoolId}::uuid and g.guardian_user_id = app_user_id() and g.revoked_at is null
    order by p.display_name`)) as unknown as ChildSummary[];
}

/** The signed-in parent's linked children in the selected school. */
export async function listMyChildren(db: Db, ctx: RequestContext, schoolId: string): Promise<ChildSummary[]> {
  return withCapability(db, ctx, schoolId, "school.children.view", (tx) => childSummaries(tx, schoolId));
}

export interface ChildDetail extends ChildSummary {
  dateOfBirth: string | null;
  admittedOn: string;
  enrollments: EnrollmentHistoryRow[];
}

/** One linked child. Any other student id is not found, exactly like an unknown id. */
export async function getMyChild(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<ChildDetail> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const child = (await childSummaries(tx, schoolId)).find((c) => c.studentId === studentId);
    if (!child) throw new AppError("NOT_FOUND", "Student not found.");
    const [p] = (await tx.execute(sql`select date_of_birth::text as "dateOfBirth", admitted_on::text as "admittedOn" from student_profiles where id = ${studentId}::uuid`)) as unknown as { dateOfBirth: string | null; admittedOn: string }[];
    return { ...child, dateOfBirth: p?.dateOfBirth ?? null, admittedOn: p?.admittedOn ?? "", enrollments: await enrollmentHistory(tx, schoolId, studentId) };
  });
}

export interface OwnRecord {
  studentId: string;
  displayName: string;
  admissionNo: string;
  sectionLabel: string | null;
  rollNo: number | null;
  yearName: string | null;
  enrollments: EnrollmentHistoryRow[];
}

/** The signed-in student's own record, or null if the school has not added student details yet. */
export async function getMyStudentRecord(db: Db, ctx: RequestContext, schoolId: string): Promise<OwnRecord | null> {
  return withCapability(db, ctx, schoolId, "school.own_record.view", async (tx) => {
    const [r] = (await tx.execute(sql`
      select p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo",
             case when s.id is null then null else c.name || ' ' || s.name end as "sectionLabel", e.roll_no as "rollNo", y.name as "yearName"
      from student_profiles p
      left join academic_years y on y.school_id = p.school_id and y.status = 'current'
      left join enrollments e on e.student_id = p.id and e.academic_year_id = y.id and e.ends_on is null
      left join sections s on s.id = e.section_id left join classes c on c.id = s.class_id
      where p.school_id = ${schoolId}::uuid and p.user_id = app_user_id()`)) as unknown as Omit<OwnRecord, "enrollments">[];
    if (!r) return null;
    return { ...r, enrollments: await enrollmentHistory(tx, schoolId, r.studentId) };
  });
}

/**
 * Today's students of a section the signed-in teacher teaches. A section they do not teach today
 * is not found (whether or not it exists).
 */
export async function getTeacherRoster(db: Db, ctx: RequestContext, schoolId: string, sectionId: string): Promise<{ label: string; today: string; rows: RosterRow[] }> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.roster.view", async (tx) => {
    const { today } = await schoolInfo(tx, schoolId);
    const [s] = (await tx.execute(sql`
      select c.name || ' ' || s.name as label from sections s join classes c on c.id = s.class_id
      where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid and app_teaches_section(s.id, ${today}::date)`)) as unknown as { label: string }[];
    if (!s) throw new AppError("NOT_FOUND", "Section not found.");
    const rows = await rosterQuery(tx, schoolId, sectionId);
    return { label: s.label, today, rows: rows.filter((r) => r.startsOn <= today) };
  });
}
