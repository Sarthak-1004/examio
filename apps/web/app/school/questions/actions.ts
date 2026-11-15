"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  archiveQuestion,
  archiveTopic,
  commitQuestionImport,
  createChapter,
  createQuestion,
  createTopic,
  previewQuestionImport,
  publishQuestion,
  renameTopic,
  sendBackQuestion,
  submitForReview,
  updateQuestion,
  uploadFile,
  type ContentInput,
  type QuestionImportPreview,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";
import { fileStorage } from "@/lib/runtime";

/**
 * Question bank actions for administrators and teachers. The services and the database decide
 * which subjects a teacher may touch; publishing, sending back and archiving are for administrators.
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/questions", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

async function contentFrom(ctx: RequestContext, schoolId: string, fd: FormData): Promise<ContentInput> {
  const image = fd.get("image");
  let imageFileId: string | null = str(fd, "removeImage") === "on" ? null : str(fd, "currentImageId") || null;
  if (image instanceof File && image.size > 0) {
    const up = await uploadFile(db, ctx, fileStorage(), { schoolId, purpose: "question_image", fileName: image.name, data: Buffer.from(await image.arrayBuffer()) });
    imageFileId = up.id;
  }
  return {
    type: str(fd, "type"),
    difficulty: str(fd, "difficulty"),
    stem: str(fd, "stem"),
    options: ["option0", "option1", "option2", "option3", "option4", "option5"].map((k) => str(fd, k)),
    correct: str(fd, "correct"),
    modelAnswer: str(fd, "modelAnswer"),
    explanation: str(fd, "explanation"),
    marks: str(fd, "marks"),
    negativeMarks: str(fd, "negativeMarks"),
    imageFileId,
  };
}

export async function createQuestionAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  let id: string;
  try {
    const r = await createQuestion(db, s.ctx, s.ctx.schoolId, { subjectId: str(fd, "subjectId"), topicId: str(fd, "topicId") || null, content: await contentFrom(s.ctx, s.ctx.schoolId, fd), submit: str(fd, "submit") === "1" });
    id = r.id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/questions", "layout");
  redirect(`/school/questions/${id}?saved=1`);
}

export async function updateQuestionAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await updateQuestion(db, ctx, schoolId, str(fd, "questionId"), { topicId: str(fd, "topicId"), content: await contentFrom(ctx, schoolId, fd) });
    return r.newVersion ? `Saved as version ${r.revision}. The published version stays in use until this one is published.` : "Saved.";
  });
}

export async function questionStateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const id = str(fd, "questionId");
    switch (str(fd, "op")) {
      case "submit":
        await submitForReview(db, ctx, schoolId, id);
        return "Submitted for review.";
      case "publish": {
        const r = await publishQuestion(db, ctx, schoolId, id);
        return `Version ${r.revision} published.`;
      }
      case "sendBack":
        await sendBackQuestion(db, ctx, schoolId, id);
        return "Sent back to draft.";
      case "archive":
        await archiveQuestion(db, ctx, schoolId, id, true);
        return "Archived.";
      case "restore":
        await archiveQuestion(db, ctx, schoolId, id, false);
        return "Restored.";
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}

export async function createChapterAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createChapter(db, ctx, schoolId, { subjectId: str(fd, "subjectId"), name: str(fd, "name") });
    return "Chapter added.";
  });
}

export async function createTopicAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createTopic(db, ctx, schoolId, { chapterId: str(fd, "chapterId"), name: str(fd, "name") });
    return "Topic added.";
  });
}

export async function renameTopicAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await renameTopic(db, ctx, schoolId, str(fd, "topicId"), str(fd, "name"));
    return "Renamed.";
  });
}

export async function archiveTopicAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archive = str(fd, "archive") === "1";
    await archiveTopic(db, ctx, schoolId, str(fd, "topicId"), archive);
    return archive ? "Archived." : "Restored.";
  });
}

export interface QuestionImportState {
  message?: string;
  preview?: QuestionImportPreview;
  text?: string;
  key?: string;
  createMissing?: boolean;
  submit?: boolean;
  result?: { created: number; topicsCreated: number; replayed: boolean };
}

export async function previewQuestionImportAction(_p: QuestionImportState, fd: FormData): Promise<QuestionImportState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const file = fd.get("file");
    const text = file instanceof File && file.size > 0 ? (await file.text()).replace(/^﻿/, "") : str(fd, "text");
    if (!text.trim()) return { message: "Choose a CSV file or paste its contents." };
    const createMissing = str(fd, "createMissing") === "on";
    const submit = str(fd, "submit") === "on";
    const preview = await previewQuestionImport(db, s.ctx, s.ctx.schoolId, { text, createMissing, submit });
    return { preview, text, key: crypto.randomUUID(), createMissing, submit };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
}

export async function commitQuestionImportAction(prev: QuestionImportState, fd: FormData): Promise<QuestionImportState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const result = await commitQuestionImport(db, s.ctx, s.ctx.schoolId, {
      text: str(fd, "text"),
      createMissing: str(fd, "createMissing") === "1",
      submit: str(fd, "submit") === "1",
      fingerprint: str(fd, "fingerprint"),
      idempotencyKey: str(fd, "key"),
    });
    revalidatePath("/school/questions", "layout");
    return { result };
  } catch (e) {
    if (e instanceof AppError) return { ...prev, message: e.message };
    throw e;
  }
}
