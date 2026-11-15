import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { files, homework, homeworkFiles, homeworkSubmissions, submissionFeedback, submissionFiles, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { instantToZonedLocal, schoolToday, zonedLocalToInstant } from "../../dates";
import { AppError } from "../../errors";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Homework (Phase 7).
 *
 * - A teacher sets homework for sections they teach today (administrators: any section), for a
 *   subject the class studies that year, with a due time in the school's time zone, optional
 *   instructions and attachments, and whether late submissions are accepted. Set for several
 *   sections at once, each section gets its own copy.
 * - Students currently enrolled in the section, and their linked parents, see it once
 *   published. A student submits privately (text and/or files) and may change the submission
 *   until feedback is returned. After the due time a first submission is accepted only if late
 *   submissions are allowed, and is marked late.
 * - Feedback is returned by the author, a teacher of the section or an administrator; the
 *   student and their parents are notified once.
 * - Notifications go through app_notify_audience with a dedupe key per item, so a retry never
 *   notifies anyone twice. Homework is archived, never deleted.
 */

const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();

async function tz(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return s?.timezone ?? "Asia/Kolkata";
}

function dueInstant(local: string, timeZone: string): Date {
  const at = zonedLocalToInstant(local, timeZone);
  if (!at) throw new AppError("VALIDATION", "Enter the due date and time.", { dueAt: "Enter a date and time." });
  return at;
}

async function ownUploads(tx: Tx, schoolId: string, userId: string, fileIds: string[], purpose: string): Promise<string[]> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return [];
  if (ids.length > 10) throw new AppError("VALIDATION", "Attach at most 10 files.");
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.schoolId, schoolId), inArray(files.id, ids), eq(files.uploadedBy, userId), eq(files.purpose, purpose), isNull(files.deletedAt)));
  if (rows.length !== ids.length) throw new AppError("VALIDATION", "An attached file was not found. Upload it again.");
  return ids;
}

const createSchema = z.object({
  sectionIds: z.array(z.uuid({ message: "Section not found." })).min(1, "Choose at least one section.").max(20),
  subjectId: z.uuid({ message: "Choose a subject." }),
  title: trimmed("Title", 1, 150),
  instructions: optionalText("Instructions", 5000),
  dueAt: z.string(),
  allowLate: z.boolean().optional(),
  fileIds: z.array(z.uuid()).max(10).optional(),
});

/** Sets homework for one or more sections and notifies their students and parents. */
export async function createHomework(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof createSchema>): Promise<{ ids: string[] }> {
  const d = parse(createSchema, input);
  return withCapability(db, ctx, schoolId, "school.homework.manage", async (tx, actor) => {
    const zone = await tz(tx, schoolId);
    const dueAt = dueInstant(d.dueAt, zone);
    if (dueAt.getTime() <= Date.now()) throw new AppError("VALIDATION", "The due time must be in the future.", { dueAt: "In the past." });
    const fileIds = await ownUploads(tx, schoolId, actor.userId, d.fileIds ?? [], "homework_attachment");
    const ids: string[] = [];
    for (const sectionId of [...new Set(d.sectionIds)]) {
      const [sec] = (await tx.execute(sql`
        select s.academic_year_id as "yearId", c.name || ' ' || s.name as label, y.status::text as status,
               app_can_manage_setup(${schoolId}::uuid) or app_teaches_section(s.id, ${schoolToday(zone)}::date) as allowed,
               exists (select 1 from class_subjects m where m.school_id = s.school_id and m.academic_year_id = s.academic_year_id and m.class_id = s.class_id and m.subject_id = ${d.subjectId}::uuid) as studies
        from sections s join classes c on c.id = s.class_id join academic_years y on y.id = s.academic_year_id
        where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid and s.archived_at is null`)) as unknown as { yearId: string; label: string; status: string; allowed: boolean; studies: boolean }[];
      if (!sec || !sec.allowed) throw new AppError("NOT_FOUND", "Section not found.");
      if (sec.status === "closed") throw new AppError("CONFLICT", `${sec.label}: that academic year is closed.`);
      if (!sec.studies) throw new AppError("VALIDATION", `${sec.label} does not study that subject this year.`, { subjectId: "Not studied by this class." });
      const [row] = await tx
        .insert(homework)
        .values({ schoolId, academicYearId: sec.yearId, sectionId, subjectId: d.subjectId, authorUserId: actor.userId, title: d.title, instructions: d.instructions ?? null, dueAt, allowLate: d.allowLate ?? false, status: "published", publishedAt: new Date() })
        .returning({ id: homework.id });
      const id = row!.id;
      if (fileIds.length) await tx.insert(homeworkFiles).values(fileIds.map((fileId) => ({ schoolId, homeworkId: id, fileId })));
      const [subject] = (await tx.execute(sql`select name from subjects where id = ${d.subjectId}::uuid`)) as unknown as { name: string }[];
      await tx.execute(sql`select app_notify_audience('homework', ${id}::uuid, 'homework.published',
        ${JSON.stringify({ title: d.title, subject: subject?.name ?? "", section: sec.label, dueAt: dueAt.toISOString() })}::jsonb, ${`homework:${id}`})`);
      await audit(tx, { action: "homework.published", actorUserId: actor.userId, schoolId, entityType: "homework", entityId: id, data: { sectionId, dueAt: dueAt.toISOString(), files: fileIds.length } });
      ids.push(id);
    }
    return { ids };
  });
}

const updateSchema = z.object({ title: trimmed("Title", 1, 150), instructions: optionalText("Instructions", 5000), dueAt: z.string(), allowLate: z.boolean().optional() });

export async function updateHomework(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string, input: z.input<typeof updateSchema>): Promise<void> {
  parse(uuidField("Homework"), homeworkId);
  const d = parse(updateSchema, input);
  await withCapability(db, ctx, schoolId, "school.homework.manage", async (tx, actor) => {
    const dueAt = dueInstant(d.dueAt, await tz(tx, schoolId));
    const r = await tx
      .update(homework)
      .set({ title: d.title, instructions: d.instructions ?? null, dueAt, allowLate: d.allowLate ?? false, updatedAt: sql`now()` })
      .where(and(eq(homework.schoolId, schoolId), eq(homework.id, homeworkId), sql`${homework.status} <> 'archived'`))
      .returning({ id: homework.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Homework not found, archived, or not yours to change.");
    await audit(tx, { action: "homework.updated", actorUserId: actor.userId, schoolId, entityType: "homework", entityId: homeworkId, data: { dueAt: dueAt.toISOString(), allowLate: d.allowLate ?? false } });
  });
}

/** Hides homework from students and parents; submissions and feedback stay. */
export async function archiveHomework(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string): Promise<void> {
  parse(uuidField("Homework"), homeworkId);
  await withCapability(db, ctx, schoolId, "school.homework.manage", async (tx, actor) => {
    const r = await tx
      .update(homework)
      .set({ status: "archived", updatedAt: sql`now()` })
      .where(and(eq(homework.schoolId, schoolId), eq(homework.id, homeworkId), sql`${homework.status} <> 'archived'`))
      .returning({ id: homework.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Homework not found or already archived.");
    await audit(tx, { action: "homework.archived", actorUserId: actor.userId, schoolId, entityType: "homework", entityId: homeworkId });
  });
}

/** Reminds students who have not submitted (and their parents); at most once per homework per day. */
export async function remindHomework(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string): Promise<{ notified: number }> {
  parse(uuidField("Homework"), homeworkId);
  return withCapability(db, ctx, schoolId, "school.homework.manage", async (tx, actor) => {
    const [h] = (await tx.execute(sql`
      select h.title, h.due_at as "dueAt", h.status::text as status, c.name || ' ' || s.name as label
      from homework h join sections s on s.id = h.section_id join classes c on c.id = s.class_id
      where h.school_id = ${schoolId}::uuid and h.id = ${homeworkId}::uuid and app_can_review_homework(h.id)`)) as unknown as { title: string; dueAt: Date | string; status: string; label: string }[];
    if (!h) throw new AppError("NOT_FOUND", "Homework not found.");
    if (h.status !== "published") throw new AppError("CONFLICT", "Only published homework can be reminded.");
    const today = schoolToday(await tz(tx, schoolId));
    const [n] = (await tx.execute(sql`select app_notify_audience('homework_reminder', ${homeworkId}::uuid, 'homework.reminder',
      ${JSON.stringify({ title: h.title, section: h.label, dueAt: new Date(h.dueAt).toISOString() })}::jsonb, ${`homework-reminder:${homeworkId}:${today}`}) as n`)) as unknown as { n: number }[];
    await audit(tx, { action: "homework.reminded", actorUserId: actor.userId, schoolId, entityType: "homework", entityId: homeworkId, data: { notifications: n?.n ?? 0 } });
    return { notified: n?.n ?? 0 };
  });
}

/* ------------------------------------------------------------------ staff views */

export interface HomeworkListRow {
  id: string;
  title: string;
  sectionId: string;
  sectionLabel: string;
  subjectName: string;
  dueAt: Date;
  allowLate: boolean;
  status: "draft" | "published" | "archived";
  students: number;
  submitted: number;
  returned: number;
}

export async function listHomeworkForStaff(db: Db, ctx: RequestContext, schoolId: string, f: { sectionId?: string; status?: "published" | "archived" } = {}): Promise<HomeworkListRow[]> {
  return withCapability(db, ctx, schoolId, "school.homework.manage", async (tx) =>
    (await tx.execute(sql`
      select h.id, h.title, h.section_id as "sectionId", c.name || ' ' || s.name as "sectionLabel", sub.name as "subjectName", h.due_at as "dueAt",
             h.allow_late as "allowLate", h.status::text as status,
             (select count(*)::int from enrollments e where e.section_id = h.section_id and e.ends_on is null) as students,
             (select count(*)::int from homework_submissions x where x.homework_id = h.id) as submitted,
             (select count(*)::int from homework_submissions x join submission_feedback fb on fb.submission_id = x.id where x.homework_id = h.id) as returned
      from homework h join sections s on s.id = h.section_id join classes c on c.id = s.class_id join subjects sub on sub.id = h.subject_id
      where h.school_id = ${schoolId}::uuid
        ${f.sectionId && z.uuid().safeParse(f.sectionId).success ? sql`and h.section_id = ${f.sectionId}::uuid` : sql``}
        and h.status = ${f.status ?? "published"}::homework_status
      order by h.due_at desc limit 200`)) as unknown as HomeworkListRow[],
  );
}

export interface Attachment {
  fileId: string;
  name: string;
  status: string;
}

export interface SubmissionRow {
  studentId: string;
  displayName: string;
  rollNo: number | null;
  submissionId: string | null;
  submittedAt: Date | null;
  late: boolean;
  body: string | null;
  files: Attachment[];
  feedback: string | null;
  returnedAt: Date | null;
}

export interface HomeworkDetail {
  id: string;
  title: string;
  instructions: string | null;
  sectionId: string;
  sectionLabel: string;
  subjectName: string;
  dueAt: Date;
  dueLocal: string;
  allowLate: boolean;
  status: "draft" | "published" | "archived";
  attachments: Attachment[];
}

async function detail(tx: Tx, schoolId: string, homeworkId: string): Promise<HomeworkDetail | null> {
  const [h] = (await tx.execute(sql`
    select h.id, h.title, h.instructions, h.section_id as "sectionId", c.name || ' ' || s.name as "sectionLabel", sub.name as "subjectName",
           h.due_at as "dueAt", h.allow_late as "allowLate", h.status::text as status
    from homework h join sections s on s.id = h.section_id join classes c on c.id = s.class_id join subjects sub on sub.id = h.subject_id
    where h.school_id = ${schoolId}::uuid and h.id = ${homeworkId}::uuid`)) as unknown as Omit<HomeworkDetail, "attachments" | "dueLocal">[];
  if (!h) return null;
  const attachments = (await tx.execute(sql`
    select f.id as "fileId", f.original_name as name, f.status::text as status from homework_files hf join files f on f.id = hf.file_id
    where hf.homework_id = ${homeworkId}::uuid and hf.removed_at is null order by hf.created_at`)) as unknown as Attachment[];
  const dueAt = new Date(h.dueAt);
  return { ...h, dueAt, dueLocal: instantToZonedLocal(dueAt, await tz(tx, schoolId)), attachments };
}

async function submissionFilesOf(tx: Tx, submissionIds: string[]): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  if (submissionIds.length === 0) return out;
  const rows = (await tx.execute(sql`
    select sf.submission_id as "submissionId", f.id as "fileId", f.original_name as name, f.status::text as status
    from submission_files sf join files f on f.id = sf.file_id
    where sf.submission_id in (${sql.join(submissionIds.map((i) => sql`${i}::uuid`), sql`, `)}) and sf.removed_at is null
    order by sf.created_at`)) as unknown as (Attachment & { submissionId: string })[];
  for (const r of rows) out.set(r.submissionId, [...(out.get(r.submissionId) ?? []), { fileId: r.fileId, name: r.name, status: r.status }]);
  return out;
}

/** Homework with every current student's submission state (author, teachers of the section, administrators). */
export async function getHomeworkForStaff(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string): Promise<HomeworkDetail & { rows: SubmissionRow[] }> {
  parse(uuidField("Homework"), homeworkId);
  return withCapability(db, ctx, schoolId, "school.homework.manage", async (tx) => {
    const [ok] = (await tx.execute(sql`select app_can_review_homework(${homeworkId}::uuid) as ok`)) as unknown as { ok: boolean }[];
    const h = ok?.ok ? await detail(tx, schoolId, homeworkId) : null;
    if (!h) throw new AppError("NOT_FOUND", "Homework not found.");
    // Current students of the section, plus anyone who submitted and has since moved.
    const rows = (await tx.execute(sql`
      with roster as (
        select p.id, p.display_name, e.roll_no from enrollments e join student_profiles p on p.id = e.student_id
        where e.section_id = ${h.sectionId}::uuid and e.ends_on is null
        union
        select p.id, p.display_name, null from homework_submissions x join student_profiles p on p.id = x.student_id where x.homework_id = ${homeworkId}::uuid
      )
      select r.id as "studentId", r.display_name as "displayName", max(r.roll_no) as "rollNo",
             x.id as "submissionId", x.submitted_at as "submittedAt", coalesce(x.late, false) as late, x.body,
             fb.feedback, fb.returned_at as "returnedAt"
      from roster r
      left join homework_submissions x on x.homework_id = ${homeworkId}::uuid and x.student_id = r.id
      left join submission_feedback fb on fb.submission_id = x.id
      group by r.id, r.display_name, x.id, x.submitted_at, x.late, x.body, fb.feedback, fb.returned_at
      order by max(r.roll_no) nulls last, lower(r.display_name)`)) as unknown as Omit<SubmissionRow, "files">[];
    const filesBy = await submissionFilesOf(tx, rows.flatMap((r) => (r.submissionId ? [r.submissionId] : [])));
    return { ...h, rows: rows.map((r) => ({ ...r, files: r.submissionId ? (filesBy.get(r.submissionId) ?? []) : [] })) };
  });
}

/** Returns (or updates) feedback; the student and their parents are notified the first time. */
export async function returnFeedback(db: Db, ctx: RequestContext, schoolId: string, submissionId: string, feedback: string): Promise<void> {
  parse(uuidField("Submission"), submissionId);
  const text = parse(trimmed("Feedback", 1, 2000), feedback);
  await withCapability(db, ctx, schoolId, "school.homework.manage", async (tx, actor) => {
    const [s] = (await tx.execute(sql`
      select x.id, h.title, p.display_name as student, app_can_review_homework(h.id) as allowed
      from homework_submissions x join homework h on h.id = x.homework_id join student_profiles p on p.id = x.student_id
      where x.school_id = ${schoolId}::uuid and x.id = ${submissionId}::uuid`)) as unknown as { id: string; title: string; student: string; allowed: boolean }[];
    if (!s || !s.allowed) throw new AppError("NOT_FOUND", "Submission not found.");
    const [existing] = await tx.select({ id: submissionFeedback.id }).from(submissionFeedback).where(eq(submissionFeedback.submissionId, submissionId));
    if (existing) {
      await tx.update(submissionFeedback).set({ feedback: text, returnedBy: actor.userId, returnedAt: sql`now()` }).where(eq(submissionFeedback.id, existing.id));
    } else {
      await tx.insert(submissionFeedback).values({ schoolId, submissionId, feedback: text, returnedBy: actor.userId });
      await tx.execute(sql`select app_notify_audience('feedback', ${submissionId}::uuid, 'homework.feedback',
        ${JSON.stringify({ title: s.title, student: s.student })}::jsonb, ${`feedback:${submissionId}`})`);
    }
    await audit(tx, { action: existing ? "homework.feedback_updated" : "homework.feedback_returned", actorUserId: actor.userId, schoolId, entityType: "homework_submission", entityId: submissionId });
  });
}

/* ------------------------------------------------------------------ students and parents */

export interface FamilyHomeworkRow {
  id: string;
  title: string;
  subjectName: string;
  sectionLabel: string;
  dueAt: Date;
  allowLate: boolean;
  submittedAt: Date | null;
  late: boolean;
  returned: boolean;
}

async function familyList(tx: Tx, schoolId: string, studentWhere: ReturnType<typeof sql>): Promise<FamilyHomeworkRow[]> {
  return (await tx.execute(sql`
    select h.id, h.title, sub.name as "subjectName", c.name || ' ' || s.name as "sectionLabel", h.due_at as "dueAt", h.allow_late as "allowLate",
           x.submitted_at as "submittedAt", coalesce(x.late, false) as late, (fb.id is not null) as returned
    from student_profiles p
    join enrollments e on e.student_id = p.id and e.ends_on is null
    join homework h on h.section_id = e.section_id and h.status = 'published'
    join sections s on s.id = h.section_id join classes c on c.id = s.class_id join subjects sub on sub.id = h.subject_id
    left join homework_submissions x on x.homework_id = h.id and x.student_id = p.id
    left join submission_feedback fb on fb.submission_id = x.id
    where p.school_id = ${schoolId}::uuid and ${studentWhere}
    order by (x.id is null and h.due_at >= now()) desc, h.due_at desc limit 100`)) as unknown as FamilyHomeworkRow[];
}

/** The signed-in student's homework (current section), unsubmitted upcoming first. */
export async function listMyHomework(db: Db, ctx: RequestContext, schoolId: string): Promise<FamilyHomeworkRow[]> {
  return withCapability(db, ctx, schoolId, "school.homework.submit", (tx) => familyList(tx, schoolId, sql`p.user_id = app_user_id()`));
}

/** A linked child's homework for a parent; any other student gives an empty list. */
export async function listChildHomework(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<FamilyHomeworkRow[]> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", (tx) => familyList(tx, schoolId, sql`p.id = ${studentId}::uuid`));
}

export interface MyHomework extends HomeworkDetail {
  submission: { id: string; body: string | null; submittedAt: Date; late: boolean; files: Attachment[]; feedback: string | null; returnedAt: Date | null } | null;
  canSubmit: boolean;
  closedReason: string | null;
}

async function studentProfileId(tx: Tx, schoolId: string): Promise<string> {
  const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
  if (!me) throw new AppError("NOT_FOUND", "Your school has not added your student details yet.");
  return me.id;
}

async function mySubmission(tx: Tx, homeworkId: string, studentId: string): Promise<MyHomework["submission"]> {
  const [x] = (await tx.execute(sql`
    select x.id, x.body, x.submitted_at as "submittedAt", x.late, fb.feedback, fb.returned_at as "returnedAt"
    from homework_submissions x left join submission_feedback fb on fb.submission_id = x.id
    where x.homework_id = ${homeworkId}::uuid and x.student_id = ${studentId}::uuid`)) as unknown as Omit<NonNullable<MyHomework["submission"]>, "files">[];
  if (!x) return null;
  return { ...x, files: (await submissionFilesOf(tx, [x.id])).get(x.id) ?? [] };
}

function closedReason(h: HomeworkDetail, submission: MyHomework["submission"]): string | null {
  if (h.status !== "published") return "This homework is no longer open.";
  if (submission?.returnedAt) return "Feedback has been returned, so the submission is final.";
  if (!submission && h.dueAt.getTime() < Date.now() && !h.allowLate) return "The due time has passed and late submissions are not accepted.";
  return null;
}

export async function getMyHomework(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string): Promise<MyHomework> {
  parse(uuidField("Homework"), homeworkId);
  return withCapability(db, ctx, schoolId, "school.homework.submit", async (tx) => {
    const me = await studentProfileId(tx, schoolId);
    const h = await detail(tx, schoolId, homeworkId);
    if (!h) throw new AppError("NOT_FOUND", "Homework not found.");
    const submission = await mySubmission(tx, homeworkId, me);
    const reason = closedReason(h, submission);
    return { ...h, submission, canSubmit: reason === null, closedReason: reason };
  });
}

/** A parent's view of one homework item for a linked child, including the child's submission and feedback. */
export async function getChildHomework(db: Db, ctx: RequestContext, schoolId: string, studentId: string, homeworkId: string): Promise<MyHomework> {
  parse(uuidField("Student"), studentId);
  parse(uuidField("Homework"), homeworkId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const [child] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid`)) as unknown as { id: string }[];
    const h = child ? await detail(tx, schoolId, homeworkId) : null;
    if (!h) throw new AppError("NOT_FOUND", "Homework not found.");
    const submission = await mySubmission(tx, homeworkId, studentId);
    return { ...h, submission, canSubmit: false, closedReason: null };
  });
}

/** Submits or updates the signed-in student's work (text and/or files uploaded for this purpose). */
export async function submitHomework(db: Db, ctx: RequestContext, schoolId: string, homeworkId: string, input: { body?: string | null; fileIds?: string[] }): Promise<{ late: boolean; created: boolean }> {
  parse(uuidField("Homework"), homeworkId);
  const body = parse(optionalText("Answer", 5000), input.body ?? "") ?? null;
  return withCapability(db, ctx, schoolId, "school.homework.submit", async (tx, actor) => {
    const me = await studentProfileId(tx, schoolId);
    const h = await detail(tx, schoolId, homeworkId);
    if (!h) throw new AppError("NOT_FOUND", "Homework not found.");
    const existing = await mySubmission(tx, homeworkId, me);
    const reason = closedReason(h, existing);
    if (reason) throw new AppError("CONFLICT", reason);
    const fileIds = await ownUploads(tx, schoolId, actor.userId, input.fileIds ?? [], "homework_submission");
    if (!body && fileIds.length === 0 && !(existing && (existing.body || existing.files.length))) {
      throw new AppError("VALIDATION", "Write an answer or attach a file.", { body: "Empty submission." });
    }
    let submissionId: string;
    let late: boolean;
    if (existing) {
      const r = await tx.update(homeworkSubmissions).set({ body: body ?? existing.body, updatedAt: sql`now()` }).where(eq(homeworkSubmissions.id, existing.id)).returning({ id: homeworkSubmissions.id });
      if (r.length === 0) throw new AppError("CONFLICT", "This submission can no longer be changed.");
      submissionId = existing.id;
      late = existing.late;
    } else {
      late = h.dueAt.getTime() < Date.now();
      const [row] = await tx.insert(homeworkSubmissions).values({ schoolId, homeworkId, studentId: me, body, late }).returning({ id: homeworkSubmissions.id });
      submissionId = row!.id;
    }
    if (fileIds.length) await tx.insert(submissionFiles).values(fileIds.map((fileId) => ({ schoolId, submissionId, fileId })));
    await audit(tx, { action: existing ? "homework.submission_updated" : "homework.submitted", actorUserId: actor.userId, schoolId, entityType: "homework_submission", entityId: submissionId, data: { late, files: fileIds.length } });
    return { late, created: !existing };
  });
}
