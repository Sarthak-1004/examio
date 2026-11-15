"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, savePracticeAnswer, startPracticeAttempt, submitPracticeAttempt } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Practice actions for students. Every input is untrusted: the services validate the
 * identifiers and the answer shape, and the database limits each student to their own attempts.
 */
export async function startPracticeAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("student");
  let attemptId: string;
  try {
    attemptId = (await startPracticeAttempt(db, s.ctx, s.ctx.schoolId, str(fd, "setId"))).attemptId;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
  revalidatePath("/student/practice");
  redirect(`/student/practice/attempts/${attemptId}`);
}

export async function savePracticeAnswerAction(attemptId: string, itemId: string, response: unknown, expectedRevision: number): Promise<{ ok: true; revision: number } | { ok: false; message: string }> {
  const s = await requireSchoolRole("student");
  try {
    const r = await savePracticeAnswer(db, s.ctx, s.ctx.schoolId, String(attemptId), { itemId: String(itemId), response, expectedRevision: Number(expectedRevision) });
    return { ok: true, revision: r.revision };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function submitPracticeAttemptAction(attemptId: string): Promise<{ ok: false; message: string } | undefined> {
  const s = await requireSchoolRole("student");
  try {
    await submitPracticeAttempt(db, s.ctx, s.ctx.schoolId, String(attemptId));
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    throw e;
  }
  revalidatePath("/student", "layout");
  redirect(`/student/practice/attempts/${attemptId}?submitted=1`);
}
