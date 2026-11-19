import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { hrLeaveRequests, hrStaffAttendance, hrStaffAttendanceChanges, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import {
  cancelLeave,
  createLeaveType,
  decideLeave,
  getMyLeave,
  getMyRegister,
  getStaffLeaveBalances,
  getStaffRegister,
  listLeaveRequests,
  listLeaveTypes,
  markStaffRegister,
  requestLeave,
  updateLeaveType,
} from "../src/services/hr/leave";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 14.2: staff attendance and leave. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("staff attendance and leave", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let teacher: RequestContext;
  let teacher2: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");
  // The Monday of last week: Mon, Tue, (Wed holiday), Thu, Fri are working days; Sun is off.
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const mon = addDays(today, -(dow - 1) - 7);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const fri = addDays(mon, 4);
  const sun = addDays(mon, 6);

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("lva");
    B = await makeSchool("lvb");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@lv.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    await owner.db.execute(sql`insert into calendar_events (school_id, academic_year_id, title, kind, starts_on, ends_on) values (${A.id}::uuid, ${yearId}::uuid, 'Festival', 'holiday', ${wed}::date, ${wed}::date)`);
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Leave", email: `t-${randomUUID().slice(0, 6)}@lv.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    id.teacher = t.staffId;
    const t2 = await createStaffMember(app.db, admin, A.id, { fullName: "Other Teacher", email: `o-${randomUUID().slice(0, 6)}@lv.test`, employeeNo: "T-2", role: "teacher" });
    teacher2 = A.ctx(t2.userId);
    id.teacher2 = t2.staffId;
    // The first administrator's own staff record, for their own leave.
    const [ap] = (await owner.db.execute(sql`insert into staff_profiles (school_id, user_id, employee_no, display_name) values (${A.id}::uuid, ${A.adminId}::uuid, 'A-1', 'Head Admin') returning id`)) as unknown as { id: string }[];
    id.admin = ap!.id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("leave types: paid with a quota in half days, unpaid without; administrators only", async () => {
    expect(await outcome(createLeaveType(app.db, teacher, A.id, { name: "Casual", paid: true, quotaDays: "2" }))).toBe("FORBIDDEN");
    expect(await outcome(createLeaveType(app.db, admin, A.id, { name: "Casual", paid: true, quotaDays: "1.3" }))).toBe("VALIDATION");
    id.casual = (await createLeaveType(app.db, admin, A.id, { name: "Casual", paid: true, quotaDays: "2" })).id;
    id.lwp = (await createLeaveType(app.db, admin, A.id, { name: "Leave without pay", paid: false })).id;
    id.old = (await createLeaveType(app.db, admin, A.id, { name: "Old", paid: true, quotaDays: "1.5" })).id;
    expect(await outcome(createLeaveType(app.db, admin, A.id, { name: "casual", paid: true, quotaDays: "3" }))).toBe("CONFLICT");
    await updateLeaveType(app.db, admin, A.id, id.old, { archived: true });
    expect((await listLeaveTypes(app.db, teacher, A.id)).map((t) => [t.name, t.paid, t.quotaDays, t.archived])).toEqual([
      ["Casual", true, "2", false],
      ["Leave without pay", false, null, false],
      ["Old", true, "1.5", true],
    ]);
  });

  it("requests count working half days, respect balances and never overlap", async () => {
    expect(await message(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.casual!, fromOn: mon, toOn: fri, reason: "Family trip" }))).toMatch(/Only 2 day\(s\) of Casual/); // 4 working days
    expect(await message(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.casual!, fromOn: wed, toOn: wed, reason: "Festival" }))).toMatch(/no working days/);
    expect(await message(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.casual!, fromOn: sun, reason: "Sunday" }))).toMatch(/no working days/);
    expect(await outcome(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.old!, fromOn: mon, reason: "Archived type" }))).toBe("NOT_FOUND");
    const a = await requestLeave(app.db, teacher, A.id, { leaveTypeId: id.casual!, fromOn: mon, toOn: tue, reason: "Family trip" });
    expect(a.days).toBe("2");
    id.reqA = a.id;
    expect(await message(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.lwp!, fromOn: tue, halfDay: true, reason: "Clinic" }))).toMatch(/overlaps/);
    expect(await message(requestLeave(app.db, teacher, A.id, { leaveTypeId: id.casual!, fromOn: thu, halfDay: true, reason: "Clinic" }))).toMatch(/Only 0 day/); // pending counts
    const b = await requestLeave(app.db, teacher, A.id, { leaveTypeId: id.lwp!, fromOn: wed, toOn: fri, reason: "Wedding" });
    expect(b.days).toBe("2"); // Wed is a holiday
    id.reqB = b.id;
    // A teacher cannot request for a colleague, by the service or directly.
    expect(await outcome(requestLeave(app.db, teacher, A.id, { staffId: id.teacher2, leaveTypeId: id.lwp!, fromOn: mon, reason: "For a friend" }))).toBe("FORBIDDEN");
    expect(
      await dbError(
        withContext(app.db, teacher, (tx) =>
          tx.insert(hrLeaveRequests).values({ schoolId: A.id, staffId: id.teacher2!, leaveTypeId: id.lwp!, academicYearId: randomUUID(), fromOn: mon, toOn: mon, daysHalves: 2, reason: "Direct", requestedBy: String(teacher.userId) }),
        ),
      ),
    ).toMatch(/row-level security|foreign key/);
  });

  it("another administrator decides; approval fills the register; nobody decides their own", async () => {
    expect(await outcome(decideLeave(app.db, teacher, A.id, id.reqA!, true))).toBe("FORBIDDEN");
    expect(await outcome(decideLeave(app.db, admin, A.id, id.reqA!, false))).toBe("VALIDATION"); // rejection needs a reason
    expect((await listLeaveRequests(app.db, admin, A.id, { status: "pending" })).find((r) => r.id === id.reqA)).toMatchObject({ remaining: "2", days: "2" });
    await decideLeave(app.db, admin, A.id, id.reqA!, true);
    expect(await message(decideLeave(app.db, admin, A.id, id.reqA!, true))).toMatch(/already been decided/);
    const marks = await owner.db.select().from(hrStaffAttendance).where(eq(hrStaffAttendance.staffId, id.teacher!));
    expect(marks.map((m) => [m.on, m.status]).sort()).toEqual([[mon, "leave"], [tue, "leave"]]);

    // An administrator's own leave, and leave an administrator requested, need another administrator.
    const own = await requestLeave(app.db, admin, A.id, { leaveTypeId: id.casual!, fromOn: thu, reason: "Conference" });
    expect(await outcome(decideLeave(app.db, admin, A.id, own.id, true))).toBe("FORBIDDEN");
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(hrLeaveRequests).set({ status: "approved", decidedBy: A.adminId, decidedAt: new Date() }).where(eq(hrLeaveRequests.id, own.id))))).toMatch(/other than the staff member/);
    await decideLeave(app.db, admin2, A.id, own.id, true);
    const forT2 = await requestLeave(app.db, admin, A.id, { staffId: id.teacher2, leaveTypeId: id.casual!, fromOn: mon, reason: "Sick child" });
    expect(await outcome(decideLeave(app.db, admin, A.id, forT2.id, true))).toBe("FORBIDDEN");
    await decideLeave(app.db, admin2, A.id, forT2.id, false, "Use sick leave instead");
    expect((await getStaffLeaveBalances(app.db, admin, A.id, id.teacher!)).map((b) => [b.name, b.quotaDays, b.approvedDays, b.pendingDays, b.remainingDays])).toEqual([["Casual", "2", "2", "0", "0"]]);
  });

  it("cancelling: staff their pending requests; administrators approved ones with a reason, clearing the register", async () => {
    expect(await outcome(cancelLeave(app.db, teacher2, A.id, id.reqB!))).toBe("NOT_FOUND"); // someone else's
    await cancelLeave(app.db, teacher, A.id, id.reqB!);
    expect(await outcome(cancelLeave(app.db, teacher, A.id, id.reqA!))).toBe("FORBIDDEN");
    expect(await outcome(cancelLeave(app.db, admin, A.id, id.reqA!))).toBe("VALIDATION");
    await cancelLeave(app.db, admin, A.id, id.reqA!, "Trip called off");
    const marks = await owner.db.select().from(hrStaffAttendance).where(eq(hrStaffAttendance.staffId, id.teacher!));
    expect(marks.map((m) => [m.on, m.status, m.leaveRequestId])).toEqual(expect.arrayContaining([[mon, null, null], [tue, null, null]]));
    const changes = await owner.db.select().from(hrStaffAttendanceChanges).where(eq(hrStaffAttendanceChanges.staffId, id.teacher!));
    expect(changes.map((c) => [c.fromStatus, c.toStatus])).toEqual([["leave", null], ["leave", null]]);
    expect((await getStaffLeaveBalances(app.db, admin, A.id, id.teacher!))[0]).toMatchObject({ remainingDays: "2" });
    // Requests keep their dates, even for an administrator writing directly.
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(hrLeaveRequests).set({ status: "pending" }).where(eq(hrLeaveRequests.id, id.reqA!))))).toMatch(/cannot go from cancelled to pending|row-level security/);
  });

  it("the staff register: first marks free, corrections need a reason, leave marks are not overwritten, no future days", async () => {
    const r = await getStaffRegister(app.db, admin, A.id, thu);
    expect(r.workingDay).toBe(true);
    expect(r.rows.find((x) => x.staffId === id.admin)).toMatchObject({ status: "leave", leaveType: "Casual" });
    expect((await getStaffRegister(app.db, admin, A.id, wed)).workingDay).toBe(false);
    expect(
      await markStaffRegister(app.db, admin, A.id, {
        date: thu,
        marks: [
          { staffId: id.teacher!, status: "present" },
          { staffId: id.teacher2!, status: "half_day" },
          { staffId: id.admin!, status: "present" },
        ],
      }),
    ).toEqual({ marked: 2, corrected: 0, skippedLeave: 1 });
    expect(await outcome(markStaffRegister(app.db, admin, A.id, { date: thu, marks: [{ staffId: id.teacher!, status: "absent" }] }))).toBe("VALIDATION");
    expect(await markStaffRegister(app.db, admin, A.id, { date: thu, marks: [{ staffId: id.teacher!, status: "absent" }], reason: "Marked by mistake" })).toEqual({ marked: 0, corrected: 1, skippedLeave: 0 });
    // A day cleared by cancelled leave is marked again without a reason, but the change is kept.
    expect(await markStaffRegister(app.db, admin, A.id, { date: mon, marks: [{ staffId: id.teacher!, status: "present" }] })).toEqual({ marked: 1, corrected: 0, skippedLeave: 0 });
    expect(await outcome(markStaffRegister(app.db, admin, A.id, { date: addDays(today, 1), marks: [{ staffId: id.teacher!, status: "present" }] }))).toBe("VALIDATION");
    expect(await outcome(markStaffRegister(app.db, admin, A.id, { date: thu, marks: [{ staffId: id.teacher!, status: "leave" }] }))).toBe("VALIDATION");
    expect(await outcome(markStaffRegister(app.db, teacher, A.id, { date: thu, marks: [{ staffId: id.teacher!, status: "present" }] }))).toBe("FORBIDDEN");
    const mine = await getMyRegister(app.db, teacher, A.id, thu.slice(0, 7));
    expect(mine.find((x) => x.on === thu)?.status).toBe("absent");
  });

  it("staff see their own leave only; other schools see nothing", async () => {
    const my = await getMyLeave(app.db, teacher, A.id);
    expect(my?.requests.map((r) => r.status).sort()).toEqual(["cancelled", "cancelled"]);
    expect(my?.balances.map((b) => [b.name, b.remainingDays])).toEqual([["Casual", "2"]]);
    expect((await withContext(app.db, teacher2, (tx) => tx.select().from(hrLeaveRequests))).every((r) => r.staffId === id.teacher2)).toBe(true);
    expect(await withContext(app.db, teacher2, (tx) => tx.select().from(hrStaffAttendance).where(and(eq(hrStaffAttendance.staffId, id.teacher!))))).toHaveLength(0);
    expect(await outcome(listLeaveRequests(app.db, teacher, A.id))).toBe("FORBIDDEN");
    const other = B.ctx(B.adminId);
    expect(await withContext(app.db, other, (tx) => tx.select().from(hrLeaveRequests))).toHaveLength(0);
    expect(await outcome(decideLeave(app.db, other, B.id, id.reqA!, true))).toBe("NOT_FOUND");
    expect(await outcome(getStaffLeaveBalances(app.db, other, B.id, id.teacher!))).toBe("NOT_FOUND");
  });
});
