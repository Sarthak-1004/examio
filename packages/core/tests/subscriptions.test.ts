import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { platformInvoices, withContext, type RequestContext } from "@examio/db";
import { withCapability } from "../src/capabilities";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { startExam } from "../src/services/exams/taking";
import { createTitle, searchCatalogue } from "../src/services/library/library";
import { exportLibraryLoansCsv } from "../src/services/operations/reports";
import {
  cancelPlatformInvoice,
  createPlan,
  createPlatformInvoice,
  getMySubscription,
  getSchoolAccess,
  getSubscription,
  listPlans,
  recordPlatformPayment,
  setOverrides,
  setSubscription,
} from "../src/services/platform/subscriptions";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 15.1: subscriptions, entitlements, read-only expiry and platform billing. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);

describe("subscriptions", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let teacher: RequestContext;
  let platform: RequestContext;
  let sectionId: string;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");
  const endsIn = (days: number) => setSubscription(app.db, platform, A.id, { planId: id.basic!, startsOn: "2024-01-01", endsOn: addDays(today, days), reason: "Test dates" });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("sba");
    B = await makeSchool("sbb");
    admin = A.ctx(A.adminId);
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    teacher = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Sub", email: `t-${randomUUID().slice(0, 6)}@sub.test`, employeeNo: "T-1", role: "teacher" })).userId);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c = (await createClass(app.db, admin, A.id, { name: "Class 1", sortOrder: 1 })).id;
    sectionId = (await createSection(app.db, admin, A.id, { yearId, classId: c, name: "A" })).id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("a school without a subscription keeps full access", async () => {
    expect(await getSchoolAccess(app.db, teacher, A.id)).toMatchObject({ access: "active", endsOn: null, modules: ["admissions", "exams", "fees", "hr", "inventory", "library", "payroll", "practice", "transport"] });
    await createTitle(app.db, admin, A.id, { title: "Before plans", accessionNos: "Z-1" });
  });

  it("plans are platform-only; modules outside the plan are refused on the server", async () => {
    expect(await outcome(createPlan(app.db, admin, { code: "basic", name: "Basic", modules: ["exams"], periodMonths: "12" }))).toBe("FORBIDDEN");
    id.basic = (await createPlan(app.db, platform, { code: "basic", name: "Basic", modules: ["exams"], maxStudents: "2", price: "30000", periodMonths: "12" })).id;
    expect(await outcome(createPlan(app.db, platform, { code: "BASIC", name: "Again", modules: [], periodMonths: "12" }))).toBe("CONFLICT");
    expect(await outcome(createPlan(app.db, platform, { code: "x", name: "Bad", modules: ["chess"], periodMonths: "12" }))).toBe("VALIDATION");
    expect((await listPlans(app.db, platform)).map((p) => [p.code, p.modules, p.maxStudents, p.pricePaise])).toEqual([["basic", ["exams"], 2, 3_000_000]]);

    await setSubscription(app.db, platform, A.id, { planId: id.basic, startsOn: "2024-01-01", endsOn: addDays(today, 100) });
    expect(await message(searchCatalogue(app.db, admin, A.id))).toBe("Library is not part of your school's plan.");
    expect(await outcome(setSubscription(app.db, platform, A.id, { planId: id.basic, startsOn: "2024-01-01", endsOn: addDays(today, 90) }))).toBe("VALIDATION"); // a change needs a reason
    expect(await outcome(setOverrides(app.db, platform, A.id, { modulesAdded: ["library"], modulesRemoved: [], reason: "" }))).toBe("VALIDATION");
    await setOverrides(app.db, platform, A.id, { modulesAdded: ["library"], modulesRemoved: [], reason: "Pilot of the library module" });
    expect((await searchCatalogue(app.db, admin, A.id)).map((t) => t.title)).toEqual(["Before plans"]); // records kept from before
    expect((await getSchoolAccess(app.db, teacher, A.id)).modules).toEqual(["exams", "library"]);
  });

  it("the student cap is enforced by the database, also when two admissions race", async () => {
    await admitStudent(app.db, admin, A.id, { fullName: "First", admissionNo: "S-1", sectionId });
    const race = await Promise.allSettled([
      admitStudent(app.db, admin, A.id, { fullName: "Second", admissionNo: "S-2", sectionId }),
      admitStudent(app.db, admin, A.id, { fullName: "Third", admissionNo: "S-3", sectionId }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as AppError).message).toMatch(/plan allows 2 active students/);
    await setOverrides(app.db, platform, A.id, { modulesAdded: ["library"], modulesRemoved: [], maxStudentsOverride: "3", reason: "Extra seats agreed" });
    await admitStudent(app.db, admin, A.id, { fullName: "Fourth", admissionNo: "S-4", sectionId });
    expect((await getSubscription(app.db, platform, A.id))).toMatchObject({ maxStudents: 3, activeStudents: 3 });
  });

  it("due, grace and read-only follow the end date; read-only keeps reads and exports and refuses writes", async () => {
    await endsIn(10);
    expect((await getSchoolAccess(app.db, teacher, A.id)).access).toBe("due");
    await endsIn(-5);
    expect(await getSchoolAccess(app.db, teacher, A.id)).toMatchObject({ access: "grace", daysLeft: -5 });
    await createTitle(app.db, admin, A.id, { title: "In grace", accessionNos: "Z-2" }); // grace still writes
    await endsIn(-16);
    expect((await getSchoolAccess(app.db, teacher, A.id)).access).toBe("read_only");
    expect(await message(createTitle(app.db, admin, A.id, { title: "Too late", accessionNos: "Z-3" }))).toMatch(/read-only/);
    expect(await message(admitStudent(app.db, admin, A.id, { fullName: "Late", admissionNo: "S-9", sectionId }))).toMatch(/read-only/);
    expect((await searchCatalogue(app.db, admin, A.id)).map((t) => t.title).sort()).toEqual(["Before plans", "In grace"]);
    expect(await exportLibraryLoansCsv(app.db, admin, A.id)).toMatch(/^Title,/); // the export and its audit record still work
    // Finishing an exam is exempt; starting a new attempt is not.
    const flag = (cap: "school.exams.take" | "school.library.manage", ctx: RequestContext) =>
      withCapability(app.db, ctx, A.id, cap, async (tx) => ((await tx.execute(sql`select current_setting('app.school_read_only', true) as v`)) as unknown as { v: string | null }[])[0]!.v);
    expect(await flag("school.library.manage", admin)).toBe("on");
    const [student] = (await owner.db.execute(sql`select user_id from student_profiles where admission_no = 'S-1'`)) as unknown as { user_id: string }[];
    expect(await flag("school.exams.take", A.ctx(student!.user_id))).not.toBe("on");
    expect(await message(startExam(app.db, A.ctx(student!.user_id), A.id, randomUUID()))).toMatch(/read-only/);
    // Nothing was deleted.
    const count = (await owner.db.execute(sql`select count(*)::int as n from student_profiles where school_id = ${A.id}::uuid`)) as unknown as { n: number }[];
    expect(count[0]!.n).toBe(3);
  });

  it("paying an invoice renews; recording the same payment again changes nothing", async () => {
    const inv = await createPlatformInvoice(app.db, platform, A.id, { periodFrom: today, periodTo: addDays(today, 364), amount: "30000", note: "Annual" });
    const inv2 = await createPlatformInvoice(app.db, platform, A.id, { periodFrom: today, periodTo: addDays(today, 30), amount: "500" });
    expect([inv.number, inv2.number]).toEqual([`PI-${today.slice(0, 4)}-0001`, `PI-${today.slice(0, 4)}-0002`]);
    expect(await recordPlatformPayment(app.db, platform, inv.id, { paidOn: today, reference: "UTR-1" })).toEqual({ alreadyRecorded: false, extendedTo: addDays(today, 364) });
    expect(await recordPlatformPayment(app.db, platform, inv.id, { paidOn: today, reference: "UTR-1" })).toEqual({ alreadyRecorded: true, extendedTo: null });
    expect(await outcome(recordPlatformPayment(app.db, platform, inv.id, { paidOn: today, reference: "UTR-2" }))).toBe("CONFLICT");
    expect(await outcome(cancelPlatformInvoice(app.db, platform, inv.id, "Wrong amount"))).toBe("CONFLICT");
    await cancelPlatformInvoice(app.db, platform, inv2.id, "Raised twice");
    expect(await outcome(recordPlatformPayment(app.db, platform, inv2.id, { paidOn: today, reference: "UTR-3" }))).toBe("CONFLICT");
    expect((await getSchoolAccess(app.db, teacher, A.id)).access).toBe("active");
    await createTitle(app.db, admin, A.id, { title: "After renewal", accessionNos: "Z-4" });
    const sub = await getSubscription(app.db, platform, A.id);
    expect(sub.history.map((h) => h.kind)).toEqual(["renewed", "changed", "changed", "changed", "overridden", "overridden", "assigned"]);
  });

  it("school administrators see their own subscription and invoices only; nobody else changes them", async () => {
    const mine = await getMySubscription(app.db, admin, A.id);
    expect(mine.invoices.map((i) => i.status).sort()).toEqual(["cancelled", "paid"]);
    expect(await outcome(getMySubscription(app.db, teacher, A.id))).toBe("FORBIDDEN");
    expect(await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select().from(platformInvoices))).toHaveLength(0);
    expect(await outcome(setSubscription(app.db, admin, A.id, { planId: id.basic!, startsOn: today, endsOn: addDays(today, 999) }))).toBe("FORBIDDEN");
    expect(await message(withContext(app.db, admin, (tx) => tx.update(platformInvoices).set({ amountPaise: 1 }).returning()))).toMatch(/Failed query/); // amounts are not writable at all
    expect(await withContext(app.db, admin, (tx) => tx.update(platformInvoices).set({ status: "cancelled", cancelledReason: "Not mine" }).returning())).toHaveLength(0);
  });

  it("every school table carries the read-only guard, except the documented exemptions", async () => {
    const rows = (await owner.db.execute(sql`
      select c.table_name as t from information_schema.columns c join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
      where c.table_schema = 'public' and c.column_name = 'school_id' and tb.table_type = 'BASE TABLE'
        and not exists (select 1 from pg_trigger g join pg_class k on k.oid = g.tgrelid where k.relname = c.table_name and g.tgname = 'app_read_only_guard')
      order by 1`)) as unknown as { t: string }[];
    expect(rows.map((r) => r.t)).toEqual(["audit_events", "idempotency_records", "jobs", "notifications", "platform_invoices", "school_subscriptions", "subscription_events", "support_access_grants"]);
  });
});
