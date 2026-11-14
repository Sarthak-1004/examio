import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { academicYears, classSubjects, classes, sections, subjects, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { mapSetupError, parse, trimmed, uuidField } from "./common";

/**
 * Classes, sections, subjects and which subjects each class studies in a year.
 * - Classes and subjects belong to the school across years; sections and subject mappings
 *   belong to one academic year.
 * - Names are unique per school (classes, subjects), per class and year (sections); subject
 *   codes are unique per school. Comparisons ignore letter case.
 * - Anything in use is archived, not deleted. Archived classes and subjects are hidden from
 *   new setup but kept for history; they can be restored.
 */

/* ------------------------------------------------------------------ classes */

export interface SchoolClass {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
}

const classSchema = z.object({
  name: trimmed("Class name", 1, 40),
  sortOrder: z.coerce.number().int("Order must be a whole number.").min(-1000).max(1000).default(0),
});
export type ClassInput = z.input<typeof classSchema>;
const classDuplicate = { classes_school_name_unique: ["name", "A class with this name already exists."] as [string, string] };

export async function listClasses(db: Db, ctx: RequestContext, schoolId: string, opts: { includeArchived?: boolean } = {}): Promise<SchoolClass[]> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = await tx
      .select({ id: classes.id, name: classes.name, sortOrder: classes.sortOrder, archivedAt: classes.archivedAt })
      .from(classes)
      .where(and(eq(classes.schoolId, schoolId), opts.includeArchived ? undefined : isNull(classes.archivedAt)))
      .orderBy(asc(classes.sortOrder), asc(classes.name));
    return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder, archived: r.archivedAt !== null }));
  });
}

export async function createClass(db: Db, ctx: RequestContext, schoolId: string, input: ClassInput): Promise<{ id: string }> {
  const data = parse(classSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [row] = await tx.insert(classes).values({ schoolId, ...data }).returning({ id: classes.id });
      await audit(tx, { action: "setup.class.created", actorUserId: actor.userId, schoolId, entityType: "class", entityId: row!.id, data: { name: data.name } });
      return { id: row!.id };
    });
  } catch (e) {
    mapSetupError(e, { duplicate: classDuplicate });
  }
}

/** Adds "Class 1" … "Class 12" (sort order 1–12), skipping any that already exist. */
export async function addStandardClasses(db: Db, ctx: RequestContext, schoolId: string): Promise<{ added: number }> {
  return withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
    const rows = await tx.execute(sql`
      insert into classes (school_id, name, sort_order)
      select ${schoolId}::uuid, 'Class ' || n, n from generate_series(1, 12) n
      on conflict do nothing
      returning id`);
    if (rows.length > 0) await audit(tx, { action: "setup.class.standard_added", actorUserId: actor.userId, schoolId, entityType: "class", data: { added: rows.length } });
    return { added: rows.length };
  });
}

export async function updateClass(db: Db, ctx: RequestContext, schoolId: string, classId: string, input: ClassInput): Promise<void> {
  parse(uuidField("Class"), classId);
  const data = parse(classSchema, input);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const updated = await tx.update(classes).set(data).where(and(eq(classes.schoolId, schoolId), eq(classes.id, classId))).returning({ id: classes.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", "Class not found.");
      await audit(tx, { action: "setup.class.updated", actorUserId: actor.userId, schoolId, entityType: "class", entityId: classId, data: { name: data.name, sortOrder: data.sortOrder } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: classDuplicate });
  }
}

/* ------------------------------------------------------------------ subjects */

export interface Subject {
  id: string;
  name: string;
  code: string;
  archived: boolean;
}

const subjectSchema = z.object({
  name: trimmed("Subject name", 1, 80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,11}$/, "Code must be 2–12 letters, digits or hyphens, e.g. MATH or SCI-1."),
});
export type SubjectInput = z.input<typeof subjectSchema>;
const subjectDuplicate = {
  subjects_school_code_unique: ["code", "A subject with this code already exists."] as [string, string],
  subjects_school_name_unique: ["name", "A subject with this name already exists."] as [string, string],
};

export async function listSubjects(db: Db, ctx: RequestContext, schoolId: string, opts: { includeArchived?: boolean } = {}): Promise<Subject[]> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = await tx
      .select({ id: subjects.id, name: subjects.name, code: subjects.code, archivedAt: subjects.archivedAt })
      .from(subjects)
      .where(and(eq(subjects.schoolId, schoolId), opts.includeArchived ? undefined : isNull(subjects.archivedAt)))
      .orderBy(asc(subjects.name));
    return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, archived: r.archivedAt !== null }));
  });
}

export async function createSubject(db: Db, ctx: RequestContext, schoolId: string, input: SubjectInput): Promise<{ id: string }> {
  const data = parse(subjectSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [row] = await tx.insert(subjects).values({ schoolId, ...data }).returning({ id: subjects.id });
      await audit(tx, { action: "setup.subject.created", actorUserId: actor.userId, schoolId, entityType: "subject", entityId: row!.id, data });
      return { id: row!.id };
    });
  } catch (e) {
    mapSetupError(e, { duplicate: subjectDuplicate });
  }
}

/** Renames a subject. The code is fixed once created, because other records refer to it. */
export async function renameSubject(db: Db, ctx: RequestContext, schoolId: string, subjectId: string, name: string): Promise<void> {
  parse(uuidField("Subject"), subjectId);
  const data = parse(z.object({ name: trimmed("Subject name", 1, 80) }), { name });
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const updated = await tx.update(subjects).set(data).where(and(eq(subjects.schoolId, schoolId), eq(subjects.id, subjectId))).returning({ id: subjects.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", "Subject not found.");
      await audit(tx, { action: "setup.subject.renamed", actorUserId: actor.userId, schoolId, entityType: "subject", entityId: subjectId, data });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: subjectDuplicate });
  }
}

/* ------------------------------------------------------------------ sections */

export interface Section {
  id: string;
  classId: string;
  name: string;
  capacity: number | null;
  archived: boolean;
}

const sectionSchema = z.object({
  name: trimmed("Section name", 1, 20),
  capacity: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z.coerce.number().int("Capacity must be a whole number.").min(1, "Capacity must be at least 1.").max(500, "Capacity must be at most 500.").nullable(),
  ),
});
export type SectionInput = { name: string; capacity?: string | number | null };
const sectionDuplicate = { sections_year_class_name_unique: ["name", "This class already has a section with that name this year."] as [string, string] };

async function requireOpenYear(tx: Tx, schoolId: string, yearId: string): Promise<void> {
  const [y] = await tx.select({ status: academicYears.status }).from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.id, yearId)));
  if (!y) throw new AppError("NOT_FOUND", "Academic year not found.");
  if (y.status === "closed") throw new AppError("CONFLICT", "This academic year is closed. Reopen it to make changes.");
}

async function requireActiveClass(tx: Tx, schoolId: string, classId: string): Promise<void> {
  const [c] = await tx.select({ archivedAt: classes.archivedAt }).from(classes).where(and(eq(classes.schoolId, schoolId), eq(classes.id, classId)));
  if (!c) throw new AppError("NOT_FOUND", "Class not found.");
  if (c.archivedAt) throw new AppError("CONFLICT", "This class is archived. Restore it first.");
}

export async function listSections(db: Db, ctx: RequestContext, schoolId: string, yearId: string, opts: { includeArchived?: boolean } = {}): Promise<Section[]> {
  parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = await tx
      .select({ id: sections.id, classId: sections.classId, name: sections.name, capacity: sections.capacity, archivedAt: sections.archivedAt })
      .from(sections)
      .where(and(eq(sections.schoolId, schoolId), eq(sections.academicYearId, yearId), opts.includeArchived ? undefined : isNull(sections.archivedAt)))
      .orderBy(asc(sections.name));
    return rows.map((r) => ({ id: r.id, classId: r.classId, name: r.name, capacity: r.capacity, archived: r.archivedAt !== null }));
  });
}

export async function createSection(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: SectionInput & { yearId: string; classId: string },
): Promise<{ id: string }> {
  parse(uuidField("Academic year"), input.yearId);
  parse(uuidField("Class"), input.classId);
  const data = parse(sectionSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      await requireOpenYear(tx, schoolId, input.yearId);
      await requireActiveClass(tx, schoolId, input.classId);
      const [row] = await tx
        .insert(sections)
        .values({ schoolId, academicYearId: input.yearId, classId: input.classId, name: data.name, capacity: data.capacity })
        .returning({ id: sections.id });
      await audit(tx, { action: "setup.section.created", actorUserId: actor.userId, schoolId, entityType: "section", entityId: row!.id, data: { yearId: input.yearId, classId: input.classId, name: data.name } });
      return { id: row!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: sectionDuplicate });
  }
}

export async function updateSection(db: Db, ctx: RequestContext, schoolId: string, sectionId: string, input: SectionInput): Promise<void> {
  parse(uuidField("Section"), sectionId);
  const data = parse(sectionSchema, input);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [s] = await tx.select({ yearId: sections.academicYearId }).from(sections).where(and(eq(sections.schoolId, schoolId), eq(sections.id, sectionId)));
      if (!s) throw new AppError("NOT_FOUND", "Section not found.");
      await requireOpenYear(tx, schoolId, s.yearId);
      await tx.update(sections).set(data).where(eq(sections.id, sectionId));
      await audit(tx, { action: "setup.section.updated", actorUserId: actor.userId, schoolId, entityType: "section", entityId: sectionId, data });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: sectionDuplicate });
  }
}

/* ------------------------------------------------------------------ class subjects */

export interface ClassSubjectMap {
  classId: string;
  subjectIds: string[];
}

export async function listClassSubjects(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<ClassSubjectMap[]> {
  parse(uuidField("Academic year"), yearId);
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const rows = await tx
      .select({ classId: classSubjects.classId, subjectId: classSubjects.subjectId })
      .from(classSubjects)
      .where(and(eq(classSubjects.schoolId, schoolId), eq(classSubjects.academicYearId, yearId)));
    const byClass = new Map<string, string[]>();
    for (const r of rows) byClass.set(r.classId, [...(byClass.get(r.classId) ?? []), r.subjectId]);
    return [...byClass.entries()].map(([classId, subjectIds]) => ({ classId, subjectIds }));
  });
}

/**
 * Sets exactly which subjects a class studies in a year: adds the missing mappings and removes
 * the others. Every subject must be an active subject of this school.
 */
export async function setClassSubjects(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { yearId: string; classId: string; subjectIds: string[] },
): Promise<{ added: number; removed: number }> {
  parse(uuidField("Academic year"), input.yearId);
  parse(uuidField("Class"), input.classId);
  const subjectIds = [...new Set(parse(z.array(uuidField("Subject")).max(60, "At most 60 subjects per class."), input.subjectIds))];
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      await requireOpenYear(tx, schoolId, input.yearId);
      await requireActiveClass(tx, schoolId, input.classId);
      if (subjectIds.length > 0) {
        const valid = await tx
          .select({ id: subjects.id })
          .from(subjects)
          .where(and(eq(subjects.schoolId, schoolId), inArray(subjects.id, subjectIds), isNull(subjects.archivedAt)));
        if (valid.length !== subjectIds.length) throw new AppError("NOT_FOUND", "One of the subjects was not found or is archived.");
      }
      const scope = and(eq(classSubjects.schoolId, schoolId), eq(classSubjects.academicYearId, input.yearId), eq(classSubjects.classId, input.classId));
      const removed = await tx
        .delete(classSubjects)
        .where(and(scope, subjectIds.length > 0 ? notInArray(classSubjects.subjectId, subjectIds) : undefined))
        .returning({ id: classSubjects.id });
      const added =
        subjectIds.length === 0
          ? []
          : await tx
              .insert(classSubjects)
              .values(subjectIds.map((subjectId) => ({ schoolId, academicYearId: input.yearId, classId: input.classId, subjectId })))
              .onConflictDoNothing()
              .returning({ id: classSubjects.id });
      if (added.length || removed.length) {
        await audit(tx, { action: "setup.class_subjects.set", actorUserId: actor.userId, schoolId, entityType: "class", entityId: input.classId, data: { yearId: input.yearId, added: added.length, removed: removed.length } });
      }
      return { added: added.length, removed: removed.length };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { inUse: "A subject is still in use for this class and cannot be removed." });
  }
}

/* ------------------------------------------------------------------ archive / delete */

export type ArchivableKind = "class" | "section" | "subject";

const tables = {
  class: { table: classes, label: "Class" },
  section: { table: sections, label: "Section" },
  subject: { table: subjects, label: "Subject" },
} as const;

/** Hide from new setup (or bring back), keeping history. */
export async function setArchived(db: Db, ctx: RequestContext, schoolId: string, kind: ArchivableKind, id: string, archived: boolean): Promise<void> {
  const { table, label } = tables[kind];
  parse(uuidField(label), id);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      if (kind === "section") {
        const [s] = await tx.select({ yearId: sections.academicYearId }).from(sections).where(and(eq(sections.schoolId, schoolId), eq(sections.id, id)));
        if (!s) throw new AppError("NOT_FOUND", "Section not found.");
        await requireOpenYear(tx, schoolId, s.yearId);
      }
      const updated = await tx
        .update(table)
        .set({ archivedAt: archived ? sql`now()` : null })
        .where(and(eq(table.schoolId, schoolId), eq(table.id, id)))
        .returning({ id: table.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", `${label} not found.`);
      await audit(tx, { action: `setup.${kind}.${archived ? "archived" : "restored"}`, actorUserId: actor.userId, schoolId, entityType: kind, entityId: id });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}

/** Delete only if nothing refers to it; otherwise the caller is told to archive instead. */
export async function deleteSetupItem(db: Db, ctx: RequestContext, schoolId: string, kind: ArchivableKind, id: string): Promise<void> {
  const { table, label } = tables[kind];
  parse(uuidField(label), id);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      if (kind === "section") {
        const [s] = await tx.select({ yearId: sections.academicYearId }).from(sections).where(and(eq(sections.schoolId, schoolId), eq(sections.id, id)));
        if (!s) throw new AppError("NOT_FOUND", "Section not found.");
        await requireOpenYear(tx, schoolId, s.yearId);
      }
      const deleted = await tx.delete(table).where(and(eq(table.schoolId, schoolId), eq(table.id, id))).returning({ id: table.id });
      if (deleted.length === 0) throw new AppError("NOT_FOUND", `${label} not found.`);
      await audit(tx, { action: `setup.${kind}.deleted`, actorUserId: actor.userId, schoolId, entityType: kind, entityId: id });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { inUse: `This ${label.toLowerCase()} is in use, so it cannot be deleted. Archive it instead to keep its history.` });
  }
}
