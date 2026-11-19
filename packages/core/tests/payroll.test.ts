import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { payrollSlips, staffSalaries, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { createLeaveType, decideLeave, markStaffRegister, requestLeave, workingDays } from "../src/services/hr/leave";
import { calculateSlip, mulDivRound } from "../src/services/payroll/calc";
import { addSalaryVersion, calculateRun, createComponent, createRun, getRun, getStaffSalaries, listComponents, listRuns, listSalaries, monthEnd, setComponentArchived } from "../src/services/payroll/payroll";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 14.3: payroll calculation. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("payroll arithmetic", () => {
  it("rounds to the nearest paisa, halves up, in integers", () => {
    expect([mulDivRound(1, 1, 2), mulDivRound(4, 1, 10), mulDivRound(5, 1, 10), mulDivRound(7, 3, 0)]).toEqual([1, 0, 1, 0]);
  });

  it("prorates basic and fixed components, applies percentages and caps", () => {
    const r = calculateSlip({
      monthWorkingHalves: 52, // 26 working days
      workingHalves: 52,
      lopHalves: 2, // one day's loss of pay
      basicPaise: 3_000_000, // ₹30,000
      components: [
        { componentId: "hra", name: "HRA", kind: "earning", calc: "percent_basic", prorate: true, capPaise: null, value: 4000 },
        { componentId: "tr", name: "Transport", kind: "earning", calc: "fixed", prorate: true, capPaise: null, value: 160_000 },
        { componentId: "bonus", name: "Fixed bonus", kind: "earning", calc: "fixed", prorate: false, capPaise: null, value: 50_000 },
        { componentId: "pf", name: "PF", kind: "deduction", calc: "percent_basic", prorate: true, capPaise: 180_000, value: 1200 },
        { componentId: "pt", name: "Professional tax", kind: "deduction", calc: "fixed", prorate: false, capPaise: null, value: 20_000 },
        { componentId: "tds", name: "TDS", kind: "deduction", calc: "percent_gross", prorate: true, capPaise: null, value: 500 },
      ],
    });
    // 30000 × 50/52 = 28846.1538… → ₹28,846.15
    expect(r.earnedBasicPaise).toBe(2_884_615);
    expect(r.lines.map((l) => [l.componentId, l.amountPaise])).toEqual([
      ["hra", 1_153_846], // 40% of 28846.15 = 11538.46
      ["tr", 153_846], // 1600 × 50/52 = 1538.4615…
      ["bonus", 50_000], // not prorated
      ["pf", 180_000], // 12% = 3461.54, capped at 1800
      ["pt", 20_000],
      ["tds", 212_115], // 5% of gross 42423.07 = 2121.1535
    ]);
    expect(r.grossPaise).toBe(2_884_615 + 1_153_846 + 153_846 + 50_000);
    expect(r.netPaise).toBe(r.grossPaise - 412_115);
    expect(r.payableHalves).toBe(50);
  });

  it("is deterministic and handles no working days", () => {
    const i = { monthWorkingHalves: 0, workingHalves: 0, lopHalves: 0, basicPaise: 1_000_000, components: [] };
    expect(calculateSlip(i)).toEqual(calculateSlip(i));
    expect(calculateSlip(i).netPaise).toBe(0);
  });
});

describe("payroll runs", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let finance: RequestContext;
  let teacher: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");
  // Last calendar month, entirely in the past and inside the academic year.
  const lastMonthStart = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  const lastMonthEnd = monthEnd(lastMonthStart);
  const month = lastMonthStart.slice(0, 7);

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("pya");
    B = await makeSchool("pyb");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@py.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    finance = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Pay Clerk", email: `f-${randomUUID().slice(0, 6)}@py.test`, employeeNo: "F-1", role: "finance" })).userId);
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Asha Teacher", email: `t-${randomUUID().slice(0, 6)}@py.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    id.teacher = t.staffId;
    const late = await createStaffMember(app.db, admin, A.id, { fullName: "Late Joiner", email: `l-${randomUUID().slice(0, 6)}@py.test`, employeeNo: "T-2", role: "teacher" });
    id.late = late.staffId;
    await owner.db.execute(sql`update staff_profiles set joined_on = ${addDays(lastMonthStart, 15)}::date where id = ${late.staffId}::uuid`);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("components and salaries: administrators set them, finance reads them, teachers neither", async () => {
    expect(await outcome(createComponent(app.db, finance, A.id, { name: "HRA", kind: "earning", calc: "percent_basic", prorate: true }))).toBe("FORBIDDEN");
    id.hra = (await createComponent(app.db, admin, A.id, { name: "HRA", kind: "earning", calc: "percent_basic", prorate: true })).id;
    id.pf = (await createComponent(app.db, admin, A.id, { name: "PF", kind: "deduction", calc: "percent_basic", prorate: true, cap: "1800" })).id;
    id.pt = (await createComponent(app.db, admin, A.id, { name: "Professional tax", kind: "deduction", calc: "fixed", prorate: false })).id;
    id.old = (await createComponent(app.db, admin, A.id, { name: "Old allowance", kind: "earning", calc: "fixed", prorate: true })).id;
    expect(await outcome(createComponent(app.db, admin, A.id, { name: "Bad", kind: "earning", calc: "percent_gross", prorate: true }))).toBe("VALIDATION");
    expect(await outcome(createComponent(app.db, admin, A.id, { name: "Bad cap", kind: "earning", calc: "fixed", prorate: true, cap: "100" }))).toBe("VALIDATION");
    expect(await outcome(createComponent(app.db, admin, A.id, { name: "hra", kind: "earning", calc: "fixed", prorate: true }))).toBe("CONFLICT");
    await setComponentArchived(app.db, admin, A.id, id.old, true);
    expect((await listComponents(app.db, finance, A.id)).map((c) => [c.name, c.archived])).toEqual([["HRA", false], ["PF", false], ["Professional tax", false], ["Old allowance", true]]);
    expect(await outcome(listComponents(app.db, teacher, A.id))).toBe("FORBIDDEN");

    const lines = [{ componentId: id.hra, value: "40" }, { componentId: id.pf, value: "12" }, { componentId: id.pt, value: "200" }];
    expect(await outcome(addSalaryVersion(app.db, finance, A.id, id.teacher!, { effectiveFrom: lastMonthStart, basic: "30000", lines }))).toBe("FORBIDDEN");
    expect(await outcome(addSalaryVersion(app.db, admin, A.id, id.teacher!, { effectiveFrom: lastMonthStart, basic: "30000", lines: [{ componentId: id.hra, value: "140" }] }))).toBe("VALIDATION");
    expect(await outcome(addSalaryVersion(app.db, admin, A.id, id.teacher!, { effectiveFrom: lastMonthStart, basic: "30000", lines: [{ componentId: id.old, value: "100" }] }))).toBe("NOT_FOUND");
    id.sal1 = (await addSalaryVersion(app.db, admin, A.id, id.teacher!, { effectiveFrom: "2025-01-01", basic: "28,000", lines })).id;
    id.sal2 = (await addSalaryVersion(app.db, admin, A.id, id.teacher!, { effectiveFrom: lastMonthStart, basic: "30000", lines, note: "Annual increment" })).id;
    await addSalaryVersion(app.db, admin, A.id, id.late!, { effectiveFrom: addDays(lastMonthStart, 15), basic: "20000", lines: [] });
    const v = await getStaffSalaries(app.db, finance, A.id, id.teacher!);
    expect(v.versions.map((x) => [x.effectiveFrom, x.basicPaise, x.lines.length])).toEqual([[lastMonthStart, 3_000_000, 3], ["2025-01-01", 2_800_000, 3]]);
    expect((await listSalaries(app.db, finance, A.id)).find((s) => s.staffId === id.teacher)?.basicPaise).toBe(3_000_000);
    // Versions are never edited, and amounts stay out of the audit log.
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(staffSalaries).set({ basicPaise: 1 }).where(eq(staffSalaries.id, id.sal2!))))).toMatch(/permission denied/);
    const logged = (await owner.db.execute(sql`select count(*)::int as n from audit_events where action = 'payroll.salary_added' and data::text like '%3000000%'`)) as unknown as { n: number }[];
    expect(logged[0]!.n).toBe(0);
  });

  it("a run is calculated from attendance and unpaid leave, with a snapshot of its inputs", async () => {
    const days = await withContext(app.db, admin, (tx) => workingDays(tx, A.id, lastMonthStart, lastMonthEnd));
    // One absence, one half day and one day of unpaid leave on working days of last month.
    const [d1, d2, d3] = [days[1]!, days[2]!, days[3]!];
    await markStaffRegister(app.db, admin, A.id, { date: d1, marks: [{ staffId: id.teacher!, status: "absent" }] });
    await markStaffRegister(app.db, admin, A.id, { date: d2, marks: [{ staffId: id.teacher!, status: "half_day" }] });
    const lwp = (await createLeaveType(app.db, admin, A.id, { name: "Leave without pay", paid: false })).id;
    const req = await requestLeave(app.db, admin, A.id, { staffId: id.teacher, leaveTypeId: lwp, fromOn: d3, reason: "Personal" });
    await decideLeave(app.db, admin2, A.id, req.id, true);

    expect(await outcome(createRun(app.db, teacher, A.id, month))).toBe("FORBIDDEN");
    id.run = (await createRun(app.db, finance, A.id, month)).id;
    expect(await outcome(createRun(app.db, admin, A.id, month))).toBe("CONFLICT");
    expect(await calculateRun(app.db, finance, A.id, id.run)).toEqual({ included: 2, excluded: 1 }); // the clerk has no salary

    const run = await getRun(app.db, finance, A.id, id.run);
    const slip = run.slips.find((s) => s.staffId === id.teacher)!;
    expect(slip).toMatchObject({ workingDays: String(days.length), lopDays: "2.5", payableDays: String(days.length - 2.5), basicPaise: 3_000_000 });
    const [row] = await owner.db.select().from(payrollSlips).where(eq(payrollSlips.id, slip.id));
    const inputs = row!.inputs as { salaryId: string; lop: unknown; components: unknown[] };
    expect(inputs.salaryId).toBe(id.sal2);
    expect(inputs.lop).toEqual({ absentDays: 1, halfDays: 1, unpaidLeaveHalves: 2 });
    // Recalculating the stored inputs gives exactly the stored result.
    const again = calculateSlip(row!.inputs as Parameters<typeof calculateSlip>[0]);
    expect([again.grossPaise, again.deductionsPaise, again.netPaise]).toEqual([row!.grossPaise, row!.deductionsPaise, row!.netPaise]);
    expect(slip.lines.find((l) => l.name === "PF")?.amountPaise).toBe(180_000); // capped
    // The late joiner is paid from their joining date only.
    const late = run.slips.find((s) => s.staffId === id.late)!;
    expect(Number(late.workingDays)).toBe(days.filter((d) => d >= addDays(lastMonthStart, 15)).length);
    expect(run.notIncluded.map((n) => n.name)).toEqual(["Pay Clerk"]);
    expect(run.totals.netPaise).toBe(run.slips.reduce((a, s) => a + s.netPaise, 0));
  });

  it("recalculating a draft picks up changes and keeps one slip per person", async () => {
    await addSalaryVersion(app.db, admin, A.id, id.teacher!, { effectiveFrom: addDays(lastMonthStart, 10), basic: "33000", lines: [] });
    await calculateRun(app.db, admin, A.id, id.run!);
    const run = await getRun(app.db, admin, A.id, id.run!);
    const slip = run.slips.find((s) => s.staffId === id.teacher)!;
    expect(slip.basicPaise).toBe(3_300_000);
    expect(slip.lines).toEqual([]);
    expect(await owner.db.select().from(payrollSlips).where(eq(payrollSlips.runId, id.run!))).toHaveLength(2);
    expect((await listRuns(app.db, finance, A.id))[0]).toMatchObject({ periodStart: lastMonthStart, status: "draft", staff: 2 });
  });

  it("teachers and other schools see no salaries or slips", async () => {
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(staffSalaries))).toHaveLength(0);
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(payrollSlips))).toHaveLength(0);
    expect(await outcome(getRun(app.db, teacher, A.id, id.run!))).toBe("FORBIDDEN");
    const other = B.ctx(B.adminId);
    expect(await withContext(app.db, other, (tx) => tx.select().from(payrollSlips))).toHaveLength(0);
    expect(await outcome(getRun(app.db, other, B.id, id.run!))).toBe("NOT_FOUND");
    expect(await outcome(calculateRun(app.db, other, B.id, id.run!))).toBe("NOT_FOUND");
    expect(await outcome(getStaffSalaries(app.db, other, B.id, id.teacher!))).toBe("NOT_FOUND");
  });
});
