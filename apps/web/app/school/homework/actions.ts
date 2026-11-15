"use server";

import { revalidatePath } from "next/cache";
import { AppError, archiveHomework, createHomework, remindHomework, returnFeedback, updateHomework } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";
import { uploadChosenFiles } from "@/lib/uploads";

/** Homework actions for administrators and teachers; the service and the database decide which sections. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/homework", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function createHomeworkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const fileIds = await uploadChosenFiles(ctx, schoolId, fd, "homework_attachment");
    const r = await createHomework(db, ctx, schoolId, {
      sectionIds: fd.getAll("sectionIds").filter((v): v is string => typeof v === "string"),
      subjectId: str(fd, "subjectId"),
      title: str(fd, "title"),
      instructions: str(fd, "instructions"),
      dueAt: str(fd, "dueAt"),
      allowLate: str(fd, "allowLate") === "on",
      fileIds,
    });
    return `Homework set for ${r.ids.length} section(s). Students and parents have been notified.`;
  });
}

export async function updateHomeworkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateHomework(db, ctx, schoolId, str(fd, "homeworkId"), { title: str(fd, "title"), instructions: str(fd, "instructions"), dueAt: str(fd, "dueAt"), allowLate: str(fd, "allowLate") === "on" });
    return "Homework updated.";
  });
}

export async function archiveHomeworkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await archiveHomework(db, ctx, schoolId, str(fd, "homeworkId"));
    return "Homework archived. Students and parents no longer see it.";
  });
}

export async function remindHomeworkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await remindHomework(db, ctx, schoolId, str(fd, "homeworkId"));
    return r.notified ? `Reminder sent (${r.notified} notification(s)).` : "Nobody new to remind today: everyone has submitted or was already reminded.";
  });
}

export async function feedbackAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await returnFeedback(db, ctx, schoolId, str(fd, "submissionId"), str(fd, "feedback"));
    return "Feedback returned.";
  });
}
