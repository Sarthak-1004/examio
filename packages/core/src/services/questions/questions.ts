import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { files, questions, questionVersions, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { likePattern, toPage, type Page, type PageRequest } from "../../paging";
import { parse, uuidField } from "../setup/common";

/**
 * Question bank (Phase 9).
 *
 * - Types: single choice (2-6 options, exactly one correct), true/false, and descriptive (graded
 *   by hand; an optional model answer). Other types need explicit scoring rules first.
 * - Marks in hundredths (½ = 50), 0.01-100; optional negative marks up to the marks (not for
 *   descriptive questions). Difficulty easy/medium/hard. Plain text with line breaks; one
 *   optional image.
 * - Versions: a question's latest version is edited in place until it is locked. Publishing
 *   locks it and makes it the published version; editing afterwards creates a new draft version,
 *   and the published one stays exactly as it was for anything that uses it.
 * - Status: draft → in review → published, archived. Teachers write and submit questions for the
 *   subjects they teach; administrators publish, send back and archive.
 * - Students and parents never read the bank. `learnerView` is the only shape a learner screen
 *   may receive: it has no answer key and no explanation.
 */

export const QUESTION_TYPES = ["single_choice", "true_false", "descriptive"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface ChoiceOption {
  id: string;
  text: string;
}

export type AnswerKey = { correct: string } | { correct: boolean } | { modelAnswer: string | null };

export interface QuestionContent {
  type: QuestionType;
  difficulty: Difficulty;
  stem: string;
  options: ChoiceOption[] | null;
  answerKey: AnswerKey;
  explanation: string | null;
  marksX100: number;
  negativeMarksX100: number;
  imageFileId: string | null;
}

/** What a learner may see of a question version: no answer key, no explanation. */
export interface LearnerQuestion {
  type: QuestionType;
  stem: string;
  options: ChoiceOption[] | null;
  marksX100: number;
  negativeMarksX100: number;
  imageFileId: string | null;
}

export function learnerView(c: Pick<QuestionContent, "type" | "stem" | "options" | "marksX100" | "negativeMarksX100" | "imageFileId">): LearnerQuestion {
  return { type: c.type, stem: c.stem, options: c.options ? c.options.map((o) => ({ id: o.id, text: o.text })) : null, marksX100: c.marksX100, negativeMarksX100: c.negativeMarksX100, imageFileId: c.imageFileId };
}

/** "1.5" → 150; null if not 0..100 with at most two decimals. */
export function parseMarks(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return v <= 10000 ? v : null;
}

export function formatMarks(x100: number): string {
  return (x100 / 100).toFixed(2).replace(/\.?0+$/, "");
}

const OPTION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

export interface ContentInput {
  type: string;
  difficulty?: string;
  stem: string;
  /** Option texts in order; empty entries are ignored (single choice). */
  options?: string[];
  /** Single choice: 0-based index of the correct option among the non-empty ones; true/false: "true"/"false". */
  correct?: string;
  modelAnswer?: string;
  explanation?: string;
  marks?: string;
  negativeMarks?: string;
  imageFileId?: string | null;
}

/** Validates and normalises question content; throws VALIDATION with the field at fault. */
export function validateContent(input: ContentInput): QuestionContent {
  const type = parse(z.enum(QUESTION_TYPES, { message: "Choose a question type." }), input.type);
  const difficulty = parse(z.enum(DIFFICULTIES, { message: "Choose a difficulty." }), input.difficulty || "medium");
  const stem = input.stem.trim();
  if (stem.length < 1 || stem.length > 5000) throw new AppError("VALIDATION", "Write the question (up to 5000 characters).", { stem: "Required." });
  const explanation = input.explanation?.trim() ? input.explanation.trim() : null;
  if (explanation && explanation.length > 5000) throw new AppError("VALIDATION", "The explanation is too long (5000 characters).", { explanation: "Too long." });
  const marks = parseMarks(input.marks?.trim() || "1");
  if (marks === null || marks < 1) throw new AppError("VALIDATION", "Marks: enter a number from 0.01 to 100, for example 1 or 0.5.", { marks: "Not valid." });
  const negative = input.negativeMarks?.trim() ? parseMarks(input.negativeMarks) : 0;
  if (negative === null || negative > marks) throw new AppError("VALIDATION", "Negative marks must be between 0 and the question's marks.", { negativeMarks: "Not valid." });
  if (type === "descriptive" && negative > 0) throw new AppError("VALIDATION", "Descriptive questions cannot have negative marks.", { negativeMarks: "Not for descriptive questions." });

  let options: ChoiceOption[] | null = null;
  let answerKey: AnswerKey;
  if (type === "single_choice") {
    const texts = (input.options ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (texts.length < 2 || texts.length > 6) throw new AppError("VALIDATION", "Give between 2 and 6 options.", { options: "2 to 6 options." });
    if (texts.some((t) => t.length > 1000)) throw new AppError("VALIDATION", "Each option can be at most 1000 characters.", { options: "Too long." });
    if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) throw new AppError("VALIDATION", "Two options are the same.", { options: "Duplicate option." });
    options = texts.map((text, i) => ({ id: OPTION_IDS[i]!, text }));
    const idx = Number(input.correct);
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) throw new AppError("VALIDATION", "Mark the one correct option.", { correct: "Choose the correct option." });
    answerKey = { correct: options[idx]!.id };
  } else if (type === "true_false") {
    if (input.correct !== "true" && input.correct !== "false") throw new AppError("VALIDATION", "Choose whether the statement is true or false.", { correct: "Choose true or false." });
    answerKey = { correct: input.correct === "true" };
  } else {
    const model = input.modelAnswer?.trim() ? input.modelAnswer.trim() : null;
    if (model && model.length > 5000) throw new AppError("VALIDATION", "The model answer is too long (5000 characters).", { modelAnswer: "Too long." });
    answerKey = { modelAnswer: model };
  }
  return { type, difficulty, stem, options, answerKey, explanation, marksX100: marks, negativeMarksX100: negative, imageFileId: input.imageFileId || null };
}

async function requireSubject(tx: Tx, schoolId: string, subjectId: string): Promise<void> {
  const [r] = (await tx.execute(sql`select app_can_author_subject(${schoolId}::uuid, ${subjectId}::uuid) as ok, exists (select 1 from subjects where school_id = ${schoolId}::uuid and id = ${subjectId}::uuid and archived_at is null) as found`)) as unknown as { ok: boolean; found: boolean }[];
  if (!r?.found || !r.ok) throw new AppError("NOT_FOUND", "Subject not found.");
}

async function checkTopic(tx: Tx, schoolId: string, subjectId: string, topicId: string | null): Promise<void> {
  if (!topicId) return;
  const [t] = (await tx.execute(sql`select archived_at is not null as archived from topics where school_id = ${schoolId}::uuid and subject_id = ${subjectId}::uuid and id = ${topicId}::uuid`)) as unknown as { archived: boolean }[];
  if (!t) throw new AppError("VALIDATION", "That chapter or topic is not part of this subject.", { topicId: "Not in this subject." });
  if (t.archived) throw new AppError("CONFLICT", "That chapter or topic is archived.");
}

async function checkImage(tx: Tx, schoolId: string, fileId: string | null): Promise<void> {
  if (!fileId) return;
  const [f] = await tx.select({ purpose: files.purpose, deletedAt: files.deletedAt }).from(files).where(and(eq(files.schoolId, schoolId), eq(files.id, fileId)));
  if (!f || f.deletedAt || f.purpose !== "question_image") throw new AppError("VALIDATION", "The image was not found. Upload it again.", { image: "Not found." });
}

function versionValues(c: QuestionContent) {
  return {
    type: c.type,
    difficulty: c.difficulty,
    stem: c.stem,
    options: c.options,
    answerKey: c.answerKey,
    explanation: c.explanation,
    marksX100: c.marksX100,
    negativeMarksX100: c.negativeMarksX100,
    imageFileId: c.imageFileId,
  };
}

export async function createQuestion(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { subjectId: string; topicId?: string | null; content: ContentInput; submit?: boolean },
): Promise<{ id: string }> {
  parse(uuidField("Subject"), input.subjectId);
  if (input.topicId) parse(uuidField("Topic"), input.topicId);
  const content = validateContent(input.content);
  return withCapability(db, ctx, schoolId, "school.questions.manage", (tx, actor) => createInTransaction(tx, actor.userId, schoolId, input.subjectId, input.topicId || null, content, input.submit ?? false));
}

export async function createInTransaction(tx: Tx, actorUserId: string, schoolId: string, subjectId: string, topicId: string | null, content: QuestionContent, submit: boolean): Promise<{ id: string }> {
  await requireSubject(tx, schoolId, subjectId);
  await checkTopic(tx, schoolId, subjectId, topicId);
  await checkImage(tx, schoolId, content.imageFileId);
  const [q] = await tx
    .insert(questions)
    .values({ schoolId, subjectId, topicId, authorUserId: actorUserId, status: submit ? "in_review" : "draft" })
    .returning({ id: questions.id });
  await tx.insert(questionVersions).values({ schoolId, questionId: q!.id, revision: 1, createdBy: actorUserId, ...versionValues(content) });
  await audit(tx, { action: "question.created", actorUserId, schoolId, entityType: "question", entityId: q!.id, data: { type: content.type, submit } });
  return { id: q!.id };
}

/**
 * Saves new content. The latest version is changed in place while unlocked; a locked (published)
 * version is never changed: a new draft version is created instead.
 */
export async function updateQuestion(db: Db, ctx: RequestContext, schoolId: string, questionId: string, input: { topicId?: string | null; content: ContentInput }): Promise<{ revision: number; newVersion: boolean }> {
  parse(uuidField("Question"), questionId);
  if (input.topicId) parse(uuidField("Topic"), input.topicId);
  const content = validateContent(input.content);
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
    const [q] = await tx.select().from(questions).where(and(eq(questions.schoolId, schoolId), eq(questions.id, questionId))).for("update");
    if (!q) throw new AppError("NOT_FOUND", "Question not found.");
    if (q.status === "archived") throw new AppError("CONFLICT", "This question is archived. Restore it first.");
    // Leaving the topic out keeps the current one; an empty value clears it.
    const topicId = input.topicId === undefined ? q.topicId : input.topicId || null;
    await checkTopic(tx, schoolId, q.subjectId, topicId);
    await checkImage(tx, schoolId, content.imageFileId);
    const [latest] = await tx.select().from(questionVersions).where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.revision, q.currentRevision)));
    if (!latest) throw new AppError("CONFLICT", "The question's latest version is missing.");
    let revision = q.currentRevision;
    let newVersion = false;
    if (latest.lockedAt) {
      revision = q.currentRevision + 1;
      newVersion = true;
      await tx.insert(questionVersions).values({ schoolId, questionId, revision, createdBy: actor.userId, ...versionValues(content) });
    } else {
      if (latest.type !== content.type && q.publishedVersionId) throw new AppError("CONFLICT", "The type of a published question cannot change.");
      await tx.update(questionVersions).set({ ...versionValues(content), updatedAt: sql`now()` }).where(eq(questionVersions.id, latest.id));
    }
    // A change goes back to draft; the published version (if any) stays in use.
    await tx
      .update(questions)
      .set({ topicId, currentRevision: revision, status: q.status === "published" || q.status === "in_review" ? "draft" : q.status, updatedAt: sql`now()` })
      .where(eq(questions.id, questionId));
    await audit(tx, { action: newVersion ? "question.version_created" : "question.updated", actorUserId: actor.userId, schoolId, entityType: "question", entityId: questionId, data: { revision } });
    return { revision, newVersion };
  });
}

export async function submitForReview(db: Db, ctx: RequestContext, schoolId: string, questionId: string): Promise<void> {
  parse(uuidField("Question"), questionId);
  await withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
    const r = await tx
      .update(questions)
      .set({ status: "in_review", updatedAt: sql`now()` })
      .where(and(eq(questions.schoolId, schoolId), eq(questions.id, questionId), eq(questions.status, "draft")))
      .returning({ id: questions.id });
    if (r.length === 0) throw new AppError("CONFLICT", "Only a draft can be submitted for review.");
    await audit(tx, { action: "question.submitted", actorUserId: actor.userId, schoolId, entityType: "question", entityId: questionId });
  });
}

/** Publishes the latest version: it is locked and becomes the version practice and exams use. */
export async function publishQuestion(db: Db, ctx: RequestContext, schoolId: string, questionId: string): Promise<{ revision: number }> {
  parse(uuidField("Question"), questionId);
  return withCapability(db, ctx, schoolId, "school.questions.publish", async (tx, actor) => {
    const [q] = await tx.select().from(questions).where(and(eq(questions.schoolId, schoolId), eq(questions.id, questionId))).for("update");
    if (!q) throw new AppError("NOT_FOUND", "Question not found.");
    if (q.status !== "draft" && q.status !== "in_review") throw new AppError("CONFLICT", q.status === "published" ? "This version is already published." : "Restore the question before publishing.");
    const [v] = await tx.select({ id: questionVersions.id }).from(questionVersions).where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.revision, q.currentRevision)));
    if (!v) throw new AppError("CONFLICT", "The question's latest version is missing.");
    await tx.update(questionVersions).set({ lockedAt: sql`now()` }).where(eq(questionVersions.id, v.id));
    await tx.update(questions).set({ status: "published", publishedVersionId: v.id, updatedAt: sql`now()` }).where(eq(questions.id, questionId));
    await audit(tx, { action: "question.published", actorUserId: actor.userId, schoolId, entityType: "question", entityId: questionId, data: { revision: q.currentRevision } });
    return { revision: q.currentRevision };
  });
}

/** Sends a question in review back to its author as a draft. */
export async function sendBackQuestion(db: Db, ctx: RequestContext, schoolId: string, questionId: string): Promise<void> {
  parse(uuidField("Question"), questionId);
  await withCapability(db, ctx, schoolId, "school.questions.publish", async (tx, actor) => {
    const r = await tx
      .update(questions)
      .set({ status: "draft", updatedAt: sql`now()` })
      .where(and(eq(questions.schoolId, schoolId), eq(questions.id, questionId), eq(questions.status, "in_review")))
      .returning({ id: questions.id });
    if (r.length === 0) throw new AppError("CONFLICT", "Only a question in review can be sent back.");
    await audit(tx, { action: "question.sent_back", actorUserId: actor.userId, schoolId, entityType: "question", entityId: questionId });
  });
}

export async function archiveQuestion(db: Db, ctx: RequestContext, schoolId: string, questionId: string, archived: boolean): Promise<void> {
  parse(uuidField("Question"), questionId);
  await withCapability(db, ctx, schoolId, "school.questions.publish", async (tx, actor) => {
    const [q] = await tx.select().from(questions).where(and(eq(questions.schoolId, schoolId), eq(questions.id, questionId)));
    if (!q) throw new AppError("NOT_FOUND", "Question not found.");
    if (archived === (q.status === "archived")) throw new AppError("CONFLICT", archived ? "Already archived." : "This question is not archived.");
    // Restoring returns to published if a published version exists, otherwise to draft.
    const status = archived ? "archived" : q.publishedVersionId ? "published" : "draft";
    await tx.update(questions).set({ status, updatedAt: sql`now()` }).where(eq(questions.id, questionId));
    await audit(tx, { action: archived ? "question.archived" : "question.restored", actorUserId: actor.userId, schoolId, entityType: "question", entityId: questionId });
  });
}

/* ------------------------------------------------------------------ search and detail */

export interface QuestionListRow {
  id: string;
  subjectName: string;
  topicPath: string | null;
  type: QuestionType;
  difficulty: Difficulty;
  stem: string;
  marksX100: number;
  status: "draft" | "in_review" | "published" | "archived";
  revision: number;
  hasPublished: boolean;
  authorName: string | null;
  updatedAt: Date;
}

export interface QuestionFilters {
  search: string;
  subjectId?: string;
  /** A chapter (includes its topics) or a topic. */
  topicId?: string;
  type?: string;
  difficulty?: string;
  status?: string;
}

const isUuid = (v: string | undefined): v is string => !!v && z.uuid().safeParse(v).success;

export async function searchQuestions(db: Db, ctx: RequestContext, schoolId: string, req: PageRequest & QuestionFilters): Promise<Page<QuestionListRow>> {
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx) => {
    const parts: SQL[] = [sql`q.school_id = ${schoolId}::uuid`];
    if (isUuid(req.subjectId)) parts.push(sql`q.subject_id = ${req.subjectId}::uuid`);
    if (isUuid(req.topicId)) parts.push(sql`(q.topic_id = ${req.topicId}::uuid or t.parent_id = ${req.topicId}::uuid)`);
    if (req.type && (QUESTION_TYPES as readonly string[]).includes(req.type)) parts.push(sql`v.type = ${req.type}::question_type`);
    if (req.difficulty && (DIFFICULTIES as readonly string[]).includes(req.difficulty)) parts.push(sql`v.difficulty = ${req.difficulty}::question_difficulty`);
    if (req.status && ["draft", "in_review", "published", "archived"].includes(req.status)) parts.push(sql`q.status = ${req.status}::question_status`);
    else parts.push(sql`q.status <> 'archived'`);
    if (req.search) parts.push(sql`v.stem ilike ${likePattern(req.search)}`);
    const where = sql.join(parts, sql` and `);
    const from = sql`
      from questions q
      join question_versions v on v.question_id = q.id and v.revision = q.current_revision
      join subjects s on s.id = q.subject_id
      left join topics t on t.id = q.topic_id left join topics ch on ch.id = t.parent_id
      left join users u on u.id = q.author_user_id`;
    const [c] = (await tx.execute(sql`select count(*)::int as n ${from} where ${where}`)) as unknown as { n: number }[];
    const rows = (await tx.execute(sql`
      select q.id, s.name as "subjectName", case when t.id is null then null when ch.id is null then t.name else ch.name || ' › ' || t.name end as "topicPath",
             v.type::text as type, v.difficulty::text as difficulty, left(v.stem, 300) as stem, v.marks_x100 as "marksX100", q.status::text as status,
             q.current_revision as revision, q.published_version_id is not null as "hasPublished", u.full_name as "authorName", q.updated_at as "updatedAt"
      ${from} where ${where}
      order by q.updated_at desc, q.id limit ${req.pageSize} offset ${(req.page - 1) * req.pageSize}`)) as unknown as QuestionListRow[];
    return toPage(rows, c?.n ?? 0, req);
  });
}

export interface QuestionVersionDetail extends QuestionContent {
  id: string;
  revision: number;
  locked: boolean;
  createdAt: Date;
  createdByName: string | null;
  imageStatus: string | null;
}

export interface QuestionDetail {
  id: string;
  subjectId: string;
  subjectName: string;
  topicId: string | null;
  topicPath: string | null;
  status: "draft" | "in_review" | "published" | "archived";
  authorUserId: string;
  authorName: string | null;
  currentRevision: number;
  publishedRevision: number | null;
  versions: QuestionVersionDetail[];
  canPublish: boolean;
}

export async function getQuestion(db: Db, ctx: RequestContext, schoolId: string, questionId: string): Promise<QuestionDetail> {
  parse(uuidField("Question"), questionId);
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx) => {
    const [q] = (await tx.execute(sql`
      select q.id, q.subject_id as "subjectId", s.name as "subjectName", q.topic_id as "topicId",
             case when t.id is null then null when ch.id is null then t.name else ch.name || ' › ' || t.name end as "topicPath",
             q.status::text as status, q.author_user_id as "authorUserId", u.full_name as "authorName", q.current_revision as "currentRevision",
             pv.revision as "publishedRevision", app_can_manage_setup(q.school_id) as "canPublish"
      from questions q join subjects s on s.id = q.subject_id
      left join topics t on t.id = q.topic_id left join topics ch on ch.id = t.parent_id
      left join users u on u.id = q.author_user_id left join question_versions pv on pv.id = q.published_version_id
      where q.school_id = ${schoolId}::uuid and q.id = ${questionId}::uuid`)) as unknown as Omit<QuestionDetail, "versions">[];
    if (!q) throw new AppError("NOT_FOUND", "Question not found.");
    const versions = (await tx.execute(sql`
      select v.id, v.revision, v.type::text as type, v.difficulty::text as difficulty, v.stem, v.options, v.answer_key as "answerKey", v.explanation,
             v.marks_x100 as "marksX100", v.negative_marks_x100 as "negativeMarksX100", v.image_file_id as "imageFileId", v.locked_at is not null as locked,
             v.created_at as "createdAt", u.full_name as "createdByName", f.status::text as "imageStatus"
      from question_versions v left join users u on u.id = v.created_by left join files f on f.id = v.image_file_id
      where v.question_id = ${questionId}::uuid order by v.revision desc`)) as unknown as QuestionVersionDetail[];
    return { ...q, versions };
  });
}
