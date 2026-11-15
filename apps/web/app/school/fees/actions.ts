"use server";

import { revalidatePath } from "next/cache";
import {
  AppError,
  addFeeStructureItem,
  applyLateFees,
  approveFeeStructure,
  archiveFeeHead,
  archiveFeeStructure,
  cancelInvoice,
  createFeeHead,
  createFeeStructure,
  decideAdjustment,
  decideConcession,
  formatPaise,
  issueInvoices,
  recordOfflinePayment,
  reconcilePendingPayments,
  removeFeeStructureItem,
  requestAdjustment,
  requestConcession,
  revokeConcession,
  sendOverdueReminders,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";
import { paymentProvider } from "@/lib/runtime";

/**
 * Fee actions for finance staff and administrators. Approvals are for school administrators; the
 * services and the database check every rule again (including "not your own request").
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "finance");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/fees", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function createHeadAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createFeeHead(db, ctx, schoolId, { name: str(fd, "name"), taxPercent: str(fd, "taxPercent") });
    return "Fee head added.";
  });
}

export async function archiveHeadAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archive = str(fd, "archive") === "1";
    await archiveFeeHead(db, ctx, schoolId, str(fd, "headId"), archive);
    return archive ? "Fee head archived." : "Fee head restored.";
  });
}

export async function createStructureAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createFeeStructure(db, ctx, schoolId, { yearId: str(fd, "yearId"), classId: str(fd, "classId"), name: str(fd, "name"), lateFee: str(fd, "lateFee"), lateGraceDays: str(fd, "lateGraceDays") || "0" });
    return "Fee structure created as a draft. Add its items, then ask a school administrator to approve it.";
  });
}

export async function addItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await addFeeStructureItem(db, ctx, schoolId, str(fd, "structureId"), { feeHeadId: str(fd, "feeHeadId"), label: str(fd, "label"), amount: str(fd, "amount"), dueOn: str(fd, "dueOn") });
    return "Item added.";
  });
}

export async function removeItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removeFeeStructureItem(db, ctx, schoolId, str(fd, "itemId"));
    return "Item removed.";
  });
}

export async function approveStructureAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await approveFeeStructure(db, ctx, schoolId, str(fd, "structureId"));
    return "Fee structure approved. Its items can no longer change.";
  });
}

export async function archiveStructureAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await archiveFeeStructure(db, ctx, schoolId, str(fd, "structureId"));
    return "Fee structure archived.";
  });
}

export async function issueAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await issueInvoices(db, ctx, schoolId, { structureId: str(fd, "structureId"), dueOn: str(fd, "dueOn") });
    return r.issued ? `${r.issued} invoice(s) issued, ${formatPaise(r.totalPaise)} in total.${r.skipped ? ` ${r.skipped} student(s) already had this invoice.` : ""}` : "Every student already has this invoice.";
  });
}

export async function recordPaymentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await recordOfflinePayment(db, ctx, schoolId, { invoiceId: str(fd, "invoiceId"), amount: str(fd, "amount"), method: str(fd, "method"), reference: str(fd, "reference"), idempotencyKey: str(fd, "key") });
    return r.replayed ? `Already recorded as receipt ${r.receiptNo}.` : `Payment recorded. Receipt ${r.receiptNo}.`;
  });
}

export async function requestConcessionAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await requestConcession(db, ctx, schoolId, { studentId: str(fd, "studentId"), feeHeadId: str(fd, "feeHeadId"), kind: str(fd, "kind"), value: str(fd, "value"), reason: str(fd, "reason") });
    return "Concession requested. A school administrator (not you) must approve it; it applies to invoices issued after approval.";
  });
}

export async function revokeConcessionAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await revokeConcession(db, ctx, schoolId, str(fd, "concessionId"));
    return "Concession revoked for future invoices.";
  });
}

export async function requestAdjustmentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await requestAdjustment(db, ctx, schoolId, { studentId: str(fd, "studentId"), invoiceId: str(fd, "invoiceId"), paymentId: str(fd, "paymentId"), kind: str(fd, "kind"), amount: str(fd, "amount"), reason: str(fd, "reason") });
    return "Adjustment requested. A school administrator (not you) must approve it before it changes the account.";
  });
}

export async function decideAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const approve = str(fd, "decision") === "approve";
    if (str(fd, "type") === "concession") await decideConcession(db, ctx, schoolId, str(fd, "id"), approve);
    else await decideAdjustment(db, ctx, schoolId, str(fd, "id"), approve);
    return approve ? "Approved." : "Rejected.";
  });
}

export async function cancelInvoiceAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await cancelInvoice(db, ctx, schoolId, str(fd, "invoiceId"), str(fd, "reason"));
    return "Invoice cancelled; its charges were reversed.";
  });
}

export async function lateFeesAction(): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await applyLateFees(db, ctx, schoolId);
    return r.applied ? `Late fee added to ${r.applied} invoice(s), ${formatPaise(r.totalPaise)} in total.` : "No invoice needs a late fee now.";
  });
}

export async function remindersAction(): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await sendOverdueReminders(db, ctx, schoolId);
    return r.invoices ? `Reminders queued for ${r.invoices} overdue invoice(s) (${r.notifications} notification(s); parents are reminded at most once a day).` : "No overdue invoices.";
  });
}

export async function reconcileAction(): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await reconcilePendingPayments(db, ctx, schoolId, paymentProvider());
    return `Checked ${r.checked} pending online payment(s): ${r.captured} captured, ${r.failed} failed.`;
  });
}
