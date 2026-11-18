import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { examAccommodations, examItems, examTargets, exams, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { instantToZonedLocal, zonedLocalToInstant } from "../../dates";
import { checkViolation, isRlsViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Formal exams (Phase 11), the staff side.
 *
 * - Administrators and teachers of the subject draft an exam for the current academic year:
 *   questions (each the question's published, locked version), target sections (teachers: the
 *   sections they teach today), an opening window in the school's time zone, a duration, an
 *   attempt limit (default 1) and whether negative marks apply.
 * - Draft → submitted for approval (frozen) → published by a school administrator, who may also
 *   send it back or publish their own draft directly. Publishing needs questions, sections, a
 *   closing time in the future and a duration that fits the window. Publication freezes
 *   everything; a published exam can only be cancelled, with a reason, which ends attempts in
 *   progress. The database enforces the same rules (trigger exams_guard).
 * - Accommodations: an administrator gives one student extra minutes and/or extra attempts, with
 *   a reason; they apply to attempts started afterwards.
 * - Scores and results are Phase 12.
 */

export type ExamStatus = "draft" | "pending_approval" | "published" | "cancelled";
export const MAX_EXAM_ITEMS = 200;

const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();

const settingsSchema = z.object({
  title: trimmed("Title", 1, 150),
  instructions: optionalText("Instructions", 5000),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
  durationMinutes: z.coerce.number({ message: "Duration: enter minutes." }).int("Duration: whole minutes.").min(5, "Duration: at least 5 minutes.").max(600, "Duration: at most 600 minutes."),
  attemptLimit: z.coerce.number({ message: "Attempts: enter a number." }).int().min(1, "Attempts: 1 to 5.").max(5, "Attempts: 1 to 5."),
  negativeMarking: z.boolean(),
});
export type ExamSettingsInput = z.input<typeof settingsSchema>;

async function timezoneOf(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  if (!s) throw new AppError("NOT_FOUND", "School not found.");
  return s.timezone;
}

function windowFrom(v: z.output<typeof settingsSchema>, zone: string): { opensAt: Date | null; closesAt: Date | null } {
  const opensAt = v.opensAt?.trim() ? zonedLocalToInstant(v.opensAt, zone) : null;
  const closesAt = v.closesAt?.trim() ? zonedLocalToInstant(v.closesAt, zone) : null;
  if (v.opensAt?.trim() && !opensAt) throw new AppError("VALIDATION", "Enter a valid opening date and time.", { opensAt: "Not valid." });
  if (v.closesAt?.trim() && !closesAt) throw new AppError("VALIDATION", "Enter a valid closing date and time.", { closesAt: "Not valid." });
  if (opensAt && closesAt) {
    if (closesAt <= opensAt) throw new AppError("VALIDATION", "The exam must close after it opens.", { closesAt: "Must be after opening." });
    if (v.durationMinutes * 60_000 > closesAt.getTime() - opensAt.getTime()) {
      throw new AppError("VALIDATION", "The duration is longer than the time between opening and closing.", { durationMinutes: "Longer than the window." });
    }
  }
  return { opensAt, closesAt };
}

/** The exam row locked for this transaction; NOT_FOUND unless the actor may manage it. */
async function lockExam(tx: Tx, schoolId: string, examId: string) {
  const [e] = await tx.select().from(exams).where(and(eq(exams.schoolId, schoolId), eq(exams.id, examId))).for("update");
  if (!e) throw new AppError("NOT_FOUND", "Exam not found.");
  const [ok] = (await tx.execute(sql`select app_can_manage_exam(${examId}::uuid) as ok`)) as unknown as { ok: boolean }[];
  if (!ok?.ok) throw new AppError("NOT_FOUND", "Exam not found.");
  return e;
}

function requireDraft(e: { status: ExamStatus }): void {
  if (e.status === "pending_approval") throw new AppError("CONFLICT", "This exam is waiting for approval. Send it back to draft to change it.");
  if (e.status !== "draft") throw new AppError("CONFLICT", "A published exam cannot be changed.");
}

/** Maps refusals raised by the exams_guard trigger. */
function guardError(e: unknown): never {
  const msg = String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? "");
  if (msg.includes("exam_incomplete")) throw new AppError("CONFLICT", "The exam needs questions, sections, a closing time in the future and a duration that fits the window.");
  if (msg.includes("exam_publish_forbidden") || isRlsViolation(e)) throw new AppError("FORBIDDEN", "Only a school administrator can publish an exam.");
  if (msg.includes("exam_frozen") || msg.includes("exam_final") || msg.includes("exam_pending")) throw new AppError("CONFLICT", "This exam can no longer be changed.");
  if (checkViolation(e) !== null) throw new AppError("VALIDATION", "Some values are outside the allowed range.");
  throw e;
}

export async function createExam(db: Db, ctx: RequestContext, schoolId: string, input: ExamSettingsInput & { subjectId: string }): Promise<{ id: string }> {
  parse(uuidField("Subject"), input.subjectId);
  const v = parse(settingsSchema, input);
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const [r] = (await tx.execute(sql`
      select app_can_author_subject(${schoolId}::uuid, ${input.subjectId}::uuid) as ok,
             (select id from academic_years where school_id = ${schoolId}::uuid and status = 'current') as "yearId"`)) as unknown as { ok: boolean; yearId: string | null }[];
    if (!r?.ok) throw new AppError("NOT_FOUND", "Subject not found.");
    if (!r.yearId) throw new AppError("CONFLICT", "Set a current academic year first.");
    const { opensAt, closesAt } = windowFrom(v, await timezoneOf(tx, schoolId));
    const [e] = await tx
      .insert(exams)
      .values({ schoolId, academicYearId: r.yearId, subjectId: input.subjectId, title: v.title, instructions: v.instructions ?? null, opensAt, closesAt, durationMinutes: v.durationMinutes, attemptLimit: v.attemptLimit, negativeMarking: v.negativeMarking, createdBy: actor.userId })
      .returning({ id: exams.id });
    await audit(tx, { action: "exam.created", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: e!.id, data: { title: v.title } });
    return { id: e!.id };
  });
}

export async function updateExam(db: Db, ctx: RequestContext, schoolId: string, examId: string, input: ExamSettingsInput): Promise<void> {
  parse(uuidField("Exam"), examId);
  const v = parse(settingsSchema, input);
  await withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    requireDraft(e);
    const { opensAt, closesAt } = windowFrom(v, await timezoneOf(tx, schoolId));
    await tx
      .update(exams)
      .set({ title: v.title, instructions: v.instructions ?? null, opensAt, closesAt, durationMinutes: v.durationMinutes, attemptLimit: v.attemptLimit, negativeMarking: v.negativeMarking, updatedAt: sql`now()` })
      .where(eq(exams.id, examId))
      .catch(guardError);
    await audit(tx, { action: "exam.updated", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId });
  });
}

/** Adds the published versions of the given questions of the exam's subject (already added ones are skipped). */
export async function addExamItems(db: Db, ctx: RequestContext, schoolId: string, examId: string, questionIds: string[]): Promise<{ added: number }> {
  parse(uuidField("Exam"), examId);
  const ids = [...new Set(parse(z.array(z.uuid({ message: "Question not found." })).min(1, "Choose at least one question.").max(MAX_EXAM_ITEMS), questionIds))];
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    requireDraft(e);
    const rows = (await tx.execute(sql`
      select q.id, q.published_version_id as "versionId" from questions q
      where q.school_id = ${schoolId}::uuid and q.subject_id = ${e.subjectId}::uuid and q.status = 'published' and q.published_version_id is not null
        and q.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as { id: string; versionId: string }[];
    if (rows.length !== ids.length) throw new AppError("VALIDATION", "Only published questions of this exam's subject can be added.");
    const existing = await tx.select({ versionId: examItems.questionVersionId, position: examItems.position }).from(examItems).where(eq(examItems.examId, examId));
    const have = new Set(existing.map((x) => x.versionId));
    // In the order the questions were chosen, not the order the database returned them.
    const byId = new Map(rows.map((r) => [r.id, r.versionId]));
    const fresh = ids.map((id) => byId.get(id)!).filter((v) => !have.has(v));
    if (existing.length + fresh.length > MAX_EXAM_ITEMS) throw new AppError("VALIDATION", `An exam can have at most ${MAX_EXAM_ITEMS} questions.`);
    let position = existing.reduce((m, x) => Math.max(m, x.position), 0);
    if (position + fresh.length > 400) throw new AppError("CONFLICT", "Too many changes to this exam's question order. Create a new exam.");
    for (const versionId of fresh) {
      position += 1;
      await tx.insert(examItems).values({ schoolId, examId, questionVersionId: versionId, position });
    }
    if (fresh.length) await audit(tx, { action: "exam.items_added", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { added: fresh.length } });
    return { added: fresh.length };
  });
}

export async function removeExamItem(db: Db, ctx: RequestContext, schoolId: string, examId: string, itemId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  parse(uuidField("Question"), itemId);
  await withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    requireDraft(await lockExam(tx, schoolId, examId));
    const r = await tx.delete(examItems).where(and(eq(examItems.examId, examId), eq(examItems.id, itemId))).returning({ id: examItems.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "That question is not in this exam.");
    await audit(tx, { action: "exam.item_removed", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId });
  });
}

/** Sets exactly which sections the exam is for (sections of the exam's year whose class studies the subject). */
export async function setExamTargets(db: Db, ctx: RequestContext, schoolId: string, examId: string, sectionIds: string[]): Promise<{ sections: number }> {
  parse(uuidField("Exam"), examId);
  const ids = [...new Set(parse(z.array(z.uuid({ message: "Section not found." })).max(60), sectionIds))];
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    requireDraft(e);
    const allowed = new Set((await assignable(tx, schoolId, examId)).map((s) => s.id));
    const current = (await tx.select({ sectionId: examTargets.sectionId }).from(examTargets).where(eq(examTargets.examId, examId))).map((t) => t.sectionId);
    for (const id of ids) if (!allowed.has(id) && !current.includes(id)) throw new AppError("NOT_FOUND", "Section not found.");
    const remove = current.filter((id) => !ids.includes(id));
    if (remove.length) await tx.delete(examTargets).where(and(eq(examTargets.examId, examId), sql`${examTargets.sectionId} in (${sql.join(remove.map((id) => sql`${id}::uuid`), sql`, `)})`));
    for (const id of ids.filter((x) => !current.includes(x))) await tx.insert(examTargets).values({ schoolId, examId, sectionId: id });
    await audit(tx, { action: "exam.targets_set", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { sections: ids.length } });
    return { sections: ids.length };
  });
}

async function completeness(tx: Tx, examId: string): Promise<string | null> {
  const [c] = (await tx.execute(sql`
    select (select count(*)::int from exam_items where exam_id = e.id) as items, (select count(*)::int from exam_targets where exam_id = e.id) as targets,
           e.opens_at is not null and e.closes_at is not null as timed, coalesce(e.closes_at > now(), false) as future,
           coalesce(e.duration_minutes * 60 <= extract(epoch from e.closes_at - e.opens_at), false) as fits
    from exams e where e.id = ${examId}::uuid`)) as unknown as { items: number; targets: number; timed: boolean; future: boolean; fits: boolean }[];
  if (!c || c.items === 0) return "Add at least one question.";
  if (c.targets === 0) return "Choose at least one section.";
  if (!c.timed) return "Set the opening and closing times.";
  if (!c.future) return "The closing time has already passed.";
  if (!c.fits) return "The duration is longer than the time between opening and closing.";
  return null;
}

export async function submitExamForApproval(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  await withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    if (e.status !== "draft") throw new AppError("CONFLICT", "Only a draft can be submitted for approval.");
    const missing = await completeness(tx, examId);
    if (missing) throw new AppError("CONFLICT", missing);
    await tx.update(exams).set({ status: "pending_approval", submittedBy: actor.userId, updatedAt: sql`now()` }).where(eq(exams.id, examId)).catch(guardError);
    await audit(tx, { action: "exam.submitted", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId });
  });
}

/** Back to draft: the author withdraws it, or an administrator sends it back. */
export async function sendBackExam(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  await withCapability(db, ctx, schoolId, "school.exams.manage", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    if (e.status !== "pending_approval") throw new AppError("CONFLICT", "Only an exam waiting for approval can go back to draft.");
    await tx.update(exams).set({ status: "draft", updatedAt: sql`now()` }).where(eq(exams.id, examId)).catch(guardError);
    await audit(tx, { action: "exam.sent_back", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId });
  });
}

export async function publishExam(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<void> {
  parse(uuidField("Exam"), examId);
  await withCapability(db, ctx, schoolId, "school.exams.publish", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    if (e.status !== "draft" && e.status !== "pending_approval") throw new AppError("CONFLICT", "This exam is already published or cancelled.");
    const missing = await completeness(tx, examId);
    if (missing) throw new AppError("CONFLICT", missing);
    await tx.update(exams).set({ status: "published", publishedBy: actor.userId, publishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(exams.id, examId)).catch(guardError);
    await audit(tx, { action: "exam.published", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId });
  });
}

/** Cancels a published exam with a reason; attempts in progress end and are kept. */
export async function cancelExam(db: Db, ctx: RequestContext, schoolId: string, examId: string, reason: string): Promise<{ endedAttempts: number }> {
  parse(uuidField("Exam"), examId);
  const why = parse(trimmed("Reason", 5, 300), reason);
  return withCapability(db, ctx, schoolId, "school.exams.publish", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    if (e.status !== "published") throw new AppError("CONFLICT", "Only a published exam can be cancelled.");
    const [n] = (await tx.execute(sql`select count(*)::int as n from exam_attempts where exam_id = ${examId}::uuid and status = 'in_progress'`)) as unknown as { n: number }[];
    await tx.update(exams).set({ status: "cancelled", cancelledBy: actor.userId, cancelledAt: sql`now()`, cancelReason: why }).where(eq(exams.id, examId)).catch(guardError);
    await audit(tx, { action: "exam.cancelled", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { reason: why, endedAttempts: n?.n ?? 0 } });
    return { endedAttempts: n?.n ?? 0 };
  });
}

const accommodationSchema = z.object({
  studentId: z.uuid({ message: "Student not found." }),
  extraMinutes: z.coerce.number({ message: "Extra minutes: enter a number." }).int().min(0, "Extra minutes: 0 to 240.").max(240, "Extra minutes: 0 to 240."),
  extraAttempts: z.coerce.number({ message: "Extra attempts: enter a number." }).int().min(0, "Extra attempts: 0 to 3.").max(3, "Extra attempts: 0 to 3."),
  reason: trimmed("Reason", 3, 300),
});

/** Records (or replaces) a student's documented accommodation; applies to attempts started afterwards. */
export async function setExamAccommodation(db: Db, ctx: RequestContext, schoolId: string, examId: string, input: z.input<typeof accommodationSchema>): Promise<void> {
  parse(uuidField("Exam"), examId);
  const v = parse(accommodationSchema, input);
  if (v.extraMinutes === 0 && v.extraAttempts === 0) throw new AppError("VALIDATION", "Give extra minutes, extra attempts, or both.");
  await withCapability(db, ctx, schoolId, "school.exams.publish", async (tx, actor) => {
    const e = await lockExam(tx, schoolId, examId);
    if (e.status === "cancelled") throw new AppError("CONFLICT", "This exam is cancelled.");
    const [eligible] = (await tx.execute(sql`
      select 1 as ok from enrollments en join exam_targets t on t.section_id = en.section_id and t.exam_id = ${examId}::uuid
      where en.school_id = ${schoolId}::uuid and en.student_id = ${v.studentId}::uuid and en.ends_on is null limit 1`)) as unknown as { ok: number }[];
    if (!eligible) throw new AppError("NOT_FOUND", "That student is not in a section this exam is for.");
    try {
      await tx
        .insert(examAccommodations)
        .values({ schoolId, examId, studentId: v.studentId, extraMinutes: v.extraMinutes, extraAttempts: v.extraAttempts, reason: v.reason, createdBy: actor.userId })
        .onConflictDoUpdate({
          target: [examAccommodations.schoolId, examAccommodations.examId, examAccommodations.studentId],
          set: { extraMinutes: v.extraMinutes, extraAttempts: v.extraAttempts, reason: v.reason, createdBy: actor.userId, updatedAt: sql`now()` },
        });
    } catch (err) {
      if (isRlsViolation(err)) throw new AppError("FORBIDDEN", "Only a school administrator can set accommodations.");
      throw err;
    }
    await audit(tx, { action: "exam.accommodation_set", actorUserId: actor.userId, schoolId, entityType: "exam", entityId: examId, data: { studentId: v.studentId, extraMinutes: v.extraMinutes, extraAttempts: v.extraAttempts, reason: v.reason } });
  });
}

/* ------------------------------------------------------------------ reading */

export interface ExamRow {
  id: string;
  title: string;
  subjectName: string;
  status: ExamStatus;
  opensAt: Date | null;
  closesAt: Date | null;
  durationMinutes: number;
  itemCount: number;
  sectionCount: number;
  submittedCount: number;
}

export async function listExams(db: Db, ctx: RequestContext, schoolId: string, f: { status?: string; search?: string } = {}): Promise<ExamRow[]> {
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx) => {
    const parts = [sql`e.school_id = ${schoolId}::uuid`];
    if (f.status && ["draft", "pending_approval", "published", "cancelled"].includes(f.status)) parts.push(sql`e.status = ${f.status}::exam_status`);
    if (f.search?.trim()) parts.push(sql`e.title ilike ${likePattern(f.search.trim())}`);
    const rows = (await tx.execute(sql`
      select e.id, e.title, s.name as "subjectName", e.status::text as status, e.opens_at as "opensAt", e.closes_at as "closesAt", e.duration_minutes as "durationMinutes",
             (select count(*)::int from exam_items i where i.exam_id = e.id) as "itemCount",
             (select count(*)::int from exam_targets t where t.exam_id = e.id) as "sectionCount",
             (select count(*)::int from exam_attempts a where a.exam_id = e.id and a.status = 'submitted') as "submittedCount"
      from exams e join subjects s on s.id = e.subject_id
      where ${sql.join(parts, sql` and `)}
      order by (e.status = 'pending_approval') desc, coalesce(e.opens_at, e.created_at) desc, e.id limit 200`)) as unknown as ExamRow[];
    return rows.map((r) => ({ ...r, opensAt: r.opensAt ? new Date(r.opensAt) : null, closesAt: r.closesAt ? new Date(r.closesAt) : null }));
  });
}

export interface ExamItemRow {
  id: string;
  position: number;
  questionId: string;
  revision: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  options: { id: string; text: string }[] | null;
  marksX100: number;
  negativeMarksX100: number;
}

export type AttemptState = "not_started" | "in_progress" | "time_up" | "submitted";

export interface ExamStudentRow {
  studentId: string;
  name: string;
  rollNo: number | null;
  attempts: number;
  state: AttemptState;
  submittedAt: Date | null;
  submitKind: string | null;
  answered: number;
  extraMinutes: number;
  extraAttempts: number;
}

export interface ExamTargetRow {
  sectionId: string;
  label: string;
  students: ExamStudentRow[];
}

export interface ExamDetail {
  id: string;
  title: string;
  instructions: string | null;
  subjectId: string;
  subjectName: string;
  yearName: string;
  status: ExamStatus;
  opensAt: Date | null;
  closesAt: Date | null;
  opensLocal: string;
  closesLocal: string;
  durationMinutes: number;
  attemptLimit: number;
  negativeMarking: boolean;
  totalMarksX100: number;
  createdByName: string | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  canPublish: boolean;
  items: ExamItemRow[];
  targets: ExamTargetRow[];
  accommodations: { studentId: string; name: string; extraMinutes: number; extraAttempts: number; reason: string }[];
}

export async function getExam(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<ExamDetail> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx) => {
    const [e] = (await tx.execute(sql`
      select e.id, e.title, e.instructions, e.subject_id as "subjectId", s.name as "subjectName", y.name as "yearName", e.status::text as status,
             e.opens_at as "opensAt", e.closes_at as "closesAt", e.duration_minutes as "durationMinutes", e.attempt_limit as "attemptLimit",
             e.negative_marking as "negativeMarking", u.full_name as "createdByName", e.published_at as "publishedAt", e.cancelled_at as "cancelledAt",
             e.cancel_reason as "cancelReason", app_can_manage_setup(e.school_id) as "canPublish", app_can_manage_exam(e.id) as allowed
      from exams e join subjects s on s.id = e.subject_id join academic_years y on y.id = e.academic_year_id left join users u on u.id = e.created_by
      where e.school_id = ${schoolId}::uuid and e.id = ${examId}::uuid`)) as unknown as (Omit<ExamDetail, "items" | "targets" | "accommodations" | "opensLocal" | "closesLocal" | "totalMarksX100"> & { allowed: boolean })[];
    if (!e || !e.allowed) throw new AppError("NOT_FOUND", "Exam not found.");
    const zone = await timezoneOf(tx, schoolId);
    const items = (await tx.execute(sql`
      select i.id, i.position, v.question_id as "questionId", v.revision, v.type::text as type, v.stem, v.options, v.marks_x100 as "marksX100", v.negative_marks_x100 as "negativeMarksX100"
      from exam_items i join question_versions v on v.id = i.question_version_id where i.exam_id = ${examId}::uuid order by i.position`)) as unknown as ExamItemRow[];
    const sectionsRows = (await tx.execute(sql`
      select t.section_id as "sectionId", c.name || ' ' || sec.name as label
      from exam_targets t join sections sec on sec.id = t.section_id join classes c on c.id = sec.class_id
      where t.exam_id = ${examId}::uuid order by c.sort_order, c.name, sec.name`)) as unknown as { sectionId: string; label: string }[];
    const targets: ExamTargetRow[] = [];
    for (const t of sectionsRows) {
      const students = (await tx.execute(sql`
        select p.id as "studentId", p.display_name as name, en.roll_no as "rollNo",
               (select count(*)::int from exam_attempts a where a.exam_id = ${examId}::uuid and a.student_id = p.id) as attempts,
               case when last.id is null then 'not_started' when last.status = 'submitted' then 'submitted' when last.deadline_at <= now() then 'time_up' else 'in_progress' end as state,
               last.submitted_at as "submittedAt", last.submit_kind::text as "submitKind",
               coalesce((select count(*)::int from exam_answers x where x.attempt_id = last.id and x.response is not null), 0) as answered,
               coalesce(acc.extra_minutes, 0) as "extraMinutes", coalesce(acc.extra_attempts, 0) as "extraAttempts"
        from enrollments en join student_profiles p on p.id = en.student_id
        left join lateral (select a.* from exam_attempts a where a.exam_id = ${examId}::uuid and a.student_id = p.id order by a.attempt_no desc limit 1) last on true
        left join exam_accommodations acc on acc.exam_id = ${examId}::uuid and acc.student_id = p.id
        where en.section_id = ${t.sectionId}::uuid and en.ends_on is null
        order by en.roll_no nulls last, lower(p.display_name)`)) as unknown as ExamStudentRow[];
      targets.push({ ...t, students });
    }
    const accommodations = (await tx.execute(sql`
      select a.student_id as "studentId", p.display_name as name, a.extra_minutes as "extraMinutes", a.extra_attempts as "extraAttempts", a.reason
      from exam_accommodations a join student_profiles p on p.id = a.student_id where a.exam_id = ${examId}::uuid order by lower(p.display_name)`)) as unknown as ExamDetail["accommodations"];
    for (const t of targets) for (const st of t.students) st.submittedAt = st.submittedAt ? new Date(st.submittedAt) : null;
    return {
      ...e,
      opensAt: e.opensAt ? new Date(e.opensAt) : null,
      closesAt: e.closesAt ? new Date(e.closesAt) : null,
      publishedAt: e.publishedAt ? new Date(e.publishedAt) : null,
      cancelledAt: e.cancelledAt ? new Date(e.cancelledAt) : null,
      opensLocal: e.opensAt ? instantToZonedLocal(new Date(e.opensAt), zone) : "",
      closesLocal: e.closesAt ? instantToZonedLocal(new Date(e.closesAt), zone) : "",
      totalMarksX100: items.reduce((a, i) => a + i.marksX100, 0),
      items,
      targets,
      accommodations,
    };
  });
}

async function assignable(tx: Tx, schoolId: string, examId: string): Promise<{ id: string; label: string }[]> {
  return (await tx.execute(sql`
    select s.id, c.name || ' ' || s.name as label
    from exams e
    join class_subjects cs on cs.school_id = e.school_id and cs.subject_id = e.subject_id and cs.academic_year_id = e.academic_year_id
    join sections s on s.academic_year_id = cs.academic_year_id and s.class_id = cs.class_id and s.archived_at is null
    join classes c on c.id = s.class_id
    where e.school_id = ${schoolId}::uuid and e.id = ${examId}::uuid
      and (app_can_manage_setup(e.school_id) or app_teaches_section(s.id, app_school_today(e.school_id)))
    order by c.sort_order, c.name, s.name`)) as unknown as { id: string; label: string }[];
}

/** Sections the actor may choose for this exam. */
export async function listExamSectionOptions(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<{ id: string; label: string }[]> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.exams.manage", async (tx) => {
    await lockExam(tx, schoolId, examId);
    return assignable(tx, schoolId, examId);
  });
}
