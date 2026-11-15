import { and, eq, sql } from "drizzle-orm";
import { topics, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { mapSetupError, parse, trimmed, uuidField } from "../setup/common";

/**
 * Curriculum (Phase 9): each subject has chapters, and each chapter has topics. Two levels only.
 * Administrators manage any subject; teachers manage the subjects they currently teach. Topics in
 * use are archived, never deleted.
 */

export interface AuthorableSubject {
  id: string;
  name: string;
  code: string;
}

/** Subjects the caller may write questions for: all for administrators, taught ones for teachers. */
export async function listAuthorableSubjects(db: Db, ctx: RequestContext, schoolId: string): Promise<AuthorableSubject[]> {
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx) =>
    (await tx.execute(sql`
      select id, name, code from subjects
      where school_id = ${schoolId}::uuid and archived_at is null and app_can_author_subject(school_id, id)
      order by name`)) as unknown as AuthorableSubject[],
  );
}

async function requireAuthorable(tx: Tx, schoolId: string, subjectId: string): Promise<void> {
  const [ok] = (await tx.execute(sql`select app_can_author_subject(${schoolId}::uuid, ${subjectId}::uuid) as ok, exists (select 1 from subjects where school_id = ${schoolId}::uuid and id = ${subjectId}::uuid) as found`)) as unknown as { ok: boolean; found: boolean }[];
  if (!ok?.found || !ok.ok) throw new AppError("NOT_FOUND", "Subject not found.");
}

export interface TopicNode {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
  questions: number;
}

export interface ChapterNode extends TopicNode {
  topics: TopicNode[];
}

export async function getCurriculum(db: Db, ctx: RequestContext, schoolId: string, subjectId: string): Promise<ChapterNode[]> {
  parse(uuidField("Subject"), subjectId);
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx) => {
    await requireAuthorable(tx, schoolId, subjectId);
    const rows = (await tx.execute(sql`
      select t.id, t.name, t.level::text as level, t.parent_id as "parentId", t.sort_order as "sortOrder", t.archived_at is not null as archived,
             (select count(*)::int from questions q where q.topic_id = t.id and q.status <> 'archived') as questions
      from topics t where t.school_id = ${schoolId}::uuid and t.subject_id = ${subjectId}::uuid
      order by t.sort_order, lower(t.name)`)) as unknown as (TopicNode & { level: string; parentId: string | null })[];
    return rows
      .filter((r) => r.level === "chapter")
      .map(({ level: _l, parentId: _p, ...c }) => ({ ...c, topics: rows.filter((t) => t.parentId === c.id).map(({ level: _l2, parentId: _p2, ...t }) => t) }));
  });
}

const duplicate = { topics_unique_name: ["name", "A chapter or topic with this name already exists here."] as [string, string] };

export async function createChapter(db: Db, ctx: RequestContext, schoolId: string, input: { subjectId: string; name: string; sortOrder?: number }): Promise<{ id: string }> {
  parse(uuidField("Subject"), input.subjectId);
  const name = parse(trimmed("Chapter name", 1, 120), input.name);
  try {
    return await withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
      await requireAuthorable(tx, schoolId, input.subjectId);
      const [t] = await tx.insert(topics).values({ schoolId, subjectId: input.subjectId, level: "chapter", name, sortOrder: input.sortOrder ?? 0 }).returning({ id: topics.id });
      await audit(tx, { action: "curriculum.chapter_created", actorUserId: actor.userId, schoolId, entityType: "topic", entityId: t!.id, data: { name } });
      return { id: t!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

export async function createTopic(db: Db, ctx: RequestContext, schoolId: string, input: { chapterId: string; name: string; sortOrder?: number }): Promise<{ id: string }> {
  parse(uuidField("Chapter"), input.chapterId);
  const name = parse(trimmed("Topic name", 1, 120), input.name);
  try {
    return await withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
      const [ch] = await tx.select({ subjectId: topics.subjectId, level: topics.level }).from(topics).where(and(eq(topics.schoolId, schoolId), eq(topics.id, input.chapterId)));
      if (!ch || ch.level !== "chapter") throw new AppError("NOT_FOUND", "Chapter not found.");
      await requireAuthorable(tx, schoolId, ch.subjectId);
      const [t] = await tx.insert(topics).values({ schoolId, subjectId: ch.subjectId, level: "topic", parentId: input.chapterId, name, sortOrder: input.sortOrder ?? 0 }).returning({ id: topics.id });
      await audit(tx, { action: "curriculum.topic_created", actorUserId: actor.userId, schoolId, entityType: "topic", entityId: t!.id, data: { name } });
      return { id: t!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

export async function renameTopic(db: Db, ctx: RequestContext, schoolId: string, topicId: string, name: string): Promise<void> {
  parse(uuidField("Topic"), topicId);
  const n = parse(trimmed("Name", 1, 120), name);
  try {
    await withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
      const r = await tx.update(topics).set({ name: n }).where(and(eq(topics.schoolId, schoolId), eq(topics.id, topicId))).returning({ id: topics.id });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Chapter or topic not found.");
      await audit(tx, { action: "curriculum.renamed", actorUserId: actor.userId, schoolId, entityType: "topic", entityId: topicId, data: { name: n } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/** Archives (or restores) a chapter or topic; archiving a chapter archives its topics too. */
export async function archiveTopic(db: Db, ctx: RequestContext, schoolId: string, topicId: string, archived: boolean): Promise<void> {
  parse(uuidField("Topic"), topicId);
  await withCapability(db, ctx, schoolId, "school.questions.manage", async (tx, actor) => {
    const r = await tx
      .update(topics)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(and(eq(topics.schoolId, schoolId), sql`(${topics.id} = ${topicId}::uuid or (${archived} and ${topics.parentId} = ${topicId}::uuid))`))
      .returning({ id: topics.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Chapter or topic not found.");
    await audit(tx, { action: archived ? "curriculum.archived" : "curriculum.restored", actorUserId: actor.userId, schoolId, entityType: "topic", entityId: topicId });
  });
}
