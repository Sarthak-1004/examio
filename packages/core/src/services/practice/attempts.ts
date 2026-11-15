import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { parse, uuidField } from "../setup/common";
import type { ChoiceOption, QuestionType } from "../questions/questions";
import type { PracticeFeedback } from "./sets";

/**
 * Practice (Phase 10), the student and parent side.
 *
 * - A student sees the published sets assigned to their current section and may start an
 *   attempt while the assignment is open (server time), within the attempt limit. Starting twice
 *   returns the attempt already in progress; at most one is in progress per set.
 * - Answers are saved one question at a time with the revision the screen last saw, so a stale
 *   tab cannot overwrite a newer answer (CONFLICT). Saving needs the window to be open; an
 *   attempt can still be submitted after it closes.
 * - Submitting scores the attempt inside the database from the answer keys (practice_submit):
 *   single choice and true/false earn their marks when correct and lose the negative marks when
 *   wrong; blanks score nothing; descriptive answers are not scored in practice.
 * - Feedback (answer keys, explanations, per-question results and the score) is shown right after
 *   submission, or only after the assignment closes, as the set says. Until then the screen shows
 *   only that the attempt was submitted. Learners never receive answer keys before that.
 * - Progress per chapter/topic: accuracy over released, scored questions; a topic is "weak" below
 *   60% once at least 5 questions have been answered, otherwise there is not enough practice yet.
 * - Parents see their linked children's practice and progress, read-only.
 */

export const WEAK_TOPIC_BP = 6000;
export const MIN_TOPIC_SAMPLE = 5;

export interface FamilyPracticeRow {
  setId: string;
  title: string;
  subjectName: string;
  topicPath: string | null;
  itemCount: number;
  opensAt: Date | null;
  closesAt: Date | null;
  open: boolean;
  attemptLimit: number | null;
  attemptsUsed: number;
  inProgressAttemptId: string | null;
  lastAttemptId: string | null;
  /** Best released score in basis points of the maximum. */
  bestBp: number | null;
  feedback: PracticeFeedback;
}

const topicPathSql = sql`case when t.id is null then null when ch.id is null then t.name else ch.name || ' › ' || t.name end`;
const releasedSql = sql`(p.feedback = 'immediate' or (a.closes_at is not null and a.closes_at <= now()))`;

async function myStudentId(tx: Tx, schoolId: string): Promise<string> {
  const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
  if (!me) throw new AppError("NOT_FOUND", "Your school has not added your student details yet.");
  return me.id;
}

async function childId(tx: Tx, schoolId: string, studentId: string): Promise<string> {
  parse(uuidField("Student"), studentId);
  const [c] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid and app_is_guardian_of(id)`)) as unknown as { id: string }[];
  if (!c) throw new AppError("NOT_FOUND", "Student not found.");
  return c.id;
}

async function familyPractice(tx: Tx, schoolId: string, studentId: string): Promise<FamilyPracticeRow[]> {
  return (await tx.execute(sql`
    select p.id as "setId", p.title, sub.name as "subjectName", ${topicPathSql} as "topicPath",
           (select count(*)::int from app_practice_items(p.id)) as "itemCount",
           a.opens_at as "opensAt", a.closes_at as "closesAt", app_practice_assignment_open(a.id) as open,
           p.attempt_limit as "attemptLimit", p.feedback::text as feedback,
           (select count(*)::int from practice_attempts x where x.set_id = p.id and x.student_id = ${studentId}::uuid) as "attemptsUsed",
           (select x.id from practice_attempts x where x.set_id = p.id and x.student_id = ${studentId}::uuid and x.status = 'in_progress' limit 1) as "inProgressAttemptId",
           (select x.id from practice_attempts x where x.set_id = p.id and x.student_id = ${studentId}::uuid order by x.attempt_no desc limit 1) as "lastAttemptId",
           case when ${releasedSql} then (select max(x.score_x100 * 10000 / nullif(x.max_x100, 0))::int from practice_attempts x
                                          where x.set_id = p.id and x.student_id = ${studentId}::uuid and x.status = 'submitted') end as "bestBp"
    from enrollments e
    join practice_assignments a on a.section_id = e.section_id and a.removed_at is null
    join practice_sets p on p.id = a.set_id and p.status = 'published'
    join subjects sub on sub.id = p.subject_id
    left join topics t on t.id = p.topic_id left join topics ch on ch.id = t.parent_id
    where e.school_id = ${schoolId}::uuid and e.student_id = ${studentId}::uuid and e.ends_on is null
    order by app_practice_assignment_open(a.id) desc, coalesce(a.closes_at, 'infinity'::timestamptz), p.title
    limit 200`)) as unknown as FamilyPracticeRow[];
}

/** The signed-in student's assigned practice, open sets first. */
export async function listMyPractice(db: Db, ctx: RequestContext, schoolId: string): Promise<FamilyPracticeRow[]> {
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx) => familyPractice(tx, schoolId, await myStudentId(tx, schoolId)));
}

/** A linked child's assigned practice for a parent. */
export async function listChildPractice(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<FamilyPracticeRow[]> {
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => familyPractice(tx, schoolId, await childId(tx, schoolId, studentId)));
}

/**
 * Starts an attempt, or returns the one already in progress. NOT_FOUND unless the set is assigned
 * to the student's section; CONFLICT outside the window or when the attempt limit is used up.
 */
export async function startPracticeAttempt(db: Db, ctx: RequestContext, schoolId: string, setId: string): Promise<{ attemptId: string; resumed: boolean }> {
  parse(uuidField("Practice set"), setId);
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx, actor) => {
    const me = await myStudentId(tx, schoolId);
    const [a] = (await tx.execute(sql`
      select x.assignment_id as "assignmentId", app_practice_assignment_open(x.assignment_id) as open, a.opens_at as "opensAt", p.attempt_limit as "attemptLimit"
      from (select app_my_practice_assignment(${setId}::uuid) as assignment_id) x
      join practice_assignments a on a.id = x.assignment_id join practice_sets p on p.id = a.set_id`)) as unknown as { assignmentId: string; open: boolean; opensAt: Date | null; attemptLimit: number | null }[];
    if (!a) throw new AppError("NOT_FOUND", "Practice set not found.");
    const [current] = (await tx.execute(sql`select id from practice_attempts where set_id = ${setId}::uuid and student_id = ${me}::uuid and status = 'in_progress'`)) as unknown as { id: string }[];
    if (current) return { attemptId: current.id, resumed: true };
    if (!a.open) throw new AppError("CONFLICT", a.opensAt && new Date(a.opensAt).getTime() > Date.now() ? "This practice has not opened yet." : "This practice has closed.");
    const [n] = (await tx.execute(sql`select coalesce(max(attempt_no), 0)::int as n from practice_attempts where set_id = ${setId}::uuid and student_id = ${me}::uuid`)) as unknown as { n: number }[];
    const used = n?.n ?? 0;
    if (a.attemptLimit !== null && used >= a.attemptLimit) throw new AppError("CONFLICT", `You have used all ${a.attemptLimit} attempts at this practice.`);
    if (used >= 50) throw new AppError("CONFLICT", "You have reached the maximum number of attempts at this practice.");
    // A concurrent start loses on the unique indexes and resumes the attempt the other request created.
    const [created] = (await tx.execute(sql`
      insert into practice_attempts (school_id, set_id, student_id, assignment_id, attempt_no)
      values (${schoolId}::uuid, ${setId}::uuid, ${me}::uuid, ${a.assignmentId}::uuid, ${used + 1})
      on conflict do nothing returning id`)) as unknown as { id: string }[];
    if (!created) {
      const [again] = (await tx.execute(sql`select id from practice_attempts where set_id = ${setId}::uuid and student_id = ${me}::uuid and status = 'in_progress'`)) as unknown as { id: string }[];
      if (again) return { attemptId: again.id, resumed: true };
      throw new AppError("CONFLICT", "The attempt could not be started. Please try again.");
    }
    await audit(tx, { action: "practice.attempt_started", actorUserId: actor.userId, schoolId, entityType: "practice_attempt", entityId: created.id, data: { setId, attemptNo: used + 1 } });
    return { attemptId: created.id, resumed: false };
  });
}

export interface PracticeAttemptItem {
  itemId: string;
  position: number;
  type: QuestionType;
  stem: string;
  options: ChoiceOption[] | null;
  marksX100: number;
  negativeMarksX100: number;
  imageFileId: string | null;
  answer: { response: PracticeResponse; revision: number } | null;
  /** Only once feedback is released. */
  result: { isCorrect: boolean | null; scoreX100: number | null; answerKey: unknown; explanation: string | null } | null;
}

export type PracticeResponse = { choice: string | null } | { value: boolean | null } | { text: string };

export interface PracticeAttemptView {
  id: string;
  setId: string;
  title: string;
  instructions: string | null;
  subjectName: string;
  attemptNo: number;
  status: "in_progress" | "submitted";
  startedAt: Date;
  submittedAt: Date | null;
  closesAt: Date | null;
  /** Answers can still be saved. */
  canAnswer: boolean;
  feedbackRule: PracticeFeedback;
  released: boolean;
  /** Only once released. */
  score: { scoreX100: number; maxX100: number; correct: number; scored: number } | null;
  items: PracticeAttemptItem[];
}

async function attemptView(tx: Tx, schoolId: string, attemptId: string, studentId: string): Promise<PracticeAttemptView> {
  const [t] = (await tx.execute(sql`
    select x.id, x.set_id as "setId", x.attempt_no as "attemptNo", x.status::text as status, x.started_at as "startedAt", x.submitted_at as "submittedAt",
           x.score_x100 as "scoreX100", x.max_x100 as "maxX100", x.correct_count as "correctCount", x.scored_count as "scoredCount",
           app_practice_attempt_mine_open(x.id) as "canAnswer"
    from practice_attempts x where x.school_id = ${schoolId}::uuid and x.id = ${attemptId}::uuid and x.student_id = ${studentId}::uuid`)) as unknown as {
    id: string; setId: string; attemptNo: number; status: "in_progress" | "submitted"; startedAt: Date; submittedAt: Date | null;
    scoreX100: number | null; maxX100: number | null; correctCount: number | null; scoredCount: number | null; canAnswer: boolean;
  }[];
  if (!t) throw new AppError("NOT_FOUND", "Attempt not found.");
  const [s] = (await tx.execute(sql`
    select p.title, p.instructions, sub.name as "subjectName", p.feedback::text as feedback, a.closes_at as "closesAt"
    from practice_attempts x join practice_sets p on p.id = x.set_id join subjects sub on sub.id = p.subject_id
    left join practice_assignments a on a.id = x.assignment_id
    where x.id = ${attemptId}::uuid`)) as unknown as { title: string; instructions: string | null; subjectName: string; feedback: PracticeFeedback; closesAt: Date | null }[];
  // The set is no longer visible (archived, unassigned, or the student moved section).
  if (!s) throw new AppError("NOT_FOUND", "This practice is no longer available.");
  const items = (await tx.execute(sql`
    select item_id as "itemId", "position", type::text as type, stem, options, marks_x100 as "marksX100", negative_marks_x100 as "negativeMarksX100", image_file_id as "imageFileId"
    from app_practice_items(${t.setId}::uuid) order by "position"`)) as unknown as Omit<PracticeAttemptItem, "answer" | "result">[];
  const answers = (await tx.execute(sql`
    select item_id as "itemId", response, revision, is_correct as "isCorrect", score_x100 as "scoreX100" from practice_answers where attempt_id = ${attemptId}::uuid`)) as unknown as {
    itemId: string; response: PracticeResponse; revision: number; isCorrect: boolean | null; scoreX100: number | null;
  }[];
  const feedback = t.status === "submitted"
    ? ((await tx.execute(sql`select item_id as "itemId", answer_key as "answerKey", explanation from app_practice_feedback(${attemptId}::uuid)`)) as unknown as { itemId: string; answerKey: unknown; explanation: string | null }[])
    : [];
  const released = t.status === "submitted" && feedback.length > 0;
  const byItem = new Map(answers.map((a) => [a.itemId, a]));
  const keyByItem = new Map(feedback.map((f) => [f.itemId, f]));
  return {
    id: t.id,
    setId: t.setId,
    title: s.title,
    instructions: s.instructions,
    subjectName: s.subjectName,
    attemptNo: t.attemptNo,
    status: t.status,
    startedAt: t.startedAt,
    submittedAt: t.submittedAt,
    closesAt: s.closesAt,
    canAnswer: t.canAnswer,
    feedbackRule: s.feedback,
    released,
    score: released && t.maxX100 !== null ? { scoreX100: t.scoreX100 ?? 0, maxX100: t.maxX100, correct: t.correctCount ?? 0, scored: t.scoredCount ?? 0 } : null,
    items: items.map((i) => {
      const a = byItem.get(i.itemId);
      const k = keyByItem.get(i.itemId);
      return {
        ...i,
        answer: a ? { response: a.response, revision: a.revision } : null,
        result: released && k
          ? { isCorrect: i.type === "descriptive" ? null : (a?.isCorrect ?? false), scoreX100: i.type === "descriptive" ? null : (a?.scoreX100 ?? 0), answerKey: k.answerKey, explanation: k.explanation }
          : null,
      };
    }),
  };
}

export async function getMyPracticeAttempt(db: Db, ctx: RequestContext, schoolId: string, attemptId: string): Promise<PracticeAttemptView> {
  parse(uuidField("Attempt"), attemptId);
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx) => attemptView(tx, schoolId, attemptId, await myStudentId(tx, schoolId)));
}

/** A linked child's attempt, read-only (answers, and feedback once released). */
export async function getChildPracticeAttempt(db: Db, ctx: RequestContext, schoolId: string, studentId: string, attemptId: string): Promise<PracticeAttemptView> {
  parse(uuidField("Attempt"), attemptId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const view = await attemptView(tx, schoolId, attemptId, await childId(tx, schoolId, studentId));
    return { ...view, canAnswer: false };
  });
}

function validateResponse(type: QuestionType, options: ChoiceOption[] | null, raw: unknown): PracticeResponse {
  if (type === "single_choice") {
    const r = z.object({ choice: z.string().nullable() }).safeParse(raw);
    if (!r.success || (r.data.choice !== null && !(options ?? []).some((o) => o.id === r.data.choice))) throw new AppError("VALIDATION", "Choose one of the options.");
    return { choice: r.data.choice };
  }
  if (type === "true_false") {
    const r = z.object({ value: z.boolean().nullable() }).safeParse(raw);
    if (!r.success) throw new AppError("VALIDATION", "Choose true or false.");
    return { value: r.data.value };
  }
  const r = z.object({ text: z.string().max(5000, "Answers can be at most 5000 characters.") }).safeParse(raw);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Write your answer.");
  return { text: r.data.text };
}

/**
 * Saves one answer. `expectedRevision` is the revision the screen last saw (0 when there was no
 * saved answer); a different current revision means another tab saved meanwhile: CONFLICT.
 */
export async function savePracticeAnswer(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  attemptId: string,
  input: { itemId: string; response: unknown; expectedRevision: number },
): Promise<{ revision: number }> {
  parse(uuidField("Attempt"), attemptId);
  parse(uuidField("Question"), input.itemId);
  const expected = parse(z.number().int().min(0), input.expectedRevision);
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx) => {
    const me = await myStudentId(tx, schoolId);
    const [t] = (await tx.execute(sql`
      select set_id as "setId", status::text as status, app_practice_attempt_mine_open(id) as open
      from practice_attempts where school_id = ${schoolId}::uuid and id = ${attemptId}::uuid and student_id = ${me}::uuid`)) as unknown as { setId: string; status: string; open: boolean }[];
    if (!t) throw new AppError("NOT_FOUND", "Attempt not found.");
    if (t.status !== "in_progress") throw new AppError("CONFLICT", "This attempt has been submitted.");
    if (!t.open) throw new AppError("CONFLICT", "This practice has closed. Submit the attempt to finish it.");
    const [item] = (await tx.execute(sql`select type::text as type, options from app_practice_items(${t.setId}::uuid) where item_id = ${input.itemId}::uuid`)) as unknown as { type: QuestionType; options: ChoiceOption[] | null }[];
    if (!item) throw new AppError("NOT_FOUND", "That question is not part of this practice.");
    const response = validateResponse(item.type, item.options, input.response);
    const json = JSON.stringify(response);
    if (expected === 0) {
      const [r] = (await tx.execute(sql`
        insert into practice_answers (school_id, attempt_id, item_id, response) values (${schoolId}::uuid, ${attemptId}::uuid, ${input.itemId}::uuid, ${json}::jsonb)
        on conflict do nothing returning revision`)) as unknown as { revision: number }[];
      if (!r) throw new AppError("CONFLICT", "This answer was changed in another window. Reload to see the latest answer.");
      return { revision: r.revision };
    }
    const [r] = (await tx.execute(sql`
      update practice_answers set response = ${json}::jsonb, revision = revision + 1, saved_at = now()
      where attempt_id = ${attemptId}::uuid and item_id = ${input.itemId}::uuid and revision = ${expected}
      returning revision`)) as unknown as { revision: number }[];
    if (!r) throw new AppError("CONFLICT", "This answer was changed in another window. Reload to see the latest answer.");
    return { revision: r.revision };
  });
}

/** Submits the attempt (also after the window has closed). Submitting twice is harmless. */
export async function submitPracticeAttempt(db: Db, ctx: RequestContext, schoolId: string, attemptId: string): Promise<{ alreadySubmitted: boolean }> {
  parse(uuidField("Attempt"), attemptId);
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx, actor) => {
    const me = await myStudentId(tx, schoolId);
    const [t] = (await tx.execute(sql`select status::text as status from practice_attempts where school_id = ${schoolId}::uuid and id = ${attemptId}::uuid and student_id = ${me}::uuid`)) as unknown as { status: string }[];
    if (!t) throw new AppError("NOT_FOUND", "Attempt not found.");
    if (t.status === "submitted") return { alreadySubmitted: true };
    await tx.execute(sql`select practice_submit(${attemptId}::uuid)`);
    await audit(tx, { action: "practice.attempt_submitted", actorUserId: actor.userId, schoolId, entityType: "practice_attempt", entityId: attemptId });
    return { alreadySubmitted: false };
  });
}

/* ------------------------------------------------------------------ progress */

export interface TopicProgress {
  topicId: string | null;
  topicPath: string;
  answered: number;
  correct: number;
  accuracyBp: number;
  /** "weak" below 60% with at least 5 answers; "ok" at or above; "too_few" under 5 answers. */
  standing: "weak" | "ok" | "too_few";
}

export interface AttemptHistoryRow {
  attemptId: string;
  title: string;
  subjectName: string;
  attemptNo: number;
  status: "in_progress" | "submitted";
  submittedAt: Date | null;
  /** Only once feedback is released. */
  scoreBp: number | null;
}

export interface PracticeProgress {
  topics: TopicProgress[];
  attempts: AttemptHistoryRow[];
}

async function progressOf(tx: Tx, schoolId: string, studentId: string): Promise<PracticeProgress> {
  const rows = (await tx.execute(sql`
    select pr.topic_id as "topicId", coalesce(${topicPathSql}, 'No chapter or topic') as "topicPath", pr.answered, pr.correct
    from app_practice_progress(${studentId}::uuid) pr
    left join topics t on t.id = pr.topic_id left join topics ch on ch.id = t.parent_id
    order by 2`)) as unknown as { topicId: string | null; topicPath: string; answered: number; correct: number }[];
  const topics = rows.map((r) => {
    const accuracyBp = r.answered > 0 ? Math.floor((r.correct * 10000) / r.answered) : 0;
    const standing: TopicProgress["standing"] = r.answered < MIN_TOPIC_SAMPLE ? "too_few" : accuracyBp < WEAK_TOPIC_BP ? "weak" : "ok";
    return { ...r, accuracyBp, standing };
  });
  const attempts = (await tx.execute(sql`
    select x.id as "attemptId", coalesce(p.title, 'Practice no longer available') as title, coalesce(sub.name, '') as "subjectName", x.attempt_no as "attemptNo",
           x.status::text as status, x.submitted_at as "submittedAt",
           case when x.status = 'submitted' and p.id is not null and ${releasedSql} then x.score_x100 * 10000 / nullif(x.max_x100, 0) end as "scoreBp"
    from practice_attempts x
    left join practice_sets p on p.id = x.set_id left join subjects sub on sub.id = p.subject_id
    left join practice_assignments a on a.id = x.assignment_id
    where x.school_id = ${schoolId}::uuid and x.student_id = ${studentId}::uuid
    order by coalesce(x.submitted_at, x.started_at) desc limit 50`)) as unknown as AttemptHistoryRow[];
  return { topics, attempts };
}

export async function getMyPracticeProgress(db: Db, ctx: RequestContext, schoolId: string): Promise<PracticeProgress> {
  return withCapability(db, ctx, schoolId, "school.practice.take", async (tx) => progressOf(tx, schoolId, await myStudentId(tx, schoolId)));
}

export async function getChildPracticeProgress(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<PracticeProgress> {
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => progressOf(tx, schoolId, await childId(tx, schoolId, studentId)));
}
