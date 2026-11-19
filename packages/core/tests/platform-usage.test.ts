import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { getSchoolReport } from "../src/services/operations/school-report";
import { createPlan, createPlatformInvoice, setSubscription } from "../src/services/platform/subscriptions";
import { listPlatformUsage } from "../src/services/platform/usage";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 15.2: platform usage counts and the school reports page. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

describe("platform usage and school reports", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let teacher: RequestContext;
  let platform: RequestContext;
  const today = schoolToday("Asia/Kolkata");

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("pua");
    B = await makeSchool("pub");
    admin = A.ctx(A.adminId);
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    teacher = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Use", email: `t-${randomUUID().slice(0, 6)}@use.test`, employeeNo: "T-1", role: "teacher" })).userId);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c = (await createClass(app.db, admin, A.id, { name: "Class 1", sortOrder: 1 })).id;
    const sec = (await createSection(app.db, admin, A.id, { yearId, classId: c, name: "A" })).id;
    for (const n of [1, 2, 3]) await admitStudent(app.db, admin, A.id, { fullName: `Student ${n}`, admissionNo: `S-${n}`, sectionId: sec });
    await owner.db.execute(sql`insert into jobs (school_id, kind, payload, status) values (${A.id}::uuid, 'test.noop', '{}'::jsonb, 'dead')`);
    await createPlatformInvoice(app.db, platform, A.id, { periodFrom: today, periodTo: addDays(today, 30), amount: "1200" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("platform administrators see per-school counts; nobody else can, even directly", async () => {
    const rows = await listPlatformUsage(app.db, platform);
    const a = rows.find((r) => r.schoolId === A.id)!;
    expect(a).toMatchObject({ code: "pua", plan: null, access: "active", activeStudents: 3, activeStaff: 1, deadJobs: 1, unpaidInvoices: 1, unpaidPaise: 120_000 });
    expect(a.lastActivity).toBeInstanceOf(Date);
    expect(rows.find((r) => r.schoolId === B.id)).toMatchObject({ activeStudents: 0, unpaidInvoices: 0 });
    expect(await outcome(listPlatformUsage(app.db, admin))).toBe("FORBIDDEN");
    const direct = await withContext(app.db, admin, (tx) => tx.execute(sql`select * from platform_school_usage()`)).then(
      () => "OK",
      (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message),
    );
    expect(direct).toMatch(/Only platform administrators/);
  });

  it("the school report covers the plan's modules for administrators only", async () => {
    const r = await getSchoolReport(app.db, admin, A.id);
    expect(r).toMatchObject({ students: { active: 3, admittedThisYear: 3 }, staff: { active: 1 }, attendance: { marks: 0, presentPercent: null } });
    expect(r.exams).toEqual({ publishedThisYear: 0, attemptsLast30: 0, resultsReleased: 0 });
    expect(r.leave).toEqual({ pending: 0, onLeaveToday: 0 });
    expect(r.payroll).toEqual({ lastMonth: null, lastStatus: null, lastNetPaise: null, adjustmentsPending: 0 });
    expect(await outcome(getSchoolReport(app.db, teacher, A.id))).toBe("FORBIDDEN");
    expect(await outcome(getSchoolReport(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");

    const plan = (await createPlan(app.db, platform, { code: "core", name: "Core", modules: [], periodMonths: "12" })).id;
    await setSubscription(app.db, platform, A.id, { planId: plan, startsOn: "2024-01-01", endsOn: addDays(today, 200) });
    const core = await getSchoolReport(app.db, admin, A.id);
    expect([core.modules, core.exams, core.leave, core.payroll]).toEqual([[], null, null, null]);
    expect((await listPlatformUsage(app.db, platform)).find((x) => x.schoolId === A.id)?.plan).toBe("Core");
  });
});
