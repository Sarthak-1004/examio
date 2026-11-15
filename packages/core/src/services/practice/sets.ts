import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { practiceAssignments, practiceSetItems, practiceSets, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { instantToZonedLocal, zonedLocalToInstant } from "../../dates";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Practice sets (Phase 10), the staff side.
 *
 * - Administrators and teachers of the subject build a set from published questions of that
 *   subject: each item points at the question's published, locked version, so later edits to the
 *   question never change a set. Items are added and removed only while the set is a draft;
 *   publishing fixes them. A published set is archived, never deleted.
 * - Settings: an optional attempt limit (1-50, none = unlimited) and when feedback (answer keys
 *   and explanations) is shown: right after submission, or only after the assignment closes.
 * - A published set is assigned to sections: administrators any section, teachers the sections
 *   they teach today. Optional opening and closing times are in the school's time zone.
 * - Practice never affects formal results.
 */

export const PRACTICE_FEEDBACK = ["immediate", "after_close"] as const;
export type PracticeFeedback = (typeof PRACTICE_FEEDBACK)[number];
export const MAX_PRACTICE_ITEMS = 100;

const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();

const settingsSchema = z.object({
  title: trimmed("Title", 1, 150),
  instructions: optionalText("Instructions", 2000),
  attemptLimit: z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1, "Attempt limit: 1 to 50, or leave empty.").max(50, "Attempt limit: 1 to 50, or leave empty.")]).nullable().optional(),
  feedback: z.enum(PRACTICE_FEEDBACK, { message: "Choose when feedback is shown." }),
  topicId: z.union([z.literal("").transform(() => null), z.uuid({ message: "Topic not found." })]).nullable().optional(),
});

async function timezoneOf(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return s?.timezone ?? "Asia/Kolkata";
}

async function checkSubject(tx: Tx, schoolId: string, subjectId: string): Promise<void> {
  const [r] = (await tx.execute(sql`select app_can_author_subject(${schoolId}::uuid, ${subjectId}::uuid) as ok, exists (select 1 from subjects where school_id = ${schoolId}::uuid and id = ${subjectId}::uuid and archived_at is null) as found`)) as unknown as { ok: boolean; found: boolean }[];
  if (!r?.found || !r.ok) throw new AppError("NOT_FOUND", "Subject not found.");
}

async function checkTopic(tx: Tx, schoolId: string, subjectId: string, topicId: string | null | undefined): Promise<void> {
  if (!topicId) return;
  const [t] = (await tx.execute(sql`select 1 as ok from topics where school_id = ${schoolId}::uuid and subject_id = ${subjectId}::uuid and id = ${topicId}::uuid and archived_at is null`)) as unknown as { ok: number }[];
  if (!t) throw new AppError("VALIDATION", "That chapter or topic is not part of this subject.", { topicId: "Not in this subject." });
}

/** The set, locked for the rest of the transaction; NOT_FOUND unless the actor may manage it. */
async function lockSet(tx: Tx, schoolId: string, setId: string) {
  const [s] = await tx.select().from(practiceSets).where(and(eq(practiceSets.schoolId, schoolId), eq(practiceSets.id, setId))).for("update");
  if (!s) throw new AppError("NOT_FOUND", "Practice set not found.");
  const [ok] = (await tx.execute(sql`select app_can_manage_practice_set(${setId}::uuid) as ok`)) as unknown as { ok: boolean }[];
  if (!ok?.ok) throw new AppError("NOT_FOUND", "Practice set not found.");
  return s;
}

export async function createPracticeSet(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof settingsSchema> & { subjectId: string }): Promise<{ id: string }> {
  parse(uuidField("Subject"), input.subjectId);
  const v = parse(settingsSchema, input);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    await checkSubject(tx, schoolId, input.subjectId);
    await checkTopic(tx, schoolId, input.subjectId, v.topicId);
    const [s] = await tx
      .insert(practiceSets)
      .values({ schoolId, subjectId: input.subjectId, topicId: v.topicId ?? null, title: v.title, instructions: v.instructions ?? null, attemptLimit: v.attemptLimit ?? null, feedback: v.feedback, createdBy: actor.userId })
      .returning({ id: practiceSets.id });
    await audit(tx, { action: "practice_set.created", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: s!.id });
    return { id: s!.id };
  });
}

/** Changes title, instructions, attempt limit, feedback rule and topic (not of an archived set). */
export async function updatePracticeSet(db: Db, ctx: RequestContext, schoolId: string, setId: string, input: z.input<typeof settingsSchema>): Promise<void> {
  parse(uuidField("Practice set"), setId);
  const v = parse(settingsSchema, input);
  await withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status === "archived") throw new AppError("CONFLICT", "This practice set is archived.");
    await checkTopic(tx, schoolId, s.subjectId, v.topicId);
    await tx
      .update(practiceSets)
      .set({ title: v.title, instructions: v.instructions ?? null, attemptLimit: v.attemptLimit ?? null, feedback: v.feedback, topicId: v.topicId ?? null, updatedAt: sql`now()` })
      .where(eq(practiceSets.id, setId));
    await audit(tx, { action: "practice_set.updated", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId });
  });
}

async function appendItems(tx: Tx, schoolId: string, setId: string, versionIds: string[]): Promise<number> {
  const existing = await tx.select({ versionId: practiceSetItems.questionVersionId, position: practiceSetItems.position }).from(practiceSetItems).where(eq(practiceSetItems.setId, setId));
  const have = new Set(existing.map((e) => e.versionId));
  const fresh = [...new Set(versionIds)].filter((id) => !have.has(id));
  if (existing.length + fresh.length > MAX_PRACTICE_ITEMS) throw new AppError("VALIDATION", `A practice set can have at most ${MAX_PRACTICE_ITEMS} questions.`);
  let position = existing.reduce((m, e) => Math.max(m, e.position), 0);
  if (position + fresh.length > 200) throw new AppError("CONFLICT", "Too many changes to this set's question order. Create a new set.");
  for (const versionId of fresh) {
    position += 1;
    await tx.insert(practiceSetItems).values({ schoolId, setId, questionVersionId: versionId, position });
  }
  return fresh.length;
}

/** Adds the published versions of the given questions (same subject; already-added ones are skipped). */
export async function addPracticeItems(db: Db, ctx: RequestContext, schoolId: string, setId: string, questionIds: string[]): Promise<{ added: number }> {
  parse(uuidField("Practice set"), setId);
  const ids = parse(z.array(z.uuid({ message: "Question not found." })).min(1, "Choose at least one question.").max(MAX_PRACTICE_ITEMS), questionIds);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "draft") throw new AppError("CONFLICT", "Questions can be added only while the set is a draft.");
    const rows = (await tx.execute(sql`
      select q.id, q.published_version_id as "versionId" from questions q
      where q.school_id = ${schoolId}::uuid and q.subject_id = ${s.subjectId}::uuid and q.status = 'published' and q.published_version_id is not null
        and q.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as { id: string; versionId: string }[];
    if (rows.length !== new Set(ids).size) throw new AppError("VALIDATION", "Only published questions of this set's subject can be added.");
    const byId = new Map(rows.map((r) => [r.id, r.versionId]));
    const added = await appendItems(tx, schoolId, setId, ids.map((id) => byId.get(id)!));
    await audit(tx, { action: "practice_set.items_added", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId, data: { added } });
    return { added };
  });
}

/** Adds up to `count` published questions of a chapter (including its topics) or topic, not yet in the set. */
export async function addPracticeItemsFromTopic(db: Db, ctx: RequestContext, schoolId: string, setId: string, topicId: string, count: number): Promise<{ added: number }> {
  parse(uuidField("Practice set"), setId);
  parse(uuidField("Topic"), topicId);
  const n = parse(z.number().int().min(1, "Add at least one question.").max(MAX_PRACTICE_ITEMS), count);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "draft") throw new AppError("CONFLICT", "Questions can be added only while the set is a draft.");
    await checkTopic(tx, schoolId, s.subjectId, topicId);
    const rows = (await tx.execute(sql`
      select q.published_version_id as "versionId" from questions q left join topics t on t.id = q.topic_id
      where q.school_id = ${schoolId}::uuid and q.subject_id = ${s.subjectId}::uuid and q.status = 'published' and q.published_version_id is not null
        and (q.topic_id = ${topicId}::uuid or t.parent_id = ${topicId}::uuid)
        and not exists (select 1 from practice_set_items i where i.set_id = ${setId}::uuid and i.question_version_id = q.published_version_id)
      order by q.created_at, q.id limit ${n}`)) as unknown as { versionId: string }[];
    if (rows.length === 0) throw new AppError("CONFLICT", "No more published questions in that chapter or topic.");
    const added = await appendItems(tx, schoolId, setId, rows.map((r) => r.versionId));
    await audit(tx, { action: "practice_set.items_added", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId, data: { added, topicId } });
    return { added };
  });
}

export async function removePracticeItem(db: Db, ctx: RequestContext, schoolId: string, setId: string, itemId: string): Promise<void> {
  parse(uuidField("Practice set"), setId);
  parse(uuidField("Question"), itemId);
  await withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "draft") throw new AppError("CONFLICT", "A published set's questions are fixed.");
    const r = await tx.delete(practiceSetItems).where(and(eq(practiceSetItems.setId, setId), eq(practiceSetItems.id, itemId))).returning({ id: practiceSetItems.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "That question is not in this set.");
    await audit(tx, { action: "practice_set.item_removed", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId });
  });
}

/** Publishes a draft: its questions are fixed and it can be assigned to sections. */
export async function publishPracticeSet(db: Db, ctx: RequestContext, schoolId: string, setId: string): Promise<void> {
  parse(uuidField("Practice set"), setId);
  await withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "draft") throw new AppError("CONFLICT", "Only a draft can be published.");
    const [c] = (await tx.execute(sql`select count(*)::int as n from practice_set_items where set_id = ${setId}::uuid`)) as unknown as { n: number }[];
    if (!c || c.n === 0) throw new AppError("CONFLICT", "Add at least one question before publishing.");
    await tx.update(practiceSets).set({ status: "published", publishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(practiceSets.id, setId));
    await audit(tx, { action: "practice_set.published", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId, data: { items: c.n } });
  });
}

/** Archives a published set: students no longer see it; attempts and scores are kept. */
export async function archivePracticeSet(db: Db, ctx: RequestContext, schoolId: string, setId: string): Promise<void> {
  parse(uuidField("Practice set"), setId);
  await withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "published") throw new AppError("CONFLICT", s.status === "archived" ? "Already archived." : "Only a published set can be archived. A draft can simply be left unpublished.");
    await tx.update(practiceSets).set({ status: "archived", updatedAt: sql`now()` }).where(eq(practiceSets.id, setId));
    await audit(tx, { action: "practice_set.archived", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId });
  });
}

const assignSchema = z.object({
  sectionId: z.uuid({ message: "Choose a section." }),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
});

/** Assigns a published set to a section; times are local to the school ("YYYY-MM-DDTHH:mm", optional). */
export async function assignPracticeSet(db: Db, ctx: RequestContext, schoolId: string, setId: string, input: z.input<typeof assignSchema>): Promise<{ id: string }> {
  parse(uuidField("Practice set"), setId);
  const v = parse(assignSchema, input);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const s = await lockSet(tx, schoolId, setId);
    if (s.status !== "published") throw new AppError("CONFLICT", "Publish the set before assigning it.");
    const zone = await timezoneOf(tx, schoolId);
    const opensAt = v.opensAt?.trim() ? zonedLocalToInstant(v.opensAt, zone) : null;
    const closesAt = v.closesAt?.trim() ? zonedLocalToInstant(v.closesAt, zone) : null;
    if (v.opensAt?.trim() && !opensAt) throw new AppError("VALIDATION", "Enter a valid opening date and time.", { opensAt: "Not valid." });
    if (v.closesAt?.trim() && !closesAt) throw new AppError("VALIDATION", "Enter a valid closing date and time.", { closesAt: "Not valid." });
    if (opensAt && closesAt && closesAt <= opensAt) throw new AppError("VALIDATION", "The closing time must be after the opening time.", { closesAt: "Must be after opening." });
    if (closesAt && closesAt.getTime() <= Date.now()) throw new AppError("VALIDATION", "The closing time has already passed.", { closesAt: "In the past." });
    const [sec] = (await tx.execute(sql`
      select app_can_manage_setup(${schoolId}::uuid) or app_teaches_section(s.id, app_school_today(${schoolId}::uuid)) as ok,
             y.status::text = 'current' and s.archived_at is null as usable,
             exists (select 1 from class_subjects cs where cs.school_id = s.school_id and cs.academic_year_id = s.academic_year_id and cs.class_id = s.class_id and cs.subject_id = ${s.subjectId}::uuid) as studies
      from sections s join academic_years y on y.id = s.academic_year_id
      where s.school_id = ${schoolId}::uuid and s.id = ${v.sectionId}::uuid`)) as unknown as { ok: boolean; usable: boolean; studies: boolean }[];
    if (!sec || !sec.ok) throw new AppError("NOT_FOUND", "Section not found.");
    if (!sec.usable) throw new AppError("CONFLICT", "Choose a section of the current academic year.");
    if (!sec.studies) throw new AppError("VALIDATION", "That class does not study this subject this year.", { sectionId: "Subject not taught." });
    const [dup] = (await tx.execute(sql`select 1 as x from practice_assignments where set_id = ${setId}::uuid and section_id = ${v.sectionId}::uuid and removed_at is null`)) as unknown as { x: number }[];
    if (dup) throw new AppError("CONFLICT", "This set is already assigned to that section.");
    const [a] = await tx.insert(practiceAssignments).values({ schoolId, setId, sectionId: v.sectionId, opensAt, closesAt, createdBy: actor.userId }).returning({ id: practiceAssignments.id });
    await audit(tx, { action: "practice_set.assigned", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: setId, data: { sectionId: v.sectionId } });
    return { id: a!.id };
  });
}

/** Stops an assignment: the section's students no longer see the set; their attempts are kept. */
export async function removePracticeAssignment(db: Db, ctx: RequestContext, schoolId: string, assignmentId: string): Promise<void> {
  parse(uuidField("Assignment"), assignmentId);
  await withCapability(db, ctx, schoolId, "school.practice.manage", async (tx, actor) => {
    const r = await tx
      .update(practiceAssignments)
      .set({ removedAt: sql`now()` })
      .where(and(eq(practiceAssignments.schoolId, schoolId), eq(practiceAssignments.id, assignmentId), sql`${practiceAssignments.removedAt} is null`))
      .returning({ setId: practiceAssignments.setId });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Assignment not found.");
    await audit(tx, { action: "practice_set.unassigned", actorUserId: actor.userId, schoolId, entityType: "practice_set", entityId: r[0]!.setId, data: { assignmentId } });
  });
}

/* ------------------------------------------------------------------ reading */

export interface PracticeSetRow {
  id: string;
  title: string;
  subjectName: string;
  topicPath: string | null;
  status: "draft" | "published" | "archived";
  itemCount: number;
  sectionCount: number;
  submittedCount: number;
  updatedAt: Date;
}

const topicPathSql = sql`case when t.id is null then null when ch.id is null then t.name else ch.name || ' › ' || t.name end`;

export async function listPracticeSets(db: Db, ctx: RequestContext, schoolId: string, f: { subjectId?: string; status?: string; search?: string } = {}): Promise<PracticeSetRow[]> {
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx) => {
    const parts = [sql`p.school_id = ${schoolId}::uuid`];
    if (f.subjectId && z.uuid().safeParse(f.subjectId).success) parts.push(sql`p.subject_id = ${f.subjectId}::uuid`);
    if (f.status && ["draft", "published", "archived"].includes(f.status)) parts.push(sql`p.status = ${f.status}::practice_set_status`);
    else parts.push(sql`p.status <> 'archived'`);
    if (f.search?.trim()) parts.push(sql`p.title ilike ${likePattern(f.search.trim())}`);
    return (await tx.execute(sql`
      select p.id, p.title, s.name as "subjectName", ${topicPathSql} as "topicPath", p.status::text as status,
             (select count(*)::int from practice_set_items i where i.set_id = p.id) as "itemCount",
             (select count(*)::int from practice_assignments a where a.set_id = p.id and a.removed_at is null) as "sectionCount",
             (select count(*)::int from practice_attempts x where x.set_id = p.id and x.status = 'submitted') as "submittedCount",
             p.updated_at as "updatedAt"
      from practice_sets p join subjects s on s.id = p.subject_id
      left join topics t on t.id = p.topic_id left join topics ch on ch.id = t.parent_id
      where ${sql.join(parts, sql` and `)}
      order by p.updated_at desc, p.id limit 200`)) as unknown as PracticeSetRow[];
  });
}

export interface PracticeItemRow {
  id: string;
  position: number;
  questionId: string;
  revision: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  marksX100: number;
  topicPath: string | null;
  /** Share of submitted attempts that answered correctly, in basis points (null: not scored or no attempts). */
  correctBp: number | null;
  answered: number;
}

export interface ParticipationRow {
  studentId: string;
  name: string;
  rollNo: number | null;
  attempts: number;
  submitted: number;
  /** Best submitted score as basis points of the maximum. */
  bestBp: number | null;
  lastSubmittedAt: Date | null;
}

export interface PracticeAssignmentRow {
  id: string;
  sectionId: string;
  sectionLabel: string;
  opensAt: Date | null;
  closesAt: Date | null;
  opensLocal: string | null;
  closesLocal: string | null;
  students: ParticipationRow[];
}

export interface PracticeSetDetail {
  id: string;
  subjectId: string;
  subjectName: string;
  topicId: string | null;
  topicPath: string | null;
  title: string;
  instructions: string | null;
  status: "draft" | "published" | "archived";
  attemptLimit: number | null;
  feedback: PracticeFeedback;
  publishedAt: Date | null;
  items: PracticeItemRow[];
  assignments: PracticeAssignmentRow[];
}

export async function getPracticeSet(db: Db, ctx: RequestContext, schoolId: string, setId: string): Promise<PracticeSetDetail> {
  parse(uuidField("Practice set"), setId);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx) => {
    const [s] = (await tx.execute(sql`
      select p.id, p.subject_id as "subjectId", sub.name as "subjectName", p.topic_id as "topicId", ${topicPathSql} as "topicPath", p.title, p.instructions,
             p.status::text as status, p.attempt_limit as "attemptLimit", p.feedback::text as feedback, p.published_at as "publishedAt"
      from practice_sets p join subjects sub on sub.id = p.subject_id
      left join topics t on t.id = p.topic_id left join topics ch on ch.id = t.parent_id
      where p.school_id = ${schoolId}::uuid and p.id = ${setId}::uuid`)) as unknown as Omit<PracticeSetDetail, "items" | "assignments">[];
    if (!s) throw new AppError("NOT_FOUND", "Practice set not found.");
    const items = (await tx.execute(sql`
      select i.id, i.position, v.question_id as "questionId", v.revision, v.type::text as type, left(v.stem, 300) as stem, v.marks_x100 as "marksX100", ${topicPathSql} as "topicPath",
             st.answered, case when v.type = 'descriptive' or st.answered = 0 then null else (st.correct * 10000 / st.answered)::int end as "correctBp"
      from practice_set_items i join question_versions v on v.id = i.question_version_id join questions q on q.id = v.question_id
      left join topics t on t.id = q.topic_id left join topics ch on ch.id = t.parent_id
      cross join lateral (
        select count(*)::int as answered, count(*) filter (where pa.is_correct)::int as correct
        from practice_answers pa join practice_attempts x on x.id = pa.attempt_id
        where pa.item_id = i.id and x.status = 'submitted'
      ) st
      where i.set_id = ${setId}::uuid order by i.position`)) as unknown as PracticeItemRow[];
    const zone = await timezoneOf(tx, schoolId);
    const assignments = (await tx.execute(sql`
      select a.id, a.section_id as "sectionId", c.name || ' ' || sec.name as "sectionLabel", a.opens_at as "opensAt", a.closes_at as "closesAt"
      from practice_assignments a join sections sec on sec.id = a.section_id join classes c on c.id = sec.class_id
      where a.set_id = ${setId}::uuid and a.removed_at is null order by c.sort_order, c.name, sec.name`)) as unknown as Omit<PracticeAssignmentRow, "students" | "opensLocal" | "closesLocal">[];
    const result: PracticeAssignmentRow[] = [];
    for (const a of assignments) {
      // Students currently in the section (with their attempts at this set), plus anyone who attempted through it and has since moved.
      const students = (await tx.execute(sql`
        with members as (
          select student_id, max(roll_no) as roll_no from (
            select e.student_id, e.roll_no from enrollments e where e.section_id = ${a.sectionId}::uuid and e.ends_on is null
            union all
            select x.student_id, null from practice_attempts x where x.assignment_id = ${a.id}::uuid
          ) u group by student_id
        )
        select p.id as "studentId", p.display_name as name, m.roll_no as "rollNo", st.attempts, st.submitted, st."bestBp", st."lastSubmittedAt"
        from members m join student_profiles p on p.id = m.student_id
        cross join lateral (
          select count(x.id)::int as attempts, count(x.id) filter (where x.status = 'submitted')::int as submitted,
                 max(case when x.status = 'submitted' and x.max_x100 > 0 then x.score_x100 * 10000 / x.max_x100 end)::int as "bestBp",
                 max(x.submitted_at) as "lastSubmittedAt"
          from practice_attempts x where x.student_id = p.id and x.set_id = ${setId}::uuid
        ) st
        order by m.roll_no nulls last, p.display_name`)) as unknown as ParticipationRow[];
      result.push({
        ...a,
        opensLocal: a.opensAt ? instantToZonedLocal(new Date(a.opensAt), zone) : null,
        closesLocal: a.closesAt ? instantToZonedLocal(new Date(a.closesAt), zone) : null,
        students,
      });
    }
    return { ...s, items, assignments: result };
  });
}

export interface AssignableSection {
  id: string;
  label: string;
}

/** Sections of the current year whose class studies the set's subject and the actor may assign to. */
export async function listAssignableSections(db: Db, ctx: RequestContext, schoolId: string, setId: string): Promise<AssignableSection[]> {
  parse(uuidField("Practice set"), setId);
  return withCapability(db, ctx, schoolId, "school.practice.manage", async (tx) => {
    return (await tx.execute(sql`
      select s.id, c.name || ' ' || s.name as label
      from practice_sets p
      join class_subjects cs on cs.school_id = p.school_id and cs.subject_id = p.subject_id
      join academic_years y on y.id = cs.academic_year_id and y.status = 'current'
      join sections s on s.academic_year_id = cs.academic_year_id and s.class_id = cs.class_id and s.archived_at is null
      join classes c on c.id = s.class_id
      where p.school_id = ${schoolId}::uuid and p.id = ${setId}::uuid
        and (app_can_manage_setup(p.school_id) or app_teaches_section(s.id, app_school_today(p.school_id)))
        and not exists (select 1 from practice_assignments a where a.set_id = p.id and a.section_id = s.id and a.removed_at is null)
      order by c.sort_order, c.name, s.name`)) as unknown as AssignableSection[];
  });
}
