import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { payrollAdjustments, payrollRuns, payrollSlips, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { setPaymentDetails } from "../src/services/hr/records";
import {
  approveRun,
  decidePayrollAdjustment,
  exportBankCsv,
  getPayslip,
  listPayrollAdjustments,
  recordPayment,
  recordRunPayment,
  requestPayrollAdjustment,
  voidPayment,
} from "../src/services/payroll/approval";
import { addSalaryVersion, calculateRun, createComponent, createRun, getRun } from "../src/services/payroll/payroll";
import { createStaffMember } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 14.4: payroll approval, payment and corrections. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("payroll approval and payment", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let finance: RequestContext;
  let teacher: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");
  const thisMonth = today.slice(0, 7);
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7);
  const monthBefore = addDays(`${lastMonth}-01`, -1).slice(0, 7);

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("paa");
    B = await makeSchool("pab");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@pa.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    finance = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Pay Clerk", email: `f-${randomUUID().slice(0, 6)}@pa.test`, employeeNo: "F-1", role: "finance" })).userId);
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Asha Teacher", email: `t-${randomUUID().slice(0, 6)}@pa.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    id.teacher = t.staffId;
    const t2 = await createStaffMember(app.db, admin, A.id, { fullName: "Bina Teacher", email: `b-${randomUUID().slice(0, 6)}@pa.test`, employeeNo: "T-2", role: "teacher" });
    id.teacher2 = t2.staffId;
    const hra = (await createComponent(app.db, admin, A.id, { name: "HRA", kind: "earning", calc: "percent_basic", prorate: true })).id;
    await addSalaryVersion(app.db, admin, A.id, id.teacher, { effectiveFrom: "2024-01-01", basic: "30000", lines: [{ componentId: hra, value: "40" }] });
    await addSalaryVersion(app.db, admin, A.id, id.teacher2, { effectiveFrom: "2024-01-01", basic: "20000", lines: [] });
    await setPaymentDetails(app.db, admin, A.id, id.teacher, { accountHolder: "Asha Teacher", accountNo: "001234567890", ifsc: "SBIN0001234" });
    id.run = (await createRun(app.db, finance, A.id, lastMonth)).id;
    await calculateRun(app.db, finance, A.id, id.run);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("only an administrator who neither prepared nor calculated the run approves it, also in the database", async () => {
    expect(await outcome(approveRun(app.db, finance, A.id, id.run!))).toBe("FORBIDDEN");
    await calculateRun(app.db, admin2, A.id, id.run!);
    expect(await message(approveRun(app.db, admin2, A.id, id.run!))).toMatch(/did not prepare or calculate/);
    expect(await dbError(withContext(app.db, admin2, (tx) => tx.update(payrollRuns).set({ status: "approved", approvedBy: admin2.userId!, approvedAt: new Date() }).where(eq(payrollRuns.id, id.run!))))).toMatch(/did not prepare or calculate/);
    await approveRun(app.db, admin, A.id, id.run!);
    expect(await message(approveRun(app.db, admin, A.id, id.run!))).toMatch(/already approved/);
    expect((await getRun(app.db, finance, A.id, id.run!))).toMatchObject({ status: "approved", approvedBy: "An administrator" }); // finance cannot read admins' names
    expect((await getRun(app.db, admin2, A.id, id.run!)).approvedAt).toBeInstanceOf(Date);
  });

  it("an approved run is locked: no recalculation, no slip changes, no second run for the month", async () => {
    expect(await message(calculateRun(app.db, finance, A.id, id.run!))).toMatch(/cannot be recalculated/);
    expect(await withContext(app.db, admin, (tx) => tx.update(payrollSlips).set({ netPaise: 1 }).where(eq(payrollSlips.runId, id.run!)).returning())).toHaveLength(0);
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(payrollRuns).set({ status: "draft" }).where(eq(payrollRuns.id, id.run!))))).toMatch(/cannot go from approved to draft/);
    expect(await outcome(createRun(app.db, finance, A.id, lastMonth))).toBe("CONFLICT");
  });

  it("payments: per slip or all at once, voided with a reason; the run is paid when every slip is", async () => {
    const run = await getRun(app.db, finance, A.id, id.run!);
    const asha = run.slips.find((s) => s.staffId === id.teacher)!;
    await recordPayment(app.db, finance, A.id, asha.id, { paidOn: today, reference: "NEFT-001" });
    expect(await message(recordPayment(app.db, finance, A.id, asha.id, { paidOn: today, reference: "NEFT-002" }))).toMatch(/already marked paid/);
    expect(await recordRunPayment(app.db, finance, A.id, id.run!, { paidOn: today, reference: "NEFT-BULK" })).toEqual({ paid: 1 });
    expect((await getRun(app.db, finance, A.id, id.run!)).status).toBe("paid");
    const paid = (await getRun(app.db, finance, A.id, id.run!)).slips.find((s) => s.staffId === id.teacher)!.payment!;
    expect(paid.reference).toBe("NEFT-001");
    expect(await outcome(voidPayment(app.db, finance, A.id, paid.id, ""))).toBe("VALIDATION");
    await voidPayment(app.db, finance, A.id, paid.id, "Bounced");
    expect((await getRun(app.db, finance, A.id, id.run!)).status).toBe("approved");
    await recordPayment(app.db, finance, A.id, asha.id, { paidOn: today, reference: "NEFT-003" });
    expect((await getRun(app.db, finance, A.id, id.run!)).status).toBe("paid");
    // A draft run takes no payments.
    id.draft = (await createRun(app.db, finance, A.id, monthBefore)).id;
    await calculateRun(app.db, finance, A.id, id.draft);
    expect(await message(recordRunPayment(app.db, finance, A.id, id.draft, { paidOn: today, reference: "X" }))).toMatch(/Approve the run/);
  });

  it("the bank file lists payee, account and amount for approved runs only, and is audited", async () => {
    expect(await message(exportBankCsv(app.db, finance, A.id, id.draft!))).toMatch(/Approve the run/);
    const lines = (await exportBankCsv(app.db, finance, A.id, id.run!)).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("Employee no.,Name,Account holder,Account number,IFSC,Amount (INR),Narration,Already paid");
    const asha = (await getRun(app.db, finance, A.id, id.run!)).slips.find((s) => s.staffId === id.teacher)!;
    expect(lines).toContain(`T-1,Asha Teacher,Asha Teacher,001234567890,SBIN0001234,${(asha.netPaise / 100).toFixed(2)},Salary ${lastMonth},yes`);
    expect(lines.find((l) => l.startsWith("T-2,"))).toMatch(/^T-2,Bina Teacher,,,,/);
    const audits = (await owner.db.execute(sql`select count(*)::int as n from audit_events where action = 'payroll.bank_file_exported'`)) as unknown as { n: number }[];
    expect(audits[0]!.n).toBe(1);
    expect(await outcome(exportBankCsv(app.db, teacher, A.id, id.run!))).toBe("FORBIDDEN");
  });

  it("corrections after approval are adjustments decided by someone else and paid by the next draft run", async () => {
    id.adj = (await requestPayrollAdjustment(app.db, finance, A.id, { staffId: id.teacher!, kind: "earning", amount: "1500", reason: "Arrears: missed HRA", sourceRunId: id.run })).id;
    expect(await outcome(decidePayrollAdjustment(app.db, finance, A.id, id.adj, true))).toBe("FORBIDDEN");
    const own = (await requestPayrollAdjustment(app.db, admin, A.id, { staffId: id.teacher2!, kind: "deduction", amount: "500", reason: "Advance recovery" })).id;
    expect(await message(decidePayrollAdjustment(app.db, admin, A.id, own, true))).toMatch(/other than the requester/);
    expect(await outcome(decidePayrollAdjustment(app.db, admin2, A.id, own, false))).toBe("VALIDATION");
    await decidePayrollAdjustment(app.db, admin2, A.id, own, false, "Already recovered in cash");
    await decidePayrollAdjustment(app.db, admin, A.id, id.adj, true);

    await calculateRun(app.db, finance, A.id, id.draft!);
    await calculateRun(app.db, finance, A.id, id.draft!); // recalculating keeps it once
    const asha = (await getRun(app.db, finance, A.id, id.draft!)).slips.find((s) => s.staffId === id.teacher)!;
    expect(asha.lines.filter((l) => l.name === "Arrears: missed HRA").map((l) => [l.kind, l.amountPaise])).toEqual([["earning", 150_000]]);
    const list = await listPayrollAdjustments(app.db, finance, A.id);
    expect(list.map((a) => [a.reason, a.status, a.appliedMonth])).toEqual(expect.arrayContaining([["Arrears: missed HRA", "approved", `${monthBefore}-01`], ["Advance recovery", "rejected", null]]));
    await approveRun(app.db, admin, A.id, id.draft!);
    // Once paid in an approved run, the adjustment stays there.
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(payrollAdjustments).set({ appliedRunId: null }).where(eq(payrollAdjustments.id, id.adj!))))).toMatch(/stays there/);
  });

  it("payslips: complete for payroll staff, refused to others", async () => {
    const run = await getRun(app.db, finance, A.id, id.run!);
    const slip = await getPayslip(app.db, finance, A.id, run.slips.find((s) => s.staffId === id.teacher)!.id);
    expect(slip).toMatchObject({ staffName: "Asha Teacher", employeeNo: "T-1", month: lastMonth, runStatus: "paid", accountLast4: "7890", basicPaise: 3_000_000 });
    expect(slip.payment?.reference).toBe("NEFT-003");
    expect(slip.lines.map((l) => l.name)).toEqual(["HRA"]);
    expect(await outcome(getPayslip(app.db, teacher, A.id, slip.id))).toBe("FORBIDDEN");
    expect(await outcome(getPayslip(app.db, B.ctx(B.adminId), B.id, slip.id))).toBe("NOT_FOUND");
    expect(await outcome(approveRun(app.db, B.ctx(B.adminId), B.id, id.run!))).toBe("NOT_FOUND");
  });
});
