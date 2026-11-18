import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { offlineAssessmentTargets, offlineAssessments, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { parseCsv, toCsv } from "../../csv";
import { AppError } from "../../errors";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";
import { gradeOf, parseMarksX100, percentBp, resultsError, schemeById, type SchemeInfo } from "./common";
import { notifyFamilies } from "./grading";

/**
 * Offline (paper) assessments (Phase 12).
 *
 * - An administrator defines one for the current academic year: subject, title, date, maximum
 *   marks and the sections it covers (sections whose class studies the subject).
 * - The subject's teacher of a section, or an administrator, records for every current student
 *   either marks (0 to the maximum, two decimals) or absent or exempt. Absent and exempt are not
 *   zero. One entry per student: saving again replaces it. Bulk import: admission number and
 *   marks/AB/EX per line, all rows or none.
 * - Draft → submitted (teachers hand it in; it can go back) → locked by an administrator, which
 *   needs a complete register → released, when students and parents see the marks and are
 *   notified. After locking, an administrator changes an entry only with a reason; the earlier
 *   value is kept (result_changes).
 */

export type OfflineStatus = "draft" | "submitted" | "locked" | "released";
export type EntryValue = { status: "present"; marksX100: number } | { status: "absent" | "exempt" };

/** "17.5" → marks; "AB"/"absent" → absent; "EX"/"exempt" → exempt; empty → null (no entry). */
export function parseEntry(text: string, maxX100: number): EntryValue | null | "invalid" {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  if (t === "ab" || t === "absent") return { status: "absent" };
  if (t === "ex" || t === "exempt") return { status: "exempt" };
  const m = parseMarksX100(t, maxX100);
  return m === null ? "invalid" : { status: "present", marksX100: m };
}

const createSchema = z.object({
  subjectId: z.uuid({ message: "Choose a subject." }),
  title: trimmed("Title", 1, 150),
  heldOn: z.union([z.literal("").transform(() => null), isoDate("date")]).nullable().optional(),
  maxMarks: z.string(),
  sectionIds: z.array(z.uuid({ message: "Section not found." })).min(1, "Choose at least one section.").max(60),
});

function maxFrom(text: string): number {
  const v = parseMarksX100(text, 100_000);
  if (v === null || v < 1) throw new AppError("VALIDATION", "Maximum marks: a number from 0.01 to 1000, for example 50.", { maxMarks: "Not valid." });
  return v;
}

async function checkSections(tx: Tx, schoolId: string, yearId: string, subjectId: string, sectionIds: string[]): Promise<void> {
  const ok = (await tx.execute(sql`
    select s.id from sections s join class_subjects cs on cs.school_id = s.school_id and cs.academic_year_id = s.academic_year_id and cs.class_id = s.class_id and cs.subject_id = ${subjectId}::uuid
    where s.school_id = ${schoolId}::uuid and s.academic_year_id = ${yearId}::uuid and s.archived_at is null
      and s.id in (${sql.join(sectionIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as { id: string }[];
  if (ok.length !== new Set(sectionIds).size) throw new AppError("VALIDATION", "Choose sections of the current year whose class studies this subject.", { sectionIds: "Not valid." });
}

export async function createOfflineAssessment(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof createSchema>): Promise<{ id: string }> {
  const v = parse(createSchema, input);
  const maxX100 = maxFrom(v.maxMarks);
  return withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    const [y] = (await tx.execute(sql`select id from academic_years where school_id = ${schoolId}::uuid and status = 'current'`)) as unknown as { id: string }[];
    if (!y) throw new AppError("CONFLICT", "Set a current academic year first.");
    await checkSections(tx, schoolId, y.id, v.subjectId, v.sectionIds);
    const [o] = await tx
      .insert(offlineAssessments)
      .values({ schoolId, academicYearId: y.id, subjectId: v.subjectId, title: v.title, heldOn: v.heldOn ?? null, maxMarksX100: maxX100, createdBy: actor.userId })
      .returning({ id: offlineAssessments.id });
    for (const sectionId of new Set(v.sectionIds)) await tx.insert(offlineAssessmentTargets).values({ schoolId, assessmentId: o!.id, sectionId });
    await audit(tx, { action: "offline.created", actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: o!.id, data: { title: v.title, maxX100, sections: v.sectionIds.length } });
    return { id: o!.id };
  });
}

/** Changes title, date, maximum and sections while a draft; a maximum below an entered mark is refused. */
export async function updateOfflineAssessment(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string, input: { title: string; heldOn?: string | null; maxMarks: string; sectionIds: string[] }): Promise<void> {
  parse(uuidField("Assessment"), assessmentId);
  const v = parse(createSchema.omit({ subjectId: true }), input);
  const maxX100 = maxFrom(v.maxMarks);
  await withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    const [o] = await tx.select().from(offlineAssessments).where(and(eq(offlineAssessments.schoolId, schoolId), eq(offlineAssessments.id, assessmentId))).for("update");
    if (!o) throw new AppError("NOT_FOUND", "Assessment not found.");
    if (o.status !== "draft") throw new AppError("CONFLICT", "Only a draft can be changed.");
    const [hi] = (await tx.execute(sql`select coalesce(max(marks_x100), 0)::int as m from offline_marks where assessment_id = ${assessmentId}::uuid`)) as unknown as { m: number }[];
    if ((hi?.m ?? 0) > maxX100) throw new AppError("VALIDATION", "Some entered marks are higher than the new maximum.", { maxMarks: "Below entered marks." });
    await checkSections(tx, schoolId, o.academicYearId, o.subjectId, v.sectionIds);
    const [withMarks] = (await tx.execute(sql`
      select count(*)::int as n from offline_marks m where m.assessment_id = ${assessmentId}::uuid
        and m.section_id not in (${sql.join(v.sectionIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as { n: number }[];
    if (withMarks?.n) throw new AppError("CONFLICT", "A section you removed already has marks entered.");
    await tx.update(offlineAssessments).set({ title: v.title, heldOn: v.heldOn ?? null, maxMarksX100: maxX100, updatedAt: sql`now()` }).where(eq(offlineAssessments.id, assessmentId));
    await tx.delete(offlineAssessmentTargets).where(eq(offlineAssessmentTargets.assessmentId, assessmentId));
    for (const sectionId of new Set(v.sectionIds)) await tx.insert(offlineAssessmentTargets).values({ schoolId, assessmentId, sectionId });
    await audit(tx, { action: "offline.updated", actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: assessmentId });
  });
}

export interface OfflineRow {
  id: string;
  title: string;
  subjectName: string;
  heldOn: string | null;
  maxX100: number;
  status: OfflineStatus;
  entered: number;
  students: number;
}

export async function listOfflineAssessments(db: Db, ctx: RequestContext, schoolId: string): Promise<OfflineRow[]> {
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) =>
    (await tx.execute(sql`
      select o.id, o.title, s.name as "subjectName", o.held_on::text as "heldOn", o.max_marks_x100 as "maxX100", o.status::text as status,
             (select count(*)::int from offline_marks m where m.assessment_id = o.id) as entered,
             (select count(*)::int from enrollments en join offline_assessment_targets t on t.section_id = en.section_id where t.assessment_id = o.id and en.ends_on is null) as students
      from offline_assessments o join subjects s on s.id = o.subject_id
      where o.school_id = ${schoolId}::uuid
      order by (o.status in ('draft', 'submitted')) desc, coalesce(o.held_on, o.created_at::date) desc, o.title limit 200`)) as unknown as OfflineRow[],
  );
}

export interface OfflineEntryRow {
  studentId: string;
  name: string;
  admissionNo: string;
  rollNo: number | null;
  status: "present" | "absent" | "exempt" | null;
  marksX100: number | null;
  revision: number | null;
  percentBp: number | null;
  grade: string | null;
}

export interface OfflineDetail extends Omit<OfflineRow, "entered" | "students"> {
  subjectId: string;
  canPublish: boolean;
  canSubmit: boolean;
  scheme: SchemeInfo | null;
  sections: { sectionId: string; label: string; canEnter: boolean; rows: OfflineEntryRow[] }[];
  changes: { at: Date; student: string; detail: string; reason: string; by: string }[];
}

const show = (status: string | null, marks: number | null) => (status === "present" ? String((marks ?? 0) / 100) : status === "absent" ? "AB" : status === "exempt" ? "EX" : "—");

export async function getOfflineAssessment(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string): Promise<OfflineDetail> {
  parse(uuidField("Assessment"), assessmentId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const [o] = (await tx.execute(sql`
      select o.id, o.title, o.subject_id as "subjectId", s.name as "subjectName", o.held_on::text as "heldOn", o.max_marks_x100 as "maxX100", o.status::text as status,
             o.grading_scheme_id as "schemeId", app_can_manage_setup(o.school_id) as "canPublish"
      from offline_assessments o join subjects s on s.id = o.subject_id where o.school_id = ${schoolId}::uuid and o.id = ${assessmentId}::uuid`)) as unknown as (Omit<OfflineDetail, "sections" | "scheme" | "changes" | "canSubmit"> & { schemeId: string | null })[];
    if (!o) throw new AppError("NOT_FOUND", "Assessment not found.");
    const scheme = o.schemeId ? await schemeById(tx, o.schemeId) : null;
    const secs = (await tx.execute(sql`
      select t.section_id as "sectionId", c.name || ' ' || sec.name as label,
             app_can_manage_setup(${schoolId}::uuid) or app_teaches_subject_section(${o.subjectId}::uuid, t.section_id) as "canEnter"
      from offline_assessment_targets t join sections sec on sec.id = t.section_id join classes c on c.id = sec.class_id
      where t.assessment_id = ${assessmentId}::uuid order by c.sort_order, c.name, sec.name`)) as unknown as { sectionId: string; label: string; canEnter: boolean }[];
    const sections: OfflineDetail["sections"] = [];
    for (const sct of secs) {
      const rows = (await tx.execute(sql`
        select p.id as "studentId", p.display_name as name, p.admission_no as "admissionNo", en.roll_no as "rollNo", m.status::text as status, m.marks_x100 as "marksX100", m.revision
        from enrollments en join student_profiles p on p.id = en.student_id
        left join offline_marks m on m.assessment_id = ${assessmentId}::uuid and m.student_id = p.id
        where en.section_id = ${sct.sectionId}::uuid and en.ends_on is null
        order by en.roll_no nulls last, lower(p.display_name)`)) as unknown as Omit<OfflineEntryRow, "percentBp" | "grade">[];
      sections.push({
        ...sct,
        // Teachers see only the sections they teach this subject in (the database hides the others' marks).
        rows: rows.map((r) => ({
          ...r,
          percentBp: r.status === "present" && r.marksX100 !== null ? percentBp(r.marksX100, o.maxX100) : null,
          grade: r.status === "present" && r.marksX100 !== null && scheme ? gradeOf(r.marksX100, o.maxX100, scheme.bands) : null,
        })),
      });
    }
    const changes = ((await tx.execute(sql`
      select c.changed_at as at, p.display_name as student, c.old_value as "oldValue", c.new_value as "newValue", c.reason, u.full_name as by
      from result_changes c join student_profiles p on p.id = c.student_id join users u on u.id = c.changed_by
      where c.assessment_id = ${assessmentId}::uuid order by c.changed_at desc limit 100`)) as unknown as { at: Date; student: string; oldValue: { status: string; marks: number | null }; newValue: { status: string; marks: number | null }; reason: string; by: string }[]).map((c) => ({
      at: new Date(c.at),
      student: c.student,
      detail: `${show(c.oldValue.status, c.oldValue.marks)} → ${show(c.newValue.status, c.newValue.marks)}`,
      reason: c.reason,
      by: c.by,
    }));
    const { schemeId: _s, ...rest } = o;
    return { ...rest, scheme, sections, changes, canSubmit: o.canPublish || sections.some((x) => x.canEnter) };
  });
}

/** Saves several entries at once (all or none). Each value is marks, "AB", "EX", or empty (skipped). */
export async function saveOfflineMarks(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string, entries: { studentId: string; value: string }[]): Promise<{ saved: number }> {
  parse(uuidField("Assessment"), assessmentId);
  const list = parse(z.array(z.object({ studentId: z.uuid({ message: "Student not found." }), value: z.string().max(20) })).max(500), entries);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    const [o] = (await tx.execute(sql`select max_marks_x100 as max from offline_assessments where school_id = ${schoolId}::uuid and id = ${assessmentId}::uuid`)) as unknown as { max: number }[];
    if (!o) throw new AppError("NOT_FOUND", "Assessment not found.");
    let saved = 0;
    for (const e of list) {
      const v = parseEntry(e.value, o.max);
      if (v === null) continue;
      if (v === "invalid") throw new AppError("VALIDATION", `"${e.value}" is not valid: enter marks from 0 to ${o.max / 100}, AB or EX.`);
      try {
        await tx.execute(sql`select offline_save_mark(${assessmentId}::uuid, ${e.studentId}::uuid, ${v.status}, ${v.status === "present" ? v.marksX100 : null}::integer)`);
      } catch (err) {
        resultsError(err);
      }
      saved++;
    }
    if (saved) await audit(tx, { action: "offline.marks_saved", actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: assessmentId, data: { saved } });
    return { saved };
  });
}

/** Bulk entry from CSV lines "admission number, marks|AB|EX" (a header row is allowed). All or none. */
export async function importOfflineMarks(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string, text: string): Promise<{ saved: number }> {
  parse(uuidField("Assessment"), assessmentId);
  if (text.length > 200_000) throw new AppError("VALIDATION", "The file is too large.");
  const rows = parseCsv(text).filter((r, i) => !(i === 0 && /admission/i.test(r[0] ?? "")));
  if (rows.length === 0) throw new AppError("VALIDATION", "The file has no rows.");
  if (rows.length > 500) throw new AppError("VALIDATION", "At most 500 rows at a time.");
  const lookup = await withCapability(db, ctx, schoolId, "school.results.grade", async (tx) =>
    (await tx.execute(sql`
      select lower(p.admission_no) as adm, p.id from enrollments en join offline_assessment_targets t on t.section_id = en.section_id and t.assessment_id = ${assessmentId}::uuid
      join student_profiles p on p.id = en.student_id where en.ends_on is null`)) as unknown as { adm: string; id: string }[],
  );
  const byAdm = new Map(lookup.map((r) => [r.adm, r.id]));
  const errors: string[] = [];
  const entries = rows.flatMap((r, i) => {
    const id = byAdm.get((r[0] ?? "").trim().toLowerCase());
    if (!id) {
      errors.push(`Row ${i + 1}: admission number "${(r[0] ?? "").trim()}" is not a student of this assessment's sections.`);
      return [];
    }
    if (!(r[1] ?? "").trim()) {
      errors.push(`Row ${i + 1}: enter marks, AB or EX.`);
      return [];
    }
    return [{ studentId: id, value: (r[1] ?? "").trim() }];
  });
  if (errors.length) throw new AppError("VALIDATION", errors.slice(0, 5).join(" ") + (errors.length > 5 ? ` (${errors.length - 5} more)` : ""));
  return saveOfflineMarks(db, ctx, schoolId, assessmentId, entries);
}

/** submit / back to draft (teachers of the subject and administrators), lock / release (administrators). */
export async function transitionOffline(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string, to: "submitted" | "draft" | "locked" | "released"): Promise<{ notified: number }> {
  parse(uuidField("Assessment"), assessmentId);
  const target = parse(z.enum(["submitted", "draft", "locked", "released"]), to);
  return withCapability(db, ctx, schoolId, target === "locked" || target === "released" ? "school.results.publish" : "school.results.grade", async (tx, actor) => {
    try {
      await tx.execute(sql`select offline_transition(${assessmentId}::uuid, ${target})`);
    } catch (e) {
      resultsError(e);
    }
    let notified = 0;
    if (target === "released") {
      const [o] = (await tx.execute(sql`select title from offline_assessments where id = ${assessmentId}::uuid`)) as unknown as { title: string }[];
      const ids = ((await tx.execute(sql`select student_id as id from offline_marks where assessment_id = ${assessmentId}::uuid`)) as unknown as { id: string }[]).map((r) => r.id);
      notified = await notifyFamilies(tx, schoolId, ids, "results.released", o!.title, `offline-released:${assessmentId}`);
    }
    await audit(tx, { action: `offline.${target}`, actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: assessmentId, data: { notified } });
    return { notified };
  });
}

/** Administrators, after locking: changes one entry with a reason; the earlier value is kept. */
export async function correctOfflineMark(db: Db, ctx: RequestContext, schoolId: string, input: { assessmentId: string; studentId: string; value: string; reason: string }): Promise<void> {
  parse(uuidField("Assessment"), input.assessmentId);
  parse(uuidField("Student"), input.studentId);
  const reason = parse(trimmed("Reason", 3, 300), input.reason);
  await withCapability(db, ctx, schoolId, "school.results.publish", async (tx, actor) => {
    const [o] = (await tx.execute(sql`select max_marks_x100 as max, title, status::text as status from offline_assessments where school_id = ${schoolId}::uuid and id = ${input.assessmentId}::uuid`)) as unknown as { max: number; title: string; status: string }[];
    if (!o) throw new AppError("NOT_FOUND", "Assessment not found.");
    const v = parseEntry(input.value, o.max);
    if (v === null || v === "invalid") throw new AppError("VALIDATION", `Enter marks from 0 to ${o.max / 100}, AB or EX.`, { value: "Not valid." });
    let rev: number;
    try {
      const [r] = (await tx.execute(sql`select offline_correct_mark(${input.assessmentId}::uuid, ${input.studentId}::uuid, ${v.status}, ${v.status === "present" ? v.marksX100 : null}::integer, ${reason}) as rev`)) as unknown as { rev: number }[];
      rev = r!.rev;
    } catch (e) {
      resultsError(e);
    }
    if (o.status === "released") await notifyFamilies(tx, schoolId, [input.studentId], "results.corrected", o.title, `offline-corrected:${input.assessmentId}:${rev}`);
    await audit(tx, { action: "offline.corrected", actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: input.assessmentId, data: { studentId: input.studentId, value: input.value, reason } });
  });
}

export async function exportOfflineCsv(db: Db, ctx: RequestContext, schoolId: string, assessmentId: string): Promise<string> {
  const d = await getOfflineAssessment(db, ctx, schoolId, assessmentId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx, actor) => {
    const rows = d.sections.flatMap((s) => s.rows.map((r) => [s.label, r.admissionNo, r.name, show(r.status, r.marksX100), (d.maxX100 / 100).toString(), r.percentBp === null ? "" : (r.percentBp / 100).toFixed(2), r.grade ?? ""]));
    await audit(tx, { action: "offline.exported", actorUserId: actor.userId, schoolId, entityType: "offline_assessment", entityId: assessmentId, data: { rows: rows.length } });
    return toCsv([["section", "admission_no", "name", "marks", "max", "percent", "grade"], ...rows]);
  });
}

