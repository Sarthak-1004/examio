import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { attendanceRecords, calendarEvents, enrollments, teacherAssignments, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { getRegister, getRegisterHistory, submitRegister, type Register } from "../src/services/attendance/register";
import { attendanceBp, getChildAttendance, getDayStatus, getMyAttendance, getMyRegisters, getSectionAttendanceReport, getStudentAttendance, exportSectionAttendanceCsv } from "../src/services/attendance/reports";
import { isoWeekday, updateAttendanceSettings } from "../src/services/attendance/settings";
import { addTimetableSlot, getMyStudentTimetable, getMyTimetable, getSectionTimetable, getTeacherLoad, removeTimetableSlot, toMinutes } from "../src/services/attendance/timetable";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 6: attendance registers, locks and corrections, reports, and the timetable. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);

describe("attendance and timetable", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let yearId: string;
  let s7A: string;
  let s7B: string;
  let math: string;
  let sci: string;
  let session: string;
  let t1: { userId: string; staffId: string; ctx: RequestContext };
  let t2: { userId: string; staffId: string; ctx: RequestContext };
  let kids: { studentId: string; userId: string; enrollmentId: string }[];
  let today: string;
  let y: number;

  const all = (r: Register, status: "present" | "absent" | "late" | "excused" = "present") => r.rows.map((x) => ({ enrollmentId: x.enrollmentId, status }));
  const reg = (ctx: RequestContext, date = today, sectionId = s7A) => getRegister(app.db, ctx, A.id, { sectionId, sessionId: session, date });
  const submit = (ctx: RequestContext, r: Register, entries: { enrollmentId: string; status: "present" | "absent" | "late" | "excused"; note?: string }[], reason?: string) =>
    submitRegister(app.db, ctx, A.id, { sectionId: r.sectionId, sessionId: r.sessionId, date: r.date, version: r.version, entries, reason });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("atta");
    B = await makeSchool("attb");
    admin = A.ctx(A.adminId);
    today = schoolToday("Asia/Kolkata");
    y = Number(today.slice(0, 4));
    yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    // Every weekday is a school day unless a test says otherwise, so the suite runs on any day.
    await updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [] });
    const c7 = (await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 })).id;
    s7A = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "A" })).id;
    s7B = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "B" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7, subjectIds: [math, sci] });
    const mk = async (no: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@att.test`, employeeNo: no, role: "teacher" });
      return { userId: t.userId, staffId: t.staffId, ctx: A.ctx(t.userId) };
    };
    t1 = await mk("T-1");
    t2 = await mk("T-2");
    await assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: s7A, subjectId: math });
    await assignTeacher(app.db, admin, A.id, { staffId: t2.staffId, sectionId: s7B, subjectId: sci });
    await owner.db.update(teacherAssignments).set({ startsOn: `${y - 1}-06-01` });
    kids = [];
    for (const name of ["Asha", "Bilal", "Chitra", "Dev"]) {
      const k = await admitStudent(app.db, admin, A.id, { fullName: `${name} Student`, admissionNo: `ATT-${name}`, admittedOn: `${y - 1}-06-01`, sectionId: s7A });
      kids.push({ studentId: k.studentId, userId: k.userId, enrollmentId: k.enrollmentId! });
    }
    await owner.db.update(enrollments).set({ startsOn: `${y - 1}-06-01` });
    const [s] = (await owner.db.execute(sql`select id from attendance_sessions where school_id = ${A.id}::uuid`)) as unknown as { id: string }[];
    session = s!.id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  describe("taking a register", () => {
    it("a teacher marks every student once; repeating the submission changes nothing", async () => {
      const r = await reg(t1.ctx);
      expect(r).toMatchObject({ sectionLabel: "Class 7 A", canWrite: true, notSchoolDay: null, marked: 0 });
      expect(r.rows.map((x) => x.status)).toEqual([null, null, null, null]);
      const entries = all(r).map((e, i) => (i === 1 ? { ...e, status: "absent" as const } : e));
      expect(await submit(t1.ctx, r, entries)).toEqual({ created: 4, changed: 0, unchanged: 0 });
      // A double click: same content with the old version is accepted and changes nothing.
      expect(await submit(t1.ctx, r, entries)).toEqual({ created: 0, changed: 0, unchanged: 4 });
      // Different content with the old version would overwrite: refused.
      expect(await outcome(submit(t1.ctx, r, all(r, "late")))).toBe("CONFLICT");
      const again = await reg(t1.ctx);
      expect(again.rows.map((x) => x.status)).toEqual(["present", "absent", "present", "present"]);
      // Same-day changes need no reason; each status change is kept in the history.
      expect(await submit(t1.ctx, again, again.rows.map((x) => ({ enrollmentId: x.enrollmentId, status: x.status === "absent" ? ("late" as const) : x.status! })))).toMatchObject({ changed: 1 });
      const history = await getRegisterHistory(app.db, admin, A.id, { sectionId: s7A, sessionId: session, date: today });
      expect(history.map((h) => [h.studentName, h.oldStatus, h.newStatus])).toEqual([["Bilal Student", "absent", "late"]]);
      const [n] = (await owner.db.execute(sql`select count(*)::int as n from attendance_records where section_id = ${s7A}::uuid and attendance_date = ${today}::date`)) as unknown as { n: number }[];
      expect(n!.n).toBe(4);
    });

    it("every student must be marked, only students of the section, only on school days", async () => {
      const d = addDays(today, -1);
      const r = await reg(t1.ctx, d);
      expect(await message(submit(t1.ctx, r, all(r).slice(1)))).toContain("Mark every student");
      expect(await outcome(submit(t1.ctx, r, [...all(r), { enrollmentId: randomUUID(), status: "present" }]))).toBe("VALIDATION");
      expect(await outcome(reg(t1.ctx, addDays(today, 1)).then((x) => submit(t1.ctx, x, all(x))))).toBe("VALIDATION"); // future
      await owner.db.insert(calendarEvents).values({ schoolId: A.id, academicYearId: yearId, title: "Festival", kind: "holiday", startsOn: addDays(today, -2), endsOn: addDays(today, -2) });
      const hol = await reg(t1.ctx, addDays(today, -2));
      expect(hol.notSchoolDay).toContain("holiday");
      expect(hol.canWrite).toBe(false);
      expect(await message(submit(t1.ctx, hol, all(hol)))).toContain("holiday");
      await updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [isoWeekday(addDays(today, -3))] });
      expect(await message(reg(t1.ctx, addDays(today, -3)).then((x) => submit(t1.ctx, x, all(x))))).toContain("weekly day off");
      await updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [] });
    });

    it("teachers write only their sections, within the edit window and after the lock date", async () => {
      expect(await outcome(reg(t2.ctx))).toBe("NOT_FOUND"); // t2 teaches 7B, not 7A
      expect(await outcome(reg(A.ctx(A.teacherId)))).toBe("NOT_FOUND"); // no assignment
      expect(await outcome(reg(A.ctx(A.studentId)))).toBe("FORBIDDEN");
      const old = await reg(t1.ctx, addDays(today, -5)); // outside the 3-day window
      expect(old.canWrite).toBe(false);
      expect(await outcome(submit(t1.ctx, old, all(old)))).toBe("FORBIDDEN");
      // The database refuses the same write made directly.
      const direct = await withContext(app.db, t1.ctx, (tx) =>
        tx.insert(attendanceRecords).values({ schoolId: A.id, enrollmentId: kids[0]!.enrollmentId, studentId: kids[0]!.studentId, sectionId: s7A, sessionId: session, attendanceDate: addDays(today, -5), status: "present", markedBy: t1.userId }),
      ).then(() => "inserted", () => "refused");
      expect(direct).toBe("refused");

      // Yesterday is inside the window; changing it later needs a reason.
      const y1 = await reg(t1.ctx, addDays(today, -1));
      await submit(t1.ctx, y1, all(y1));
      const y2 = await reg(t1.ctx, addDays(today, -1));
      const changed = y2.rows.map((x, i) => ({ enrollmentId: x.enrollmentId, status: i === 0 ? ("excused" as const) : ("present" as const) }));
      expect(y2.changesNeedReason).toBe(true);
      expect(await outcome(submit(t1.ctx, y2, changed))).toBe("VALIDATION");
      expect(await submit(t1.ctx, y2, changed, "Medical note received")).toMatchObject({ changed: 1 });

      // After locking, the teacher cannot change it; the administrator can, with a reason.
      await updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [], lockedThrough: addDays(today, -1) });
      const locked = await reg(t1.ctx, addDays(today, -1));
      expect(locked.canWrite).toBe(false);
      expect(await outcome(submit(t1.ctx, locked, all(locked)))).toBe("FORBIDDEN");
      const asAdmin = await reg(admin, addDays(today, -1));
      expect(asAdmin).toMatchObject({ canWrite: true, writeNeedsReason: true });
      expect(await outcome(submit(admin, asAdmin, all(asAdmin, "absent")))).toBe("VALIDATION");
      expect(await submit(admin, asAdmin, all(asAdmin, "absent"), "Register was taken on paper")).toMatchObject({ changed: 4 });
      expect(await outcome(updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [], lockedThrough: addDays(today, 1) }))).toBe("VALIDATION");
      expect(await outcome(updateAttendanceSettings(app.db, t1.ctx, A.id, { editDays: 9, weeklyOffDays: [] }))).toBe("FORBIDDEN");
      await updateAttendanceSettings(app.db, admin, A.id, { editDays: 3, weeklyOffDays: [], lockedThrough: "" });
    });

    it("a closed year's attendance is read-only; another school sees nothing", async () => {
      await setAcademicYearStatus(app.db, admin, A.id, yearId, "closed");
      try {
        const r = await reg(admin);
        const write = await withContext(app.db, admin, (tx) =>
          tx.update(attendanceRecords).set({ status: "absent", updatedBy: A.adminId }).where(and(eq(attendanceRecords.sectionId, s7A), eq(attendanceRecords.attendanceDate, today))).returning({ id: attendanceRecords.id }),
        );
        expect(write).toHaveLength(0);
        expect(r.rows.length).toBe(4);
      } finally {
        await owner.db.execute(sql`update academic_years set status = 'current' where id = ${yearId}::uuid`);
      }
      const seen = await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select({ id: attendanceRecords.id }).from(attendanceRecords));
      expect(seen).toHaveLength(0);
      expect(await outcome(getRegister(app.db, B.ctx(B.adminId), B.id, { sectionId: s7A, sessionId: session, date: today }))).toBe("NOT_FOUND");
    });
  });

  describe("summaries and reports", () => {
    it("percentages follow the policy: (present + late) / (present + late + absent); N/A when nothing counts", () => {
      expect(attendanceBp({ present: 3, late: 1, absent: 1, excused: 5 })).toBe(8000);
      expect(attendanceBp({ present: 0, late: 0, absent: 0, excused: 2 })).toBeNull();
      expect(attendanceBp({ present: 1, late: 0, absent: 2, excused: 0 })).toBe(3333);
    });

    it("section report, missing entries, day status and student, parent and teacher views", async () => {
      const from = addDays(today, -1);
      const report = await getSectionAttendanceReport(app.db, admin, A.id, { sectionId: s7A, from, to: today });
      expect(report.schoolDays).toBe(2);
      const asha = report.rows.find((r) => r.displayName === "Asha Student")!;
      // Yesterday: absent (admin correction). Today: present.
      expect(asha).toMatchObject({ present: 1, absent: 1, late: 0, missing: 0, bp: 5000 });
      expect(report.incompleteDates).toEqual([]);
      expect(await exportSectionAttendanceCsv(app.db, admin, A.id, { sectionId: s7A, from, to: today })).toContain("Asha Student,1,0,1,0,0,50.0");
      // Two days ago was a holiday and is not counted; three days ago has no register yet.
      const wider = await getSectionAttendanceReport(app.db, admin, A.id, { sectionId: s7A, from: addDays(today, -3), to: today });
      expect(wider.schoolDays).toBe(3);
      expect(wider.incompleteDates).toEqual([addDays(today, -3)]);
      expect(wider.rows[0]!.missing).toBe(1);

      const status = await getDayStatus(app.db, admin, A.id, today);
      expect(status.rows.find((r) => r.sectionId === s7A)).toMatchObject({ state: "complete", students: 4, marked: 4 });
      expect(status.rows.find((r) => r.sectionId === s7B)).toMatchObject({ state: "no_students" });
      const mine = await getMyRegisters(app.db, t1.ctx, A.id);
      expect(mine.rows.map((r) => r.sectionLabel)).toEqual(["Class 7 A"]);
      expect(await outcome(getDayStatus(app.db, t1.ctx, A.id, today))).toBe("FORBIDDEN");
      expect(await outcome(getSectionAttendanceReport(app.db, t2.ctx, A.id, { sectionId: s7A, from, to: today }))).toBe("NOT_FOUND");

      const own = await getMyAttendance(app.db, A.ctx(kids[0]!.userId), A.id, { from, to: today });
      expect(own).toMatchObject({ present: 1, absent: 1, bp: 5000 });
      expect(own.entries.map((e) => e.status)).toEqual(["absent"]);
      expect((await getStudentAttendance(app.db, admin, A.id, kids[0]!.studentId, { from, to: today })).bp).toBe(5000);
      const parent = await createGuardianAccount(app.db, admin, A.id, kids[0]!.studentId, { fullName: "Parent Of Asha", phone: "9876512345", relationship: "mother" });
      const pctx = A.ctx(parent.userId);
      expect((await getChildAttendance(app.db, pctx, A.id, kids[0]!.studentId, { from, to: today })).bp).toBe(5000);
      expect(await outcome(getChildAttendance(app.db, pctx, A.id, kids[1]!.studentId))).toBe("NOT_FOUND");
      const parentSees = await withContext(app.db, pctx, (tx) => tx.select({ s: attendanceRecords.studentId }).from(attendanceRecords));
      expect(new Set(parentSees.map((r) => r.s))).toEqual(new Set([kids[0]!.studentId]));
    });
  });

  describe("timetable", () => {
    it("refuses section, teacher and room clashes; a removed period frees its time", async () => {
      const mon = { weekday: 1, start: "09:00", end: "09:45" };
      const first = await addTimetableSlot(app.db, admin, A.id, { sectionId: s7A, subjectId: math, staffId: t1.staffId, room: "Lab 1", ...mon });
      expect(await message(addTimetableSlot(app.db, admin, A.id, { sectionId: s7A, subjectId: sci, ...mon, start: "09:30", end: "10:00" }))).toContain("This section already has a period at that time (Class 7 A Mathematics, 09:00–09:45 on Monday)");
      await assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: s7B, subjectId: math });
      expect(await message(addTimetableSlot(app.db, admin, A.id, { sectionId: s7B, subjectId: math, staffId: t1.staffId, ...mon }))).toContain("This teacher is already teaching at that time");
      expect(await message(addTimetableSlot(app.db, admin, A.id, { sectionId: s7B, subjectId: sci, staffId: t2.staffId, room: "lab 1", ...mon }))).toContain("This room is already in use");
      // Back-to-back periods do not clash.
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { sectionId: s7A, subjectId: sci, weekday: 1, start: "09:45", end: "10:30", room: "Lab 1" }))).toBe("OK");
      await removeTimetableSlot(app.db, admin, A.id, first.id);
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { sectionId: s7B, subjectId: math, staffId: t1.staffId, ...mon }))).toBe("OK");
      expect(await outcome(removeTimetableSlot(app.db, admin, A.id, first.id))).toBe("NOT_FOUND");
    });

    it("checks subject, assignment and times; teachers and students read; only admins write", async () => {
      const c = { sectionId: s7B, weekday: 2, start: "11:00", end: "11:40" };
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { ...c, subjectId: sci, staffId: t1.staffId }))).toBe("VALIDATION"); // t1 not assigned sci in 7B
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { ...c, subjectId: sci, end: "10:00" }))).toBe("VALIDATION");
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { ...c, subjectId: sci, start: "25:00" }))).toBe("VALIDATION");
      const other = (await createSubject(app.db, admin, A.id, { name: "French", code: "FRE" })).id;
      expect(await outcome(addTimetableSlot(app.db, admin, A.id, { ...c, subjectId: other }))).toBe("VALIDATION");
      expect(await outcome(addTimetableSlot(app.db, t1.ctx, A.id, { ...c, subjectId: sci }))).toBe("FORBIDDEN");
      expect((await getSectionTimetable(app.db, admin, A.id, s7A)).map((s) => [s.subjectName, s.startMinute])).toEqual([["Science", toMinutes("09:45")]]);
      expect((await getMyTimetable(app.db, t1.ctx, A.id)).map((s) => s.sectionLabel)).toEqual(["Class 7 B"]);
      expect((await getMyStudentTimetable(app.db, A.ctx(kids[0]!.userId), A.id)).map((s) => s.subjectName)).toEqual(["Science"]);
      const load = await getTeacherLoad(app.db, admin, A.id, yearId);
      expect(load.find((l) => l.staffId === t1.staffId)).toMatchObject({ periods: 1, minutes: 45 });
    });
  });
});
