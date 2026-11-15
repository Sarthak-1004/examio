"use server";

import { revalidatePath } from "next/cache";
import { AppError, submitHomework } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { str, type FormState } from "@/lib/forms";
import { db } from "@/lib/db";
import { uploadChosenFiles } from "@/lib/uploads";

/** A student submits their own homework; the service and the database check the rest. */
export async function submitHomeworkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("student");
  try {
    const fileIds = await uploadChosenFiles(s.ctx, s.ctx.schoolId, fd, "homework_submission");
    const r = await submitHomework(db, s.ctx, s.ctx.schoolId, str(fd, "homeworkId"), { body: str(fd, "body"), fileIds });
    revalidatePath("/student", "layout");
    return { ok: true, message: r.created ? (r.late ? "Submitted (late)." : "Submitted.") : "Submission updated." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
