import { sql } from "drizzle-orm";
import type { Db, RequestContext, Tx } from "@examio/db";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { parse, uuidField } from "../setup/common";
import { defaultScheme, gradeOf, passesExact, percentBp, schemeById, type SchemeInfo } from "./common";
import { reviewItem, type ReviewItem } from "./grading";

/**
 * Released results and report cards (Phase 12). Practice never appears here.
 *
 * Provisional rules until the school agrees a report-card format (TASKS.md):
 * - every released online exam and offline assessment of the year counts with equal weight, by
 *   its marks: a subject's total is the sum of scores over the sum of maximums;
 * - absent counts as zero out of the maximum; exempt is left out of the total;
 * - percentages are rounded half-up to two decimals for display; grades and pass/fail compare
 *   the exact fraction with the school's current default grading scheme;
 * - no ranking.
 */

export interface ResultItem {
  kind: "exam" | "offline";
  id: string;
  title: string;
  subjectId: string;
  subjectName: string;
  date: string | null;
  status: "present" | "absent" | "exempt";
  scoreX100: number | null;
  maxX100: number;
  percentBp: number | null;
  grade: string | null;
  corrected: boolean;
}

export interface SubjectTotal {
  subjectId: string;
  subjectName: string;
  scoreX100: number;
  maxX100: number;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  items: ResultItem[];
}

export interface ReportCard {
  student: { id: string; name: string; admissionNo: string; className: string | null };
  year: { id: string; name: string };
  years: { id: string; name: string }[];
  scheme: Pick<SchemeInfo, "name" | "passBp"> | null;
  subjects: SubjectTotal[];
  overall: { scoreX100: number; maxX100: number; percentBp: number | null; grade: string | null; passed: boolean | null };
}

async function items(tx: Tx, schoolId: string, studentId: string, yearId: string): Promise<ResultItem[]> {
  const schemes = new Map<string, SchemeInfo>();
  const scheme = async (id: string | null) => {
    if (!id) return null;
    if (!schemes.has(id)) schemes.set(id, await schemeById(tx, id));
    return schemes.get(id)!;
  };
  // Row visibility is the database's: released results of the student's own (or linked child's) record, or staff of the subject.
  const rows = (await tx.execute(sql`
    select 'exam' as kind, e.id, e.title, e.subject_id as "subjectId", s.name as "subjectName", (e.closes_at at time zone sc.timezone)::date::text as date,
           case when r.attempt_id is null then 'absent' else 'present' end as status, r.score_x100 as "scoreX100", r.max_x100 as "maxX100",
           rs.grading_scheme_id as "schemeId", r.revision > 1 as corrected
    from exam_results r join exams e on e.id = r.exam_id join subjects s on s.id = e.subject_id join schools sc on sc.id = e.school_id
    join exam_result_sets rs on rs.exam_id = e.id and rs.status = 'released'
    where r.school_id = ${schoolId}::uuid and r.student_id = ${studentId}::uuid and e.academic_year_id = ${yearId}::uuid
    union all
    select 'offline', o.id, o.title, o.subject_id, s.name, o.held_on::text, m.status::text, m.marks_x100, o.max_marks_x100, o.grading_scheme_id,
           exists (select 1 from result_changes c where c.assessment_id = o.id and c.student_id = m.student_id)
    from offline_marks m join offline_assessments o on o.id = m.assessment_id join subjects s on s.id = o.subject_id
    where m.school_id = ${schoolId}::uuid and m.student_id = ${studentId}::uuid and o.academic_year_id = ${yearId}::uuid and o.status = 'released'
    order by 5, 6 nulls last, 3`)) as unknown as (Omit<ResultItem, "percentBp" | "grade"> & { schemeId: string | null })[];
  const out: ResultItem[] = [];
  for (const { schemeId, ...r } of rows) {
    const sch = await scheme(schemeId);
    const counted = r.status === "present" && r.scoreX100 !== null;
    out.push({ ...r, percentBp: counted ? percentBp(r.scoreX100!, r.maxX100) : null, grade: counted && sch ? gradeOf(r.scoreX100!, r.maxX100, sch.bands) : null });
  }
  return out;
}

function totals(list: ResultItem[], scheme: SchemeInfo | null) {
  const counted = list.filter((i) => i.status !== "exempt");
  const scoreX100 = counted.reduce((a, i) => a + (i.status === "present" ? (i.scoreX100 ?? 0) : 0), 0);
  const maxX100 = counted.reduce((a, i) => a + i.maxX100, 0);
  return {
    scoreX100,
    maxX100,
    percentBp: maxX100 > 0 ? percentBp(scoreX100, maxX100) : null,
    grade: maxX100 > 0 && scheme ? gradeOf(scoreX100, maxX100, scheme.bands) : null,
    passed: maxX100 > 0 && scheme ? passesExact(scoreX100, maxX100, scheme.passBp) : null,
  };
}

async function reportCard(tx: Tx, schoolId: string, studentId: string, yearId: string | null): Promise<ReportCard> {
  const [p] = (await tx.execute(sql`
    select p.id, p.display_name as name, p.admission_no as "admissionNo",
           (select c.name || ' ' || sec.name from enrollments e join sections sec on sec.id = e.section_id join classes c on c.id = sec.class_id
            where e.student_id = p.id order by e.ends_on is null desc, e.starts_on desc limit 1) as "className"
    from student_profiles p where p.school_id = ${schoolId}::uuid and p.id = ${studentId}::uuid`)) as unknown as ReportCard["student"][];
  if (!p) throw new AppError("NOT_FOUND", "Student not found.");
  const years = (await tx.execute(sql`
    select distinct y.id, y.name, y.starts_on from enrollments e join academic_years y on y.id = e.academic_year_id
    where e.school_id = ${schoolId}::uuid and e.student_id = ${studentId}::uuid order by y.starts_on desc`)) as unknown as { id: string; name: string }[];
  const year = (yearId ? years.find((y) => y.id === yearId) : undefined) ?? years[0];
  const scheme = await defaultScheme(tx, schoolId);
  if (!year) return { student: p, year: { id: "", name: "" }, years: [], scheme: scheme && { name: scheme.name, passBp: scheme.passBp }, subjects: [], overall: totals([], scheme) };
  const list = await items(tx, schoolId, studentId, year.id);
  const bySubject = new Map<string, ResultItem[]>();
  for (const i of list) bySubject.set(i.subjectId, [...(bySubject.get(i.subjectId) ?? []), i]);
  const subjects = [...bySubject.values()].map((its) => ({ subjectId: its[0]!.subjectId, subjectName: its[0]!.subjectName, ...totals(its, scheme), items: its }));
  return {
    student: p,
    year: { id: year.id, name: year.name },
    years: years.map((y) => ({ id: y.id, name: y.name })),
    scheme: scheme && { name: scheme.name, passBp: scheme.passBp },
    subjects: subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
    overall: totals(list, scheme),
  };
}

async function myStudentId(tx: Tx, schoolId: string): Promise<string> {
  const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
  if (!me) throw new AppError("NOT_FOUND", "Your school has not added your student details yet.");
  return me.id;
}

async function childId(tx: Tx, schoolId: string, studentId: string): Promise<string> {
  parse(uuidField("Student"), studentId);
  const [c] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid and app_is_guardian_of(id)`)) as unknown as { id: string }[];
  if (!c) throw new AppError("NOT_FOUND", "Student not found.");
  return c.id;
}

const yearParam = (y?: string | null) => (y && /^[0-9a-f-]{36}$/i.test(y) ? y : null);

export async function getMyReportCard(db: Db, ctx: RequestContext, schoolId: string, yearId?: string | null): Promise<ReportCard> {
  return withCapability(db, ctx, schoolId, "school.results.view", async (tx) => reportCard(tx, schoolId, await myStudentId(tx, schoolId), yearParam(yearId)));
}

export async function getChildReportCard(db: Db, ctx: RequestContext, schoolId: string, studentId: string, yearId?: string | null): Promise<ReportCard> {
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => reportCard(tx, schoolId, await childId(tx, schoolId, studentId), yearParam(yearId)));
}

/** Administrators: any student's report card (every year they were enrolled). */
export async function getStudentReportCard(db: Db, ctx: RequestContext, schoolId: string, studentId: string, yearId?: string | null): Promise<ReportCard> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.students.view", async (tx) => reportCard(tx, schoolId, studentId, yearParam(yearId)));
}

export interface MyExamResult {
  examId: string;
  title: string;
  subjectName: string;
  status: "present" | "absent";
  scoreX100: number | null;
  maxX100: number;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  revision: number;
  items: ReviewItem[];
}

/** A student's released exam result with each question, their answer, marks, comment and the answer key. */
export async function getMyExamResult(db: Db, ctx: RequestContext, schoolId: string, examId: string): Promise<MyExamResult> {
  parse(uuidField("Exam"), examId);
  return withCapability(db, ctx, schoolId, "school.results.view", async (tx) => {
    const me = await myStudentId(tx, schoolId);
    const [r] = (await tx.execute(sql`
      select e.id as "examId", e.title, s.name as "subjectName", r.attempt_id as "attemptId", r.score_x100 as "scoreX100", r.max_x100 as "maxX100", r.revision, rs.grading_scheme_id as "schemeId"
      from exam_results r join exams e on e.id = r.exam_id join subjects s on s.id = e.subject_id join exam_result_sets rs on rs.exam_id = e.id and rs.status = 'released'
      where r.school_id = ${schoolId}::uuid and r.exam_id = ${examId}::uuid and r.student_id = ${me}::uuid`)) as unknown as { examId: string; title: string; subjectName: string; attemptId: string | null; scoreX100: number | null; maxX100: number; revision: number; schemeId: string }[];
    if (!r) throw new AppError("NOT_FOUND", "Result not found or not released yet.");
    const scheme = await schemeById(tx, r.schemeId);
    const present = r.attemptId !== null && r.scoreX100 !== null;
    const review = present ? ((await tx.execute(sql`select * from exam_result_review(${examId}::uuid, ${me}::uuid)`)) as unknown as Parameters<typeof reviewItem>[0][]) : [];
    return {
      examId: r.examId,
      title: r.title,
      subjectName: r.subjectName,
      status: present ? "present" : "absent",
      scoreX100: r.scoreX100,
      maxX100: r.maxX100,
      percentBp: present ? percentBp(r.scoreX100!, r.maxX100) : null,
      grade: present ? gradeOf(r.scoreX100!, r.maxX100, scheme.bands) : null,
      passed: present ? passesExact(r.scoreX100!, r.maxX100, scheme.passBp) : null,
      revision: r.revision,
      items: review.map(reviewItem),
    };
  });
}

export interface SectionOverview {
  sectionLabel: string;
  subjects: { subjectId: string; subjectName: string; averageBp: number | null }[];
  students: { studentId: string; name: string; rollNo: number | null; bySubject: Record<string, number | null>; overallBp: number | null }[];
}

/**
 * A section's released results for a year: each current student's percentage per subject and
 * overall, and each subject's average. Teachers see only the subjects whose results they may read.
 */
export async function getSectionResultsOverview(db: Db, ctx: RequestContext, schoolId: string, sectionId: string): Promise<SectionOverview> {
  parse(uuidField("Section"), sectionId);
  return withCapability(db, ctx, schoolId, "school.results.grade", async (tx) => {
    const [sec] = (await tx.execute(sql`
      select c.name || ' ' || s.name as label, s.academic_year_id as "yearId" from sections s join classes c on c.id = s.class_id
      where s.school_id = ${schoolId}::uuid and s.id = ${sectionId}::uuid and (app_can_manage_setup(s.school_id) or app_teaches_section(s.id, app_school_today(s.school_id)))`)) as unknown as { label: string; yearId: string }[];
    if (!sec) throw new AppError("NOT_FOUND", "Section not found.");
    const students = (await tx.execute(sql`
      select p.id as "studentId", p.display_name as name, e.roll_no as "rollNo" from enrollments e join student_profiles p on p.id = e.student_id
      where e.section_id = ${sectionId}::uuid and e.ends_on is null order by e.roll_no nulls last, lower(p.display_name)`)) as unknown as { studentId: string; name: string; rollNo: number | null }[];
    const scheme = await defaultScheme(tx, schoolId);
    const subjectNames = new Map<string, string>();
    const out: SectionOverview["students"] = [];
    const sums = new Map<string, { s: number; m: number }>();
    for (const st of students) {
      const list = await items(tx, schoolId, st.studentId, sec.yearId);
      const bySubject: Record<string, number | null> = {};
      const grouped = new Map<string, ResultItem[]>();
      for (const i of list) {
        subjectNames.set(i.subjectId, i.subjectName);
        grouped.set(i.subjectId, [...(grouped.get(i.subjectId) ?? []), i]);
      }
      for (const [sid, its] of grouped) {
        const t = totals(its, scheme);
        bySubject[sid] = t.percentBp;
        const acc = sums.get(sid) ?? { s: 0, m: 0 };
        sums.set(sid, { s: acc.s + t.scoreX100, m: acc.m + t.maxX100 });
      }
      out.push({ ...st, bySubject, overallBp: totals(list, scheme).percentBp });
    }
    const subjects = [...subjectNames.entries()]
      .map(([subjectId, subjectName]) => {
        const acc = sums.get(subjectId);
        return { subjectId, subjectName, averageBp: acc && acc.m > 0 ? percentBp(acc.s, acc.m) : null };
      })
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
    return { sectionLabel: sec.label, subjects, students: out };
  });
}
