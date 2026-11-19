"use server";

import { revalidatePath } from "next/cache";
import {
  AppError,
  addHrDocument,
  cancelLeave,
  createHrName,
  createLeaveType,
  decideLeave,
  markStaffRegister,
  removeHrDocument,
  requestLeave,
  setHrNameArchived,
  setPaymentDetails,
  updateEmployment,
  updateLeaveType,
  uploadFile,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";
import { fileStorage } from "@/lib/runtime";

/** HR actions for school administrators; the services and the database check the rest. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/hr", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const kindOf = (fd: FormData) => (str(fd, "list") === "designation" ? "designation" : "department");

export async function createNameAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createHrName(db, ctx, schoolId, kindOf(fd), str(fd, "name"));
    return "Added.";
  });
}

export async function archiveNameAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "1";
    await setHrNameArchived(db, ctx, schoolId, kindOf(fd), str(fd, "id"), archived);
    return archived ? "Archived." : "Restored.";
  });
}

export async function employmentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const { changes } = await updateEmployment(db, ctx, schoolId, str(fd, "staffId"), {
      employmentType: str(fd, "employmentType") as never,
      departmentId: str(fd, "departmentId"),
      designationId: str(fd, "designationId"),
      confirmedOn: str(fd, "confirmedOn"),
      noticeDays: str(fd, "noticeDays"),
      emergencyName: str(fd, "emergencyName"),
      emergencyPhone: str(fd, "emergencyPhone"),
      effectiveOn: str(fd, "effectiveOn"),
      note: str(fd, "note"),
    });
    return changes ? `Saved; ${changes} change${changes === 1 ? "" : "s"} added to the history.` : "Saved.";
  });
}

export async function paymentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await setPaymentDetails(db, ctx, schoolId, str(fd, "staffId"), { accountHolder: str(fd, "accountHolder"), accountNo: str(fd, "accountNo"), ifsc: str(fd, "ifsc"), pan: str(fd, "pan") });
    return "Payment details saved.";
  });
}

export async function documentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose a file.", { file: "Required." });
    const up = await uploadFile(db, ctx, fileStorage(), { schoolId, purpose: "hr_document", fileName: file.name, data: Buffer.from(await file.arrayBuffer()) });
    await addHrDocument(db, ctx, schoolId, str(fd, "staffId"), { kind: str(fd, "kind"), fileId: up.id, note: str(fd, "note") });
    return "Document added.";
  });
}

export async function removeDocumentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removeHrDocument(db, ctx, schoolId, str(fd, "documentId"));
    return "Document removed.";
  });
}

/* ------------------------------------------------------------------ leave and the staff register (Phase 14.2) */

export async function leaveTypeAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createLeaveType(db, ctx, schoolId, { name: str(fd, "name"), paid: str(fd, "paid") !== "no", quotaDays: str(fd, "quotaDays") });
    return "Leave type added.";
  });
}

export async function leaveTypeUpdateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived");
    await updateLeaveType(db, ctx, schoolId, str(fd, "typeId"), {
      quotaDays: fd.has("quotaDays") ? str(fd, "quotaDays") : undefined,
      archived: archived === "" ? undefined : archived === "1",
    });
    return "Saved.";
  });
}

export async function decideLeaveAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const approve = str(fd, "decision") === "approve";
    await decideLeave(db, ctx, schoolId, str(fd, "requestId"), approve, str(fd, "note"));
    return approve ? "Approved." : "Rejected.";
  });
}

export async function cancelLeaveAdminAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await cancelLeave(db, ctx, schoolId, str(fd, "requestId"), str(fd, "reason"));
    return "Cancelled.";
  });
}

export async function requestForStaffAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await requestLeave(db, ctx, schoolId, {
      staffId: str(fd, "staffId"),
      leaveTypeId: str(fd, "leaveTypeId"),
      fromOn: str(fd, "fromOn"),
      toOn: str(fd, "toOn"),
      halfDay: str(fd, "halfDay") === "on",
      reason: str(fd, "reason"),
    });
    return `Requested ${r.days} day(s); another administrator decides it.`;
  });
}

export async function registerAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const marks = [...fd.entries()].filter(([k]) => k.startsWith("m:")).map(([k, v]) => ({ staffId: k.slice(2), status: String(v) }));
    const r = await markStaffRegister(db, ctx, schoolId, { date: str(fd, "date"), marks, reason: str(fd, "reason") });
    return `Saved: ${r.marked} marked, ${r.corrected} corrected${r.skippedLeave ? `, ${r.skippedLeave} on leave left unchanged` : ""}.`;
  });
}
