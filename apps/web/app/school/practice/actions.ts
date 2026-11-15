"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addPracticeItems,
  addPracticeItemsFromTopic,
  AppError,
  archivePracticeSet,
  assignPracticeSet,
  createPracticeSet,
  publishPracticeSet,
  removePracticeAssignment,
  removePracticeItem,
  updatePracticeSet,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Practice set actions for administrators and teachers. The services and the database decide
 * which subjects a teacher may build sets for and which sections they may assign to.
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/practice", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const settings = (fd: FormData) => ({
  title: str(fd, "title"),
  instructions: str(fd, "instructions"),
  attemptLimit: str(fd, "attemptLimit"),
  feedback: str(fd, "feedback") as "immediate" | "after_close",
  topicId: str(fd, "topicId"),
});

export async function createPracticeSetAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  let id: string;
  try {
    id = (await createPracticeSet(db, s.ctx, s.ctx.schoolId, { subjectId: str(fd, "subjectId"), ...settings(fd) })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/practice", "layout");
  redirect(`/school/practice/${id}`);
}

export async function updatePracticeSetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updatePracticeSet(db, ctx, schoolId, str(fd, "setId"), settings(fd));
    return "Saved.";
  });
}

export async function addPracticeQuestionsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const ids = fd.getAll("questionId").filter((v): v is string => typeof v === "string");
    const r = await addPracticeItems(db, ctx, schoolId, str(fd, "setId"), ids);
    return r.added ? `Added ${r.added} question(s).` : "Those questions are already in the set.";
  });
}

export async function addPracticeTopicAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await addPracticeItemsFromTopic(db, ctx, schoolId, str(fd, "setId"), str(fd, "topicId"), Number(str(fd, "count") || "10"));
    return `Added ${r.added} question(s).`;
  });
}

export async function removePracticeItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removePracticeItem(db, ctx, schoolId, str(fd, "setId"), str(fd, "itemId"));
    return "Removed.";
  });
}

export async function practiceSetStateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const id = str(fd, "setId");
    if (str(fd, "op") === "publish") {
      await publishPracticeSet(db, ctx, schoolId, id);
      return "Published. Assign it to a section so students can practise.";
    }
    if (str(fd, "op") === "archive") {
      await archivePracticeSet(db, ctx, schoolId, id);
      return "Archived.";
    }
    throw new AppError("VALIDATION", "Unknown action.");
  });
}

export async function assignPracticeAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await assignPracticeSet(db, ctx, schoolId, str(fd, "setId"), { sectionId: str(fd, "sectionId"), opensAt: str(fd, "opensAt"), closesAt: str(fd, "closesAt") });
    return "Assigned.";
  });
}

export async function unassignPracticeAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removePracticeAssignment(db, ctx, schoolId, str(fd, "assignmentId"));
    return "Assignment removed.";
  });
}
