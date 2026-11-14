import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { enrollments, studentProfiles, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays } from "../../dates";
import { AppError } from "../../errors";
import { isoDate, mapSetupError, parse, uuidField } from "../setup/common";
import { openSection, schoolInfo, startWithinYear } from "./common";
import { leaveInTransaction, studentDuplicate } from "./profiles";

/**
 * Enrollments (Phase 5): a student in a section for dates within one academic year.
 *
 * - One open enrollment per student per year; roll numbers unique among a section's open
 *   enrollments. Rows are never deleted.
 * - Moving section: the current enrollment ends the day before the move and a new one starts.
 * - A mistaken enrollment is ended as "corrected" on its first day; it stays in the history.
 * - Promotion: the source enrollment ends on its year's last day (if that year is still open;
 *   in a closed year it already ends with the year) and a new enrollment starts on the first
 *   day of the target year. Running the same promotion again skips students already enrolled
 *   in the target year, so a retry never enrolls anyone twice.
 */

const roll = z.union([z.literal("").transform(() => null), z.coerce.number({ message: "Roll number must be a whole number." }).int("Roll number must be a whole number.").min(1, "Roll number must be 1 or more.").max(9999, "Roll number is too large.")]).nullable().optional();

async function activeStudent(tx: Tx, schoolId: string, studentId: string) {
  const [p] = await tx.select().from(studentProfiles).where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
  if (!p) throw new AppError("NOT_FOUND", "Student not found.");
  if (p.status !== "active") throw new AppError("CONFLICT", "This student has left the school. Readmit them first.");
  return p;
}

export async function enrollStudent(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { studentId: string; sectionId: string; rollNo?: string | number | null; startsOn?: string | null },
): Promise<{ id: string; startsOn: string }> {
  parse(uuidField("Student"), input.studentId);
  parse(uuidField("Section"), input.sectionId);
  const rollNo = parse(roll, input.rollNo ?? null) ?? null;
  const requested = input.startsOn ? parse(isoDate("start date"), input.startsOn) : null;
  try {
    return await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const p = await activeStudent(tx, schoolId, input.studentId);
      const sec = await openSection(tx, schoolId, input.sectionId);
      const school = await schoolInfo(tx, schoolId);
      const startsOn = startWithinYear(sec, school.today, requested, p.admittedOn > sec.endsOn ? null : p.admittedOn);
      const [e] = await tx
        .insert(enrollments)
        .values({ schoolId, studentId: p.id, academicYearId: sec.yearId, sectionId: sec.sectionId, rollNo, startsOn })
        .returning({ id: enrollments.id });
      await audit(tx, { action: "enrollment.created", actorUserId: actor.userId, schoolId, entityType: "enrollment", entityId: e!.id, data: { studentId: p.id, sectionId: sec.sectionId, startsOn } });
      return { id: e!.id, startsOn };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

async function openEnrollment(tx: Tx, schoolId: string, enrollmentId: string) {
  const rows = (await tx.execute(sql`
    select e.id, e.student_id as "studentId", e.academic_year_id as "yearId", e.section_id as "sectionId", e.roll_no as "rollNo",
           e.starts_on::text as "startsOn", e.ends_on::text as "endsOn", y.status::text as "yearStatus", y.ends_on::text as "yearEnds"
    from enrollments e join academic_years y on y.id = e.academic_year_id
    where e.school_id = ${schoolId}::uuid and e.id = ${enrollmentId}::uuid`)) as unknown as {
    id: string; studentId: string; yearId: string; sectionId: string; rollNo: number | null; startsOn: string; endsOn: string | null; yearStatus: string; yearEnds: string;
  }[];
  const e = rows[0];
  if (!e) throw new AppError("NOT_FOUND", "Enrollment not found.");
  if (e.endsOn) throw new AppError("CONFLICT", "This enrollment has already ended.");
  if (e.yearStatus === "closed") throw new AppError("CONFLICT", "That academic year is closed. Reopen it to change enrollments.");
  return e;
}

/** Moves a student to another section of the same year from a date (default today). */
export async function changeSection(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { enrollmentId: string; sectionId: string; effectiveOn?: string | null; rollNo?: string | number | null },
): Promise<{ id: string; startsOn: string }> {
  parse(uuidField("Enrollment"), input.enrollmentId);
  parse(uuidField("Section"), input.sectionId);
  const rollNo = parse(roll, input.rollNo ?? null) ?? null;
  const requested = input.effectiveOn ? parse(isoDate("move date"), input.effectiveOn) : null;
  try {
    return await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const cur = await openEnrollment(tx, schoolId, input.enrollmentId);
      await activeStudent(tx, schoolId, cur.studentId);
      const sec = await openSection(tx, schoolId, input.sectionId);
      if (sec.yearId !== cur.yearId) throw new AppError("VALIDATION", "Choose a section in the same academic year. Use promotion to move to another year.", { sectionId: "Different academic year." });
      if (sec.sectionId === cur.sectionId) throw new AppError("CONFLICT", "The student is already in this section.");
      const school = await schoolInfo(tx, schoolId);
      const effectiveOn = requested ?? school.today;
      if (effectiveOn <= cur.startsOn) {
        throw new AppError("VALIDATION", `The move date must be after the current enrollment started (${cur.startsOn}). To fix a mistaken enrollment, end it as a correction and enroll again.`, { effectiveOn: "Not after the current start." });
      }
      if (effectiveOn > sec.endsOn) throw new AppError("VALIDATION", "The move date must be within the academic year.", { effectiveOn: "After the year ends." });
      await tx.update(enrollments).set({ endsOn: addDays(effectiveOn, -1), endReason: "section_changed" }).where(eq(enrollments.id, cur.id));
      const [e] = await tx
        .insert(enrollments)
        .values({ schoolId, studentId: cur.studentId, academicYearId: sec.yearId, sectionId: sec.sectionId, rollNo, startsOn: effectiveOn })
        .returning({ id: enrollments.id });
      await audit(tx, { action: "enrollment.section_changed", actorUserId: actor.userId, schoolId, entityType: "enrollment", entityId: e!.id, data: { from: cur.sectionId, to: sec.sectionId, effectiveOn } });
      return { id: e!.id, startsOn: effectiveOn };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

/** Ends a mistaken enrollment as a correction (kept in the history, marked "corrected"). */
export async function correctEnrollment(db: Db, ctx: RequestContext, schoolId: string, enrollmentId: string): Promise<void> {
  parse(uuidField("Enrollment"), enrollmentId);
  await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
    const cur = await openEnrollment(tx, schoolId, enrollmentId);
    await tx.update(enrollments).set({ endsOn: cur.startsOn, endReason: "corrected", rollNo: null }).where(eq(enrollments.id, cur.id));
    await audit(tx, { action: "enrollment.corrected", actorUserId: actor.userId, schoolId, entityType: "enrollment", entityId: cur.id, data: { studentId: cur.studentId, sectionId: cur.sectionId } });
  });
}

export async function setRollNo(db: Db, ctx: RequestContext, schoolId: string, enrollmentId: string, value: string | number | null): Promise<void> {
  parse(uuidField("Enrollment"), enrollmentId);
  const rollNo = parse(roll, value) ?? null;
  try {
    await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const cur = await openEnrollment(tx, schoolId, enrollmentId);
      await tx.update(enrollments).set({ rollNo }).where(eq(enrollments.id, cur.id));
      await audit(tx, { action: "enrollment.roll_set", actorUserId: actor.userId, schoolId, entityType: "enrollment", entityId: cur.id, data: { rollNo } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}

/** Numbers a section's current students 1..n in alphabetical order of name. */
export async function numberRollsAlphabetically(db: Db, ctx: RequestContext, schoolId: string, sectionId: string): Promise<{ numbered: number }> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
    await openSection(tx, schoolId, sectionId);
    // Clear first so the new numbers never collide with old ones mid-update.
    await tx.update(enrollments).set({ rollNo: null }).where(and(eq(enrollments.schoolId, schoolId), eq(enrollments.sectionId, sectionId), isNull(enrollments.endsOn)));
    const rows = (await tx.execute(sql`
      with ordered as (
        select e.id, row_number() over (order by lower(p.display_name), p.admission_no) as n
        from enrollments e join student_profiles p on p.id = e.student_id
        where e.school_id = ${schoolId}::uuid and e.section_id = ${sectionId}::uuid and e.ends_on is null
      )
      update enrollments e set roll_no = o.n from ordered o where e.id = o.id returning e.id`)) as unknown as { id: string }[];
    await audit(tx, { action: "enrollment.rolls_numbered", actorUserId: actor.userId, schoolId, entityType: "section", entityId: sectionId, data: { numbered: rows.length } });
    return { numbered: rows.length };
  });
}

/* ------------------------------------------------------------------ section roster (admin) */

export interface RosterRow {
  enrollmentId: string;
  studentId: string;
  displayName: string;
  admissionNo: string;
  rollNo: number | null;
  startsOn: string;
}

export async function rosterQuery(tx: Tx, schoolId: string, sectionId: string): Promise<RosterRow[]> {
  return (await tx.execute(sql`
    select e.id as "enrollmentId", p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo", e.roll_no as "rollNo", e.starts_on::text as "startsOn"
    from enrollments e join student_profiles p on p.id = e.student_id
    where e.school_id = ${schoolId}::uuid and e.section_id = ${sectionId}::uuid and e.ends_on is null
    order by e.roll_no nulls last, lower(p.display_name), p.id`)) as unknown as RosterRow[];
}

export async function getSectionRoster(db: Db, ctx: RequestContext, schoolId: string, sectionId: string): Promise<RosterRow[]> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.students.view", (tx) => rosterQuery(tx, schoolId, sectionId));
}

/* ------------------------------------------------------------------ promotion */

export interface PromotionPreviewRow {
  studentId: string;
  displayName: string;
  admissionNo: string;
  rollNo: number | null;
  /** "ready" or why the student will be skipped. */
  state: "ready" | "already_enrolled";
  targetLabel: string | null;
}

export interface PromotionPreview {
  fromLabel: string;
  fromYearName: string;
  toLabel: string | null;
  toYearName: string | null;
  rows: PromotionPreviewRow[];
}

async function promotionSections(tx: Tx, schoolId: string, fromSectionId: string, toSectionId: string | null) {
  const rows = (await tx.execute(sql`
    select s.id, s.academic_year_id as "yearId", y.name as "yearName", y.status::text as status, y.starts_on::text as "startsOn", y.ends_on::text as "endsOn",
           c.name || ' ' || s.name as label, c.sort_order as "sortOrder", (s.archived_at is not null) as archived
    from sections s join academic_years y on y.id = s.academic_year_id join classes c on c.id = s.class_id
    where s.school_id = ${schoolId}::uuid and s.id in (${fromSectionId}::uuid, ${toSectionId ?? fromSectionId}::uuid)`)) as unknown as {
    id: string; yearId: string; yearName: string; status: string; startsOn: string; endsOn: string; label: string; sortOrder: number; archived: boolean;
  }[];
  const from = rows.find((r) => r.id === fromSectionId);
  if (!from) throw new AppError("NOT_FOUND", "Section not found.");
  const to = toSectionId ? rows.find((r) => r.id === toSectionId) : null;
  if (toSectionId && !to) throw new AppError("NOT_FOUND", "Target section not found.");
  if (to) {
    if (to.yearId === from.yearId) throw new AppError("VALIDATION", "Choose a section in a later academic year.", { toSectionId: "Same academic year." });
    if (to.startsOn <= from.startsOn) throw new AppError("VALIDATION", "The target year must start after the current one.", { toSectionId: "Not a later year." });
    if (to.status === "closed") throw new AppError("CONFLICT", "The target academic year is closed.");
    if (to.archived) throw new AppError("CONFLICT", "The target section is archived.");
  }
  return { from, to: to ?? null };
}

async function promotionRows(tx: Tx, schoolId: string, fromSectionId: string, toYearId: string | null): Promise<(PromotionPreviewRow & { enrollmentId: string })[]> {
  return (await tx.execute(sql`
    select e.id as "enrollmentId", p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo", e.roll_no as "rollNo",
           case when t.id is null then 'ready' else 'already_enrolled' end as state,
           case when t.id is null then null else tc.name || ' ' || ts.name end as "targetLabel"
    from enrollments e
    join academic_years y on y.id = e.academic_year_id
    join student_profiles p on p.id = e.student_id
    left join enrollments t on t.school_id = e.school_id and t.student_id = e.student_id and t.academic_year_id = ${toYearId}::uuid and t.ends_on is null
    left join sections ts on ts.id = t.section_id left join classes tc on tc.id = ts.class_id
    where e.school_id = ${schoolId}::uuid and e.section_id = ${fromSectionId}::uuid and p.status = 'active'
      and (e.ends_on is null or (e.ends_on = y.ends_on and e.end_reason = 'promoted'))
    order by e.roll_no nulls last, lower(p.display_name)`)) as unknown as (PromotionPreviewRow & { enrollmentId: string })[];
}

/**
 * Who would move from a section to a section of a later year (or graduate when `toSectionId` is
 * null). Students already enrolled in the target year are listed and will be skipped.
 */
export async function previewPromotion(db: Db, ctx: RequestContext, schoolId: string, input: { fromSectionId: string; toSectionId: string | null }): Promise<PromotionPreview> {
  parse(uuidField("Section"), input.fromSectionId);
  if (input.toSectionId) parse(uuidField("Target section"), input.toSectionId);
  return withCapability(db, ctx, schoolId, "school.students.manage", async (tx) => {
    const { from, to } = await promotionSections(tx, schoolId, input.fromSectionId, input.toSectionId);
    const rows = await promotionRows(tx, schoolId, from.id, to?.yearId ?? null);
    return {
      fromLabel: from.label,
      fromYearName: from.yearName,
      toLabel: to?.label ?? null,
      toYearName: to?.yearName ?? null,
      rows: rows.map(({ enrollmentId: _e, ...r }) => (to ? r : { ...r, state: "ready" as const, targetLabel: null })),
    };
  });
}

/**
 * Promotes (or graduates) the chosen students of a section. Students not chosen stay where they
 * are (for example to repeat the year: enroll them in the same class of the new year later).
 */
export async function commitPromotion(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { fromSectionId: string; toSectionId: string | null; studentIds: string[]; keepRollNumbers?: boolean },
): Promise<{ promoted: number; graduated: number; skipped: number }> {
  parse(uuidField("Section"), input.fromSectionId);
  if (input.toSectionId) parse(uuidField("Target section"), input.toSectionId);
  const chosen = new Set(parse(z.array(z.uuid({ message: "Student not found." })).min(1, "Choose at least one student.").max(500), input.studentIds));
  try {
    return await withCapability(db, ctx, schoolId, "school.students.manage", async (tx, actor) => {
      const { from, to } = await promotionSections(tx, schoolId, input.fromSectionId, input.toSectionId);
      const school = await schoolInfo(tx, schoolId);
      const rows = (await promotionRows(tx, schoolId, from.id, to?.yearId ?? null)).filter((r) => chosen.has(r.studentId));
      let promoted = 0;
      let graduated = 0;
      let skipped = 0;
      for (const r of rows) {
        if (to && r.state === "already_enrolled") {
          skipped++;
          continue;
        }
        // End the old enrollment on the last day of its year while that year is open (a graduate's
        // enrollment is ended by leaving instead).
        if (to && from.status !== "closed") {
          await tx.execute(sql`
            update enrollments set ends_on = greatest(starts_on, ${from.endsOn}::date), end_reason = 'promoted'
            where id = ${r.enrollmentId}::uuid and ends_on is null`);
        }
        if (to) {
          await tx.insert(enrollments).values({
            schoolId,
            studentId: r.studentId,
            academicYearId: to.yearId,
            sectionId: to.id,
            rollNo: input.keepRollNumbers ? r.rollNo : null,
            startsOn: to.startsOn,
          });
          promoted++;
        } else {
          // Leaving date: the year's last day, or today if the year has not ended yet.
          await leaveInTransaction(tx, actor.userId, schoolId, r.studentId, "graduated", school.today < from.endsOn ? school.today : from.endsOn);
          graduated++;
        }
      }
      skipped += chosen.size - rows.length;
      await audit(tx, {
        action: to ? "enrollment.promoted" : "enrollment.graduated",
        actorUserId: actor.userId,
        schoolId,
        entityType: "section",
        entityId: from.id,
        data: { toSectionId: to?.id ?? null, promoted, graduated, skipped },
      });
      return { promoted, graduated, skipped };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: studentDuplicate });
  }
}
