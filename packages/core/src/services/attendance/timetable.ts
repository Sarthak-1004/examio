import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { timetableSlots, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { exclusionViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { isoDate, parse, uuidField } from "../setup/common";
import { WEEKDAY_NAMES, attendanceSettingsTx, daysInRange, isoWeekday, type DayInfo } from "./settings";

/**
 * Weekly timetable (Phase 6). A period is a subject for a section on a weekday between two times,
 * optionally with a teacher and a room, in one academic year. The database refuses clashes: the
 * same section, teacher or room cannot have overlapping periods on the same weekday of a year.
 * The teacher must be assigned to teach that subject in that section. Removed periods stay as
 * history.
 */

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(hhmm: string): number | null {
  const m = TIME.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const slotSchema = z.object({
  sectionId: z.uuid({ message: "Section not found." }),
  subjectId: z.uuid({ message: "Subject not found." }),
  staffId: z.union([z.literal("").transform(() => null), z.uuid({ message: "Teacher not found." })]).nullable().optional(),
  weekday: z.coerce.number({ message: "Choose a day." }).int().min(1, "Choose a day.").max(7, "Choose a day."),
  start: z.string().regex(TIME, "Start time must be HH:MM."),
  end: z.string().regex(TIME, "End time must be HH:MM."),
  room: z.union([z.literal("").transform(() => null), z.string().trim().min(1).max(40, "Room must be at most 40 characters.")]).nullable().optional(),
});

export interface TimetableSlot {
  id: string;
  sectionId: string;
  sectionLabel: string;
  subjectId: string;
  subjectName: string;
  staffId: string | null;
  /** Null when the caller may not see staff names (students, parents, other teachers). */
  teacherName: string | null;
  weekday: number;
  startMinute: number;
  endMinute: number;
  room: string | null;
}

async function describeClash(tx: Tx, schoolId: string, yearId: string, kind: "section" | "teacher" | "room", v: { sectionId: string; staffId: string | null; room: string | null; weekday: number; start: number; end: number }): Promise<string> {
  const cond =
    kind === "section" ? sql`t.section_id = ${v.sectionId}::uuid` : kind === "teacher" ? sql`t.staff_id = ${v.staffId}::uuid` : sql`lower(t.room) = lower(${v.room})`;
  const [c] = (await tx.execute(sql`
    select c.name || ' ' || s.name as section, sub.name as subject, t.start_minute as start, t.end_minute as "end"
    from timetable_slots t join sections s on s.id = t.section_id join classes c on c.id = s.class_id join subjects sub on sub.id = t.subject_id
    where t.school_id = ${schoolId}::uuid and t.academic_year_id = ${yearId}::uuid and t.removed_at is null and t.weekday = ${v.weekday}
      and t.start_minute < ${v.end} and t.end_minute > ${v.start} and ${cond}
    limit 1`)) as unknown as { section: string; subject: string; start: number; end: number }[];
  const when = c ? `${c.section} ${c.subject}, ${formatMinutes(c.start)}–${formatMinutes(c.end)}` : "another period";
  const who = kind === "section" ? "This section already has a period at that time" : kind === "teacher" ? "This teacher is already teaching at that time" : "This room is already in use at that time";
  return `${who} (${when} on ${WEEKDAY_NAMES[v.weekday - 1]}).`;
}

export async function addTimetableSlot(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof slotSchema>): Promise<{ id: string }> {
  const d = parse(slotSchema, input);
  const start = toMinutes(d.start)!;
  const end = toMinutes(d.end)!;
  if (end <= start) throw new AppError("VALIDATION", "The end time must be after the start time.", { end: "Not after the start." });
  return withCapability(db, ctx, schoolId, "school.timetable.manage", async (tx, actor) => {
    const [sec] = (await tx.execute(sql`
      select s.academic_year_id as "yearId", s.class_id as "classId", y.status::text as status
      from sections s join academic_years y on y.id = s.academic_year_id where s.school_id = ${schoolId}::uuid and s.id = ${d.sectionId}::uuid and s.archived_at is null`)) as unknown as { yearId: string; classId: string; status: string }[];
    if (!sec) throw new AppError("NOT_FOUND", "Section not found.");
    if (sec.status === "closed") throw new AppError("CONFLICT", "That academic year is closed.");
    const [studied] = (await tx.execute(sql`select 1 as ok from class_subjects where school_id = ${schoolId}::uuid and academic_year_id = ${sec.yearId}::uuid and class_id = ${sec.classId}::uuid and subject_id = ${d.subjectId}::uuid`)) as unknown as { ok: number }[];
    if (!studied) throw new AppError("VALIDATION", "This class does not study that subject this year. Add it under School setup → Subjects first.", { subjectId: "Not studied by this class." });
    if (d.staffId) {
      const [assigned] = (await tx.execute(sql`
        select 1 as ok from teacher_assignments a join staff_profiles p on p.id = a.staff_id
        where a.school_id = ${schoolId}::uuid and a.staff_id = ${d.staffId}::uuid and a.section_id = ${d.sectionId}::uuid and a.subject_id = ${d.subjectId}::uuid
          and a.ends_on is null and p.status = 'active'`)) as unknown as { ok: number }[];
      if (!assigned) throw new AppError("VALIDATION", "That teacher is not assigned to teach this subject in this section. Assign them on the Staff page first.", { staffId: "Not assigned." });
    }
    const v = { sectionId: d.sectionId, staffId: d.staffId ?? null, room: d.room ?? null, weekday: d.weekday, start, end };
    try {
      // A savepoint keeps the transaction usable to explain a clash.
      const id = await tx.transaction(async (sp) => {
        const [row] = await sp
          .insert(timetableSlots)
          .values({ schoolId, academicYearId: sec.yearId, sectionId: d.sectionId, subjectId: d.subjectId, staffId: v.staffId, weekday: d.weekday, startMinute: start, endMinute: end, room: v.room, createdBy: actor.userId })
          .returning({ id: timetableSlots.id });
        return row!.id;
      });
      await audit(tx, { action: "timetable.slot_added", actorUserId: actor.userId, schoolId, entityType: "timetable_slot", entityId: id, data: { sectionId: d.sectionId, weekday: d.weekday, start, end } });
      return { id };
    } catch (e) {
      const constraint = exclusionViolation(e);
      if (constraint === "timetable_slots_no_section_clash") throw new AppError("CONFLICT", await describeClash(tx, schoolId, sec.yearId, "section", v));
      if (constraint === "timetable_slots_no_teacher_clash") throw new AppError("CONFLICT", await describeClash(tx, schoolId, sec.yearId, "teacher", v), { staffId: "Busy at that time." });
      if (constraint === "timetable_slots_no_room_clash") throw new AppError("CONFLICT", await describeClash(tx, schoolId, sec.yearId, "room", v), { room: "In use at that time." });
      throw e;
    }
  });
}

export async function removeTimetableSlot(db: Db, ctx: RequestContext, schoolId: string, slotId: string): Promise<void> {
  parse(uuidField("Period"), slotId);
  await withCapability(db, ctx, schoolId, "school.timetable.manage", async (tx, actor) => {
    const r = await tx
      .update(timetableSlots)
      .set({ removedAt: sql`now()` })
      .where(and(eq(timetableSlots.schoolId, schoolId), eq(timetableSlots.id, slotId), isNull(timetableSlots.removedAt)))
      .returning({ id: timetableSlots.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Period not found, already removed, or its year is closed.");
    await audit(tx, { action: "timetable.slot_removed", actorUserId: actor.userId, schoolId, entityType: "timetable_slot", entityId: slotId });
  });
}

async function slotsWhere(tx: Tx, schoolId: string, where: ReturnType<typeof sql>): Promise<TimetableSlot[]> {
  return (await tx.execute(sql`
    select t.id, t.section_id as "sectionId", c.name || ' ' || s.name as "sectionLabel", t.subject_id as "subjectId", sub.name as "subjectName",
           t.staff_id as "staffId", p.display_name as "teacherName", t.weekday, t.start_minute as "startMinute", t.end_minute as "endMinute", t.room
    from timetable_slots t join sections s on s.id = t.section_id join classes c on c.id = s.class_id join subjects sub on sub.id = t.subject_id
    left join staff_profiles p on p.id = t.staff_id
    where t.school_id = ${schoolId}::uuid and t.removed_at is null and ${where}
    order by t.weekday, t.start_minute, c.sort_order, s.name`)) as unknown as TimetableSlot[];
}

/** A section's weekly timetable (any member of the school may read timetables). */
export async function getSectionTimetable(db: Db, ctx: RequestContext, schoolId: string, sectionId: string): Promise<TimetableSlot[]> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.timetable.view", (tx) => slotsWhere(tx, schoolId, sql`t.section_id = ${sectionId}::uuid`));
}

/** The signed-in teacher's weekly timetable in the current year. */
export async function getMyTimetable(db: Db, ctx: RequestContext, schoolId: string): Promise<TimetableSlot[]> {
  return withCapability(db, ctx, schoolId, "school.teaching.view", (tx) =>
    slotsWhere(tx, schoolId, sql`t.staff_id = app_my_staff_id(${schoolId}::uuid) and t.academic_year_id in (select id from academic_years where school_id = ${schoolId}::uuid and status = 'current')`),
  );
}

/** The current section of a student the caller can see (own record or linked child). */
async function currentSectionOf(tx: Tx, schoolId: string, studentId: string | null): Promise<string | null> {
  const [r] = (await tx.execute(sql`
    select e.section_id as id from enrollments e join academic_years y on y.id = e.academic_year_id join student_profiles p on p.id = e.student_id
    where e.school_id = ${schoolId}::uuid and y.status = 'current' and e.ends_on is null
      and ${studentId ? sql`p.id = ${studentId}::uuid` : sql`p.user_id = app_user_id()`}
    limit 1`)) as unknown as { id: string }[];
  return r?.id ?? null;
}

/** The signed-in student's timetable (their current section); empty if not enrolled. */
export async function getMyStudentTimetable(db: Db, ctx: RequestContext, schoolId: string): Promise<TimetableSlot[]> {
  return withCapability(db, ctx, schoolId, "school.own_record.view", async (tx) => {
    const sectionId = await currentSectionOf(tx, schoolId, null);
    return sectionId ? slotsWhere(tx, schoolId, sql`t.section_id = ${sectionId}::uuid`) : [];
  });
}

/** A linked child's timetable for a parent; any other student gives an empty timetable. */
export async function getChildTimetable(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<TimetableSlot[]> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const sectionId = await currentSectionOf(tx, schoolId, studentId);
    return sectionId ? slotsWhere(tx, schoolId, sql`t.section_id = ${sectionId}::uuid`) : [];
  });
}

/** A date's periods from a weekly timetable, with the calendar entries for that date. */
export async function dayPlan(db: Db, ctx: RequestContext, schoolId: string, slots: TimetableSlot[], date: string): Promise<{ day: DayInfo | null; periods: TimetableSlot[] }> {
  const d = parse(isoDate("date"), date);
  return withCapability(db, ctx, schoolId, "school.timetable.view", async (tx) => {
    const settings = await attendanceSettingsTx(tx, schoolId);
    const [y] = (await tx.execute(sql`select id from academic_years where school_id = ${schoolId}::uuid and starts_on <= ${d}::date and ends_on >= ${d}::date order by (status = 'current') desc limit 1`)) as unknown as { id: string }[];
    const day = y ? ((await daysInRange(tx, schoolId, y.id, d, d, { ...settings, today: d }))[0] ?? null) : null;
    const periods = day && (day.reason === "weekly_off" || day.reason === "holiday" || day.reason === "outside_year") ? [] : slots.filter((s) => s.weekday === isoWeekday(d));
    return { day, periods };
  });
}

/* ------------------------------------------------------------------ teacher load report */

export interface TeacherLoadRow {
  staffId: string;
  name: string;
  periods: number;
  minutes: number;
  sections: number;
}

/** Periods and teaching minutes per teacher per week in a year (administrators). */
export async function getTeacherLoad(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<TeacherLoadRow[]> {
  parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.timetable.manage", async (tx) =>
    (await tx.execute(sql`
      select p.id as "staffId", p.display_name as name, count(t.id)::int as periods, coalesce(sum(t.end_minute - t.start_minute), 0)::int as minutes, count(distinct t.section_id)::int as sections
      from staff_profiles p join timetable_slots t on t.staff_id = p.id and t.removed_at is null and t.academic_year_id = ${yearId}::uuid
      where p.school_id = ${schoolId}::uuid
      group by p.id, p.display_name order by minutes desc, p.display_name`)) as unknown as TeacherLoadRow[],
  );
}

export async function exportTeacherLoadCsv(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<string> {
  const rows = await getTeacherLoad(db, ctx, schoolId, yearId);
  return withCapability(db, ctx, schoolId, "school.timetable.manage", async (tx, actor) => {
    await audit(tx, { action: "timetable.load_exported", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: yearId, data: { rows: rows.length } });
    return toCsv([["teacher", "periods_per_week", "hours_per_week", "sections"], ...rows.map((r) => [r.name, String(r.periods), (r.minutes / 60).toFixed(1), String(r.sections)])]);
  });
}
