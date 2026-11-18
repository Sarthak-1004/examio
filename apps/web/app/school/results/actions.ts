"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  assignGrader,
  correctExamMark,
  correctOfflineMark,
  createOfflineAssessment,
  designateAttempt,
  importOfflineMarks,
  releaseExamResults,
  removeGrader,
  saveOfflineMarks,
  setWrittenMark,
  startGrading,
  transitionOffline,
  updateOfflineAssessment,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Grading and results actions. The services and the database decide who may grade which exam,
 * enter which section's marks, and release or correct (administrators).
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/results", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function startGradingAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  const examId = str(fd, "examId");
  try {
    await startGrading(db, s.ctx, s.ctx.schoolId, examId);
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
  revalidatePath("/school/results", "layout");
  redirect(`/school/results/exams/${examId}`);
}

export async function markAnswerAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await setWrittenMark(db, ctx, schoolId, { attemptId: str(fd, "attemptId"), itemId: str(fd, "itemId"), marks: str(fd, "marks"), comment: str(fd, "comment") });
    return "Saved.";
  });
}

export async function graderAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    if (str(fd, "op") === "remove") {
      await removeGrader(db, ctx, schoolId, str(fd, "examId"), str(fd, "userId"));
      return "Grader removed.";
    }
    await assignGrader(db, ctx, schoolId, str(fd, "examId"), str(fd, "userId"));
    return "Grader added.";
  });
}

export async function releaseExamAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await releaseExamResults(db, ctx, schoolId, str(fd, "examId"));
    return `Results released for ${r.results} student(s). ${r.notified} notification(s) queued.`;
  });
}

export async function correctExamMarkAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await correctExamMark(db, ctx, schoolId, { attemptId: str(fd, "attemptId"), itemId: str(fd, "itemId"), marks: str(fd, "marks"), reason: str(fd, "reason") });
    return "Corrected. The earlier marks are kept in the history and the family is notified.";
  });
}

export async function designateAttemptAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await designateAttempt(db, ctx, schoolId, { examId: str(fd, "examId"), studentId: str(fd, "studentId"), attemptId: str(fd, "attemptId"), reason: str(fd, "reason") });
    return "The chosen attempt now counts.";
  });
}

const sections = (fd: FormData) => fd.getAll("sectionId").filter((v): v is string => typeof v === "string");

export async function createOfflineAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  let id: string;
  try {
    id = (await createOfflineAssessment(db, s.ctx, s.ctx.schoolId, { subjectId: str(fd, "subjectId"), title: str(fd, "title"), heldOn: str(fd, "heldOn"), maxMarks: str(fd, "maxMarks"), sectionIds: sections(fd) })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/results", "layout");
  redirect(`/school/results/offline/${id}`);
}

export async function updateOfflineAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateOfflineAssessment(db, ctx, schoolId, str(fd, "assessmentId"), { title: str(fd, "title"), heldOn: str(fd, "heldOn"), maxMarks: str(fd, "maxMarks"), sectionIds: sections(fd) });
    return "Saved.";
  });
}

/** Saves a section's register: one field per student, named "v:<studentId>". */
export async function saveOfflineMarksAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const entries = [...fd.entries()].flatMap(([k, v]) => (k.startsWith("v:") && typeof v === "string" ? [{ studentId: k.slice(2), value: v }] : []));
    const r = await saveOfflineMarks(db, ctx, schoolId, str(fd, "assessmentId"), entries);
    return `Saved ${r.saved} entr${r.saved === 1 ? "y" : "ies"}.`;
  });
}

export async function importOfflineAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const file = fd.get("file");
    const text = file instanceof File && file.size > 0 ? (await file.text()).replace(/^﻿/, "") : str(fd, "text");
    if (!text.trim()) throw new AppError("VALIDATION", "Choose a CSV file or paste the lines.");
    const r = await importOfflineMarks(db, ctx, schoolId, str(fd, "assessmentId"), text);
    return `Imported ${r.saved} entr${r.saved === 1 ? "y" : "ies"}.`;
  });
}

export async function offlineStateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const to = str(fd, "to") as "submitted" | "draft" | "locked" | "released";
    const r = await transitionOffline(db, ctx, schoolId, str(fd, "assessmentId"), to);
    return to === "released" ? `Released. ${r.notified} notification(s) queued.` : to === "locked" ? "Locked." : to === "submitted" ? "Submitted." : "Back to draft.";
  });
}

export async function correctOfflineAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await correctOfflineMark(db, ctx, schoolId, { assessmentId: str(fd, "assessmentId"), studentId: str(fd, "studentId"), value: str(fd, "value"), reason: str(fd, "reason") });
    return "Corrected. The earlier entry is kept in the history.";
  });
}
