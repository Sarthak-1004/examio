import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { attendanceChanges, attendanceRecords, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { isoDate, parse, uuidField } from "../setup/common";
import { NON_SCHOOL_DAY_MESSAGE, attendanceSettingsTx, daysInRange, type AttendanceSettings } from "./settings";

/**
 * Attendance registers (Phase 6): one per section, local school date and attendance session.
 *
 * - The register lists the students enrolled in the section on that date. Every student must be
 *   marked present, absent, late or excused; not recorded is never assumed to be absent.
 * - Teachers write registers of sections they teach that day, within the school's edit window,
 *   never for a future date and never on or before the lock date; administrators may write any
 *   date. The database enforces the same rules.
 * - Changing an entry after its date, or an administrator writing a date that is locked or
 *   outside the teachers' window, needs a reason; every change is kept in attendance_changes.
 * - Submitting the same register twice changes nothing. If someone else changed the register
 *   after it was opened, the submission is refused (unless it asks for exactly what is stored).
 */

export const ATTENDANCE_STATUSES = ["present", "absent", "late", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface RegisterRow {
  enrollmentId: string;
  studentId: string;
  displayName: string;
  admissionNo: string;
  rollNo: number | null;
  status: AttendanceStatus | null;
  note: string | null;
  recordId: string | null;
}

export interface Register {
  sectionId: string;
  sectionLabel: string;
  yearId: string;
  sessionId: string;
  sessionName: string;
  date: string;
  /** Why attendance cannot be taken that day, or null on a school day. */
  notSchoolDay: string | null;
  events: { title: string; kind: string }[];
  rows: RegisterRow[];
  marked: number;
  /** Opaque token of the stored state; sent back with a submission. */
  version: string;
  /** Whether the caller may submit (teacher window and lock, or administrator). */
  canWrite: boolean;
  /** Whether a submission that changes stored entries, or writes this date at all, needs a reason. */
  changesNeedReason: boolean;
  writeNeedsReason: boolean;
  lockedThrough: string | null;
  isAdmin: boolean;
}

interface Context {
  settings: AttendanceSettings;
  section: { id: string; label: string; yearId: string };
  session: { id: string; name: string };
  isAdmin: boolean;
  teaches: boolean;
}

async function context(tx: Tx, schoolId: string, sectionId: string, sessionId: string, date: string): Promise<Context> {
  const settings = await attendanceSettingsTx(tx, schoolId);
  const [sec] = (await tx.execute(sql`
    select s.id, c.name || ' ' || s.name as label, s.academic_year_id as "yearId" from sections s join classes c on c.id = s.class_id
    where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid`)) as unknown as { id: string; label: string; yearId: string }[];
  const [ses] = (await tx.execute(sql`select id, name from attendance_sessions where school_id = ${schoolId}::uuid and id = ${sessionId}::uuid and archived_at is null`)) as unknown as { id: string; name: string }[];
  const [who] = (await tx.execute(sql`select app_can_manage_setup(${schoolId}::uuid) as admin, app_teaches_section(${sectionId}::uuid, ${date}::date) as teaches`)) as unknown as { admin: boolean; teaches: boolean }[];
  // A section the caller may not see is reported exactly like an unknown one.
  if (!sec || (!who?.admin && !who?.teaches)) throw new AppError("NOT_FOUND", "Section not found.");
  if (!ses) throw new AppError("NOT_FOUND", "Attendance session not found.");
  return { settings, section: sec, session: ses, isAdmin: !!who.admin, teaches: !!who.teaches };
}

async function roster(tx: Tx, sectionId: string, date: string) {
  return (await tx.execute(sql`select enrollment_id as "enrollmentId", student_id as "studentId", display_name as "displayName", admission_no as "admissionNo", roll_no as "rollNo" from app_attendance_roster(${sectionId}::uuid, ${date}::date)`)) as unknown as Omit<RegisterRow, "status" | "note" | "recordId">[];
}

async function stored(tx: Tx, schoolId: string, sectionId: string, sessionId: string, date: string) {
  return tx
    .select({ id: attendanceRecords.id, enrollmentId: attendanceRecords.enrollmentId, status: attendanceRecords.status, note: attendanceRecords.note, markedAt: attendanceRecords.markedAt, updatedAt: attendanceRecords.updatedAt })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.schoolId, schoolId), eq(attendanceRecords.sectionId, sectionId), eq(attendanceRecords.sessionId, sessionId), eq(attendanceRecords.attendanceDate, date)));
}

function versionOf(rows: { id: string; status: string; note: string | null; markedAt: Date; updatedAt: Date | null }[]): string {
  const latest = rows.reduce((m, r) => Math.max(m, (r.updatedAt ?? r.markedAt).getTime()), 0);
  return `${rows.length}.${latest}`;
}

function teacherWindowOpen(settings: AttendanceSettings, date: string): boolean {
  return date <= settings.today && date >= addDays(settings.today, -settings.editDays) && (!settings.lockedThrough || date > settings.lockedThrough);
}

export async function getRegister(db: Db, ctx: RequestContext, schoolId: string, input: { sectionId: string; sessionId: string; date: string }): Promise<Register> {
  parse(uuidField("Section"), input.sectionId);
  parse(uuidField("Attendance session"), input.sessionId);
  const date = parse(isoDate("date"), input.date);
  return withCapability(db, ctx, schoolId, "school.attendance.mark", async (tx) => {
    const c = await context(tx, schoolId, input.sectionId, input.sessionId, date);
    const [day] = await daysInRange(tx, schoolId, c.section.yearId, date, date, c.settings);
    const students = await roster(tx, input.sectionId, date);
    const records = await stored(tx, schoolId, input.sectionId, input.sessionId, date);
    const byEnrollment = new Map(records.map((r) => [r.enrollmentId, r]));
    const window = teacherWindowOpen(c.settings, date);
    const locked = !!c.settings.lockedThrough && date <= c.settings.lockedThrough;
    return {
      sectionId: c.section.id,
      sectionLabel: c.section.label,
      yearId: c.section.yearId,
      sessionId: c.session.id,
      sessionName: c.session.name,
      date,
      notSchoolDay: day?.reason ? NON_SCHOOL_DAY_MESSAGE[day.reason] : null,
      events: day?.events ?? [],
      rows: students.map((s) => {
        const r = byEnrollment.get(s.enrollmentId);
        return { ...s, status: r?.status ?? null, note: r?.note ?? null, recordId: r?.id ?? null };
      }),
      marked: records.length,
      version: versionOf(records),
      canWrite: !day?.reason && (c.isAdmin || window),
      changesNeedReason: date < c.settings.today || (c.isAdmin && (locked || !window)),
      writeNeedsReason: c.isAdmin && (locked || !window),
      lockedThrough: c.settings.lockedThrough,
      isAdmin: c.isAdmin,
    };
  });
}

const entrySchema = z.object({
  enrollmentId: z.uuid({ message: "Student not found." }),
  status: z.enum(ATTENDANCE_STATUSES, { message: "Choose present, absent, late or excused for every student." }),
  note: z.union([z.literal("").transform(() => null), z.string().trim().min(1).max(200, "Notes must be at most 200 characters.")]).nullable().optional(),
});

export interface SubmitResult {
  created: number;
  changed: number;
  unchanged: number;
}

/** Saves a whole register. See the module comment for the rules. */
export async function submitRegister(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { sectionId: string; sessionId: string; date: string; version: string; entries: { enrollmentId: string; status: string; note?: string | null }[]; reason?: string | null },
): Promise<SubmitResult> {
  parse(uuidField("Section"), input.sectionId);
  parse(uuidField("Attendance session"), input.sessionId);
  const date = parse(isoDate("date"), input.date);
  const entries = parse(z.array(entrySchema).max(500), input.entries);
  const reason = input.reason?.trim() ? parse(z.string().trim().min(3, "Give a reason of at least 3 characters.").max(200, "Keep the reason under 200 characters."), input.reason) : null;
  try {
    return await withCapability(db, ctx, schoolId, "school.attendance.mark", async (tx, actor) => {
      const c = await context(tx, schoolId, input.sectionId, input.sessionId, date);
      const [day] = await daysInRange(tx, schoolId, c.section.yearId, date, date, c.settings);
      if (day?.reason) throw new AppError("VALIDATION", NON_SCHOOL_DAY_MESSAGE[day.reason], { date: NON_SCHOOL_DAY_MESSAGE[day.reason] });
      const window = teacherWindowOpen(c.settings, date);
      const locked = !!c.settings.lockedThrough && date <= c.settings.lockedThrough;
      if (!c.isAdmin && !window) {
        throw new AppError("FORBIDDEN", locked ? "Attendance for this date is locked. Ask the school administrator to correct it." : `Teachers can take or change attendance up to ${c.settings.editDays} day(s) after the date. Ask the school administrator.`);
      }
      const students = await roster(tx, input.sectionId, date);
      if (students.length === 0) throw new AppError("VALIDATION", "No students are enrolled in this section on that date.");
      const want = new Map(entries.map((e) => [e.enrollmentId, e]));
      if (want.size !== entries.length) throw new AppError("VALIDATION", "A student appears twice in the register.");
      const missing = students.filter((s) => !want.has(s.enrollmentId));
      if (missing.length) throw new AppError("VALIDATION", `Mark every student: ${missing.length} not marked (${missing.slice(0, 3).map((m) => m.displayName).join(", ")}${missing.length > 3 ? ", …" : ""}).`);
      const known = new Map(students.map((s) => [s.enrollmentId, s]));
      if (entries.some((e) => !known.has(e.enrollmentId))) throw new AppError("VALIDATION", "The register lists a student who is not in this section on that date. Reload the register.");

      const records = await stored(tx, schoolId, input.sectionId, input.sessionId, date);
      const byEnrollment = new Map(records.map((r) => [r.enrollmentId, r]));
      const same = (e: z.output<typeof entrySchema>) => {
        const r = byEnrollment.get(e.enrollmentId);
        return !!r && r.status === e.status && (r.note ?? null) === (e.note ?? null);
      };
      if (versionOf(records) !== input.version) {
        // A repeat of a submission that already went through is fine; anything else would overwrite someone.
        if (entries.every(same)) return { created: 0, changed: 0, unchanged: entries.length };
        throw new AppError("CONFLICT", "Someone else saved this register after you opened it. Reload it to see their entries, then save again.");
      }
      const changing = entries.filter((e) => byEnrollment.has(e.enrollmentId) && !same(e));
      const creating = entries.filter((e) => !byEnrollment.has(e.enrollmentId));
      const needsReason = (changing.length > 0 && (date < c.settings.today || (c.isAdmin && (locked || !window)))) || (creating.length > 0 && c.isAdmin && (locked || !window));
      if (needsReason && !reason) {
        throw new AppError("VALIDATION", locked ? "This date is locked: give a reason for the correction." : "Changing earlier attendance needs a reason.", { reason: "A reason is required." });
      }

      if (creating.length) {
        await tx.insert(attendanceRecords).values(
          creating.map((e) => {
            const s = known.get(e.enrollmentId)!;
            return { schoolId, enrollmentId: e.enrollmentId, studentId: s.studentId, sectionId: input.sectionId, sessionId: input.sessionId, attendanceDate: date, status: e.status, note: e.note ?? null, markedBy: actor.userId };
          }),
        );
      }
      for (const e of changing) {
        const r = byEnrollment.get(e.enrollmentId)!;
        await tx.update(attendanceRecords).set({ status: e.status, note: e.note ?? null, updatedBy: actor.userId, updatedAt: sql`now()` }).where(eq(attendanceRecords.id, r.id));
        if (r.status !== e.status) {
          await tx.insert(attendanceChanges).values({ schoolId, recordId: r.id, oldStatus: r.status, newStatus: e.status, reason, changedBy: actor.userId });
        }
      }
      const result = { created: creating.length, changed: changing.length, unchanged: entries.length - creating.length - changing.length };
      if (result.created || result.changed) {
        await audit(tx, {
          action: result.changed ? "attendance.corrected" : "attendance.marked",
          actorUserId: actor.userId,
          schoolId,
          entityType: "section",
          entityId: input.sectionId,
          data: { date, sessionId: input.sessionId, ...result, reason, locked },
        });
      }
      return result;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Two first submissions at the same instant: the loser is told to reload.
    if (uniqueViolation(e)?.includes("attendance_records_one_per_session")) {
      throw new AppError("CONFLICT", "Someone else saved this register at the same moment. Reload it and check the entries.");
    }
    throw e;
  }
}

export interface RecordChange {
  oldStatus: AttendanceStatus;
  newStatus: AttendanceStatus;
  reason: string | null;
  changedBy: string;
  changedAt: Date;
}

/** Change history of a register's entries (administrators). */
export async function getRegisterHistory(db: Db, ctx: RequestContext, schoolId: string, input: { sectionId: string; sessionId: string; date: string }): Promise<(RecordChange & { studentName: string })[]> {
  parse(uuidField("Section"), input.sectionId);
  parse(uuidField("Attendance session"), input.sessionId);
  const date = parse(isoDate("date"), input.date);
  return withCapability(db, ctx, schoolId, "school.attendance.view", async (tx) => {
    const ids = (await stored(tx, schoolId, input.sectionId, input.sessionId, date)).map((r) => r.id);
    if (ids.length === 0) return [];
    return (await tx.execute(sql`
      select c.old_status::text as "oldStatus", c.new_status::text as "newStatus", c.reason, u.full_name as "changedBy", c.changed_at as "changedAt", p.display_name as "studentName"
      from attendance_changes c join attendance_records r on r.id = c.record_id join student_profiles p on p.id = r.student_id join users u on u.id = c.changed_by
      where c.school_id = ${schoolId}::uuid and c.record_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
      order by c.changed_at desc`)) as unknown as (RecordChange & { studentName: string })[];
  });
}

