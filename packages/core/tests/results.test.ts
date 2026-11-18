import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { examMarks, examResults, notifications, offlineMarks, resultChanges, withContext, type RequestContext } from "@examio/db";
import { instantToZonedLocal } from "../src/dates";
import { AppError } from "../src/errors";
import { addExamItems, createExam, publishExam, setExamAccommodation, setExamTargets } from "../src/services/exams/exams";
import { getMyExamAttempt, saveExamAnswer, startExam, submitExam } from "../src/services/exams/taking";
import { createQuestion, publishQuestion } from "../src/services/questions/questions";
import { gradeOf, passesExact, percentBp } from "../src/services/results/common";
import {
  correctExamMark,
  designateAttempt,
  getExamGrading,
  getStudentExamMarks,
  listAnswersToMark,
  releaseExamResults,
  setWrittenMark,
  startGrading,
} from "../src/services/results/grading";
import { correctOfflineMark, createOfflineAssessment, getOfflineAssessment, importOfflineMarks, saveOfflineMarks, transitionOffline } from "../src/services/results/offline";
import { getChildReportCard, getMyExamResult, getMyReportCard, getSectionResultsOverview, getStudentReportCard } from "../src/services/results/reports";
import { CBSE_STYLE_PRESET, createGradingScheme } from "../src/services/setup/grading";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 12: grading, offline marks, results and report cards. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const MIN = 60_000;
const local = (ms: number) => instantToZonedLocal(new Date(Date.now() + ms), "Asia/Kolkata");

describe("grading and results", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let tA: RequestContext;
  let tB: RequestContext;
  let tSci: RequestContext;
  let s1: RequestContext;
  let s2: RequestContext;
  let s3: RequestContext;
  let parent: RequestContext;
  const id: Record<string, string> = {};
  let examId: string;
  let sectionA: string;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("rsa");
    B = await makeSchool("rsb");
    admin = A.ctx(A.adminId);
    await createGradingScheme(app.db, admin, A.id, CBSE_STYLE_PRESET);
    const y = Number(new Date().toISOString().slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c9 = (await createClass(app.db, admin, A.id, { name: "Class 9", sortOrder: 9 })).id;
    sectionA = (await createSection(app.db, admin, A.id, { yearId, classId: c9, name: "A" })).id;
    const sectionB = (await createSection(app.db, admin, A.id, { yearId, classId: c9, name: "B" })).id;
    id.sectionB = sectionB;
    const math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    const sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    id.math = math;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c9, subjectIds: [math, sci] });
    const mk = async (no: string, subjectId: string, sectionId: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@rs.test`, employeeNo: no, role: "teacher" });
      await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId, subjectId });
      return A.ctx(t.userId);
    };
    tA = await mk("T-MA", math, sectionA);
    tB = await mk("T-MB", math, sectionB);
    tSci = await mk("T-SA", sci, sectionA);
    const k1 = await admitStudent(app.db, admin, A.id, { fullName: "Asha", admissionNo: "RS-1", sectionId: sectionA, rollNo: 1 });
    const k2 = await admitStudent(app.db, admin, A.id, { fullName: "Bina", admissionNo: "RS-2", sectionId: sectionA, rollNo: 2 });
    const k3 = await admitStudent(app.db, admin, A.id, { fullName: "Chetan", admissionNo: "RS-3", sectionId: sectionB, rollNo: 1 });
    [s1, s2, s3] = [A.ctx(k1.userId), A.ctx(k2.userId), A.ctx(k3.userId)];
    [id.s1, id.s2, id.s3] = [k1.studentId, k2.studentId, k3.studentId];
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k1.studentId, { fullName: "Parent Asha", phone: "9876500051", relationship: "father" })).userId);
    const q = async (content: Record<string, unknown>) => {
      const r = (await createQuestion(app.db, admin, A.id, { subjectId: math, content: content as never })).id;
      await publishQuestion(app.db, admin, A.id, r);
      return r;
    };
    // 2 marks (−0.5 if wrong), 1 mark, 5 marks written: maximum 8.
    id.mcq = await q({ type: "single_choice", stem: "9 x 7 = ?", options: ["56", "63", "72"], correct: "1", marks: "2", negativeMarks: "0.5" });
    id.tf = await q({ type: "true_false", stem: "1 is prime.", correct: "false", marks: "1" });
    id.desc = await q({ type: "descriptive", stem: "Explain primes.", marks: "5" });
    examId = (await createExam(app.db, admin, A.id, { subjectId: math, title: "Mid term", opensAt: local(-MIN), closesAt: local(60 * MIN), durationMinutes: 30, attemptLimit: 1, negativeMarking: true })).id;
    await addExamItems(app.db, admin, A.id, examId, [id.mcq, id.tf, id.desc]);
    await setExamTargets(app.db, admin, A.id, examId, [sectionA, sectionB]);
    await publishExam(app.db, admin, A.id, examId);
    await setExamAccommodation(app.db, admin, A.id, examId, { studentId: id.s2, extraMinutes: 0, extraAttempts: 1, reason: "Fire drill interrupted" });

    const sit = async (who: RequestContext, answers: (unknown | null)[]) => {
      const a = (await startExam(app.db, who, A.id, examId)).attemptId;
      const items = (await getMyExamAttempt(app.db, who, A.id, a)).items;
      for (const [n, r] of answers.entries()) if (r) await saveExamAnswer(app.db, who, A.id, a, { itemId: items[n]!.itemId, response: r, expectedRevision: 0 });
      await submitExam(app.db, who, A.id, a);
      return { attempt: a, items: items.map((i) => i.itemId) };
    };
    const one = await sit(s1, [{ choice: "b" }, { value: true }, { text: "Numbers with two factors." }]); // +2, 0 (no penalty on the TF), written
    const two = await sit(s2, [{ choice: "a" }, null, null]); // −0.5 → total floored at 0
    const retake = await sit(s2, [{ choice: "b" }, { value: false }, { text: "Prime means two factors." }]); // +2 +1, written
    [id.a1, id.a2, id.a2b] = [one.attempt, two.attempt, retake.attempt];
    [id.iMcq, id.iTf, id.iDesc] = [one.items[0]!, one.items[1]!, one.items[2]!];
    // s3 never sits it: absent.
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const closeExam = async () => {
    await owner.db.execute(sql`alter table exams disable trigger exams_guard`);
    try {
      await owner.db.execute(sql`update exams set closes_at = now() - interval '1 minute', opens_at = now() - interval '2 hours' where id = ${examId}::uuid`);
    } finally {
      await owner.db.execute(sql`alter table exams enable trigger exams_guard`);
    }
  };

  it("percentages round half-up; grades and pass compare the exact fraction", () => {
    expect(percentBp(100, 300)).toBe(3333);
    expect(percentBp(200, 300)).toBe(6667);
    expect(percentBp(1, 8)).toBe(1250);
    expect(percentBp(0, 800)).toBe(0);
    const bands = CBSE_STYLE_PRESET.bands.map((b) => ({ label: b.label, minBp: Math.round(Number(b.minPercent) * 100), description: null }));
    // 33 of 100 is exactly the pass mark and the D band; 32.995% shows as 33.00% but is below both.
    expect(passesExact(3300, 10000, 3300)).toBe(true);
    expect(gradeOf(3300, 10000, bands)).toBe("D");
    expect(percentBp(6599, 20000)).toBe(3300);
    expect(passesExact(6599, 20000, 3300)).toBe(false);
    expect(gradeOf(6599, 20000, bands)).toBe("E");
    expect(gradeOf(10000, 10000, bands)).toBe("A1");
  });

  describe("online exams", () => {
    it("grading starts only after closing, by the subject's staff; objective questions are scored by the rules", async () => {
      expect(await message(startGrading(app.db, admin, A.id, examId))).toMatch(/still open/);
      await closeExam();
      expect(await outcome(startGrading(app.db, tSci, A.id, examId))).toBe("NOT_FOUND");
      expect(await startGrading(app.db, tA, A.id, examId)).toEqual({ students: 3 });
      expect(await startGrading(app.db, admin, A.id, examId)).toEqual({ students: 3 });
      const marks = async (attempt: string) =>
        Object.fromEntries((await owner.db.select().from(examMarks).where(eq(examMarks.attemptId, attempt))).map((m) => [m.itemId, m.marksX100]));
      expect(await marks(id.a1!)).toEqual({ [id.iMcq!]: 200, [id.iTf!]: 0 });
      expect(await marks(id.a2!)).toEqual({ [id.iMcq!]: -50, [id.iTf!]: 0 });
      const g = await getExamGrading(app.db, admin, A.id, examId);
      expect(g.students.map((s) => [s.name, s.attemptNo, s.unmarked])).toEqual([["Asha", 1, 1], ["Bina", 1, 1], ["Chetan", null, 0]]);
      // A teacher of section A grades every student but sees names only in their own section.
      expect((await getExamGrading(app.db, tA, A.id, examId)).students.map((s) => s.name)).toEqual(["Asha", "Bina", "Student (another section)"]);
      // Nothing is visible to students or parents yet.
      expect(await withContext(app.db, s1, (tx) => tx.select().from(examResults))).toHaveLength(0);
      expect(await outcome(getMyExamResult(app.db, s1, A.id, examId))).toBe("NOT_FOUND");
    });

    it("written answers are marked within bounds; release waits until every counted answer is marked", async () => {
      const list = await listAnswersToMark(app.db, tA, A.id, examId, id.iDesc!);
      expect(list.answers.map((a) => [a.studentName, a.text])).toEqual([["Asha", "Numbers with two factors."], ["Bina", null]]);
      // A grader from another section marks the same answers without seeing the names.
      const anon = await listAnswersToMark(app.db, tB, A.id, examId, id.iDesc!);
      expect(anon.answers.map((a) => a.studentName)).toEqual(["Student (another section)", "Student (another section)"]);
      expect(anon.answers.map((a) => a.text).sort()).toEqual(["Numbers with two factors.", null].sort());
      expect(await outcome(setWrittenMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "5.5" }))).toBe("VALIDATION");
      expect(await outcome(setWrittenMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iMcq!, marks: "1" }))).toBe("CONFLICT");
      expect(await outcome(setWrittenMark(app.db, tSci, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "3" }))).toBe("NOT_FOUND");
      expect(await outcome(setWrittenMark(app.db, s1, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "5" }))).toBe("FORBIDDEN");
      expect(await outcome(setWrittenMark(app.db, tA, A.id, { attemptId: id.a2b!, itemId: id.iDesc!, marks: "4" }))).toBe("CONFLICT"); // not the counted attempt
      await setWrittenMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "3", comment: "Give an example." });
      await setWrittenMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "3.5", comment: "Give an example." });
      expect(await message(releaseExamResults(app.db, admin, A.id, examId))).toMatch(/not marked yet/);
      await setWrittenMark(app.db, tB, A.id, { attemptId: id.a2!, itemId: id.iDesc!, marks: "0" });
      expect(await outcome(releaseExamResults(app.db, tA, A.id, examId))).toBe("FORBIDDEN");
      expect((await releaseExamResults(app.db, admin, A.id, examId)).results).toBe(3);
      expect(await message(setWrittenMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "4" }))).toMatch(/already released/);
      const g = await getExamGrading(app.db, admin, A.id, examId);
      // Asha 2 + 0 + 3.5 = 5.5 / 8; Bina −0.5 → 0; Chetan absent.
      expect(g.students.map((s) => [s.name, s.scoreX100, s.percentBp, s.grade])).toEqual([["Asha", 550, 6875, "B2"], ["Bina", 0, 0, "E"], ["Chetan", null, null, null]]);
      expect(g.summary).toMatchObject({ counted: 2, absent: 1, highestBp: 6875, lowestBp: 0, passed: 1 });
    });

    it("released results: students see questions, marks and keys; parents see totals; families are notified", async () => {
      const r = await getMyExamResult(app.db, s1, A.id, examId);
      expect(r).toMatchObject({ scoreX100: 550, maxX100: 800, percentBp: 6875, grade: "B2", passed: true, revision: 1 });
      expect(r.items.map((i) => [i.answer, i.marksX100, i.key])).toEqual([
        ["B. 63", 200, "B. 63"],
        ["True", 0, "False"],
        ["Numbers with two factors.", 350, ""],
      ]);
      expect(r.items[2]!.comment).toBe("Give an example.");
      const card = await getChildReportCard(app.db, parent, A.id, id.s1!);
      expect(card.subjects[0]!.items.map((i) => [i.title, i.scoreX100, i.grade])).toEqual([["Mid term", 550, "B2"]]);
      expect(await outcome(getChildReportCard(app.db, parent, A.id, id.s2!))).toBe("NOT_FOUND");
      expect(await withContext(app.db, parent, (tx) => tx.select().from(examMarks))).toHaveLength(0);
      const n = await owner.db.select().from(notifications).where(sql`${notifications.template} = 'results.released' and ${notifications.channel} = 'in_app'`);
      expect(n.length).toBe(4); // three students and one parent
    });

    it("corrections after release need an administrator and a reason, keep the old marks and notify", async () => {
      expect(await outcome(correctExamMark(app.db, tA, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "4", reason: "Re-marked" }))).toBe("FORBIDDEN");
      expect(await outcome(correctExamMark(app.db, admin, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "6", reason: "Re-marked" }))).toBe("VALIDATION");
      expect(await outcome(correctExamMark(app.db, admin, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "4", reason: "" }))).toBe("VALIDATION");
      await correctExamMark(app.db, admin, A.id, { attemptId: id.a1!, itemId: id.iDesc!, marks: "4", reason: "Re-marked after review" });
      const r = await getMyExamResult(app.db, s1, A.id, examId);
      expect(r).toMatchObject({ scoreX100: 600, revision: 2 });
      const [h] = await owner.db.select().from(resultChanges).where(eq(resultChanges.kind, "exam_mark"));
      expect(h).toMatchObject({ oldValue: 350, newValue: 400, reason: "Re-marked after review" });
      const corrected = await owner.db.select().from(notifications).where(sql`${notifications.template} = 'results.corrected' and ${notifications.channel} = 'in_app'`);
      expect(corrected.length).toBe(2); // student and parent
      // A retake counts only when an administrator says so, with a reason; its written answer must be marked first.
      expect(await message(designateAttempt(app.db, admin, A.id, { examId, studentId: id.s2!, attemptId: id.a2b!, reason: "Retake after fire drill" }))).toMatch(/not marked/);
    });
  });

  describe("offline assessments", () => {
    let offId: string;

    it("an administrator defines it; the subject's teacher of each section enters bounded marks, absent or exempt", async () => {
      expect(await outcome(createOfflineAssessment(app.db, tA, A.id, { subjectId: id.math!, title: "Unit test", maxMarks: "50", sectionIds: [sectionA] }))).toBe("FORBIDDEN");
      offId = (await createOfflineAssessment(app.db, admin, A.id, { subjectId: id.math!, title: "Unit test", heldOn: "", maxMarks: "50", sectionIds: [sectionA, id.sectionB!] })).id;
      expect(await saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "45.5" }, { studentId: id.s2!, value: "AB" }])).toEqual({ saved: 2 });
      expect(await outcome(saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s3!, value: "40" }]))).toBe("FORBIDDEN");
      expect(await outcome(saveOfflineMarks(app.db, tSci, A.id, offId, [{ studentId: id.s1!, value: "40" }]))).toBe("NOT_FOUND");
      expect(await outcome(saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "51" }]))).toBe("VALIDATION");
      expect(await outcome(saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "-1" }]))).toBe("VALIDATION");
      // Saving again replaces the entry: still one row, revision raised.
      await saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "46" }]);
      await saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "46" }]);
      const rows = await owner.db.select().from(offlineMarks).where(eq(offlineMarks.studentId, id.s1!));
      expect(rows.map((r) => [r.marksX100, r.revision])).toEqual([[4600, 2]]);
      // A student outside the target sections cannot be given marks, even by an administrator.
      const other = await admitStudent(app.db, admin, A.id, { fullName: "Dev", admissionNo: "RS-9" });
      expect(await outcome(saveOfflineMarks(app.db, admin, A.id, offId, [{ studentId: other.studentId, value: "10" }]))).toBe("NOT_FOUND");
      // The teacher of section B sees only their section's marks.
      const d = await getOfflineAssessment(app.db, tB, A.id, offId);
      expect(d.sections.map((s) => [s.label, s.canEnter, s.rows.filter((r) => r.status).length])).toEqual([["Class 9 A", false, 0], ["Class 9 B", true, 0]]);
    });

    it("locking needs a complete register and an administrator; nothing is visible before release", async () => {
      expect(await message(transitionOffline(app.db, admin, A.id, offId, "locked"))).toMatch(/Every student needs/);
      expect(await outcome(importOfflineMarks(app.db, tB, A.id, offId, "admission_no,marks\nRS-3,EX\nRS-404,10"))).toBe("VALIDATION");
      expect(await importOfflineMarks(app.db, tB, A.id, offId, "admission_no,marks\nRS-3,EX")).toEqual({ saved: 1 });
      await transitionOffline(app.db, tA, A.id, offId, "submitted");
      expect(await outcome(transitionOffline(app.db, tA, A.id, offId, "locked"))).toBe("FORBIDDEN");
      await transitionOffline(app.db, admin, A.id, offId, "locked");
      expect(await message(saveOfflineMarks(app.db, tA, A.id, offId, [{ studentId: id.s1!, value: "10" }]))).toMatch(/locked/);
      expect(await withContext(app.db, s1, (tx) => tx.select().from(offlineMarks))).toHaveLength(0);
      expect((await getMyReportCard(app.db, s1, A.id)).subjects[0]!.items.map((i) => i.kind)).toEqual(["exam"]);
      await transitionOffline(app.db, admin, A.id, offId, "released");
      expect((await getMyReportCard(app.db, s1, A.id)).subjects[0]!.items.map((i) => [i.kind, i.status, i.scoreX100])).toEqual([["exam", "present", 600], ["offline", "present", 4600]]);
    });

    it("after locking, changes need an administrator and a reason and keep the earlier value", async () => {
      expect(await outcome(correctOfflineMark(app.db, tA, A.id, { assessmentId: offId, studentId: id.s2!, value: "30", reason: "Paper found" }))).toBe("FORBIDDEN");
      await correctOfflineMark(app.db, admin, A.id, { assessmentId: offId, studentId: id.s2!, value: "30", reason: "Paper found" });
      const [h] = await owner.db.select().from(resultChanges).where(eq(resultChanges.kind, "offline_mark"));
      expect(h).toMatchObject({ oldValue: { status: "absent", marks: null }, newValue: { status: "present", marks: 3000 }, reason: "Paper found" });
    });
  });

  describe("report cards and analysis", () => {
    it("totals: absent counts as zero, exempt is left out; grades by the default scheme", async () => {
      const c1 = await getMyReportCard(app.db, s1, A.id);
      // Asha: 6 / 8 + 46 / 50 = 52 / 58 = 89.66%.
      expect(c1.overall).toMatchObject({ scoreX100: 5200, maxX100: 5800, percentBp: 8966, grade: "A2", passed: true });
      const c3 = await getStudentReportCard(app.db, admin, A.id, id.s3!);
      // Chetan: absent from the exam (0 / 8), exempt from the unit test (left out).
      expect(c3.subjects[0]!.items.map((i) => i.status)).toEqual(["absent", "exempt"]);
      expect(c3.overall).toMatchObject({ scoreX100: 0, maxX100: 800, percentBp: 0, grade: "E", passed: false });
      const o = await getSectionResultsOverview(app.db, admin, A.id, sectionA);
      expect(o.students.map((s) => [s.name, s.overallBp])).toEqual([["Asha", 8966], ["Bina", percentBp(3000, 5800)]]);
      expect(o.subjects).toMatchObject([{ subjectName: "Mathematics", averageBp: percentBp(8200, 11600) }]);
      expect(await outcome(getStudentReportCard(app.db, tA, A.id, id.s1!))).toBe("FORBIDDEN");
    });

    it("staff see per-question marks; another school sees nothing", async () => {
      const m = await getStudentExamMarks(app.db, tA, A.id, examId, id.s1!);
      expect(m.items.map((i) => i.marksX100)).toEqual([200, 0, 400]);
      const other = B.ctx(B.adminId);
      expect(await withContext(app.db, other, (tx) => tx.select().from(examResults))).toHaveLength(0);
      expect(await withContext(app.db, other, (tx) => tx.select().from(offlineMarks))).toHaveLength(0);
      expect(await outcome(getExamGrading(app.db, other, A.id, examId))).toBe("NOT_FOUND");
    });
  });
});
