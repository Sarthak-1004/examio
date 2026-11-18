import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { feeAdjustments, feeConcessions, invoiceLines, invoices, ledgerEntries, payments, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { schoolToday } from "../../dates";
import { isRlsViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { withIdempotency } from "../../idempotency";
import { queueNotification } from "../../notifications/notifications";
import { likePattern } from "../../paging";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";
import { computeLine, formatPaise, parsePercentBp, requireRupees } from "./money";

/**
 * Billing (Phase 8).
 *
 * - Invoices are issued per instalment (the items of an approved structure sharing a due date)
 *   to the students currently enrolled in the structure's class that year. Concessions approved
 *   before issue are applied; tax is computed per head on the discounted amount. Issuing posts
 *   the total as a charge to the student's ledger. One invoice per structure, student and due
 *   date: issuing the same batch again bills nobody twice.
 * - Offline payments (cash, cheque, bank transfer, UPI) are recorded with a receipt number and
 *   credited at once; never more than the invoice's outstanding balance; retry-safe.
 * - A late fee (flat, from the structure) is added at most once per invoice, after the grace days.
 * - Concessions and adjustments (waivers, extra charges, refunds, receipt reversals) take effect
 *   only when a school administrator other than the requester approves them; the approval posts
 *   the ledger entry. Nothing in the ledger is edited or deleted.
 */

async function today(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

async function nextNumber(tx: Tx, schoolId: string, kind: "invoice" | "receipt"): Promise<string> {
  const [r] = (await tx.execute(sql`select app_next_fee_number(${schoolId}::uuid, ${kind}) as n`)) as unknown as { n: string }[];
  return r!.n;
}

/** Outstanding balance of an invoice (positive = owed). */
async function invoiceBalance(tx: Tx, invoiceId: string): Promise<number> {
  const [r] = (await tx.execute(sql`select coalesce(sum(amount_paise), 0)::int as b from ledger_entries where invoice_id = ${invoiceId}::uuid`)) as unknown as { b: number }[];
  return r?.b ?? 0;
}

/* ------------------------------------------------------------------ concessions */

export async function requestConcession(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { studentId: string; feeHeadId?: string | null; kind: string; value: string; reason: string },
): Promise<{ id: string }> {
  parse(uuidField("Student"), input.studentId);
  if (input.feeHeadId) parse(uuidField("Fee head"), input.feeHeadId);
  const kind = parse(z.enum(["percent", "amount"], { message: "Choose a percentage or an amount." }), input.kind);
  const value = kind === "percent" ? parsePercentBp(input.value) : requireRupees(input.value, "value", "Concession");
  if (value === null) throw new AppError("VALIDATION", "Percentage: enter 0.01 to 100.", { value: "Not a valid percentage." });
  const reason = parse(trimmed("Reason", 3, 200), input.reason);
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const [c] = await tx
      .insert(feeConcessions)
      .values({ schoolId, studentId: input.studentId, feeHeadId: input.feeHeadId || null, kind, value, reason, requestedBy: actor.userId })
      .returning({ id: feeConcessions.id });
    await audit(tx, { action: "fees.concession_requested", actorUserId: actor.userId, schoolId, entityType: "fee_concession", entityId: c!.id, data: { studentId: input.studentId, kind, value } });
    return { id: c!.id };
  });
}

/** Approve or reject a pending concession or adjustment: a school administrator, not the requester. */
async function decisionGuard(tx: Tx, table: "fee_concessions" | "fee_adjustments", id: string, schoolId: string, actorUserId: string) {
  const [r] = (await tx.execute(sql`select status::text as status, requested_by as "requestedBy" from ${sql.identifier(table)} where school_id = ${schoolId}::uuid and id = ${id}::uuid`)) as unknown as { status: string; requestedBy: string }[];
  if (!r) throw new AppError("NOT_FOUND", "Request not found.");
  if (r.status !== "pending") throw new AppError("CONFLICT", "This request has already been decided.");
  if (r.requestedBy === actorUserId) throw new AppError("FORBIDDEN", "Someone other than the requester must decide this.");
}

export async function decideConcession(db: Db, ctx: RequestContext, schoolId: string, concessionId: string, approve: boolean): Promise<void> {
  parse(uuidField("Concession"), concessionId);
  await withCapability(db, ctx, schoolId, "school.fees.approve", async (tx, actor) => {
    await decisionGuard(tx, "fee_concessions", concessionId, schoolId, actor.userId);
    await tx.update(feeConcessions).set({ status: approve ? "approved" : "rejected", decidedBy: actor.userId, decidedAt: sql`now()` }).where(eq(feeConcessions.id, concessionId));
    await audit(tx, { action: approve ? "fees.concession_approved" : "fees.concession_rejected", actorUserId: actor.userId, schoolId, entityType: "fee_concession", entityId: concessionId });
  });
}

export async function revokeConcession(db: Db, ctx: RequestContext, schoolId: string, concessionId: string): Promise<void> {
  parse(uuidField("Concession"), concessionId);
  await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const r = await tx
      .update(feeConcessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(feeConcessions.schoolId, schoolId), eq(feeConcessions.id, concessionId), eq(feeConcessions.status, "approved"), sql`${feeConcessions.revokedAt} is null`))
      .returning({ id: feeConcessions.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Approved concession not found.");
    await audit(tx, { action: "fees.concession_revoked", actorUserId: actor.userId, schoolId, entityType: "fee_concession", entityId: concessionId });
  });
}

/* ------------------------------------------------------------------ invoices */

export interface IssueResult {
  issued: number;
  skipped: number;
  totalPaise: number;
}

/** Issues one instalment of an approved structure to its class's current students. Retry-safe. */
export async function issueInvoices(db: Db, ctx: RequestContext, schoolId: string, input: { structureId: string; dueOn: string }): Promise<IssueResult> {
  parse(uuidField("Fee structure"), input.structureId);
  const dueOn = parse(isoDate("due date"), input.dueOn);
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const [s] = (await tx.execute(sql`select status::text as status, academic_year_id as "yearId", class_id as "classId", name from fee_structures where school_id = ${schoolId}::uuid and id = ${input.structureId}::uuid`)) as unknown as { status: string; yearId: string; classId: string; name: string }[];
    if (!s) throw new AppError("NOT_FOUND", "Fee structure not found.");
    if (s.status !== "approved") throw new AppError("CONFLICT", "Only an approved fee structure can be billed.");
    const items = (await tx.execute(sql`
      select i.fee_head_id as "headId", h.name as "headName", i.label, i.amount_paise as "amountPaise", h.tax_bp as "taxBp"
      from fee_structure_items i join fee_heads h on h.id = i.fee_head_id
      where i.structure_id = ${input.structureId}::uuid and i.due_on = ${dueOn}::date order by h.name`)) as unknown as { headId: string; headName: string; label: string; amountPaise: number; taxBp: number }[];
    if (items.length === 0) throw new AppError("VALIDATION", "This structure has no items due on that date.");
    const students = (await tx.execute(sql`
      select distinct p.id from enrollments e join sections sec on sec.id = e.section_id join student_profiles p on p.id = e.student_id
      where e.school_id = ${schoolId}::uuid and e.academic_year_id = ${s.yearId}::uuid and sec.class_id = ${s.classId}::uuid
        and e.ends_on is null and p.status = 'active'`)) as unknown as { id: string }[];
    const concessions = (await tx.execute(sql`
      select student_id as "studentId", fee_head_id as "headId", kind::text as kind, value from fee_concessions
      where school_id = ${schoolId}::uuid and status = 'approved' and revoked_at is null`)) as unknown as { studentId: string; headId: string | null; kind: "percent" | "amount"; value: number }[];
    // Students already billed for this instalment are skipped before a number is taken, so
    // issuing the same batch again leaves no gaps in the invoice numbers.
    const billed = new Set(
      ((await tx.execute(sql`select student_id as id from invoices where school_id = ${schoolId}::uuid and structure_id = ${input.structureId}::uuid and due_on = ${dueOn}::date`)) as unknown as { id: string }[]).map((r) => r.id),
    );
    let issued = 0;
    let total = 0;
    for (const st of students) {
      if (billed.has(st.id)) continue;
      const lines = items.map((it) => {
        const applicable = concessions.filter((c) => c.studentId === st.id && (c.headId === null || c.headId === it.headId));
        return { ...it, ...computeLine({ amountPaise: it.amountPaise, taxBp: it.taxBp, concessions: applicable }) };
      });
      const invoiceTotal = lines.reduce((a, l) => a + l.totalPaise, 0);
      const number = await nextNumber(tx, schoolId, "invoice");
      const inserted = (await tx
        .insert(invoices)
        .values({ schoolId, studentId: st.id, structureId: input.structureId, number, dueOn, totalPaise: invoiceTotal, issuedBy: actor.userId })
        .onConflictDoNothing({ target: [invoices.schoolId, invoices.structureId, invoices.studentId, invoices.dueOn] })
        .returning({ id: invoices.id })) as { id: string }[];
      const inv = inserted[0];
      if (!inv) continue; // billed by a concurrent request
      await tx.insert(invoiceLines).values(lines.map((l) => ({ schoolId, invoiceId: inv.id, feeHeadId: l.headId, description: `${l.headName}: ${l.label}`, amountPaise: l.amountPaise, discountPaise: l.discountPaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise })));
      if (invoiceTotal > 0) await tx.insert(ledgerEntries).values({ schoolId, studentId: st.id, invoiceId: inv.id, kind: "charge", amountPaise: invoiceTotal, memo: `Invoice ${number}`, createdBy: actor.userId });
      issued++;
      total += invoiceTotal;
    }
    await audit(tx, { action: "fees.invoices_issued", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: input.structureId, data: { dueOn, issued, skipped: students.length - issued, totalPaise: total } });
    return { issued, skipped: students.length - issued, totalPaise: total };
  });
}

/** Cancels an unpaid invoice (school administrators): its charges are reversed, nothing is deleted. */
export async function cancelInvoice(db: Db, ctx: RequestContext, schoolId: string, invoiceId: string, reason: string): Promise<void> {
  parse(uuidField("Invoice"), invoiceId);
  const why = parse(trimmed("Reason", 3, 200), reason);
  await withCapability(db, ctx, schoolId, "school.fees.approve", async (tx, actor) => {
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.schoolId, schoolId), eq(invoices.id, invoiceId)));
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
    if (inv.status === "cancelled") throw new AppError("CONFLICT", "This invoice is already cancelled.");
    const [paid] = (await tx.execute(sql`select count(*)::int as n from payments where invoice_id = ${invoiceId}::uuid and status in ('captured', 'pending')`)) as unknown as { n: number }[];
    if (paid?.n) throw new AppError("CONFLICT", "This invoice has payments. Refund or reverse them first (approved adjustments).");
    const open = (await tx.execute(sql`
      select e.id, e.amount_paise as amount from ledger_entries e
      where e.invoice_id = ${invoiceId}::uuid and e.kind <> 'reversal' and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id)`)) as unknown as { id: string; amount: number }[];
    for (const e of open) {
      await tx.insert(ledgerEntries).values({ schoolId, studentId: inv.studentId, invoiceId, kind: "reversal", amountPaise: -e.amount, reversesEntryId: e.id, memo: `Invoice ${inv.number} cancelled`, createdBy: actor.userId });
    }
    await tx.update(invoices).set({ status: "cancelled", cancelledAt: sql`now()` }).where(eq(invoices.id, invoiceId));
    await audit(tx, { action: "fees.invoice_cancelled", actorUserId: actor.userId, schoolId, entityType: "invoice", entityId: invoiceId, data: { reason: why, reversed: open.length } });
  });
}

/* ------------------------------------------------------------------ offline payments */

const METHODS = ["cash", "cheque", "bank_transfer", "upi"] as const;

export async function recordOfflinePayment(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { invoiceId: string; amount: string; method: string; reference?: string | null; idempotencyKey: string },
): Promise<{ paymentId: string; receiptNo: string; replayed: boolean }> {
  parse(uuidField("Invoice"), input.invoiceId);
  const amountPaise = requireRupees(input.amount, "amount");
  const method = parse(z.enum(METHODS, { message: "Choose how it was paid." }), input.method);
  const reference = input.reference?.trim() ? parse(trimmed("Reference", 1, 100), input.reference) : null;
  if (method === "cheque" && !reference) throw new AppError("VALIDATION", "Enter the cheque number.", { reference: "Required for a cheque." });
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const out = await withIdempotency(tx, ctx, { operation: "fees.receipt", key: input.idempotencyKey, request: { invoiceId: input.invoiceId, amountPaise, method, reference }, schoolId }, async () => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.schoolId, schoolId), eq(invoices.id, input.invoiceId))).for("update");
      if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
      if (inv.status === "cancelled") throw new AppError("CONFLICT", "This invoice is cancelled.");
      const balance = await invoiceBalance(tx, inv.id);
      if (balance <= 0) throw new AppError("CONFLICT", "This invoice is already paid.");
      if (amountPaise > balance) throw new AppError("VALIDATION", `The amount is more than the outstanding ${formatPaise(balance)}.`, { amount: "More than outstanding." });
      const receiptNo = await nextNumber(tx, schoolId, "receipt");
      const [p] = await tx
        .insert(payments)
        .values({ schoolId, studentId: inv.studentId, invoiceId: inv.id, method, amountPaise, status: "captured", reference, receiptNo, createdBy: actor.userId, capturedAt: new Date() })
        .returning({ id: payments.id });
      await tx.insert(ledgerEntries).values({ schoolId, studentId: inv.studentId, invoiceId: inv.id, paymentId: p!.id, kind: "payment", amountPaise: -amountPaise, memo: `Receipt ${receiptNo}`, createdBy: actor.userId });
      await audit(tx, { action: "fees.payment_recorded", actorUserId: actor.userId, schoolId, entityType: "payment", entityId: p!.id, data: { invoiceId: inv.id, amountPaise, method } });
      return { paymentId: p!.id, receiptNo };
    });
    return { ...out.result, replayed: out.replayed };
  });
}

/* ------------------------------------------------------------------ late fees and reminders */

/** Adds the structure's late fee to every overdue, unpaid invoice that has none yet. Idempotent. */
export async function applyLateFees(db: Db, ctx: RequestContext, schoolId: string): Promise<{ applied: number; totalPaise: number }> {
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const t = await today(tx, schoolId);
    const due = (await tx.execute(sql`
      select i.id, i.student_id as "studentId", i.number, s.late_fee_paise as fee
      from invoices i join fee_structures s on s.id = i.structure_id
      where i.school_id = ${schoolId}::uuid and i.status = 'open' and s.late_fee_paise > 0
        and i.due_on + s.late_grace_days < ${t}::date
        and not exists (select 1 from ledger_entries l where l.invoice_id = i.id and l.kind = 'late_fee')
        and (select coalesce(sum(amount_paise), 0) from ledger_entries l where l.invoice_id = i.id) > 0`)) as unknown as { id: string; studentId: string; number: string; fee: number }[];
    let applied = 0;
    let total = 0;
    for (const d of due) {
      const r = await tx
        .insert(ledgerEntries)
        .values({ schoolId, studentId: d.studentId, invoiceId: d.id, kind: "late_fee", amountPaise: d.fee, memo: `Late fee on ${d.number}`, createdBy: actor.userId })
        .onConflictDoNothing()
        .returning({ id: ledgerEntries.id });
      if (r.length) {
        applied++;
        total += d.fee;
      }
    }
    await audit(tx, { action: "fees.late_fees_applied", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { applied, totalPaise: total } });
    return { applied, totalPaise: total };
  });
}

/** Notifies the linked parents of students with overdue invoices; at most once per invoice per day. */
export async function sendOverdueReminders(db: Db, ctx: RequestContext, schoolId: string): Promise<{ invoices: number; notifications: number }> {
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const t = await today(tx, schoolId);
    const rows = (await tx.execute(sql`
      select i.id, i.number, p.display_name as student, g.guardian_user_id as "parentId",
             (select coalesce(sum(amount_paise), 0)::int from ledger_entries l where l.invoice_id = i.id) as balance
      from invoices i join student_profiles p on p.id = i.student_id
      join guardian_links g on g.student_id = p.id and g.revoked_at is null
      where i.school_id = ${schoolId}::uuid and i.status = 'open' and i.due_on < ${t}::date`)) as unknown as { id: string; number: string; student: string; parentId: string; balance: number }[];
    const overdue = rows.filter((r) => r.balance > 0);
    let sent = 0;
    for (const r of overdue) {
      // The database refuses to notify a parent whose membership has ended. Each notification
      // runs in its own savepoint, so that refusal skips one parent without aborting the rest.
      sent += await tx
        .transaction((sp) =>
          queueNotification(sp, {
            recipientUserId: r.parentId,
            schoolId,
            channels: ["in_app", "email"],
            template: "fees.overdue",
            params: { student: r.student, invoice: r.number, amount: formatPaise(r.balance) },
            dedupeKey: `fees-overdue:${r.id}:${t}`,
          }),
        )
        .catch((e: unknown) => {
          if (isRlsViolation(e)) return 0;
          throw e;
        });
    }
    await audit(tx, { action: "fees.overdue_reminders_sent", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { invoices: new Set(overdue.map((r) => r.id)).size, notifications: sent } });
    return { invoices: new Set(overdue.map((r) => r.id)).size, notifications: sent };
  });
}

/* ------------------------------------------------------------------ adjustments */

const ADJUSTMENT_KINDS = ["waiver", "extra_charge", "refund", "receipt_reversal"] as const;

export async function requestAdjustment(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { studentId: string; invoiceId?: string | null; paymentId?: string | null; kind: string; amount: string; reason: string },
): Promise<{ id: string }> {
  parse(uuidField("Student"), input.studentId);
  const kind = parse(z.enum(ADJUSTMENT_KINDS, { message: "Choose the kind of adjustment." }), input.kind);
  const reason = parse(trimmed("Reason", 3, 200), input.reason);
  return withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    let amountPaise: number;
    let invoiceId = input.invoiceId || null;
    const paymentId = input.paymentId || null;
    if (kind === "refund" || kind === "receipt_reversal") {
      if (!paymentId) throw new AppError("VALIDATION", "Choose the payment.", { paymentId: "Required." });
      parse(uuidField("Payment"), paymentId);
      const [p] = await tx.select().from(payments).where(and(eq(payments.schoolId, schoolId), eq(payments.id, paymentId), eq(payments.studentId, input.studentId)));
      if (!p || p.status !== "captured") throw new AppError("NOT_FOUND", "Received payment not found.");
      invoiceId = p.invoiceId;
      amountPaise = kind === "receipt_reversal" ? p.amountPaise : requireRupees(input.amount, "amount");
      if (kind === "receipt_reversal" && p.method === "online") throw new AppError("VALIDATION", "Online payments are refunded, not reversed.");
      if (amountPaise > p.amountPaise) throw new AppError("VALIDATION", "A refund cannot be more than the payment.", { amount: "More than the payment." });
    } else {
      amountPaise = requireRupees(input.amount, "amount");
      if (invoiceId) {
        parse(uuidField("Invoice"), invoiceId);
        const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.schoolId, schoolId), eq(invoices.id, invoiceId), eq(invoices.studentId, input.studentId)));
        if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
      }
    }
    try {
      const [a] = await tx
        .insert(feeAdjustments)
        .values({ schoolId, studentId: input.studentId, invoiceId, paymentId, kind, amountPaise, reason, requestedBy: actor.userId })
        .returning({ id: feeAdjustments.id });
      await audit(tx, { action: "fees.adjustment_requested", actorUserId: actor.userId, schoolId, entityType: "fee_adjustment", entityId: a!.id, data: { kind, amountPaise } });
      return { id: a!.id };
    } catch (e) {
      if (uniqueViolation(e)?.includes("one_open_payment_reversal")) {
        throw new AppError("CONFLICT", "This payment already has a refund or reversal requested.");
      }
      throw e;
    }
  });
}

export async function decideAdjustment(db: Db, ctx: RequestContext, schoolId: string, adjustmentId: string, approve: boolean): Promise<void> {
  parse(uuidField("Adjustment"), adjustmentId);
  await withCapability(db, ctx, schoolId, "school.fees.approve", async (tx, actor) => {
    await decisionGuard(tx, "fee_adjustments", adjustmentId, schoolId, actor.userId);
    const [a] = await tx.select().from(feeAdjustments).where(eq(feeAdjustments.id, adjustmentId));
    if (!a) throw new AppError("NOT_FOUND", "Request not found.");
    if (!approve) {
      await tx.update(feeAdjustments).set({ status: "rejected", decidedBy: actor.userId, decidedAt: sql`now()` }).where(eq(feeAdjustments.id, adjustmentId));
      await audit(tx, { action: "fees.adjustment_rejected", actorUserId: actor.userId, schoolId, entityType: "fee_adjustment", entityId: adjustmentId });
      return;
    }
    let entry: { id: string };
    if (a.kind === "receipt_reversal") {
      const [credit] = (await tx.execute(sql`select id, amount_paise as amount from ledger_entries where payment_id = ${a.paymentId}::uuid and kind = 'payment'`)) as unknown as { id: string; amount: number }[];
      if (!credit) throw new AppError("CONFLICT", "The payment's ledger entry was not found.");
      [entry] = (await tx
        .insert(ledgerEntries)
        .values({ schoolId, studentId: a.studentId, invoiceId: a.invoiceId, paymentId: null, kind: "reversal", amountPaise: -credit.amount, reversesEntryId: credit.id, memo: `Receipt reversed: ${a.reason}`.slice(0, 200), createdBy: actor.userId })
        .returning({ id: ledgerEntries.id })) as [{ id: string }];
    } else {
      const amount = a.kind === "waiver" ? -a.amountPaise : a.amountPaise;
      [entry] = (await tx
        .insert(ledgerEntries)
        .values({ schoolId, studentId: a.studentId, invoiceId: a.invoiceId, kind: a.kind === "refund" ? "refund" : "adjustment", amountPaise: amount, memo: `${a.kind === "refund" ? "Refund" : a.kind === "waiver" ? "Waiver" : "Extra charge"}: ${a.reason}`.slice(0, 200), createdBy: actor.userId })
        .returning({ id: ledgerEntries.id })) as [{ id: string }];
    }
    await tx.update(feeAdjustments).set({ status: "approved", decidedBy: actor.userId, decidedAt: sql`now()`, ledgerEntryId: entry.id }).where(eq(feeAdjustments.id, adjustmentId));
    await audit(tx, { action: "fees.adjustment_approved", actorUserId: actor.userId, schoolId, entityType: "fee_adjustment", entityId: adjustmentId, data: { kind: a.kind, amountPaise: a.amountPaise } });
  });
}

export interface PendingApproval {
  id: string;
  type: "concession" | "adjustment";
  kind: string;
  studentId: string;
  studentName: string;
  amountText: string;
  reason: string;
  requestedBy: string;
  requestedByMe: boolean;
  createdAt: Date;
}

export async function listPendingApprovals(db: Db, ctx: RequestContext, schoolId: string): Promise<PendingApproval[]> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id, 'concession' as type, c.kind::text as kind, c.student_id as "studentId", p.display_name as "studentName", c.value, c.kind::text as vkind,
             c.reason, u.full_name as "requestedBy", c.requested_by = app_user_id() as "requestedByMe", c.created_at as "createdAt"
      from fee_concessions c join student_profiles p on p.id = c.student_id left join users u on u.id = c.requested_by
      where c.school_id = ${schoolId}::uuid and c.status = 'pending'
      union all
      select a.id, 'adjustment', a.kind::text, a.student_id, p.display_name, a.amount_paise, 'amount', a.reason, u.full_name, a.requested_by = app_user_id(), a.created_at
      from fee_adjustments a join student_profiles p on p.id = a.student_id left join users u on u.id = a.requested_by
      where a.school_id = ${schoolId}::uuid and a.status = 'pending'
      order by "createdAt"`)) as unknown as (Omit<PendingApproval, "amountText"> & { value: number; vkind: string })[];
    return rows.map(({ value, vkind, ...r }) => ({ ...r, amountText: vkind === "percent" ? `${(value / 100).toFixed(2)}%` : formatPaise(value) }));
  });
}

/* ------------------------------------------------------------------ statements */

export interface InvoiceSummary {
  id: string;
  number: string;
  dueOn: string;
  totalPaise: number;
  balancePaise: number;
  status: "open" | "cancelled";
  structureName: string;
  lines: { description: string; amountPaise: number; discountPaise: number; taxPaise: number; totalPaise: number }[];
}

export interface PaymentSummary {
  id: string;
  invoiceNumber: string;
  method: string;
  amountPaise: number;
  status: "pending" | "captured" | "failed";
  receiptNo: string | null;
  reference: string | null;
  capturedAt: Date | null;
  createdAt: Date;
}

export interface StudentAccount {
  studentId: string;
  displayName: string;
  admissionNo: string;
  balancePaise: number;
  overduePaise: number;
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  ledger: { id: string; kind: string; amountPaise: number; memo: string | null; createdAt: Date; reversed: boolean }[];
  concessions: { id: string; headName: string | null; kind: string; value: number; status: string; revoked: boolean; reason: string }[];
  adjustments: { id: string; kind: string; amountPaise: number; status: string; reason: string }[];
}

export async function accountTx(tx: Tx, schoolId: string, studentId: string, full: boolean): Promise<StudentAccount> {
  const [p] = (await tx.execute(sql`select id, display_name as "displayName", admission_no as "admissionNo" from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid`)) as unknown as { id: string; displayName: string; admissionNo: string }[];
  if (!p) throw new AppError("NOT_FOUND", "Student not found.");
  const t = await today(tx, schoolId);
  const inv = (await tx.execute(sql`
    select i.id, i.number, i.due_on::text as "dueOn", i.total_paise as "totalPaise", i.status::text as status, coalesce(s.name, 'School fees') as "structureName",
           (select coalesce(sum(l.amount_paise), 0)::int from ledger_entries l where l.invoice_id = i.id) as "balancePaise"
    from invoices i left join fee_structures s on s.id = i.structure_id -- parents cannot read fee structures
    where i.school_id = ${schoolId}::uuid and i.student_id = ${studentId}::uuid order by i.due_on desc, i.number desc`)) as unknown as Omit<InvoiceSummary, "lines">[];
  const lines = inv.length
    ? ((await tx.execute(sql`
        select invoice_id as "invoiceId", description, amount_paise as "amountPaise", discount_paise as "discountPaise", tax_paise as "taxPaise", total_paise as "totalPaise"
        from invoice_lines where invoice_id in (${sql.join(inv.map((i) => sql`${i.id}::uuid`), sql`, `)}) order by description`)) as unknown as (InvoiceSummary["lines"][number] & { invoiceId: string })[])
    : [];
  const pays = (await tx.execute(sql`
    select py.id, i.number as "invoiceNumber", py.method::text as method, py.amount_paise as "amountPaise", py.status::text as status, py.receipt_no as "receiptNo",
           py.reference, py.captured_at as "capturedAt", py.created_at as "createdAt"
    from payments py join invoices i on i.id = py.invoice_id where py.school_id = ${schoolId}::uuid and py.student_id = ${studentId}::uuid order by py.created_at desc`)) as unknown as PaymentSummary[];
  const ledger = (await tx.execute(sql`
    select e.id, e.kind::text as kind, e.amount_paise as "amountPaise", e.memo, e.created_at as "createdAt",
           exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id) as reversed
    from ledger_entries e where e.school_id = ${schoolId}::uuid and e.student_id = ${studentId}::uuid order by e.created_at desc`)) as unknown as StudentAccount["ledger"];
  const concessions = full
    ? ((await tx.execute(sql`
        select c.id, h.name as "headName", c.kind::text as kind, c.value, c.status::text as status, c.revoked_at is not null as revoked, c.reason
        from fee_concessions c left join fee_heads h on h.id = c.fee_head_id where c.school_id = ${schoolId}::uuid and c.student_id = ${studentId}::uuid order by c.created_at desc`)) as unknown as StudentAccount["concessions"])
    : [];
  const adjustments = full
    ? ((await tx.execute(sql`select id, kind::text as kind, amount_paise as "amountPaise", status::text as status, reason from fee_adjustments where school_id = ${schoolId}::uuid and student_id = ${studentId}::uuid order by created_at desc`)) as unknown as StudentAccount["adjustments"])
    : [];
  return {
    studentId: p.id,
    displayName: p.displayName,
    admissionNo: p.admissionNo,
    balancePaise: ledger.reduce((a, e) => a + e.amountPaise, 0),
    overduePaise: inv.filter((i) => i.status === "open" && i.dueOn < t && i.balancePaise > 0).reduce((a, i) => a + i.balancePaise, 0),
    invoices: inv.map((i) => ({ ...i, lines: lines.filter((l) => l.invoiceId === i.id).map(({ invoiceId: _x, ...l }) => l) })),
    payments: pays,
    ledger,
    concessions,
    adjustments,
  };
}

/** A student's full fee account for finance staff. */
export async function getStudentAccount(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<StudentAccount> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.fees.view", (tx) => accountTx(tx, schoolId, studentId, true));
}

/** A linked child's statement for a parent (another student is not found). */
export async function getChildFees(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<StudentAccount> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.fees.pay", (tx) => accountTx(tx, schoolId, studentId, false));
}

export interface Receipt {
  paymentId: string;
  receiptNo: string;
  schoolName: string;
  studentName: string;
  admissionNo: string;
  invoiceNumber: string;
  method: string;
  reference: string | null;
  amountPaise: number;
  capturedAt: Date;
  reversed: boolean;
}

/** A receipt for finance staff or the child's linked parent. */
export async function getReceipt(db: Db, ctx: RequestContext, schoolId: string, paymentId: string): Promise<Receipt> {
  parse(uuidField("Payment"), paymentId);
  // Any member may ask; the payments policy shows the row only to finance staff and the child's parents.
  return withCapability(db, ctx, schoolId, "school.view", async (tx) => {
    const [r] = (await tx.execute(sql`
      select py.id as "paymentId", py.receipt_no as "receiptNo", s.name as "schoolName", p.display_name as "studentName", p.admission_no as "admissionNo",
             i.number as "invoiceNumber", py.method::text as method, py.reference, py.amount_paise as "amountPaise", py.captured_at as "capturedAt",
             exists (select 1 from ledger_entries c join ledger_entries r on r.reverses_entry_id = c.id where c.payment_id = py.id) as reversed
      from payments py join invoices i on i.id = py.invoice_id join student_profiles p on p.id = py.student_id join schools s on s.id = py.school_id
      where py.school_id = ${schoolId}::uuid and py.id = ${paymentId}::uuid and py.status = 'captured'`)) as unknown as Receipt[];
    if (!r) throw new AppError("NOT_FOUND", "Receipt not found.");
    return r;
  });
}


export interface FeeStudentRow {
  studentId: string;
  displayName: string;
  admissionNo: string;
  className: string | null;
  balancePaise: number;
}

/** Students by name or admission number with their balance (finance staff). */
export async function searchFeeStudents(db: Db, ctx: RequestContext, schoolId: string, search: string): Promise<FeeStudentRow[]> {
  const q = search.trim().slice(0, 100);
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) =>
    (await tx.execute(sql`
      select p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo",
             (select c.name || ' ' || sec.name from enrollments e join sections sec on sec.id = e.section_id join classes c on c.id = sec.class_id
              where e.student_id = p.id and e.ends_on is null order by e.starts_on desc limit 1) as "className",
             (select coalesce(sum(l.amount_paise), 0)::int from ledger_entries l where l.student_id = p.id) as "balancePaise"
      from student_profiles p
      where p.school_id = ${schoolId}::uuid
        ${q ? sql`and (p.display_name ilike ${likePattern(q)} or p.admission_no ilike ${likePattern(q)})` : sql``}
      order by lower(p.display_name) limit 50`)) as unknown as FeeStudentRow[],
  );
}
