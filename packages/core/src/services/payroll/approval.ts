import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { payrollAdjustments, payrollPayments, payrollRuns, payrollSlips, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { checkViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { parseRupees } from "../fees/money";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";
import type { SlipLine } from "./calc";
import { monthEnd } from "./payroll";

/**
 * Payroll approval, payment and corrections (Phase 14.4).
 *
 * - A calculated draft run is approved by a school administrator who neither prepared nor last
 *   calculated it, with every slip's deductions within its earnings. Approval locks the run.
 * - Payments are recorded per slip (date and reference) or for every unpaid slip at once; a
 *   payment recorded in error is voided with a reason. A run is paid when every slip is.
 * - The bank file lists payee, account, IFSC and amount for an approved run (audited).
 * - Corrections after approval are adjustments (arrears or recovery) approved by someone other
 *   than the requester and paid by the next draft run that includes them.
 */

const PREPARE = "school.payroll.prepare";
const APPROVE = "school.payroll.approve";

async function runFor(tx: Tx, schoolId: string, runId: string, lock = false) {
  parse(uuidField("Payroll run"), runId);
  const q = tx.select().from(payrollRuns).where(and(eq(payrollRuns.schoolId, schoolId), eq(payrollRuns.id, runId)));
  const [r] = lock ? await q.for("update") : await q;
  if (!r) throw new AppError("NOT_FOUND", "Payroll run not found.");
  return r;
}

async function settleRunStatus(tx: Tx, runId: string) {
  const [c] = (await tx.execute(sql`
    select count(*)::int as slips,
           count(*) filter (where exists (select 1 from payroll_payments p where p.slip_id = s.id and p.voided_at is null))::int as paid
    from payroll_slips s where s.run_id = ${runId}::uuid and s.included`)) as unknown as { slips: number; paid: number }[];
  const [r] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  const allPaid = (c?.slips ?? 0) > 0 && c!.paid === c!.slips;
  if (r?.status === "approved" && allPaid) await tx.update(payrollRuns).set({ status: "paid", paidAt: sql`now()` }).where(eq(payrollRuns.id, runId));
  if (r?.status === "paid" && !allPaid) await tx.update(payrollRuns).set({ status: "approved", paidAt: null }).where(eq(payrollRuns.id, runId));
}

/** Approves and locks a calculated draft run. */
export async function approveRun(db: Db, ctx: RequestContext, schoolId: string, runId: string): Promise<void> {
  try {
    await withCapability(db, ctx, schoolId, APPROVE, async (tx, actor) => {
      const run = await runFor(tx, schoolId, runId, true);
      if (run.status !== "draft") throw new AppError("CONFLICT", "This run is already approved.");
      if (!run.calculatedAt) throw new AppError("CONFLICT", "Calculate the run before approving it.");
      if (run.preparedBy === actor.userId || run.calculatedBy === actor.userId) throw new AppError("FORBIDDEN", "An administrator who did not prepare or calculate this run must approve it.");
      const [c] = (await tx.execute(sql`
        select count(*)::int as slips, count(*) filter (where net_paise < 0)::int as negative
        from payroll_slips where run_id = ${runId}::uuid and included`)) as unknown as { slips: number; negative: number }[];
      if (!c?.slips) throw new AppError("CONFLICT", "There are no payslips to approve.");
      if (c.negative) throw new AppError("CONFLICT", `${c.negative} payslip(s) have deductions larger than earnings. Fix them and recalculate.`);
      await tx.update(payrollRuns).set({ status: "approved", approvedBy: actor.userId, approvedAt: sql`now()` }).where(eq(payrollRuns.id, runId));
      await audit(tx, { action: "payroll.run_approved", actorUserId: actor.userId, schoolId, entityType: "payroll_run", entityId: runId, data: { slips: c.slips } });
    });
  } catch (e) {
    if (checkViolation(e) === "payroll_runs_approver") throw new AppError("FORBIDDEN", "An administrator who did not prepare or calculate this run must approve it.");
    throw e;
  }
}

const paymentSchema = z.object({ paidOn: isoDate("payment date"), reference: trimmed("Reference", 1, 80) });

async function pay(tx: Tx, schoolId: string, actorUserId: string, slipId: string, v: z.output<typeof paymentSchema>) {
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(payrollPayments).values({ schoolId, slipId, paidOn: v.paidOn, reference: v.reference, recordedBy: actorUserId });
    });
    return true;
  } catch (e) {
    if (uniqueViolation(e)?.includes("payroll_payments_one_active_per_slip")) return false;
    if (checkViolation(e) === "payroll_payments_approved") throw new AppError("CONFLICT", "Approve the run before recording payments.");
    throw e;
  }
}

/** Records the payment of one payslip of an approved run. */
export async function recordPayment(db: Db, ctx: RequestContext, schoolId: string, slipId: string, input: { paidOn: string; reference: string }): Promise<void> {
  parse(uuidField("Payslip"), slipId);
  const v = parse(paymentSchema, input);
  await withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const [slip] = await tx.select().from(payrollSlips).where(and(eq(payrollSlips.schoolId, schoolId), eq(payrollSlips.id, slipId)));
    if (!slip || !slip.included) throw new AppError("NOT_FOUND", "Payslip not found.");
    await runFor(tx, schoolId, slip.runId, true);
    if (!(await pay(tx, schoolId, actor.userId, slipId, v))) throw new AppError("CONFLICT", "This payslip is already marked paid.");
    await settleRunStatus(tx, slip.runId);
    await audit(tx, { action: "payroll.payment_recorded", actorUserId: actor.userId, schoolId, entityType: "payroll_slip", entityId: slipId, data: { paidOn: v.paidOn } });
  });
}

/** Records the same payment date and reference for every unpaid payslip of an approved run. */
export async function recordRunPayment(db: Db, ctx: RequestContext, schoolId: string, runId: string, input: { paidOn: string; reference: string }): Promise<{ paid: number }> {
  const v = parse(paymentSchema, input);
  return withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const run = await runFor(tx, schoolId, runId, true);
    if (run.status === "draft") throw new AppError("CONFLICT", "Approve the run before recording payments.");
    const slips = await tx.select({ id: payrollSlips.id }).from(payrollSlips).where(and(eq(payrollSlips.runId, runId), eq(payrollSlips.included, true)));
    let paid = 0;
    for (const s of slips) if (await pay(tx, schoolId, actor.userId, s.id, v)) paid++;
    await settleRunStatus(tx, runId);
    await audit(tx, { action: "payroll.run_payment_recorded", actorUserId: actor.userId, schoolId, entityType: "payroll_run", entityId: runId, data: { paid, paidOn: v.paidOn } });
    return { paid };
  });
}

/** Voids a payment recorded in error, with a reason. The run returns to approved if it was paid. */
export async function voidPayment(db: Db, ctx: RequestContext, schoolId: string, paymentId: string, reason: string): Promise<void> {
  parse(uuidField("Payment"), paymentId);
  const why = parse(trimmed("Reason", 3, 300), reason);
  await withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const [p] = await tx.select().from(payrollPayments).where(and(eq(payrollPayments.schoolId, schoolId), eq(payrollPayments.id, paymentId), isNull(payrollPayments.voidedAt))).for("update");
    if (!p) throw new AppError("NOT_FOUND", "Payment not found.");
    const [slip] = await tx.select({ runId: payrollSlips.runId }).from(payrollSlips).where(eq(payrollSlips.id, p.slipId));
    await runFor(tx, schoolId, slip!.runId, true);
    await tx.update(payrollPayments).set({ voidedAt: sql`now()`, voidedBy: actor.userId, voidReason: why }).where(eq(payrollPayments.id, paymentId));
    await settleRunStatus(tx, slip!.runId);
    await audit(tx, { action: "payroll.payment_voided", actorUserId: actor.userId, schoolId, entityType: "payroll_slip", entityId: p.slipId, data: { reason: why } });
  });
}

/**
 * The bank file for an approved run: one row per payslip with net pay above zero. Staff without
 * payment details are listed with empty account columns so they are not missed. Audited.
 */
export async function exportBankCsv(db: Db, ctx: RequestContext, schoolId: string, runId: string): Promise<string> {
  return withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const run = await runFor(tx, schoolId, runId);
    if (run.status === "draft") throw new AppError("CONFLICT", "Approve the run before downloading the bank file.");
    const rows = (await tx.execute(sql`
      select p.employee_no as "employeeNo", p.display_name as name, d.account_holder as holder, d.account_no as account, d.ifsc, s.net_paise::float8 as net,
             exists (select 1 from payroll_payments x where x.slip_id = s.id and x.voided_at is null) as paid
      from payroll_slips s join staff_profiles p on p.id = s.staff_id left join hr_payment_details d on d.staff_id = s.staff_id
      where s.run_id = ${runId}::uuid and s.included and s.net_paise > 0 order by lower(p.display_name)`)) as unknown as {
      employeeNo: string;
      name: string;
      holder: string | null;
      account: string | null;
      ifsc: string | null;
      net: number;
      paid: boolean;
    }[];
    const narration = `Salary ${run.periodStart.slice(0, 7)}`;
    await audit(tx, { action: "payroll.bank_file_exported", actorUserId: actor.userId, schoolId, entityType: "payroll_run", entityId: runId, data: { rows: rows.length } });
    return toCsv([
      ["Employee no.", "Name", "Account holder", "Account number", "IFSC", "Amount (INR)", "Narration", "Already paid"],
      // Account numbers are text so spreadsheets keep leading zeros.
      ...rows.map((r) => [r.employeeNo, r.name, r.holder, r.account, r.ifsc, (r.net / 100).toFixed(2), narration, r.paid ? "yes" : "no"]),
    ]);
  });
}

/* ------------------------------------------------------------------ adjustments */

export interface AdjustmentRow {
  id: string;
  staffId: string;
  staff: string;
  kind: "earning" | "deduction";
  amountPaise: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  appliedMonth: string | null;
  createdAt: Date;
}

export async function listPayrollAdjustments(db: Db, ctx: RequestContext, schoolId: string): Promise<AdjustmentRow[]> {
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const rows = (await tx.execute(sql`
      select a.id, a.staff_id as "staffId", p.display_name || ' (' || p.employee_no || ')' as staff, a.kind::text as kind, a.amount_paise::float8 as "amountPaise", a.reason,
             a.status::text as status, coalesce(ru.full_name, 'A colleague') as "requestedBy", du.full_name as "decidedBy", a.decision_note as "decisionNote",
             r.period_start::text as "appliedMonth", a.created_at as "createdAt"
      from payroll_adjustments a join staff_profiles p on p.id = a.staff_id
      left join users ru on ru.id = a.requested_by left join users du on du.id = a.decided_by left join payroll_runs r on r.id = a.applied_run_id
      where a.school_id = ${schoolId}::uuid order by a.status <> 'pending', a.created_at desc limit 200`)) as unknown as AdjustmentRow[];
    return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
  });
}

/** Requests arrears (earning) or a recovery (deduction) for a staff member. */
export async function requestPayrollAdjustment(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { staffId: string; kind: string; amount: string; reason: string; sourceRunId?: string },
): Promise<{ id: string }> {
  const staffId = parse(uuidField("Staff member"), input.staffId);
  const kind = parse(z.enum(["earning", "deduction"], { message: "Choose arrears or recovery." }), input.kind);
  const amount = parseRupees(input.amount);
  if (!amount) throw new AppError("VALIDATION", "Amount: enter rupees, for example 1500.", { amount: "Not a valid amount." });
  const reason = parse(trimmed("Reason", 3, 200), input.reason);
  const sourceRunId = input.sourceRunId ? parse(uuidField("Payroll run"), input.sourceRunId) : null;
  return withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const [p] = (await tx.execute(sql`select id from staff_profiles where school_id = ${schoolId}::uuid and id = ${staffId}::uuid`)) as unknown as { id: string }[];
    if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
    if (sourceRunId) await runFor(tx, schoolId, sourceRunId);
    const [a] = await tx.insert(payrollAdjustments).values({ schoolId, staffId, kind, amountPaise: amount, reason, sourceRunId, requestedBy: actor.userId }).returning({ id: payrollAdjustments.id });
    await audit(tx, { action: "payroll.adjustment_requested", actorUserId: actor.userId, schoolId, entityType: "payroll_adjustment", entityId: a!.id, data: { staffId, kind } });
    return { id: a!.id };
  });
}

/** Approves or rejects (with a reason) an adjustment; someone other than the requester decides. */
export async function decidePayrollAdjustment(db: Db, ctx: RequestContext, schoolId: string, adjustmentId: string, approve: boolean, note?: string): Promise<void> {
  parse(uuidField("Adjustment"), adjustmentId);
  const why = note?.trim() ? parse(trimmed("Note", 3, 300), note) : null;
  if (!approve && !why) throw new AppError("VALIDATION", "Give a reason for rejecting.", { note: "Required." });
  try {
    await withCapability(db, ctx, schoolId, APPROVE, async (tx, actor) => {
      const [a] = await tx.select().from(payrollAdjustments).where(and(eq(payrollAdjustments.schoolId, schoolId), eq(payrollAdjustments.id, adjustmentId))).for("update");
      if (!a) throw new AppError("NOT_FOUND", "Adjustment not found.");
      if (a.status !== "pending") throw new AppError("CONFLICT", "This adjustment has already been decided.");
      if (a.requestedBy === actor.userId) throw new AppError("FORBIDDEN", "Someone other than the requester must decide this adjustment.");
      await tx.update(payrollAdjustments).set({ status: approve ? "approved" : "rejected", decidedBy: actor.userId, decidedAt: sql`now()`, decisionNote: why }).where(eq(payrollAdjustments.id, adjustmentId));
      await audit(tx, { action: approve ? "payroll.adjustment_approved" : "payroll.adjustment_rejected", actorUserId: actor.userId, schoolId, entityType: "payroll_adjustment", entityId: adjustmentId });
    });
  } catch (e) {
    if (checkViolation(e) === "payroll_adjustments_decider") throw new AppError("FORBIDDEN", "Someone other than the requester must decide this adjustment.");
    throw e;
  }
}

/* ------------------------------------------------------------------ payslips */

export interface Payslip {
  id: string;
  runId: string;
  month: string;
  periodStart: string;
  periodEnd: string;
  runStatus: "draft" | "approved" | "paid";
  schoolName: string;
  staffName: string;
  employeeNo: string;
  designation: string | null;
  department: string | null;
  workingDays: string;
  lopDays: string;
  payableDays: string;
  basicPaise: number;
  earnedBasicPaise: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  lines: SlipLine[];
  payment: { id: string; paidOn: string; reference: string } | null;
  accountLast4: string | null;
}

const halves = (h: number) => (h % 2 === 0 ? String(h / 2) : `${(h - 1) / 2}.5`);

/** One payslip. `self`: only the signed-in staff member's own, and only from approved runs. */
export async function payslipTx(tx: Tx, schoolId: string, slipId: string, self: boolean): Promise<Payslip> {
  const [s] = (await tx.execute(sql`
    select s.id, s.run_id as "runId", r.period_start::text as "periodStart", r.status::text as "runStatus", sc.name as "schoolName",
           p.display_name as "staffName", p.employee_no as "employeeNo", g.name as designation, d.name as department,
           s.working_halves as wh, s.lop_halves as lh, s.payable_halves as ph, s.basic_paise::float8 as "basicPaise", s.earned_basic_paise::float8 as "earnedBasicPaise",
           s.gross_paise::float8 as "grossPaise", s.deductions_paise::float8 as "deductionsPaise", s.net_paise::float8 as "netPaise", s.lines,
           pm.id as "paymentId", pm.paid_on::text as "paidOn", pm.reference, right(pd.account_no, 4) as "accountLast4"
    from payroll_slips s join payroll_runs r on r.id = s.run_id join schools sc on sc.id = s.school_id join staff_profiles p on p.id = s.staff_id
    left join hr_employment e on e.staff_id = s.staff_id left join hr_designations g on g.id = e.designation_id left join hr_departments d on d.id = e.department_id
    left join payroll_payments pm on pm.slip_id = s.id and pm.voided_at is null
    left join hr_payment_details pd on pd.staff_id = s.staff_id
    where s.school_id = ${schoolId}::uuid and s.id = ${slipId}::uuid and s.included
      ${self ? sql`and s.staff_id = app_my_staff_id(${schoolId}::uuid) and r.status <> 'draft'` : sql``}`)) as unknown as (Omit<Payslip, "workingDays" | "lopDays" | "payableDays" | "payment" | "month" | "periodEnd"> & {
    wh: number;
    lh: number;
    ph: number;
    paymentId: string | null;
    paidOn: string | null;
    reference: string | null;
  })[];
  if (!s) throw new AppError("NOT_FOUND", "Payslip not found.");
  const { wh, lh, ph, paymentId, paidOn, reference, ...rest } = s;
  return {
    ...rest,
    month: s.periodStart.slice(0, 7),
    periodEnd: monthEnd(s.periodStart),
    workingDays: halves(wh),
    lopDays: halves(lh),
    payableDays: halves(ph),
    payment: paymentId ? { id: paymentId, paidOn: paidOn!, reference: reference! } : null,
  };
}

/** A payslip for administrators and finance. */
export async function getPayslip(db: Db, ctx: RequestContext, schoolId: string, slipId: string): Promise<Payslip> {
  parse(uuidField("Payslip"), slipId);
  return withCapability(db, ctx, schoolId, PREPARE, (tx) => payslipTx(tx, schoolId, slipId, false));
}
