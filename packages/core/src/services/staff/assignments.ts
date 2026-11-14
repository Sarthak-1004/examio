import { and, eq, isNull, sql } from "drizzle-orm";
import { academicYears, classSubjects, classTeachers, sections, staffProfiles, teacherAssignments, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays, schoolToday } from "../../dates";
import { AppError } from "../../errors";
import { isoDate, mapSetupError, parse, uuidField } from "../setup/common";
import { schoolTimezone } from "./profiles";

/**
 * Teaching assignments: which teacher teaches which subject to which section, and who is each
 * section's class teacher, with effective dates.
 *
 * - Dates are school-local and must fall inside the section's academic year. The start defaults
 *   to today (or the year's first day, if the year has not started).
 * - The teacher must be an active staff member with the teacher role; the subject must be one
 *   the section's class studies that year; the year must be open.
 * - A teacher has at most one open assignment per section and subject; several teachers may
 *   share one (co-teaching). A section has at most one open class teacher.
 * - Assignments are ended, never deleted, so the history of who taught what is kept.
 *
 * Access follows assignments: the database helpers app_teaches_section / app_teaches_subject
 * answer "does the signed-in teacher teach this section (subject) on this date?" for the
 * student, attendance and homework rules of later phases.
 */
interface SectionInfo {
  yearId: string;
  classId: string;
  startsOn: string;
  endsOn: string;
  status: string;
  archived: boolean;
}

async function sectionInfo(tx: Tx, schoolId: string, sectionId: string): Promise<SectionInfo> {
  const [s] = await tx
    .select({ yearId: sections.academicYearId, classId: sections.classId, archivedAt: sections.archivedAt, startsOn: academicYears.startsOn, endsOn: academicYears.endsOn, status: academicYears.status })
    .from(sections)
    .innerJoin(academicYears, eq(academicYears.id, sections.academicYearId))
    .where(and(eq(sections.schoolId, schoolId), eq(sections.id, sectionId)));
  if (!s) throw new AppError("NOT_FOUND", "Section not found.");
  if (s.status === "closed") throw new AppError("CONFLICT", "This academic year is closed. Reopen it to change assignments.");
  if (s.archivedAt) throw new AppError("CONFLICT", "This section is archived.");
  return { yearId: s.yearId, classId: s.classId, startsOn: s.startsOn, endsOn: s.endsOn, status: s.status, archived: false };
}

async function requireActiveTeacher(tx: Tx, schoolId: string, staffId: string): Promise<void> {
  const [p] = await tx
    // Column names are written out with their table: inside the subquery an unqualified
    // "school_id" would refer to the membership row itself.
    .select({ status: staffProfiles.status, teacher: sql<boolean>`exists (select 1 from school_memberships m where m.school_id = "staff_profiles"."school_id" and m.user_id = "staff_profiles"."user_id" and m.role = 'teacher' and m.status = 'active')` })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)));
  if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
  if (p.status !== "active") throw new AppError("CONFLICT", "This staff member has left the school.");
  if (!p.teacher) throw new AppError("CONFLICT", "Only staff with the teacher role can be assigned to teach.");
}

async function effectiveStart(tx: Tx, schoolId: string, s: SectionInfo, requested: string | undefined): Promise<string> {
  let value: string;
  if (requested) value = parse(isoDate("start date"), requested);
  else {
    const today = schoolToday(await schoolTimezone(tx, schoolId));
    value = today < s.startsOn ? s.startsOn : today;
  }
  if (value < s.startsOn || value > s.endsOn) throw new AppError("VALIDATION", `The start date must be within the academic year (${s.startsOn} to ${s.endsOn}).`, { startsOn: "Outside the academic year." });
  return value;
}

export async function assignTeacher(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { staffId: string; sectionId: string; subjectId: string; startsOn?: string },
): Promise<{ id: string; startsOn: string }> {
  parse(uuidField("Staff member"), input.staffId);
  parse(uuidField("Section"), input.sectionId);
  parse(uuidField("Subject"), input.subjectId);
  try {
    return await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      await requireActiveTeacher(tx, schoolId, input.staffId);
      const s = await sectionInfo(tx, schoolId, input.sectionId);
      const [taught] = await tx
        .select({ id: classSubjects.id })
        .from(classSubjects)
        .where(and(eq(classSubjects.schoolId, schoolId), eq(classSubjects.academicYearId, s.yearId), eq(classSubjects.classId, s.classId), eq(classSubjects.subjectId, input.subjectId)));
      if (!taught) throw new AppError("CONFLICT", "This class does not study that subject this year. Add it under School setup → Subjects first.");
      const startsOn = await effectiveStart(tx, schoolId, s, input.startsOn);
      const [row] = await tx
        .insert(teacherAssignments)
        .values({ schoolId, staffId: input.staffId, academicYearId: s.yearId, sectionId: input.sectionId, subjectId: input.subjectId, startsOn })
        .returning({ id: teacherAssignments.id });
      await audit(tx, { action: "assignment.created", actorUserId: actor.userId, schoolId, entityType: "teacher_assignment", entityId: row!.id, data: { staffId: input.staffId, sectionId: input.sectionId, subjectId: input.subjectId, startsOn } });
      return { id: row!.id, startsOn };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: { teacher_assignments_one_open: ["subjectId", "This teacher already teaches that subject to this section."] } });
  }
}

/** Makes a teacher the class teacher of a section, replacing the current one from the start date. */
export async function setClassTeacher(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { staffId: string; sectionId: string; startsOn?: string },
): Promise<{ id: string; startsOn: string; replaced: boolean }> {
  parse(uuidField("Staff member"), input.staffId);
  parse(uuidField("Section"), input.sectionId);
  try {
    return await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      await requireActiveTeacher(tx, schoolId, input.staffId);
      const s = await sectionInfo(tx, schoolId, input.sectionId);
      const startsOn = await effectiveStart(tx, schoolId, s, input.startsOn);
      const [current] = await tx
        .select({ id: classTeachers.id, staffId: classTeachers.staffId, startsOn: classTeachers.startsOn })
        .from(classTeachers)
        .where(and(eq(classTeachers.schoolId, schoolId), eq(classTeachers.sectionId, input.sectionId), isNull(classTeachers.endsOn)));
      if (current) {
        if (current.staffId === input.staffId) throw new AppError("CONFLICT", "This teacher is already the class teacher of this section.");
        if (current.startsOn >= startsOn) throw new AppError("CONFLICT", "The current class teacher started on or after that date. Choose a later start date, or end their role first.");
        await tx.update(classTeachers).set({ endsOn: addDays(startsOn, -1) }).where(eq(classTeachers.id, current.id));
      }
      const [row] = await tx
        .insert(classTeachers)
        .values({ schoolId, staffId: input.staffId, academicYearId: s.yearId, sectionId: input.sectionId, startsOn })
        .returning({ id: classTeachers.id });
      await audit(tx, { action: "class_teacher.set", actorUserId: actor.userId, schoolId, entityType: "class_teacher", entityId: row!.id, data: { staffId: input.staffId, sectionId: input.sectionId, startsOn, replaced: current?.id ?? null } });
      return { id: row!.id, startsOn, replaced: !!current };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

/** Ends a subject assignment or class-teacher role on the given date (default: today). */
export async function endAssignment(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { kind: "subject" | "class_teacher"; id: string; endsOn?: string },
): Promise<{ endsOn: string }> {
  parse(uuidField("Assignment"), input.id);
  const table = input.kind === "subject" ? teacherAssignments : classTeachers;
  try {
    return await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      const [a] = await tx
        .select({ startsOn: table.startsOn, endsOn: table.endsOn, yearEnds: academicYears.endsOn, status: academicYears.status })
        .from(table)
        .innerJoin(academicYears, eq(academicYears.id, table.academicYearId))
        .where(and(eq(table.schoolId, schoolId), eq(table.id, input.id)));
      if (!a) throw new AppError("NOT_FOUND", "Assignment not found.");
      if (a.endsOn) throw new AppError("CONFLICT", "This assignment has already ended.");
      if (a.status === "closed") throw new AppError("CONFLICT", "This academic year is closed.");
      const today = schoolToday(await schoolTimezone(tx, schoolId));
      let endsOn = input.endsOn ? parse(isoDate("end date"), input.endsOn) : today;
      if (!input.endsOn && endsOn < a.startsOn) endsOn = a.startsOn; // ending one that has not started yet
      if (endsOn < a.startsOn) throw new AppError("VALIDATION", "The end date cannot be before the start date.", { endsOn: "Before the start date." });
      if (endsOn > a.yearEnds) throw new AppError("VALIDATION", "The end date must be within the academic year.", { endsOn: "After the year ends." });
      await tx.update(table).set({ endsOn }).where(eq(table.id, input.id));
      await audit(tx, { action: input.kind === "subject" ? "assignment.ended" : "class_teacher.ended", actorUserId: actor.userId, schoolId, entityType: input.kind === "subject" ? "teacher_assignment" : "class_teacher", entityId: input.id, data: { endsOn } });
      return { endsOn };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

export interface SectionTeaching {
  sectionId: string;
  classId: string;
  className: string;
  sectionName: string;
  classTeacher: { id: string; staffId: string; name: string } | null;
  subjects: { subjectId: string; subjectName: string; teachers: { assignmentId: string; staffId: string; name: string }[] }[];
}

/** Who teaches what in a year, as of today: every active section, its subjects and teachers. */
export async function listYearTeaching(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<SectionTeaching[]> {
  parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.staff.view", async (tx) => {
    const today = schoolToday(await schoolTimezone(tx, schoolId));
    const rows = (await tx.execute(sql`
      select s.id as section_id, c.id as class_id, c.name as class_name, s.name as section_name, c.sort_order,
             sub.id as subject_id, sub.name as subject_name,
             a.id as assignment_id, a.staff_id, p.display_name as teacher_name
      from sections s
      join classes c on c.id = s.class_id
      left join class_subjects m on m.academic_year_id = s.academic_year_id and m.class_id = s.class_id and m.school_id = s.school_id
      left join subjects sub on sub.id = m.subject_id and sub.archived_at is null
      left join teacher_assignments a on a.section_id = s.id and a.subject_id = sub.id
        and a.starts_on <= ${today}::date and (a.ends_on is null or a.ends_on >= ${today}::date)
      left join staff_profiles p on p.id = a.staff_id
      where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${yearId}::uuid and s.archived_at is null and c.archived_at is null
      order by c.sort_order, c.name, s.name, sub.name, p.display_name`)) as unknown as {
      section_id: string; class_id: string; class_name: string; section_name: string; subject_id: string | null; subject_name: string | null;
      assignment_id: string | null; staff_id: string | null; teacher_name: string | null;
    }[];
    const cts = (await tx.execute(sql`
      select t.id, t.section_id, t.staff_id, p.display_name as name from class_teachers t join staff_profiles p on p.id = t.staff_id
      where t.school_id = ${schoolId}::uuid and t.academic_year_id = ${yearId}::uuid
        and t.starts_on <= ${today}::date and (t.ends_on is null or t.ends_on >= ${today}::date)`)) as unknown as { id: string; section_id: string; staff_id: string; name: string }[];
    const out = new Map<string, SectionTeaching>();
    for (const r of rows) {
      const sec = out.get(r.section_id) ?? { sectionId: r.section_id, classId: r.class_id, className: r.class_name, sectionName: r.section_name, classTeacher: null, subjects: [] };
      if (r.subject_id && r.subject_name) {
        let subj = sec.subjects.find((x) => x.subjectId === r.subject_id);
        if (!subj) {
          subj = { subjectId: r.subject_id, subjectName: r.subject_name, teachers: [] };
          sec.subjects.push(subj);
        }
        if (r.assignment_id && r.staff_id && r.teacher_name) subj.teachers.push({ assignmentId: r.assignment_id, staffId: r.staff_id, name: r.teacher_name });
      }
      out.set(r.section_id, sec);
    }
    for (const c of cts) {
      const sec = out.get(c.section_id);
      if (sec) sec.classTeacher = { id: c.id, staffId: c.staff_id, name: c.name };
    }
    return [...out.values()];
  });
}

export interface MyTeaching {
  today: string;
  yearName: string | null;
  subjects: { sectionId: string; label: string; subjectName: string; since: string; until: string | null }[];
  classTeacherOf: { sectionId: string; label: string; since: string }[];
}

/** The signed-in teacher's own classes today (teacher dashboard). */
export async function getMyTeaching(db: Db, ctx: RequestContext, schoolId: string): Promise<MyTeaching> {
  return withCapability(db, ctx, schoolId, "school.teaching.view", async (tx) => {
    const today = schoolToday(await schoolTimezone(tx, schoolId));
    const subjects = (await tx.execute(sql`
      select s.id as section_id, c.name || ' ' || s.name as label, sub.name as subject_name, a.starts_on::text as since, a.ends_on::text as until, y.name as year_name
      from teacher_assignments a
      join sections s on s.id = a.section_id join classes c on c.id = s.class_id
      join subjects sub on sub.id = a.subject_id join academic_years y on y.id = a.academic_year_id
      where a.school_id = ${schoolId}::uuid and a.staff_id = app_my_staff_id(${schoolId}::uuid)
        and a.starts_on <= ${today}::date and (a.ends_on is null or a.ends_on >= ${today}::date)
      order by c.sort_order, c.name, s.name, sub.name`)) as unknown as { section_id: string; label: string; subject_name: string; since: string; until: string | null; year_name: string }[];
    const ct = (await tx.execute(sql`
      select s.id as section_id, c.name || ' ' || s.name as label, t.starts_on::text as since
      from class_teachers t join sections s on s.id = t.section_id join classes c on c.id = s.class_id
      where t.school_id = ${schoolId}::uuid and t.staff_id = app_my_staff_id(${schoolId}::uuid)
        and t.starts_on <= ${today}::date and (t.ends_on is null or t.ends_on >= ${today}::date)
      order by c.sort_order, s.name`)) as unknown as { section_id: string; label: string; since: string }[];
    return {
      today,
      yearName: subjects[0]?.year_name ?? null,
      subjects: subjects.map((r) => ({ sectionId: r.section_id, label: r.label, subjectName: r.subject_name, since: r.since, until: r.until })),
      classTeacherOf: ct.map((r) => ({ sectionId: r.section_id, label: r.label, since: r.since })),
    };
  });
}

/** Whether the signed-in teacher teaches the section on a date (default today). For later modules' service checks. */
export async function teachesSection(db: Db, ctx: RequestContext, schoolId: string, sectionId: string, onDate?: string): Promise<boolean> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.teaching.view", async (tx) => {
    const day = onDate ? parse(isoDate("date"), onDate) : schoolToday(await schoolTimezone(tx, schoolId));
    const [r] = (await tx.execute(sql`select app_teaches_section(${sectionId}::uuid, ${day}::date) as ok`)) as unknown as { ok: boolean }[];
    return r?.ok === true;
  });
}

