import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { academicYears, classSubjects, sections, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { daysBetween, isoDate, mapSetupError, parse, trimmed, uuidField } from "./common";

/**
 * Academic years. Lifecycle: planned → current → closed (and closed → planned to reopen).
 * - At most one current year per school; making a year current closes the previous one.
 * - A closed year is read-only: its sections, subject mappings and calendar cannot change.
 * - Years may overlap (preparing next year while this one runs); the UI warns about it.
 * - A year can be deleted only while nothing belongs to it.
 */
export type YearStatus = "planned" | "current" | "closed";

export interface AcademicYear {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: YearStatus;
}

const yearSchema = z
  .object({
    name: trimmed("Name", 1, 40),
    startsOn: isoDate("start date"),
    endsOn: isoDate("end date"),
  })
  .refine((y) => y.startsOn < y.endsOn, { message: "The year must end after it starts.", path: ["endsOn"] })
  .refine((y) => daysBetween(y.startsOn, y.endsOn) <= 731, { message: "An academic year can be at most two years long.", path: ["endsOn"] });
export type YearInput = z.input<typeof yearSchema>;

const columns = { id: academicYears.id, name: academicYears.name, startsOn: academicYears.startsOn, endsOn: academicYears.endsOn, status: academicYears.status };
const duplicate = { academic_years_school_name_unique: ["name", "An academic year with this name already exists."] as [string, string] };

export async function listAcademicYears(db: Db, ctx: RequestContext, schoolId: string): Promise<AcademicYear[]> {
  return withCapability(db, ctx, schoolId, "school.setup.view", (tx) =>
    tx.select(columns).from(academicYears).where(eq(academicYears.schoolId, schoolId)).orderBy(desc(academicYears.startsOn), asc(academicYears.id)),
  );
}

/** The current year, or null when none is set. */
export async function getCurrentAcademicYear(db: Db, ctx: RequestContext, schoolId: string): Promise<AcademicYear | null> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const [y] = await tx.select(columns).from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.status, "current")));
    return y ?? null;
  });
}

async function loadYear(tx: Tx, schoolId: string, yearId: string): Promise<AcademicYear> {
  const [y] = await tx.select(columns).from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.id, yearId)));
  if (!y) throw new AppError("NOT_FOUND", "Academic year not found.");
  return y;
}

/** Years of the school whose dates overlap the given range (for a warning, not a refusal). */
async function overlapping(tx: Tx, schoolId: string, startsOn: string, endsOn: string, exceptId?: string): Promise<string[]> {
  const rows = await tx
    .select({ name: academicYears.name })
    .from(academicYears)
    .where(
      and(
        eq(academicYears.schoolId, schoolId),
        exceptId ? ne(academicYears.id, exceptId) : undefined,
        sql`${academicYears.startsOn} <= ${endsOn}::date and ${academicYears.endsOn} >= ${startsOn}::date`,
      ),
    );
  return rows.map((r) => r.name);
}

export async function createAcademicYear(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: YearInput,
): Promise<{ id: string; overlapsWith: string[] }> {
  const data = parse(yearSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const overlapsWith = await overlapping(tx, schoolId, data.startsOn, data.endsOn);
      const [row] = await tx.insert(academicYears).values({ schoolId, ...data }).returning({ id: academicYears.id });
      await audit(tx, { action: "setup.year.created", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: row!.id, data: { name: data.name, startsOn: data.startsOn, endsOn: data.endsOn } });
      return { id: row!.id, overlapsWith };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

export async function updateAcademicYear(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  yearId: string,
  input: YearInput,
): Promise<{ overlapsWith: string[] }> {
  parse(uuidField("Academic year"), yearId);
  const data = parse(yearSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const year = await loadYear(tx, schoolId, yearId);
      if (year.status === "closed") throw new AppError("CONFLICT", "A closed year cannot be edited. Reopen it first.");
      const overlapsWith = await overlapping(tx, schoolId, data.startsOn, data.endsOn, yearId);
      await tx.update(academicYears).set({ ...data, updatedAt: sql`now()` }).where(eq(academicYears.id, yearId));
      await audit(tx, { action: "setup.year.updated", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: yearId, data: { name: data.name, startsOn: data.startsOn, endsOn: data.endsOn } });
      return { overlapsWith };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/**
 * Change a year's status. Making a year current closes the year that was current before, in
 * the same transaction. Closing makes the year read-only; reopening sets it back to planned.
 */
export async function setAcademicYearStatus(db: Db, ctx: RequestContext, schoolId: string, yearId: string, status: YearStatus): Promise<void> {
  parse(uuidField("Academic year"), yearId);
  if (!["planned", "current", "closed"].includes(status)) throw new AppError("VALIDATION", "Unknown status.");
  await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
    const year = await loadYear(tx, schoolId, yearId);
    if (year.status === status) return;
    if (status === "planned" && year.status === "current") throw new AppError("CONFLICT", "Make another year current instead; the current year cannot go back to planned.");
    if (status === "current") {
      const closed = await tx
        .update(academicYears)
        .set({ status: "closed", updatedAt: sql`now()` })
        .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.status, "current")))
        .returning({ id: academicYears.id });
      for (const c of closed) {
        await audit(tx, { action: "setup.year.closed", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: c.id, data: { reason: "another year made current" } });
      }
    }
    await tx.update(academicYears).set({ status, updatedAt: sql`now()` }).where(eq(academicYears.id, yearId));
    const verb = status === "current" ? "made_current" : status === "closed" ? "closed" : "reopened";
    await audit(tx, { action: `setup.year.${verb}`, actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: yearId, data: { from: year.status, to: status } });
  });
}

/** Delete a year that has nothing in it yet (no sections, subject mappings or calendar). */
export async function deleteAcademicYear(db: Db, ctx: RequestContext, schoolId: string, yearId: string): Promise<void> {
  parse(uuidField("Academic year"), yearId);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const year = await loadYear(tx, schoolId, yearId);
      if (year.status === "current") throw new AppError("CONFLICT", "The current year cannot be deleted.");
      await tx.delete(academicYears).where(eq(academicYears.id, yearId));
      await audit(tx, { action: "setup.year.deleted", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: yearId, data: { name: year.name } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { inUse: "This year already has sections, subjects or calendar entries, so it cannot be deleted. Close it instead." });
  }
}

/**
 * Copies the structure of one year into another, empty year: every active section (name and
 * capacity, per class) and every class-subject mapping. Used to prepare a new year quickly.
 */
export async function copyYearStructure(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  fromYearId: string,
  toYearId: string,
): Promise<{ sections: number; classSubjects: number }> {
  parse(uuidField("Academic year"), fromYearId);
  parse(uuidField("Academic year"), toYearId);
  if (fromYearId === toYearId) throw new AppError("VALIDATION", "Choose two different years.");
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      await loadYear(tx, schoolId, fromYearId);
      const target = await loadYear(tx, schoolId, toYearId);
      if (target.status === "closed") throw new AppError("CONFLICT", "Cannot copy into a closed year.");
      const [existing] = await tx.select({ n: sql<number>`count(*)::int` }).from(sections).where(and(eq(sections.schoolId, schoolId), eq(sections.academicYearId, toYearId)));
      const [existingMaps] = await tx.select({ n: sql<number>`count(*)::int` }).from(classSubjects).where(and(eq(classSubjects.schoolId, schoolId), eq(classSubjects.academicYearId, toYearId)));
      if ((existing?.n ?? 0) > 0 || (existingMaps?.n ?? 0) > 0) throw new AppError("CONFLICT", "The target year already has sections or subjects. Copying works only into an empty year.");

      const copiedSections = await tx.execute(sql`
        insert into sections (school_id, academic_year_id, class_id, name, capacity)
        select s.school_id, ${toYearId}::uuid, s.class_id, s.name, s.capacity
        from sections s join classes c on c.id = s.class_id
        where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${fromYearId}::uuid and s.archived_at is null and c.archived_at is null
        returning id`);
      const copiedMaps = await tx.execute(sql`
        insert into class_subjects (school_id, academic_year_id, class_id, subject_id)
        select m.school_id, ${toYearId}::uuid, m.class_id, m.subject_id
        from class_subjects m join classes c on c.id = m.class_id join subjects sub on sub.id = m.subject_id
        where m.school_id = ${schoolId}::uuid and m.academic_year_id = ${fromYearId}::uuid and c.archived_at is null and sub.archived_at is null
        returning id`);
      const result = { sections: copiedSections.length, classSubjects: copiedMaps.length };
      await audit(tx, { action: "setup.year.structure_copied", actorUserId: actor.userId, schoolId, entityType: "academic_year", entityId: toYearId, data: { fromYearId, ...result } });
      return result;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e);
  }
}
