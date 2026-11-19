import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { hrPaymentDetails, payrollPayments, payrollRuns, payrollSlips, staffSalaries, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { createHrName, setPaymentDetails, updateEmployment } from "../src/services/hr/records";
import { getMyEmployment, getMyPayslip, listMyPayslips } from "../src/services/hr/self";
import { approveRun, recordRunPayment } from "../src/services/payroll/approval";
import { addSalaryVersion, calculateRun, createRun, getRun } from "../src/services/payroll/payroll";
import { createStaffMember } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 14.5: staff self-service without access to colleagues' salary records. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

describe("staff self-service", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let finance: RequestContext;
  let asha: RequestContext;
  let bina: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const monthBefore = addDays(`${lastMonth}-01`, -1).slice(0, 7);

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("ssa");
    B = await makeSchool("ssb");
    admin = A.ctx(A.adminId);
    finance = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Pay Clerk", email: `f-${randomUUID().slice(0, 6)}@ss.test`, employeeNo: "F-1", role: "finance" })).userId);
    const a = await createStaffMember(app.db, admin, A.id, { fullName: "Asha", email: `a-${randomUUID().slice(0, 6)}@ss.test`, employeeNo: "T-1", role: "teacher" });
    const b = await createStaffMember(app.db, admin, A.id, { fullName: "Bina", email: `b-${randomUUID().slice(0, 6)}@ss.test`, employeeNo: "T-2", role: "teacher" });
    asha = A.ctx(a.userId);
    bina = A.ctx(b.userId);
    id.asha = a.staffId;
    id.bina = b.staffId;
    for (const s of [a.staffId, b.staffId]) await addSalaryVersion(app.db, admin, A.id, s, { effectiveFrom: "2024-01-01", basic: s === a.staffId ? "30000" : "45000", lines: [] });
    await setPaymentDetails(app.db, admin, A.id, a.staffId, { accountHolder: "Asha", accountNo: "111122223333", ifsc: "SBIN0001234" });
    await setPaymentDetails(app.db, admin, A.id, b.staffId, { accountHolder: "Bina", accountNo: "999988887777", ifsc: "HDFC0001234" });
    const dept = (await createHrName(app.db, admin, A.id, "department", "Science")).id;
    await updateEmployment(app.db, admin, A.id, a.staffId, { employmentType: "permanent", departmentId: dept, effectiveOn: "2024-06-01" });

    id.approved = (await createRun(app.db, finance, A.id, monthBefore)).id;
    await calculateRun(app.db, finance, A.id, id.approved);
    await approveRun(app.db, admin, A.id, id.approved);
    await recordRunPayment(app.db, finance, A.id, id.approved, { paidOn: today, reference: "NEFT-9" });
    id.draft = (await createRun(app.db, finance, A.id, lastMonth)).id;
    await calculateRun(app.db, finance, A.id, id.draft);
    const runs = [await getRun(app.db, finance, A.id, id.approved), await getRun(app.db, finance, A.id, id.draft)];
    id.ashaApproved = runs[0]!.slips.find((s) => s.staffId === id.asha)!.id;
    id.binaApproved = runs[0]!.slips.find((s) => s.staffId === id.bina)!.id;
    id.ashaDraft = runs[1]!.slips.find((s) => s.staffId === id.asha)!.id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("a staff member sees their own payslips from approved runs only", async () => {
    expect((await listMyPayslips(app.db, asha, A.id)).map((s) => [s.month, s.netPaise, s.runStatus, s.paidOn])).toEqual([[monthBefore, 3_000_000, "paid", today]]);
    const p = await getMyPayslip(app.db, asha, A.id, id.ashaApproved!);
    expect(p).toMatchObject({ staffName: "Asha", department: "Science", accountLast4: "3333", netPaise: 3_000_000 });
    expect(p.payment?.reference).toBe("NEFT-9");
    expect(await outcome(getMyPayslip(app.db, asha, A.id, id.binaApproved!))).toBe("NOT_FOUND"); // a colleague's
    expect(await outcome(getMyPayslip(app.db, asha, A.id, id.ashaDraft!))).toBe("NOT_FOUND"); // a draft
  });

  it("the database shows a staff member nothing of colleagues' pay, salaries or drafts", async () => {
    const slips = await withContext(app.db, asha, (tx) => tx.select().from(payrollSlips));
    expect(slips.map((s) => s.id)).toEqual([id.ashaApproved]);
    expect((await withContext(app.db, asha, (tx) => tx.select().from(payrollRuns))).map((r) => r.id)).toEqual([id.approved]);
    expect(await withContext(app.db, asha, (tx) => tx.select().from(staffSalaries))).toHaveLength(0);
    expect(await withContext(app.db, asha, (tx) => tx.select().from(payrollPayments))).toHaveLength(1);
    expect((await withContext(app.db, asha, (tx) => tx.select().from(hrPaymentDetails))).map((d) => d.accountNo)).toEqual(["111122223333"]);
    // Bina's view is just as narrow.
    expect((await withContext(app.db, bina, (tx) => tx.select().from(payrollSlips))).map((s) => s.id)).toEqual([id.binaApproved]);
  });

  it("own employment terms and history; finance's own payslips work the same way", async () => {
    const e = await getMyEmployment(app.db, asha, A.id);
    expect(e).toMatchObject({ name: "Asha", employeeNo: "T-1", employmentType: "permanent", department: "Science" });
    expect(e?.history.map((h) => [h.kind, h.effectiveOn])).toEqual([["department", "2024-06-01"], ["employment_type", "2024-06-01"]]); // newest first
    expect(await listMyPayslips(app.db, finance, A.id)).toEqual([]); // no salary recorded for the clerk
  });

  it("other schools and parents or students have no self-service", async () => {
    const other = B.ctx(B.adminId);
    expect(await listMyPayslips(app.db, other, B.id)).toEqual([]);
    expect(await outcome(getMyPayslip(app.db, other, B.id, id.ashaApproved!))).toBe("NOT_FOUND");
    expect(await outcome(listMyPayslips(app.db, A.ctx(A.studentId), A.id))).toBe("FORBIDDEN");
    const rows = (await owner.db.execute(sql`select count(*)::int as n from pg_policies where policyname like '%_select_self' and tablename in ('payroll_slips', 'payroll_runs', 'payroll_payments', 'hr_payment_details')`)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(4);
  });
});
