"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, saveExamAnswer, setExamFlag, startExam, submitExam } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Exam actions for students. Inputs are untrusted: the services validate identifiers and the
 * answer's shape, and the database accepts a write only for the student's own active attempt
 * before its deadline, with the revision the screen last saw.
 */
export async function startExamAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("student");
  let attemptId: string;
  try {
    attemptId = (await startExam(db, s.ctx, s.ctx.schoolId, str(fd, "examId"))).attemptId;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
  revalidatePath("/student/exams");
  redirect(`/student/exams/attempts/${attemptId}`);
}

export type SaveResult = { ok: true; revision: number; savedAt: string } | { ok: false; message: string; final: boolean };

/** `final`: the attempt can no longer be written (submitted or time up); the screen stops trying. */
export async function saveExamAnswerAction(attemptId: string, itemId: string, response: unknown, expectedRevision: number): Promise<SaveResult> {
  const s = await requireSchoolRole("student");
  try {
    const r = await saveExamAnswer(db, s.ctx, s.ctx.schoolId, String(attemptId), { itemId: String(itemId), response, expectedRevision: Number(expectedRevision) });
    return { ok: true, revision: r.revision, savedAt: r.savedAt.toISOString() };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message, final: /submitted|Time is up/.test(e.message) };
    throw e;
  }
}

export async function flagExamQuestionAction(attemptId: string, itemId: string, flagged: boolean): Promise<{ ok: boolean; message?: string }> {
  const s = await requireSchoolRole("student");
  try {
    await setExamFlag(db, s.ctx, s.ctx.schoolId, String(attemptId), String(itemId), Boolean(flagged));
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function submitExamAction(attemptId: string): Promise<{ ok: false; message: string } | undefined> {
  const s = await requireSchoolRole("student");
  try {
    await submitExam(db, s.ctx, s.ctx.schoolId, String(attemptId));
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    throw e;
  }
  revalidatePath("/student", "layout");
  redirect(`/student/exams/attempts/${attemptId}?submitted=1`);
}
