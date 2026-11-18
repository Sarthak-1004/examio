"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addExamItems,
  AppError,
  cancelExam,
  createExam,
  publishExam,
  removeExamItem,
  sendBackExam,
  setExamAccommodation,
  setExamTargets,
  submitExamForApproval,
  updateExam,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Exam actions for administrators and teachers. The services and the database decide which
 * subjects and sections a teacher may use; publishing, cancelling and accommodations are for
 * school administrators.
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/exams", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const settings = (fd: FormData) => ({
  title: str(fd, "title"),
  instructions: str(fd, "instructions"),
  opensAt: str(fd, "opensAt"),
  closesAt: str(fd, "closesAt"),
  durationMinutes: str(fd, "durationMinutes"),
  attemptLimit: str(fd, "attemptLimit") || "1",
  negativeMarking: str(fd, "negativeMarking") === "on",
});

export async function createExamAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  let id: string;
  try {
    id = (await createExam(db, s.ctx, s.ctx.schoolId, { subjectId: str(fd, "subjectId"), ...settings(fd) })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/exams", "layout");
  redirect(`/school/exams/${id}`);
}

export async function updateExamAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateExam(db, ctx, schoolId, str(fd, "examId"), settings(fd));
    return "Saved.";
  });
}

export async function addExamQuestionsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const ids = fd.getAll("questionId").filter((v): v is string => typeof v === "string");
    const r = await addExamItems(db, ctx, schoolId, str(fd, "examId"), ids);
    return r.added ? `Added ${r.added} question(s).` : "Those questions are already in the exam.";
  });
}

export async function removeExamQuestionAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removeExamItem(db, ctx, schoolId, str(fd, "examId"), str(fd, "itemId"));
    return "Removed.";
  });
}

export async function setExamSectionsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const ids = fd.getAll("sectionId").filter((v): v is string => typeof v === "string");
    const r = await setExamTargets(db, ctx, schoolId, str(fd, "examId"), ids);
    return `Sections saved (${r.sections}).`;
  });
}

export async function examStateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const id = str(fd, "examId");
    switch (str(fd, "op")) {
      case "submit":
        await submitExamForApproval(db, ctx, schoolId, id);
        return "Submitted for approval.";
      case "sendBack":
        await sendBackExam(db, ctx, schoolId, id);
        return "Back to draft.";
      case "publish":
        await publishExam(db, ctx, schoolId, id);
        return "Published. Students of the chosen sections can sit it while it is open.";
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}

export async function cancelExamAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await cancelExam(db, ctx, schoolId, str(fd, "examId"), str(fd, "reason"));
    return `Exam cancelled.${r.endedAttempts ? ` ${r.endedAttempts} attempt(s) in progress were ended.` : ""}`;
  });
}

export async function accommodationAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await setExamAccommodation(db, ctx, schoolId, str(fd, "examId"), {
      studentId: str(fd, "studentId"),
      extraMinutes: str(fd, "extraMinutes") || "0",
      extraAttempts: str(fd, "extraAttempts") || "0",
      reason: str(fd, "reason"),
    });
    return "Accommodation saved. It applies to attempts started from now on.";
  });
}
