"use server";

import { revalidatePath } from "next/cache";
import { AppError, addHrDocument, createHrName, removeHrDocument, setHrNameArchived, setPaymentDetails, updateEmployment, uploadFile } from "@examio/core";
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
