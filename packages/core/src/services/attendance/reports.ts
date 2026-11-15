import { sql } from "drizzle-orm";
import type { Db, RequestContext, Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability, type Capability } from "../../capabilities";
import { addDays } from "../../dates";
import { toCsv } from "../../csv";
import { AppError } from "../../errors";
import { isoDate, parse, uuidField } from "../setup/common";
import { attendanceSettingsTx, daysInRange, type AttendanceSettings, type DayInfo } from "./settings";

/**
 * Attendance summaries and reports (Phase 6).
 *
 * Percentage policy (BUSINESS_RULES.md): (present + late) / (present + late + absent) × 100.
 * Excused and not-recorded entries are left out; with nothing to count the result is N/A (null),
 * never 0 %. Values are computed in basis points with integer arithmetic.
 * "Missing" counts sessions on school days, while the student was enrolled in the section,
 * that have no record.
 */

export interface Counts {
  present: number;
  absent: number;
  late: number;
  excused: number;
}

/** Basis points (0..10000) or null when nothing counts. */
export function attendanceBp(c: Counts): number | null {
  const den = c.present + c.late + c.absent;
  if (den === 0) return null;
  return Math.round(((c.present + c.late) * 10000) / den);
}

export function formatBp(bp: number | null): string {
  if (bp === null) return "N/A";
  return `${(bp / 100).toFixed(1)}%`;
}

const MAX_DAYS = 400;

function checkRange(from: string, to: string): void {
  if (from > to) throw new AppError("VALIDATION", "The start date must not be after the end date.", { from: "After the end date." });
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_DAYS * 86_400_000) throw new AppError("VALIDATION", `Choose a period of at most ${MAX_DAYS} days.`);
}

async function activeSessions(tx: Tx, schoolId: string): Promise<{ id: string; name: string }[]> {
  return (await tx.execute(sql`select id, name from attendance_sessions where school_id = ${schoolId}::uuid and archived_at is null order by sort_order, name`)) as unknown as { id: string; name: string }[];
}

/** The academic year containing a date (the current one if several do). */
async function yearOn(tx: Tx, schoolId: string, date: string): Promise<{ id: string; name: string } | null> {
  const [y] = (await tx.execute(sql`
    select id, name from academic_years where school_id = ${schoolId}::uuid and starts_on <= ${date}::date and ends_on >= ${date}::date
    order by (status = 'current') desc, starts_on desc limit 1`)) as unknown as { id: string; name: string }[];
  return y ?? null;
}

/* ------------------------------------------------------------------ register status for a day */

export interface RegisterStatusRow {
  sectionId: string;
  sectionLabel: string;
  sessionId: string;
  sessionName: string;
  students: number;
  marked: number;
  state: "complete" | "partial" | "missing" | "no_students";
}

export interface DayStatus {
  date: string;
  yearName: string | null;
  day: DayInfo | null;
  rows: RegisterStatusRow[];
  counts: Counts;
}

async function statusFor(tx: Tx, schoolId: string, date: string, onlyMine: boolean): Promise<DayStatus> {
  const settings = await attendanceSettingsTx(tx, schoolId);
  const year = await yearOn(tx, schoolId, date);
  if (!year) return { date, yearName: null, day: null, rows: [], counts: { present: 0, absent: 0, late: 0, excused: 0 } };
  const [day] = await daysInRange(tx, schoolId, year.id, date, date, settings);
  const sessions = await activeSessions(tx, schoolId);
  const sections = (await tx.execute(sql`
    select s.id, c.name || ' ' || s.name as label,
           (select count(*)::int from enrollments e where e.section_id = s.id and e.starts_on <= ${date}::date and (e.ends_on is null or e.ends_on >= ${date}::date)
              and (e.end_reason is null or e.end_reason <> 'corrected')) as students
    from sections s join classes c on c.id = s.class_id
    where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${year.id}::uuid and s.archived_at is null
      ${onlyMine ? sql`and app_teaches_section(s.id, ${date}::date)` : sql``}
    order by c.sort_order, c.name, s.name`)) as unknown as { id: string; label: string; students: number }[];
  const marks = (await tx.execute(sql`
    select section_id as "sectionId", session_id as "sessionId", count(*)::int as n,
           count(*) filter (where status = 'present')::int as present, count(*) filter (where status = 'absent')::int as absent,
           count(*) filter (where status = 'late')::int as late, count(*) filter (where status = 'excused')::int as excused
    from attendance_records where school_id = ${schoolId}::uuid and attendance_date = ${date}::date
    group by section_id, session_id`)) as unknown as ({ sectionId: string; sessionId: string; n: number } & Counts)[];
  const key = (a: string, b: string) => `${a}|${b}`;
  const markMap = new Map(marks.map((m) => [key(m.sectionId, m.sessionId), m]));
  const counts: Counts = { present: 0, absent: 0, late: 0, excused: 0 };
  const rows: RegisterStatusRow[] = [];
  for (const s of sections) {
    for (const ses of sessions) {
      const m = markMap.get(key(s.id, ses.id));
      const marked = m?.n ?? 0;
      if (m) for (const k of ["present", "absent", "late", "excused"] as const) counts[k] += m[k];
      rows.push({
        sectionId: s.id,
        sectionLabel: s.label,
        sessionId: ses.id,
        sessionName: ses.name,
        students: s.students,
        marked,
        state: s.students === 0 ? "no_students" : marked === 0 ? "missing" : marked >= s.students ? "complete" : "partial",
      });
    }
  }
  return { date, yearName: year.name, day: day ?? null, rows, counts };
}

/** Which registers are taken, partly taken or missing on a date, school-wide (administrators). */
export async function getDayStatus(db: Db, ctx: RequestContext, schoolId: string, date: string): Promise<DayStatus> {
  const d = parse(isoDate("date"), date);
  return withCapability(db, ctx, schoolId, "school.attendance.view", (tx) => statusFor(tx, schoolId, d, false));
}

/** The signed-in teacher's registers for a date (sections they teach that day). */
export async function getMyRegisters(db: Db, ctx: RequestContext, schoolId: string, date?: string): Promise<DayStatus & { settings: AttendanceSettings }> {
  return withCapability(db, ctx, schoolId, "school.attendance.mark", async (tx) => {
    const settings = await attendanceSettingsTx(tx, schoolId);
    const d = date ? parse(isoDate("date"), date) : settings.today;
    return { ...(await statusFor(tx, schoolId, d, true)), settings };
  });
}

/* ------------------------------------------------------------------ per-student summaries */

export interface StudentAttendanceRow extends Counts {
  studentId: string;
  displayName: string;
  admissionNo: string;
  rollNo: number | null;
  missing: number;
  bp: number | null;
}

export interface SectionReport {
  sectionLabel: string;
  from: string;
  to: string;
  schoolDays: number;
  sessions: number;
  rows: StudentAttendanceRow[];
  /** Dates (school days) on which at least one session has no record for an enrolled student. */
  incompleteDates: string[];
}

async function sectionReportTx(tx: Tx, schoolId: string, sectionId: string, from: string, to: string): Promise<SectionReport> {
  const [sec] = (await tx.execute(sql`select c.name || ' ' || s.name as label, s.academic_year_id as "yearId" from sections s join classes c on c.id = s.class_id where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid`)) as unknown as { label: string; yearId: string }[];
  if (!sec) throw new AppError("NOT_FOUND", "Section not found.");
  const settings = await attendanceSettingsTx(tx, schoolId);
  const days = (await daysInRange(tx, schoolId, sec.yearId, from, to, settings)).filter((d) => d.schoolDay).map((d) => d.date);
  const sessions = await activeSessions(tx, schoolId);
  const enrolled = (await tx.execute(sql`
    select e.student_id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo", e.roll_no as "rollNo",
           e.starts_on::text as "startsOn", e.ends_on::text as "endsOn"
    from enrollments e join student_profiles p on p.id = e.student_id
    where e.school_id = ${schoolId}::uuid and e.section_id = ${sectionId}::uuid and e.starts_on <= ${to}::date and (e.ends_on is null or e.ends_on >= ${from}::date)
      and (e.end_reason is null or e.end_reason <> 'corrected')
    order by e.roll_no nulls last, lower(p.display_name)`)) as unknown as { studentId: string; displayName: string; admissionNo: string; rollNo: number | null; startsOn: string; endsOn: string | null }[];
  const recs = (await tx.execute(sql`
    select student_id as "studentId", attendance_date::text as date, session_id as "sessionId", status::text as status
    from attendance_records where school_id = ${schoolId}::uuid and section_id = ${sectionId}::uuid and attendance_date between ${from}::date and ${to}::date`)) as unknown as { studentId: string; date: string; sessionId: string; status: keyof Counts }[];
  const recSet = new Set(recs.map((r) => `${r.studentId}|${r.date}|${r.sessionId}`));
  const incomplete = new Set<string>();
  const byStudent = new Map<string, StudentAttendanceRow>();
  for (const e of enrolled) {
    const row = byStudent.get(e.studentId) ?? { studentId: e.studentId, displayName: e.displayName, admissionNo: e.admissionNo, rollNo: e.rollNo, present: 0, absent: 0, late: 0, excused: 0, missing: 0, bp: null };
    for (const d of days) {
      if (d < e.startsOn || (e.endsOn && d > e.endsOn)) continue;
      for (const s of sessions) {
        if (!recSet.has(`${e.studentId}|${d}|${s.id}`)) {
          row.missing++;
          incomplete.add(d);
        }
      }
    }
    byStudent.set(e.studentId, row);
  }
  for (const r of recs) {
    const row = byStudent.get(r.studentId);
    if (row) row[r.status]++;
  }
  const rows = [...byStudent.values()].map((r) => ({ ...r, bp: attendanceBp(r) }));
  return { sectionLabel: sec.label, from, to, schoolDays: days.length, sessions: sessions.length, rows, incompleteDates: [...incomplete].sort() };
}

/** Attendance of a section's students over a period (administrators, or a teacher of the section today). */
export async function getSectionAttendanceReport(db: Db, ctx: RequestContext, schoolId: string, input: { sectionId: string; from: string; to: string }): Promise<SectionReport> {
  parse(uuidField("Section"), input.sectionId);
  const from = parse(isoDate("start date"), input.from);
  const to = parse(isoDate("end date"), input.to);
  checkRange(from, to);
  return withCapability(db, ctx, schoolId, "school.attendance.mark", async (tx) => {
    const [who] = (await tx.execute(sql`select app_can_manage_setup(${schoolId}::uuid) as admin, app_teaches_section(${input.sectionId}::uuid, app_school_today(${schoolId}::uuid)) as teaches`)) as unknown as { admin: boolean; teaches: boolean }[];
    if (!who?.admin && !who?.teaches) throw new AppError("NOT_FOUND", "Section not found.");
    return sectionReportTx(tx, schoolId, input.sectionId, from, to);
  });
}

export async function exportSectionAttendanceCsv(db: Db, ctx: RequestContext, schoolId: string, input: { sectionId: string; from: string; to: string }): Promise<string> {
  const r = await getSectionAttendanceReport(db, ctx, schoolId, input);
  return withCapability(db, ctx, schoolId, "school.attendance.view", async (tx, actor) => {
    await audit(tx, { action: "attendance.exported", actorUserId: actor.userId, schoolId, entityType: "section", entityId: input.sectionId, data: { from: r.from, to: r.to, rows: r.rows.length } });
    return toCsv([
      ["roll_no", "admission_no", "name", "present", "late", "absent", "excused", "not_recorded", "attendance_percent"],
      ...r.rows.map((x) => [x.rollNo === null ? null : String(x.rollNo), x.admissionNo, x.displayName, String(x.present), String(x.late), String(x.absent), String(x.excused), String(x.missing), x.bp === null ? "N/A" : (x.bp / 100).toFixed(1)]),
    ]);
  });
}

export interface StudentAttendance extends Counts {
  from: string;
  to: string;
  bp: number | null;
  missing: number;
  /** Entries other than "present", newest first. */
  entries: { date: string; session: string; status: string; note: string | null }[];
}

async function studentAttendanceTx(tx: Tx, schoolId: string, studentId: string, from: string, to: string): Promise<StudentAttendance> {
  const settings = await attendanceSettingsTx(tx, schoolId);
  const counts = (await tx.execute(sql`
    select count(*) filter (where status = 'present')::int as present, count(*) filter (where status = 'absent')::int as absent,
           count(*) filter (where status = 'late')::int as late, count(*) filter (where status = 'excused')::int as excused
    from attendance_records where school_id = ${schoolId}::uuid and student_id = ${studentId}::uuid and attendance_date between ${from}::date and ${to}::date`)) as unknown as Counts[];
  const entries = (await tx.execute(sql`
    select r.attendance_date::text as date, s.name as session, r.status::text as status, r.note
    from attendance_records r join attendance_sessions s on s.id = r.session_id
    where r.school_id = ${schoolId}::uuid and r.student_id = ${studentId}::uuid and r.attendance_date between ${from}::date and ${to}::date and r.status <> 'present'
    order by r.attendance_date desc, s.sort_order limit 200`)) as unknown as StudentAttendance["entries"];
  // Missing: school days × sessions while enrolled (any section), without a record.
  const spans = (await tx.execute(sql`
    select academic_year_id as "yearId", greatest(starts_on, ${from}::date)::text as "from", least(coalesce(ends_on, ${to}::date), ${to}::date)::text as "to"
    from enrollments where school_id = ${schoolId}::uuid and student_id = ${studentId}::uuid and starts_on <= ${to}::date and (ends_on is null or ends_on >= ${from}::date)
      and (end_reason is null or end_reason <> 'corrected')`)) as unknown as { yearId: string; from: string; to: string }[];
  const sessions = await activeSessions(tx, schoolId);
  const recorded = new Set(
    ((await tx.execute(sql`select attendance_date::text || '|' || session_id as k from attendance_records where school_id = ${schoolId}::uuid and student_id = ${studentId}::uuid and attendance_date between ${from}::date and ${to}::date`)) as unknown as { k: string }[]).map((x) => x.k),
  );
  let missing = 0;
  for (const sp of spans) {
    if (sp.from > sp.to) continue;
    for (const d of (await daysInRange(tx, schoolId, sp.yearId, sp.from, sp.to, settings)).filter((x) => x.schoolDay)) {
      for (const s of sessions) if (!recorded.has(`${d.date}|${s.id}`)) missing++;
    }
  }
  const c = counts[0] ?? { present: 0, absent: 0, late: 0, excused: 0 };
  return { from, to, ...c, bp: attendanceBp(c), missing, entries };
}

function defaultRange(today: string, from?: string, to?: string): { from: string; to: string } {
  const t = to ? parse(isoDate("end date"), to) : today;
  const f = from ? parse(isoDate("start date"), from) : addDays(t, -29);
  checkRange(f, t);
  return { from: f, to: t };
}

async function studentScoped(db: Db, ctx: RequestContext, schoolId: string, capability: Capability, studentId: string | null, range: { from?: string; to?: string }): Promise<StudentAttendance> {
  return withCapability(db, ctx, schoolId, capability, async (tx) => {
    const settings = await attendanceSettingsTx(tx, schoolId);
    const r = defaultRange(settings.today, range.from, range.to);
    let id = studentId;
    if (capability === "school.own_record.view") {
      const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
      if (!me) throw new AppError("NOT_FOUND", "Your school has not added your student details yet.");
      id = me.id;
    } else {
      // The policies decide visibility: an unlinked child or another school's student is not found.
      const [seen] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${id}::uuid`)) as unknown as { id: string }[];
      if (!seen) throw new AppError("NOT_FOUND", "Student not found.");
    }
    return studentAttendanceTx(tx, schoolId, id!, r.from, r.to);
  });
}

/** A student's attendance for administrators (default: the last 30 days). */
export function getStudentAttendance(db: Db, ctx: RequestContext, schoolId: string, studentId: string, range: { from?: string; to?: string } = {}): Promise<StudentAttendance> {
  parse(uuidField("Student"), studentId);
  return studentScoped(db, ctx, schoolId, "school.students.view", studentId, range);
}

/** The signed-in student's own attendance. */
export function getMyAttendance(db: Db, ctx: RequestContext, schoolId: string, range: { from?: string; to?: string } = {}): Promise<StudentAttendance> {
  return studentScoped(db, ctx, schoolId, "school.own_record.view", null, range);
}

/** A linked child's attendance for a parent. */
export function getChildAttendance(db: Db, ctx: RequestContext, schoolId: string, studentId: string, range: { from?: string; to?: string } = {}): Promise<StudentAttendance> {
  parse(uuidField("Student"), studentId);
  return studentScoped(db, ctx, schoolId, "school.children.view", studentId, range);
}
