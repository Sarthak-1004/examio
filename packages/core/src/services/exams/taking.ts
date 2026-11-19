import { sql } from "drizzle-orm";
import { z } from "zod";
import { withWorkerContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { READ_ONLY_MESSAGE, withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { validateResponse, type PracticeResponse } from "../practice/attempts";
import type { ChoiceOption, QuestionType } from "../questions/questions";
import { parse, uuidField } from "../setup/common";

/**
 * Taking formal exams (Phase 11), the student and parent side.
 *
 * Server time is authoritative. Every write goes through a database function that checks the
 * caller owns an active attempt whose deadline has not passed:
 * - exam_start allocates an attempt under a lock (concurrent starts cannot exceed the limit) or
 *   returns the one in progress; the deadline is min(start + duration, closing time), each plus
 *   any accommodation minutes.
 * - exam_save_answer saves one answer only with the revision the screen last saw, so a stale
 *   window or second tab is refused instead of overwriting a newer answer. An acknowledged save
 *   is in the database; nothing unsent counts as saved.
 * - exam_submit is repeat-safe: a second submission returns the original receipt.
 * - After the deadline nothing can be saved. The worker submits overdue attempts with what was
 *   saved (exam_finalize_due), and opening an overdue attempt does the same, so the deadline
 *   holds without an open browser.
 * Learners see questions only during their own active attempt and never answer keys. Results
 * are released in Phase 12.
 */

export type ExamResponse = PracticeResponse;

const MESSAGES: Record<string, [AppError["code"], string]> = {
  exam_not_found: ["NOT_FOUND", "Exam not found."],
  exam_cancelled: ["CONFLICT", "This exam has been cancelled."],
  exam_not_open: ["CONFLICT", "This exam has not opened yet."],
  exam_closed: ["CONFLICT", "This exam has closed."],
  exam_no_attempts_left: ["CONFLICT", "You have no attempts left for this exam."],
  attempt_not_found: ["NOT_FOUND", "Attempt not found."],
  attempt_submitted: ["CONFLICT", "This attempt has been submitted. Answers can no longer change."],
  deadline_passed: ["CONFLICT", "Time is up. Answers can no longer change; what was saved has been submitted."],
  item_not_found: ["NOT_FOUND", "That question is not part of this exam."],
  invalid_response: ["VALIDATION", "That answer could not be saved."],
  stale_revision: ["CONFLICT", "This answer was changed in another window. Reload to see the latest answer."],
};

/** Turns a refusal raised by an exam_* database function into an AppError. */
function examError(e: unknown): never {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && msg in MESSAGES) {
      const [code, text] = MESSAGES[msg]!;
      throw new AppError(code, text);
    }
  }
  throw e;
}

async function myStudentId(tx: Tx, schoolId: string): Promise<string> {
  const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
  if (!me) throw new AppError("NOT_FOUND", "Your school has not added your student details yet.");
  return me.id;
}

/* ------------------------------------------------------------------ lists */

export type ExamWindowState = "upcoming" | "open" | "closed" | "cancelled";

export interface FamilyExamRow {
  examId: string;
  title: string;
  subjectName: string;
  instructions: string | null;
  opensAt: Date;
  closesAt: Date;
  durationMinutes: number;
  itemCount: number;
  totalMarksX100: number;
  window: ExamWindowState;
  attemptsAllowed: number;
  attemptsUsed: number;
  extraMinutes: number;
  inProgressAttemptId: string | null;
  lastSubmittedAt: Date | null;
  lastReceipt: string | null;
}

async function familyExams(tx: Tx, schoolId: string, studentId: string): Promise<FamilyExamRow[]> {
  const rows = (await tx.execute(sql`
    select e.id as "examId", e.title, sub.name as "subjectName", e.instructions, e.opens_at as "opensAt", e.closes_at as "closesAt",
           e.duration_minutes as "durationMinutes", ov.item_count as "itemCount", ov.total_marks_x100 as "totalMarksX100",
           case when e.status = 'cancelled' then 'cancelled' when now() < e.opens_at then 'upcoming' when now() >= e.closes_at then 'closed' else 'open' end as window,
           e.attempt_limit + coalesce(acc.extra_attempts, 0) as "attemptsAllowed", coalesce(acc.extra_minutes, 0) as "extraMinutes",
           (select count(*)::int from exam_attempts a where a.exam_id = e.id and a.student_id = ${studentId}::uuid) as "attemptsUsed",
           (select a.id from exam_attempts a where a.exam_id = e.id and a.student_id = ${studentId}::uuid and a.status = 'in_progress' limit 1) as "inProgressAttemptId",
           last.submitted_at as "lastSubmittedAt", last.receipt as "lastReceipt"
    from exams e
    join subjects sub on sub.id = e.subject_id
    cross join lateral app_exam_overview(e.id) ov
    left join exam_accommodations acc on acc.exam_id = e.id and acc.student_id = ${studentId}::uuid
    left join lateral (select a.submitted_at, a.receipt from exam_attempts a where a.exam_id = e.id and a.student_id = ${studentId}::uuid and a.status = 'submitted' order by a.attempt_no desc limit 1) last on true
    where e.school_id = ${schoolId}::uuid and e.status in ('published', 'cancelled')
      and exists (select 1 from exam_targets t join enrollments en on en.section_id = t.section_id
                  where t.exam_id = e.id and en.student_id = ${studentId}::uuid and en.ends_on is null)
    order by (now() >= e.opens_at and now() < e.closes_at and e.status = 'published') desc, e.opens_at desc
    limit 200`)) as unknown as FamilyExamRow[];
  return rows.map((r) => ({ ...r, opensAt: new Date(r.opensAt), closesAt: new Date(r.closesAt), lastSubmittedAt: r.lastSubmittedAt ? new Date(r.lastSubmittedAt) : null }));
}

export async function listMyExams(db: Db, ctx: RequestContext, schoolId: string): Promise<FamilyExamRow[]> {
  return withCapability(db, ctx, schoolId, "school.exams.take", async (tx) => familyExams(tx, schoolId, await myStudentId(tx, schoolId)));
}

/** A linked child's exam schedule and submissions for a parent (no questions or answers). */
export async function listChildExams(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<FamilyExamRow[]> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const [c] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid and app_is_guardian_of(id)`)) as unknown as { id: string }[];
    if (!c) throw new AppError("NOT_FOUND", "Student not found.");
    return familyExams(tx, schoolId, c.id);
  });
}

/* ------------------------------------------------------------------ taking */

/** Starts an attempt, or returns the one in progress. Repeat-safe. */
export async function startExam(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<{ attemptId: string }> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.exams.take", async (tx, actor) => {
    // A read-only school (subscription ended) lets a started attempt finish but starts no new one.
    if (actor.access === "read_only") {
      const [open] = (await tx.execute(sql`
        select a.id from exam_attempts a join student_profiles p on p.id = a.student_id
        where a.exam_id = ${examId}::uuid and a.status = 'in_progress' and p.user_id = app_user_id()`)) as unknown as { id: string }[];
      if (!open) throw new AppError("FORBIDDEN", READ_ONLY_MESSAGE);
    }
    let attemptId: string;
    try {
      const [r] = (await tx.execute(sql`select exam_start(${examId}::uuid) as id`)) as unknown as { id: string }[];
      attemptId = r!.id;
    } catch (e) {
      examError(e);
    }
    await audit(tx, { action: "exam.attempt_opened", actorUserId: actor.userId, schoolId, entityType: "exam_attempt", entityId: attemptId, data: { examId } });
    return { attemptId };
  });
}

export interface ExamAttemptItem {
  itemId: string;
  position: number;
  type: QuestionType;
  stem: string;
  options: ChoiceOption[] | null;
  marksX100: number;
  negativeMarksX100: number;
  imageFileId: string | null;
  response: ExamResponse | null;
  revision: number;
  flagged: boolean;
}

export interface ExamReceipt {
  receipt: string;
  submittedAt: Date;
  submitKind: "student" | "deadline" | "cancelled";
  answered: number;
  questionCount: number;
}

export interface ExamAttemptView {
  attemptId: string;
  examId: string;
  title: string;
  subjectName: string;
  instructions: string | null;
  attemptNo: number;
  startedAt: Date;
  deadlineAt: Date;
  /** Server time when this view was built, so the screen's timer follows the server clock. */
  serverNow: Date;
  status: "in_progress" | "submitted";
  /** Questions only while the attempt is active. */
  items: ExamAttemptItem[];
  receipt: ExamReceipt | null;
}

async function submitInTx(tx: Tx, attemptId: string): Promise<ExamReceipt> {
  try {
    const [r] = (await tx.execute(sql`select receipt, submitted_at as "submittedAt", submit_kind as "submitKind", answered, question_count as "questionCount" from exam_submit(${attemptId}::uuid)`)) as unknown as ExamReceipt[];
    return { ...r!, submittedAt: new Date(r!.submittedAt) };
  } catch (e) {
    examError(e);
  }
}

/**
 * The student's own attempt. An attempt whose deadline has passed is submitted on the spot (with
 * the answers saved before it), so it never shows as still open.
 */
export async function getMyExamAttempt(db: Db, ctx: RequestContext, schoolId: string, attemptId: string): Promise<ExamAttemptView> {
  parse(uuidField("Attempt"), attemptId);
  return withCapability(db, ctx, schoolId, "school.exams.take", async (tx) => {
    const me = await myStudentId(tx, schoolId);
    const [a] = (await tx.execute(sql`
      select a.id as "attemptId", a.exam_id as "examId", e.title, sub.name as "subjectName", e.instructions, a.attempt_no as "attemptNo",
             a.started_at as "startedAt", a.deadline_at as "deadlineAt", now() as "serverNow", a.status::text as status, a.deadline_at <= now() as overdue
      from exam_attempts a join exams e on e.id = a.exam_id join subjects sub on sub.id = e.subject_id
      where a.school_id = ${schoolId}::uuid and a.id = ${attemptId}::uuid and a.student_id = ${me}::uuid`)) as unknown as (Omit<ExamAttemptView, "items" | "receipt"> & { overdue: boolean })[];
    if (!a) throw new AppError("NOT_FOUND", "Attempt not found.");
    const { overdue, ...raw } = a;
    // Raw query results carry timestamps as text.
    const view = { ...raw, startedAt: new Date(raw.startedAt), deadlineAt: new Date(raw.deadlineAt), serverNow: new Date(raw.serverNow) };
    if (view.status === "submitted" || overdue) {
      return { ...view, status: "submitted", items: [], receipt: await submitInTx(tx, attemptId) };
    }
    const items = (await tx.execute(sql`
      select i.item_id as "itemId", i."position", i.type::text as type, i.stem, i.options, i.marks_x100 as "marksX100", i.negative_marks_x100 as "negativeMarksX100",
             i.image_file_id as "imageFileId", x.response, coalesce(x.revision, 0) as revision, coalesce(x.flagged, false) as flagged
      from exam_attempt_items(${attemptId}::uuid) i left join exam_answers x on x.attempt_id = ${attemptId}::uuid and x.item_id = i.item_id
      order by i."position"`)) as unknown as ExamAttemptItem[];
    return { ...view, items, receipt: null };
  });
}

/** Saves one answer; `expectedRevision` is the revision the screen last saw (0: none saved). */
export async function saveExamAnswer(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  attemptId: string,
  input: { itemId: string; response: unknown; expectedRevision: number },
): Promise<{ revision: number; savedAt: Date }> {
  parse(uuidField("Attempt"), attemptId);
  parse(uuidField("Question"), input.itemId);
  const expected = parse(z.number().int().min(0), input.expectedRevision);
  return withCapability(db, ctx, schoolId, "school.exams.take", async (tx) => {
    const [item] = (await tx.execute(sql`select type::text as type, options from exam_attempt_items(${attemptId}::uuid) where item_id = ${input.itemId}::uuid`)) as unknown as { type: QuestionType; options: ChoiceOption[] | null }[];
    if (!item) {
      // Not this student's active attempt, past its deadline, or not one of its questions: let the database say which.
      try {
        await tx.execute(sql`select exam_save_answer(${attemptId}::uuid, ${input.itemId}::uuid, null, ${expected})`);
      } catch (e) {
        examError(e);
      }
      throw new AppError("NOT_FOUND", "That question is not part of this exam.");
    }
    const response = validateResponse(item.type, item.options, input.response);
    try {
      const [r] = (await tx.execute(sql`select exam_save_answer(${attemptId}::uuid, ${input.itemId}::uuid, ${JSON.stringify(response)}::jsonb, ${expected}) as revision, now() as "savedAt"`)) as unknown as { revision: number; savedAt: Date }[];
      return { revision: r!.revision, savedAt: new Date(r!.savedAt) };
    } catch (e) {
      examError(e);
    }
  });
}

export async function setExamFlag(db: Db, ctx: RequestContext, schoolId: string, attemptId: string, itemId: string, flagged: boolean): Promise<void> {
  parse(uuidField("Attempt"), attemptId);
  parse(uuidField("Question"), itemId);
  await withCapability(db, ctx, schoolId, "school.exams.take", async (tx) => {
    try {
      await tx.execute(sql`select exam_set_flag(${attemptId}::uuid, ${itemId}::uuid, ${flagged})`);
    } catch (e) {
      examError(e);
    }
  });
}

/** Submits the attempt. A repeat returns the original receipt. */
export async function submitExam(db: Db, ctx: RequestContext, schoolId: string, attemptId: string): Promise<ExamReceipt> {
  parse(uuidField("Attempt"), attemptId);
  return withCapability(db, ctx, schoolId, "school.exams.take", async (tx, actor) => {
    const [before] = (await tx.execute(sql`select status::text as status from exam_attempts where id = ${attemptId}::uuid`)) as unknown as { status: string }[];
    const receipt = await submitInTx(tx, attemptId);
    if (before?.status === "in_progress") {
      await audit(tx, { action: "exam.attempt_submitted", actorUserId: actor.userId, schoolId, entityType: "exam_attempt", entityId: attemptId, data: { kind: receipt.submitKind, answered: receipt.answered } });
    }
    return receipt;
  });
}

/* ------------------------------------------------------------------ worker */

/** Submits every attempt whose deadline has passed (worker). Returns how many were finalised. */
export async function finalizeDueExamAttempts(db: Db, max = 500): Promise<number> {
  const [r] = (await withWorkerContext(db, null, (tx) => tx.execute(sql`select exam_finalize_due(${max}::integer) as n`))) as unknown as { n: number }[];
  return r?.n ?? 0;
}
