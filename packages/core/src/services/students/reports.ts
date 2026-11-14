import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { files, studentDocuments, studentProfiles, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { AppError } from "../../errors";
import { parse, trimmed, uuidField } from "../setup/common";
import { currentYearId } from "./common";

/** Enrollment reports and student documents (Phase 5). School administrators only. */

export interface SectionStrength {
  sectionId: string;
  classId: string;
  label: string;
  capacity: number | null;
  enrolled: number;
  withoutRoll: number;
}

export interface EnrollmentReport {
  yearId: string | null;
  sections: SectionStrength[];
  totalEnrolled: number;
  activeNotEnrolled: number;
}

/** Students per section in a year (default the current year), and active students with no section. */
export async function getEnrollmentReport(db: Db, ctx: RequestContext, schoolId: string, yearId?: string): Promise<EnrollmentReport> {
  if (yearId) parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx) => {
    const y = yearId ?? (await currentYearId(tx, schoolId));
    if (!y) return { yearId: null, sections: [], totalEnrolled: 0, activeNotEnrolled: 0 };
    const sections = (await tx.execute(sql`
      select s.id as "sectionId", c.id as "classId", c.name || ' ' || s.name as label, s.capacity,
             count(e.id)::int as enrolled, count(e.id) filter (where e.roll_no is null)::int as "withoutRoll"
      from sections s join classes c on c.id = s.class_id
      left join enrollments e on e.section_id = s.id and e.ends_on is null
      where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${y}::uuid and s.archived_at is null
      group by s.id, c.id, c.sort_order, c.name, s.name, s.capacity
      order by c.sort_order, c.name, s.name`)) as unknown as SectionStrength[];
    const [n] = (await tx.execute(sql`
      select count(*)::int as n from student_profiles p
      where p.school_id = ${schoolId}::uuid and p.status = 'active'
        and not exists (select 1 from enrollments e where e.student_id = p.id and e.academic_year_id = ${y}::uuid and e.ends_on is null)`)) as unknown as { n: number }[];
    return { yearId: y, sections, totalEnrolled: sections.reduce((a, s) => a + s.enrolled, 0), activeNotEnrolled: n?.n ?? 0 };
  });
}

/** The enrollment report as CSV (one row per section); audited. */
export async function exportEnrollmentReportCsv(db: Db, ctx: RequestContext, schoolId: string, yearId?: string): Promise<string> {
  const r = await getEnrollmentReport(db, ctx, schoolId, yearId);
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx, actor) => {
    await audit(tx, { action: "enrollment.report_exported", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: r.yearId ?? undefined, data: { sections: r.sections.length } });
    return toCsv([
      ["class_section", "capacity", "enrolled", "without_roll_no"],
      ...r.sections.map((s) => [s.label, s.capacity === null ? null : String(s.capacity), String(s.enrolled), String(s.withoutRoll)]),
      ["Total", null, String(r.totalEnrolled), null],
    ]);
  });
}

/* ------------------------------------------------------------------ documents */

export const STUDENT_DOCUMENT_PURPOSE = "student_document";

export interface StudentDocumentRow {
  id: string;
  fileId: string;
  title: string;
  fileName: string;
  fileStatus: string;
  createdAt: Date;
}

export async function listStudentDocuments(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<StudentDocumentRow[]> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.students.view", (tx) =>
    tx
      .select({ id: studentDocuments.id, fileId: studentDocuments.fileId, title: studentDocuments.title, fileName: files.originalName, fileStatus: files.status, createdAt: studentDocuments.createdAt })
      .from(studentDocuments)
      .innerJoin(files, eq(files.id, studentDocuments.fileId))
      .where(and(eq(studentDocuments.schoolId, schoolId), eq(studentDocuments.studentId, studentId), isNull(studentDocuments.removedAt)))
      .orderBy(desc(studentDocuments.createdAt)),
  );
}

/** Attaches an uploaded private file (purpose student_document) to a student's record. */
export async function attachStudentDocument(db: Db, ctx: RequestContext, schoolId: string, studentId: string, input: { fileId: string; title: string }): Promise<{ id: string }> {
  parse(uuidField("Student"), studentId);
  parse(uuidField("File"), input.fileId);
  const title = parse(trimmed("Title", 1, 120), input.title);
  return withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
    const [p] = await tx.select({ id: studentProfiles.id }).from(studentProfiles).where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
    if (!p) throw new AppError("NOT_FOUND", "Student not found.");
    const [f] = await tx.select({ purpose: files.purpose, deletedAt: files.deletedAt }).from(files).where(and(eq(files.schoolId, schoolId), eq(files.id, input.fileId)));
    if (!f || f.deletedAt) throw new AppError("NOT_FOUND", "File not found.");
    if (f.purpose !== STUDENT_DOCUMENT_PURPOSE) throw new AppError("VALIDATION", "This file was not uploaded as a student document.");
    const [d] = await tx.insert(studentDocuments).values({ schoolId, studentId, fileId: input.fileId, title, addedBy: actor.userId }).returning({ id: studentDocuments.id });
    await audit(tx, { action: "student.document_added", actorUserId: actor.userId, schoolId, entityType: "student", entityId: studentId, data: { documentId: d!.id, title } });
    return { id: d!.id };
  });
}

/** Hides a document from the record; the row and the audit trail remain. */
export async function removeStudentDocument(db: Db, ctx: RequestContext, schoolId: string, documentId: string): Promise<void> {
  parse(uuidField("Document"), documentId);
  await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
    const [d] = await tx
      .update(studentDocuments)
      .set({ removedAt: sql`now()` })
      .where(and(eq(studentDocuments.schoolId, schoolId), eq(studentDocuments.id, documentId), isNull(studentDocuments.removedAt)))
      .returning({ studentId: studentDocuments.studentId });
    if (!d) throw new AppError("NOT_FOUND", "Document not found.");
    await audit(tx, { action: "student.document_removed", actorUserId: actor.userId, schoolId, entityType: "student", entityId: d.studentId, data: { documentId } });
  });
}
