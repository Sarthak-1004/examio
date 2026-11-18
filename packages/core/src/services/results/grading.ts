import { and, eq, sql } from "drizzle-orm";
import { examGraders, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { isRlsViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { queueNotification } from "../../notifications/notifications";
import type { TemplateName } from "../../notifications/templates";
import { parse, trimmed, uuidField } from "../setup/common";
import { gradeOf, parseMarksX100, passesExact, percentBp, resultsError, schemeById, type SchemeInfo } from "./common";

/**
 * Grading of online exams (Phase 12).
 *
 * 1. After an exam closes, its managers start grading: for every student now in a target section
 *    (and anyone who attempted it) the first submitted attempt counts; single choice and
 *    true/false are scored at once: full marks when correct, minus the penalty when wrong if the
 *    exam applies negative marking, nothing when blank.
 * 2. Administrators, the subject's authors and assigned graders mark written answers (0 to the
 *    question's marks, optional comment).
 * 3. An administrator releases the results once every counted written answer is marked. Totals
 *    are floored at zero; a student with no attempt is absent. Students and parents see results
 *    only from then on, and are notified.
 * 4. After release an administrator corrects marks with a reason; the earlier marks are kept
 *    (result_changes), the result's revision rises and the family is notified. An administrator
 *    can also choose another submitted attempt (a retake) to count, with a reason.
 */

/** Notifies each student and their linked parents; a recipient whose membership ended is skipped. */
export async function notifyFamilies(tx: Tx, schoolId: string, studentIds: string[], template: TemplateName, title: string, dedupe: string): Promise<number> {
  if (studentIds.length === 0) return 0;
  const rows = (await tx.execute(sql`
    select p.id as "studentId", p.display_name as name, p.user_id as "userId" from student_profiles p
    where p.school_id = ${schoolId}::uuid and p.id in (${sql.join(studentIds.map((id) => sql`${id}::uuid`), sql`, `)})
    union all
    select p.id, p.display_name, g.guardian_user_id from student_profiles p join guardian_links g on g.student_id = p.id and g.revoked_at is null
    where p.school_id = ${schoolId}::uuid and p.id in (${sql.join(studentIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as { studentId: string; name: string; userId: string }[];
  let sent = 0;
  for (const r of rows) {
    sent += await tx
      .transaction((sp) =>
        queueNotification(sp, { recipientUserId: r.userId, schoolId, channels: ["in_app", "email"], template, params: { title: title.slice(0, 150), student: r.name.slice(0, 120) }, dedupeKey: `${dedupe}:${r.studentId}` }),
      )
      .catch((e: unknown) => {
        if (isRlsViolation(e)) return 0;
        throw e;
      });
  }
  return sent;
}

export type GradingState = "open" | "ready" | "grading" | "released" | "cancelled";

export interface GradableExamRow {
  examId: string;
  title: string;
  subjectName: string;
  closesAt: Date;
  state: GradingState;
  students: number;
  toMark: number;
}

/** Exams the actor may grade, with how many written answers still need marks. */
export async function listGradableExams(db: Db, ctx: RequestContext, schoolId: string): Promise<GradableExamRow[]> {
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const rows = (await tx.execute(sql`
      select e.id as "examId", e.title, s.name as "subjectName", e.closes_at as "closesAt",
             case when e.status = 'cancelled' then 'cancelled' when rs.status = 'released' then 'released' when rs.id is not null then 'grading'
                  when e.closes_at <= now() then 'ready' else 'open' end as state,
             (select count(*)::int from exam_results r where r.exam_id = e.id) as students,
             (select count(*)::int from exam_results r join exam_items i on i.exam_id = r.exam_id join question_versions v on v.id = i.question_version_id
              where r.exam_id = e.id and r.attempt_id is not null and v.type = 'descriptive'
                and not exists (select 1 from exam_marks m where m.attempt_id = r.attempt_id and m.item_id = i.id)) as "toMark"
      from exams e join subjects s on s.id = e.subject_id left join exam_result_sets rs on rs.exam_id = e.id
      where e.school_id = ${schoolId}::uuid and e.status in ('published', 'cancelled') and app_can_grade_exam(e.id)
      order by (rs.status is distinct from 'released' and e.closes_at <= now()) desc, e.closes_at desc limit 200`)) as unknown as GradableExamRow[];
    return rows.map((r) => ({ ...r, closesAt: new Date(r.closesAt) }));
  });
}

export async function startGrading(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<{ students: number }> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    try {
      const [r] = (await tx.execute(sql`select exam_start_grading(${examId}::uuid) as n`)) as unknown as { n: number }[];
      await audit(tx, { action: "results.grading_started", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { students: r!.n } });
      return { students: r!.n };
    } catch (e) {
      resultsError(e);
    }
  });
}

export interface GradingItem {
  itemId: string;
  position: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  maxX100: number;
  marked: number;
}

export interface GradingStudentRow {
  studentId: string;
  name: string;
  admissionNo: string;
  attemptId: string | null;
  attemptNo: number | null;
  attempts: number;
  scoreX100: number | null;
  marksSoFarX100: number;
  unmarked: number;
  revision: number;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
}

export interface ExamGrading {
  examId: string;
  title: string;
  subjectName: string;
  status: "grading" | "released";
  releasedAt: Date | null;
  maxX100: number;
  scheme: SchemeInfo | null;
  canPublish: boolean;
  items: GradingItem[];
  students: GradingStudentRow[];
  graders: { userId: string; name: string }[];
  changes: { at: Date; student: string; kind: string; detail: string; reason: string; by: string }[];
  summary: { counted: number; absent: number; averageBp: number | null; highestBp: number | null; lowestBp: number | null; passed: number; grades: { grade: string; count: number }[] } | null;
}

export async function getExamGrading(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<ExamGrading> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const [e] = (await tx.execute(sql`
      select e.id as "examId", e.title, s.name as "subjectName", rs.status::text as status, rs.released_at as "releasedAt", rs.grading_scheme_id as "schemeId",
             app_can_manage_setup(e.school_id) as "canPublish", app_can_grade_exam(e.id) as allowed
      from exams e join subjects s on s.id = e.subject_id join exam_result_sets rs on rs.exam_id = e.id
      where e.school_id = ${schoolId}::uuid and e.id = ${examId}::uuid`)) as unknown as { examId: string; title: string; subjectName: string; status: "grading" | "released"; releasedAt: Date | null; schemeId: string | null; canPublish: boolean; allowed: boolean }[];
    if (!e || !e.allowed) throw new AppError("NOT_FOUND", "Grading not found. Start grading after the exam closes.");
    const items = (await tx.execute(sql`
      select i.id as "itemId", i.position, v.type::text as type, left(v.stem, 200) as stem, v.marks_x100 as "maxX100",
             (select count(*)::int from exam_marks m join exam_results r on r.attempt_id = m.attempt_id where r.exam_id = i.exam_id and m.item_id = i.id) as marked
      from exam_items i join question_versions v on v.id = i.question_version_id where i.exam_id = ${examId}::uuid order by i.position`)) as unknown as GradingItem[];
    const maxX100 = items.reduce((a, i) => a + i.maxX100, 0);
    const scheme = e.schemeId ? await schemeById(tx, e.schemeId) : null;
    const descriptive = items.filter((i) => i.type === "descriptive").length;
    const raw = (await tx.execute(sql`
      select r.student_id as "studentId", coalesce(p.display_name, 'Student (another section)') as name, coalesce(p.admission_no, '') as "admissionNo", r.attempt_id as "attemptId", a.attempt_no as "attemptNo",
             (select count(*)::int from exam_attempts x where x.exam_id = r.exam_id and x.student_id = r.student_id and x.status = 'submitted') as attempts,
             r.score_x100 as "scoreX100", r.revision,
             coalesce((select sum(m.marks_x100)::int from exam_marks m where m.attempt_id = r.attempt_id), 0) as "marksSoFarX100",
             (select count(*)::int from exam_marks m join exam_items i on i.id = m.item_id join question_versions v on v.id = i.question_version_id
              where m.attempt_id = r.attempt_id and v.type = 'descriptive') as "markedWritten"
      from exam_results r left join student_profiles p on p.id = r.student_id left join exam_attempts a on a.id = r.attempt_id
      where r.exam_id = ${examId}::uuid order by p.display_name is null, lower(p.display_name)`)) as unknown as (Omit<GradingStudentRow, "unmarked" | "percentBp" | "grade" | "passed"> & { markedWritten: number })[];
    const students: GradingStudentRow[] = raw.map(({ markedWritten, ...r }) => {
      const released = e.status === "released" && r.scoreX100 !== null;
      return {
        ...r,
        unmarked: r.attemptId ? descriptive - markedWritten : 0,
        percentBp: released ? percentBp(r.scoreX100!, maxX100) : null,
        grade: released && scheme ? gradeOf(r.scoreX100!, maxX100, scheme.bands) : null,
        passed: released && scheme ? passesExact(r.scoreX100!, maxX100, scheme.passBp) : null,
      };
    });
    const graders = (await tx.execute(sql`select g.user_id as "userId", u.full_name as name from exam_graders g join users u on u.id = g.user_id where g.exam_id = ${examId}::uuid order by u.full_name`)) as unknown as ExamGrading["graders"];
    const changes = ((await tx.execute(sql`
      select c.changed_at as at, p.display_name as student, c.kind, c.old_value as "oldValue", c.new_value as "newValue", c.reason, u.full_name as by
      from result_changes c join student_profiles p on p.id = c.student_id join users u on u.id = c.changed_by
      where c.exam_id = ${examId}::uuid order by c.changed_at desc limit 100`)) as unknown as { at: Date; student: string; kind: string; oldValue: unknown; newValue: unknown; reason: string; by: string }[]).map((c) => ({
      at: new Date(c.at),
      student: c.student,
      kind: c.kind,
      detail: c.kind === "exam_mark" ? `${Number(c.oldValue ?? 0) / 100} → ${Number(c.newValue ?? 0) / 100}` : "counted attempt changed",
      reason: c.reason,
      by: c.by,
    }));
    const counted = students.filter((s) => s.percentBp !== null);
    const summary = e.status === "released"
      ? {
          counted: counted.length,
          absent: students.filter((s) => !s.attemptId).length,
          averageBp: counted.length ? percentBp(counted.reduce((a, s) => a + s.scoreX100!, 0), maxX100 * counted.length) : null,
          highestBp: counted.length ? Math.max(...counted.map((s) => s.percentBp!)) : null,
          lowestBp: counted.length ? Math.min(...counted.map((s) => s.percentBp!)) : null,
          passed: counted.filter((s) => s.passed).length,
          grades: scheme ? scheme.bands.map((b) => ({ grade: b.label, count: counted.filter((s) => s.grade === b.label).length })) : [],
        }
      : null;
    return { examId: e.examId, title: e.title, subjectName: e.subjectName, status: e.status, releasedAt: e.releasedAt ? new Date(e.releasedAt) : null, maxX100, scheme, canPublish: e.canPublish, items, students, graders, changes, summary };
  });
}

export interface AnswerToMark {
  attemptId: string;
  studentName: string;
  text: string | null;
  marksX100: number | null;
  comment: string | null;
}

/**
 * Every counted answer to one written question, with its current marks (graders). A grader who
 * does not teach a student's section sees the answer without the student's name.
 */
export async function listAnswersToMark(db: Db, ctx: RequestContext, schoolId: string, examId: string, itemId: string): Promise<{ stem: string; maxX100: number; position: number; answers: AnswerToMark[] }> {
  parse(uuidField("Exam"), examId);
  parse(uuidField("Question"), itemId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const [item] = (await tx.execute(sql`
      select v.stem, v.marks_x100 as "maxX100", i.position from exam_items i join question_versions v on v.id = i.question_version_id
      where i.exam_id = ${examId}::uuid and i.id = ${itemId}::uuid and v.type = 'descriptive' and app_can_grade_exam(i.exam_id)`)) as unknown as { stem: string; maxX100: number; position: number }[];
    if (!item) throw new AppError("NOT_FOUND", "Written question not found.");
    const answers = (await tx.execute(sql`
      select r.attempt_id as "attemptId", coalesce(p.display_name, 'Student (another section)') as "studentName", x.response->>'text' as text, m.marks_x100 as "marksX100", m.comment
      from exam_results r left join student_profiles p on p.id = r.student_id
      left join exam_answers x on x.attempt_id = r.attempt_id and x.item_id = ${itemId}::uuid
      left join exam_marks m on m.attempt_id = r.attempt_id and m.item_id = ${itemId}::uuid
      where r.exam_id = ${examId}::uuid and r.attempt_id is not null
      order by (m.id is not null), lower(p.display_name)`)) as unknown as AnswerToMark[];
    return { ...item, answers };
  });
}

/** Marks one written answer while grading is open. `marks` is text such as "3" or "2.5". */
export async function setWrittenMark(db: Db, ctx: RequestContext, schoolId: string, input: { attemptId: string; itemId: string; marks: string; comment?: string | null }): Promise<void> {
  parse(uuidField("Attempt"), input.attemptId);
  parse(uuidField("Question"), input.itemId);
  const marks = parseMarksX100(input.marks);
  if (marks === null) throw new AppError("VALIDATION", "Marks: a number such as 3 or 2.5.", { marks: "Not valid." });
  const comment = input.comment?.trim() ? parse(trimmed("Comment", 1, 1000), input.comment) : null;
  await withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    try {
      await tx.execute(sql`select exam_set_mark(${input.attemptId}::uuid, ${input.itemId}::uuid, ${marks}::integer, ${comment})`);
    } catch (e) {
      resultsError(e);
    }
    await audit(tx, { action: "results.answer_marked", actorUserId: actor.userId, schoolId, entityType: "exam_attempt", entityId: input.attemptId, data: { itemId: input.itemId, marksX100: marks } });
  });
}

/** Teachers who may be assigned to mark an exam's written answers. */
export async function listGraderOptions(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<{ userId: string; name: string }[]> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) =>
    (await tx.execute(sql`
      select distinct u.id as "userId", u.full_name as name from school_memberships m join users u on u.id = m.user_id
      where m.school_id = ${schoolId}::uuid and m.role = 'teacher' and m.status = 'active' and app_can_manage_exam(${examId}::uuid)
        and not exists (select 1 from exam_graders g where g.exam_id = ${examId}::uuid and g.user_id = u.id)
      order by u.full_name`)) as unknown as { userId: string; name: string }[],
  );
}

export async function assignGrader(db: Db, ctx: RequestContext, schoolId: string, examId: string, userId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  parse(uuidField("Teacher"), userId);
  await withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    const [t] = (await tx.execute(sql`select 1 as ok from school_memberships where school_id = ${schoolId}::uuid and user_id = ${userId}::uuid and role = 'teacher' and status = 'active'`)) as unknown as { ok: number }[];
    if (!t) throw new AppError("NOT_FOUND", "Teacher not found.");
    try {
      await tx.insert(examGraders).values({ schoolId, examId, userId, createdBy: actor.userId });
    } catch (e) {
      if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "Only the exam's managers can assign graders.");
      if (uniqueViolation(e) !== null) throw new AppError("CONFLICT", "Already a grader.");
      throw e;
    }
    await audit(tx, { action: "results.grader_assigned", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { userId } });
  });
}

export async function removeGrader(db: Db, ctx: RequestContext, schoolId: string, examId: string, userId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  parse(uuidField("Teacher"), userId);
  await withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    const r = await tx.delete(examGraders).where(and(eq(examGraders.examId, examId), eq(examGraders.userId, userId))).returning({ id: examGraders.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Grader not found.");
    await audit(tx, { action: "results.grader_removed", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { userId } });
  });
}

/** Administrators: counts another submitted attempt (a retake) for a student, with a reason. */
export async function designateAttempt(db: Db, ctx: RequestContext, schoolId: string, input: { examId: string; studentId: string; attemptId: string; reason: string }): Promise<void> {
  parse(uuidField("Exam"), input.examId);
  parse(uuidField("Student"), input.studentId);
  parse(uuidField("Attempt"), input.attemptId);
  const reason = parse(trimmed("Reason", 3, 300), input.reason);
  await withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    try {
      await tx.execute(sql`select exam_designate_attempt(${input.examId}::uuid, ${input.studentId}::uuid, ${input.attemptId}::uuid, ${reason})`);
    } catch (e) {
      resultsError(e);
    }
    await audit(tx, { action: "results.attempt_designated", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: input.examId, data: { studentId: input.studentId, attemptId: input.attemptId, reason } });
  });
}

/** Administrators: releases the results once grading is complete; students and parents are notified. */
export async function releaseExamResults(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<{ results: number; notified: number }> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    let n: number;
    try {
      const [r] = (await tx.execute(sql`select exam_release_results(${examId}::uuid) as n`)) as unknown as { n: number }[];
      n = r!.n;
    } catch (e) {
      resultsError(e);
    }
    const [e] = (await tx.execute(sql`select title from exams where id = ${examId}::uuid`)) as unknown as { title: string }[];
    const ids = ((await tx.execute(sql`select student_id as id from exam_results where exam_id = ${examId}::uuid`)) as unknown as { id: string }[]).map((r) => r.id);
    const notified = await notifyFamilies(tx, schoolId, ids, "results.released", e!.title, `exam-released:${examId}`);
    await audit(tx, { action: "results.released", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { results: n, notified } });
    return { results: n, notified };
  });
}

/** Administrators: corrects one question's marks after release, with a reason; history kept, family notified. */
export async function correctExamMark(db: Db, ctx: RequestContext, schoolId: string, input: { attemptId: string; itemId: string; marks: string; reason: string }): Promise<void> {
  parse(uuidField("Attempt"), input.attemptId);
  parse(uuidField("Question"), input.itemId);
  const m = /^(-)?(.*)$/.exec(input.marks.trim())!;
  const abs = parseMarksX100(m[2] ?? "");
  if (abs === null) throw new AppError("VALIDATION", "Marks: a number such as 3 or 2.5.", { marks: "Not valid." });
  const marks = m[1] ? -abs : abs;
  const reason = parse(trimmed("Reason", 3, 300), input.reason);
  await withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    try {
      await tx.execute(sql`select exam_correct_mark(${input.attemptId}::uuid, ${input.itemId}::uuid, ${marks}::integer, ${reason})`);
    } catch (e) {
      resultsError(e);
    }
    const [a] = (await tx.execute(sql`select a.exam_id as "examId", a.student_id as "studentId", e.title, r.revision from exam_attempts a join exams e on e.id = a.exam_id join exam_results r on r.attempt_id = a.id where a.id = ${input.attemptId}::uuid`)) as unknown as { examId: string; studentId: string; title: string; revision: number }[];
    await notifyFamilies(tx, schoolId, [a!.studentId], "results.corrected", a!.title, `exam-corrected:${a!.examId}:${a!.revision}`);
    await audit(tx, { action: "results.corrected", actorUserId: actor.userId, schoolId, entityType: "exam_attempt", entityId: input.attemptId, data: { itemId: input.itemId, marksX100: marks, reason } });
  });
}

/** Per-question marks of a student's counted attempt (staff), for corrections. */
export async function getStudentExamMarks(db: Db, ctx: RequestContext, schoolId: string, examId: string, studentId: string) {
  parse(uuidField("Exam"), examId);
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const rows = (await tx.execute(sql`select * from exam_result_review(${examId}::uuid, ${studentId}::uuid)`)) as unknown as ReviewRow[];
    const [r] = (await tx.execute(sql`
      select r.attempt_id as "attemptId", p.display_name as name,
             (select json_agg(json_build_object('id', a.id, 'no', a.attempt_no) order by a.attempt_no) from exam_attempts a where a.exam_id = r.exam_id and a.student_id = r.student_id and a.status = 'submitted') as attempts
      from exam_results r join student_profiles p on p.id = r.student_id where r.exam_id = ${examId}::uuid and r.student_id = ${studentId}::uuid and app_can_grade_exam(r.exam_id)`)) as unknown as { attemptId: string | null; name: string; attempts: { id: string; no: number }[] | null }[];
    if (!r) throw new AppError("NOT_FOUND", "Result not found.");
    return { name: r.name, attemptId: r.attemptId, attempts: r.attempts ?? [], items: rows.map(reviewItem) };
  });
}

interface ReviewRow {
  item_id: string;
  position: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  options: { id: string; text: string }[] | null;
  max_x100: number;
  response: { choice?: string | null; value?: boolean | null; text?: string } | null;
  marks_x100: number | null;
  comment: string | null;
  answer_key: { correct?: string | boolean; modelAnswer?: string | null };
  explanation: string | null;
}

export interface ReviewItem {
  itemId: string;
  position: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  options: { id: string; text: string }[] | null;
  maxX100: number;
  answer: string;
  marksX100: number | null;
  comment: string | null;
  key: string;
  explanation: string | null;
}

export function reviewItem(r: ReviewRow): ReviewItem {
  const opt = (id: string | null | undefined) => (id ? `${id.toUpperCase()}. ${r.options?.find((o) => o.id === id)?.text ?? ""}` : "");
  const answer =
    r.type === "single_choice" ? opt(r.response?.choice) : r.type === "true_false" ? (r.response?.value === true ? "True" : r.response?.value === false ? "False" : "") : (r.response?.text ?? "");
  const key = r.type === "single_choice" ? opt(String(r.answer_key.correct ?? "")) : r.type === "true_false" ? (r.answer_key.correct ? "True" : "False") : (r.answer_key.modelAnswer ?? "");
  return { itemId: r.item_id, position: r.position, type: r.type, stem: r.stem, options: r.options, maxX100: r.max_x100, answer: answer.trim() ? answer : "Not answered", marksX100: r.marks_x100, comment: r.comment, key, explanation: r.explanation };
}

export async function exportExamResultsCsv(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<string> {
  const g = await getExamGrading(db, ctx, schoolId, examId);
  if (g.status !== "released") throw new AppError("CONFLICT", "Release the results before exporting them.");
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    await audit(tx, { action: "results.exported", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { rows: g.students.length } });
    return toCsv([
      ["admission_no", "name", "score", "max", "percent", "grade", "result", "revision"],
      ...g.students.map((s) => [s.admissionNo, s.name, s.scoreX100 === null ? "absent" : (s.scoreX100 / 100).toFixed(2), (g.maxX100 / 100).toFixed(2), s.percentBp === null ? "" : (s.percentBp / 100).toFixed(2), s.grade ?? "", s.passed === null ? "" : s.passed ? "pass" : "below pass", s.revision]),
    ]);
  });
}

