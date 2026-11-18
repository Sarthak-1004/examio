"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, changeApplicationStatus, convertApplication, createApplication, setApplicationDocument, updateApplication, uploadFile } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { str, type FormState } from "@/lib/forms";
import { fileStorage } from "@/lib/runtime";

/** Admissions actions for school administrators; the services and the database check the rest. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string | FormState>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const r = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/admissions", "layout");
    return typeof r === "string" ? { ok: true, message: r } : r;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const details = (fd: FormData) => ({
  yearId: str(fd, "yearId"),
  classId: str(fd, "classId"),
  applicantName: str(fd, "applicantName"),
  dateOfBirth: str(fd, "dateOfBirth"),
  guardianName: str(fd, "guardianName"),
  guardianPhone: str(fd, "guardianPhone"),
  guardianEmail: str(fd, "guardianEmail"),
  previousSchool: str(fd, "previousSchool"),
  notes: str(fd, "notes"),
});

export async function createApplicationAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  let id: string;
  try {
    id = (await createApplication(db, s.ctx, s.ctx.schoolId, { ...details(fd), stage: str(fd, "stage") === "applied" ? "applied" : "enquiry", confirmNotDuplicate: str(fd, "confirmNotDuplicate") === "on" })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/admissions", "layout");
  redirect(`/school/admissions/${id}`);
}

export async function updateApplicationAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateApplication(db, ctx, schoolId, str(fd, "applicationId"), details(fd));
    return "Saved.";
  });
}

export async function documentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const file = fd.get("file");
    let fileId: string | undefined;
    if (file instanceof File && file.size > 0) {
      fileId = (await uploadFile(db, ctx, fileStorage(), { schoolId, purpose: "admission_document", fileName: file.name, data: Buffer.from(await file.arrayBuffer()) })).id;
    }
    const status = str(fd, "status") || (fileId ? "received" : "missing");
    await setApplicationDocument(db, ctx, schoolId, str(fd, "applicationId"), {
      kind: str(fd, "kind") as never,
      status: status as never,
      required: str(fd, "required") ? str(fd, "required") === "1" : undefined,
      fileId,
      note: str(fd, "note"),
    });
    return "Saved.";
  });
}

export async function statusAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const to = str(fd, "to");
    await changeApplicationStatus(db, ctx, schoolId, str(fd, "applicationId"), to, str(fd, "note"));
    return { ok: true, message: "Updated." };
  });
}

/**
 * Creates the student. The page is deliberately not refreshed here: the one-time activation code
 * is shown once in this form's message, and a refresh would replace the form (the application is
 * now enrolled) before the administrator could copy it.
 */
export async function convertAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const r = await convertApplication(db, s.ctx, s.ctx.schoolId, str(fd, "applicationId"), {
      admissionNo: str(fd, "admissionNo"),
      sectionId: str(fd, "sectionId"),
      rollNo: str(fd, "rollNo"),
      confirmNotDuplicate: str(fd, "confirmNotDuplicate") === "on",
    });
    if (!r.created) return { ok: true, message: "This application was already converted; nothing new was created. Reload the page." };
    return {
      ok: true,
      message: `Student created (sign-in name ${r.username}). Copy the activation code now: it is not shown again. They choose a password at /redeem. Reload the page when done.`,
      code: r.activationCode ?? undefined,
      codeExpires: r.codeExpiresAt ? formatDateTime(r.codeExpiresAt, s.timeZone) : undefined,
    };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
