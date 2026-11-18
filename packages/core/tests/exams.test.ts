import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { examAnswers, examAttempts, examItems, examTargets, exams, questionVersions, withContext, withWorkerContext, type RequestContext } from "@examio/db";
import { instantToZonedLocal } from "../src/dates";
import { AppError } from "../src/errors";
import {
  addExamItems,
  cancelExam,
  createExam,
  getExam,
  listExams,
  listExamSectionOptions,
  publishExam,
  removeExamItem,
  sendBackExam,
  setExamAccommodation,
  setExamTargets,
  submitExamForApproval,
  updateExam,
} from "../src/services/exams/exams";
import { finalizeDueExamAttempts, getMyExamAttempt, listChildExams, listMyExams, saveExamAnswer, setExamFlag, startExam, submitExam } from "../src/services/exams/taking";
import { createQuestion, publishQuestion } from "../src/services/questions/questions";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 11: formal exams and reliable exam-taking. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));
const TZ = "Asia/Kolkata";
const local = (msFromNow: number) => instantToZonedLocal(new Date(Date.now() + msFromNow), TZ);
const MIN = 60_000;

describe("formal exams", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let t1: RequestContext;
  let t2: RequestContext;
  let s1: RequestContext;
  let s2: RequestContext;
  let s3: RequestContext;
  let parent: RequestContext;
  let s1Id: string;
  let s2Id: string;
  let s3Id: string;
  let sectionA: string;
  let sectionB: string;
  let math: string;
  const q: Record<string, string> = {};
  let examId: string;
  const settings = (extra: Record<string, unknown> = {}) => ({ title: "Unit test 1", instructions: "Answer all questions.", opensAt: local(-MIN), closesAt: local(120 * MIN), durationMinutes: 30, attemptLimit: 1, negativeMarking: true, ...extra });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("exa");
    B = await makeSchool("exb");
    admin = A.ctx(A.adminId);
    const y = Number(new Date().toISOString().slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c8 = (await createClass(app.db, admin, A.id, { name: "Class 8", sortOrder: 8 })).id;
    sectionA = (await createSection(app.db, admin, A.id, { yearId, classId: c8, name: "A" })).id;
    sectionB = (await createSection(app.db, admin, A.id, { yearId, classId: c8, name: "B" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    const sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c8, subjectIds: [math, sci] });
    const mk = async (no: string, subjectId: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@ex.test`, employeeNo: no, role: "teacher" });
      await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId: sectionA, subjectId });
      return A.ctx(t.userId);
    };
    t1 = await mk("T-M", math);
    t2 = await mk("T-S", sci);
    const k1 = await admitStudent(app.db, admin, A.id, { fullName: "Learner One", admissionNo: "EX-1", sectionId: sectionA, rollNo: 1 });
    const k2 = await admitStudent(app.db, admin, A.id, { fullName: "Learner Two", admissionNo: "EX-2", sectionId: sectionB, rollNo: 1 });
    const k3 = await admitStudent(app.db, admin, A.id, { fullName: "Learner Three", admissionNo: "EX-3", sectionId: sectionA, rollNo: 2 });
    [s1, s2, s3] = [A.ctx(k1.userId), A.ctx(k2.userId), A.ctx(k3.userId)];
    [s1Id, s2Id, s3Id] = [k1.studentId, k2.studentId, k3.studentId];
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k1.studentId, { fullName: "Parent One", phone: "9876500041", relationship: "mother" })).userId);
    const make = async (key: string, content: Record<string, unknown>, publish = true) => {
      q[key] = (await createQuestion(app.db, admin, A.id, { subjectId: math, content: content as never })).id;
      if (publish) await publishQuestion(app.db, admin, A.id, q[key]!);
    };
    await make("mcq", { type: "single_choice", stem: "7 x 8 = ?", options: ["54", "56", "64"], correct: "1", marks: "2", negativeMarks: "0.5", explanation: "Times tables." });
    await make("tf", { type: "true_false", stem: "0 is an even number.", correct: "true", marks: "1" });
    await make("desc", { type: "descriptive", stem: "Explain place value.", marks: "5" });
    await make("draft", { type: "true_false", stem: "Not published.", correct: "true" }, false);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  describe("drafting and approval", () => {
    it("teachers of the subject draft exams with questions and their own sections", async () => {
      expect(await outcome(createExam(app.db, t1, A.id, { subjectId: math, ...settings({ durationMinutes: 300 }) }))).toBe("VALIDATION");
      expect(await outcome(createExam(app.db, t2, A.id, { subjectId: math, ...settings() }))).toBe("NOT_FOUND");
      expect(await outcome(createExam(app.db, s1, A.id, { subjectId: math, ...settings() }))).toBe("FORBIDDEN");
      examId = (await createExam(app.db, t1, A.id, { subjectId: math, ...settings() })).id;
      expect(await message(addExamItems(app.db, t1, A.id, examId, [q.draft!]))).toMatch(/Only published questions/);
      expect(await addExamItems(app.db, t1, A.id, examId, [q.mcq!, q.tf!, q.desc!])).toEqual({ added: 3 });
      expect((await listExamSectionOptions(app.db, t1, A.id, examId)).map((s) => s.label)).toEqual(["Class 8 A"]);
      expect(await outcome(setExamTargets(app.db, t1, A.id, examId, [sectionB]))).toBe("NOT_FOUND");
      expect(await setExamTargets(app.db, t1, A.id, examId, [sectionA])).toEqual({ sections: 1 });
      expect(await outcome(getExam(app.db, t2, A.id, examId))).toBe("NOT_FOUND");
      // Learners see nothing of a draft.
      expect(await listMyExams(app.db, s1, A.id)).toEqual([]);
      expect(await withContext(app.db, s1, (tx) => tx.select({ id: exams.id }).from(exams))).toHaveLength(0);
    });

    it("submission freezes the draft; only an administrator publishes; publication freezes everything", async () => {
      await submitExamForApproval(app.db, t1, A.id, examId);
      expect(await outcome(updateExam(app.db, t1, A.id, examId, settings({ title: "Changed" })))).toBe("CONFLICT");
      expect(await outcome(addExamItems(app.db, t1, A.id, examId, [q.tf!]))).toBe("CONFLICT");
      expect(await outcome(publishExam(app.db, t1, A.id, examId))).toBe("FORBIDDEN");
      // The database refuses a teacher's direct publication too.
      expect(await dbError(withContext(app.db, t1, (tx) => tx.update(exams).set({ status: "published", publishedBy: t1.userId!, publishedAt: new Date() }).where(eq(exams.id, examId))))).toMatch(/exam_publish_forbidden/);
      await sendBackExam(app.db, admin, A.id, examId);
      const items = (await getExam(app.db, t1, A.id, examId)).items;
      await removeExamItem(app.db, t1, A.id, examId, items[2]!.id);
      await addExamItems(app.db, t1, A.id, examId, [q.desc!]);
      await submitExamForApproval(app.db, t1, A.id, examId);
      await publishExam(app.db, admin, A.id, examId);
      expect(await outcome(updateExam(app.db, t1, A.id, examId, settings()))).toBe("CONFLICT");
      expect(await outcome(setExamTargets(app.db, t1, A.id, examId, []))).toBe("CONFLICT");
      expect(await dbError(withContext(app.db, admin, (tx) => tx.update(exams).set({ title: "Sneaky" }).where(eq(exams.id, examId))))).toMatch(/exam_frozen/);
      const [v] = await owner.db.select({ id: questionVersions.id }).from(questionVersions).where(sql`${questionVersions.questionId} = ${q.tf!}::uuid`);
      expect(await dbError(withContext(app.db, admin, (tx) => tx.insert(examItems).values({ schoolId: A.id, examId, questionVersionId: v!.id, position: 50 })))).toMatch(/row-level security/);
      expect(await dbError(withContext(app.db, admin, (tx) => tx.insert(examTargets).values({ schoolId: A.id, examId, sectionId: sectionB })))).toMatch(/row-level security/);
      const d = await getExam(app.db, admin, A.id, examId);
      expect(d).toMatchObject({ status: "published", totalMarksX100: 800 });
      expect((await listExams(app.db, t1, A.id, { status: "published" })).map((e) => e.title)).toEqual(["Unit test 1"]);
    });
  });

  describe("taking", () => {
    let attempt: string;

    it("only students of the target section start; starting again or concurrently gives one attempt", async () => {
      const mine = await listMyExams(app.db, s1, A.id);
      expect(mine.map((e) => [e.title, e.window, e.itemCount, e.totalMarksX100, e.attemptsAllowed])).toEqual([["Unit test 1", "open", 3, 800, 1]]);
      expect(await listMyExams(app.db, s2, A.id)).toEqual([]);
      expect(await outcome(startExam(app.db, s2, A.id, examId))).toBe("NOT_FOUND");
      attempt = (await startExam(app.db, s1, A.id, examId)).attemptId;
      expect((await startExam(app.db, s1, A.id, examId)).attemptId).toBe(attempt);
      const many = await Promise.all(Array.from({ length: 6 }, () => startExam(app.db, s3, A.id, examId)));
      expect(new Set(many.map((m) => m.attemptId)).size).toBe(1);
      const rows = await owner.db.select({ id: examAttempts.id }).from(examAttempts).where(eq(examAttempts.studentId, s3Id));
      expect(rows).toHaveLength(1);
      // Students cannot create attempts or read questions directly.
      expect(await dbError(withContext(app.db, s1, (tx) => tx.insert(examAttempts).values({ schoolId: A.id, examId, studentId: s1Id, attemptNo: 2, deadlineAt: new Date(Date.now() + 3600_000) })))).toMatch(/permission denied/);
      expect(await withContext(app.db, s1, (tx) => tx.select().from(examItems))).toHaveLength(0);
      expect(await withContext(app.db, s1, (tx) => tx.select({ id: questionVersions.id }).from(questionVersions))).toHaveLength(0);
    });

    it("the attempt shows questions without keys, with a server deadline; saves are revisioned", async () => {
      const v = await getMyExamAttempt(app.db, s1, A.id, attempt);
      expect(v.status).toBe("in_progress");
      expect(v.items).toHaveLength(3);
      expect(JSON.stringify(v.items)).not.toMatch(/correct|Times tables/);
      const deadline = v.deadlineAt.getTime() - v.startedAt.getTime();
      expect(Math.round(deadline / MIN)).toBe(30);
      const [mcq, tf, desc] = v.items;
      expect(await outcome(saveExamAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "z" }, expectedRevision: 0 }))).toBe("VALIDATION");
      expect((await saveExamAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "a" }, expectedRevision: 0 })).revision).toBe(1);
      expect(await message(saveExamAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "b" }, expectedRevision: 0 }))).toMatch(/another window/);
      expect((await saveExamAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "b" }, expectedRevision: 1 })).revision).toBe(2);
      // Marked for review before answering: the flag does not consume a revision.
      await setExamFlag(app.db, s1, A.id, attempt, tf!.itemId, true);
      expect((await saveExamAnswer(app.db, s1, A.id, attempt, { itemId: tf!.itemId, response: { value: true }, expectedRevision: 0 })).revision).toBe(1);
      await saveExamAnswer(app.db, s1, A.id, attempt, { itemId: desc!.itemId, response: { text: "Ones, tens, hundreds." }, expectedRevision: 0 });
      // Reopening (refresh, another device) shows exactly what was acknowledged.
      const again = await getMyExamAttempt(app.db, s1, A.id, attempt);
      expect(again.items.map((i) => [i.revision, i.flagged])).toEqual([[2, false], [1, true], [1, false]]);
      expect(again.items[0]!.response).toEqual({ choice: "b" });
      // Nobody else writes into it, and nobody writes the tables directly.
      expect(await outcome(saveExamAnswer(app.db, s3, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "a" }, expectedRevision: 2 }))).toBe("NOT_FOUND");
      expect(await outcome(getMyExamAttempt(app.db, s3, A.id, attempt))).toBe("NOT_FOUND");
      expect(await dbError(withContext(app.db, s1, (tx) => tx.update(examAnswers).set({ revision: 9 }).where(eq(examAnswers.attemptId, attempt))))).toMatch(/permission denied/);
    });

    it("submission returns a receipt; repeating it returns the same one; nothing changes afterwards", async () => {
      const r1 = await submitExam(app.db, s1, A.id, attempt);
      expect(r1).toMatchObject({ submitKind: "student", answered: 3, questionCount: 3 });
      expect(r1.receipt).toMatch(/^[0-9A-F]{10}$/);
      const r2 = await submitExam(app.db, s1, A.id, attempt);
      expect(r2).toEqual(r1);
      const v = await getMyExamAttempt(app.db, s1, A.id, attempt);
      expect(v).toMatchObject({ status: "submitted", items: [], receipt: { receipt: r1.receipt } });
      const itemId = (await owner.db.select({ id: examItems.id }).from(examItems).where(eq(examItems.examId, examId)))[0]!.id;
      expect(await message(saveExamAnswer(app.db, s1, A.id, attempt, { itemId, response: { choice: "a" }, expectedRevision: 2 }))).toMatch(/submitted/);
      expect(await message(startExam(app.db, s1, A.id, examId))).toMatch(/no attempts left/);
    });

    it("accommodations (administrators only) add a documented retake and extra time", async () => {
      expect(await outcome(setExamAccommodation(app.db, t1, A.id, examId, { studentId: s1Id, extraMinutes: 15, extraAttempts: 1, reason: "Medical note" }))).toBe("FORBIDDEN");
      expect(await outcome(setExamAccommodation(app.db, admin, A.id, examId, { studentId: s2Id, extraMinutes: 15, extraAttempts: 0, reason: "Not in a target section" }))).toBe("NOT_FOUND");
      await setExamAccommodation(app.db, admin, A.id, examId, { studentId: s1Id, extraMinutes: 15, extraAttempts: 1, reason: "Medical note" });
      const second = (await startExam(app.db, s1, A.id, examId)).attemptId;
      const v = await getMyExamAttempt(app.db, s1, A.id, second);
      expect(v.attemptNo).toBe(2);
      expect(Math.round((v.deadlineAt.getTime() - v.startedAt.getTime()) / MIN)).toBe(45);
      expect((await listMyExams(app.db, s1, A.id))[0]).toMatchObject({ attemptsAllowed: 2, attemptsUsed: 2, extraMinutes: 15, inProgressAttemptId: second });
    });

    it("after the deadline nothing is saved; the worker submits overdue attempts with the saved answers", async () => {
      const a3 = (await startExam(app.db, s3, A.id, examId)).attemptId;
      const item = (await getMyExamAttempt(app.db, s3, A.id, a3)).items[1]!.itemId;
      await saveExamAnswer(app.db, s3, A.id, a3, { itemId: item, response: { value: false }, expectedRevision: 0 });
      await owner.db.update(examAttempts).set({ startedAt: new Date(Date.now() - 60 * MIN), deadlineAt: new Date(Date.now() - 10 * MIN) }).where(eq(examAttempts.id, a3));
      expect(await message(saveExamAnswer(app.db, s3, A.id, a3, { itemId: item, response: { value: true }, expectedRevision: 1 }))).toMatch(/Time is up/);
      const [stats] = (await withWorkerContext(app.db, null, (tx) => tx.execute(sql`select * from exam_stats()`))) as unknown as { in_progress: number; overdue: number }[];
      expect(stats).toMatchObject({ overdue: 1 });
      expect(await finalizeDueExamAttempts(app.db)).toBe(1);
      expect(await finalizeDueExamAttempts(app.db)).toBe(0);
      const [row] = await owner.db.select().from(examAttempts).where(eq(examAttempts.id, a3));
      expect(row).toMatchObject({ status: "submitted", submitKind: "deadline" });
      expect(row!.submittedAt!.getTime()).toBe(row!.deadlineAt.getTime());
      const [saved] = await owner.db.select({ response: examAnswers.response }).from(examAnswers).where(eq(examAnswers.attemptId, a3));
      expect(saved!.response).toEqual({ value: false });
      // Only the worker may finalise in bulk; monitoring is not for school users.
      expect(await dbError(withContext(app.db, s3, (tx) => tx.execute(sql`select exam_finalize_due(10)`)))).toMatch(/worker only/);
      expect(await dbError(withContext(app.db, admin, (tx) => tx.execute(sql`select * from exam_stats()`)))).toMatch(/not allowed/);
    });

    it("opening an overdue attempt submits it on the spot", async () => {
      const second = (await listMyExams(app.db, s1, A.id))[0]!.inProgressAttemptId!;
      await owner.db.update(examAttempts).set({ startedAt: new Date(Date.now() - 60 * MIN), deadlineAt: new Date(Date.now() - MIN) }).where(eq(examAttempts.id, second));
      const v = await getMyExamAttempt(app.db, s1, A.id, second);
      expect(v).toMatchObject({ status: "submitted", receipt: { submitKind: "deadline", answered: 0 } });
    });
  });

  describe("monitoring, parents, cancellation and isolation", () => {
    it("staff see each student's state; parents see the schedule and receipts but no answers", async () => {
      const d = await getExam(app.db, t1, A.id, examId);
      expect(d.targets[0]!.students.map((s) => [s.name, s.attempts, s.state, s.extraAttempts])).toEqual([
        ["Learner One", 2, "submitted", 1],
        ["Learner Three", 1, "submitted", 0],
      ]);
      expect(d.accommodations.map((a) => a.reason)).toEqual(["Medical note"]);
      const child = await listChildExams(app.db, parent, A.id, s1Id);
      expect(child[0]).toMatchObject({ title: "Unit test 1", attemptsUsed: 2 });
      expect(child[0]!.lastReceipt).toMatch(/^[0-9A-F]{10}$/);
      expect(await outcome(listChildExams(app.db, parent, A.id, s3Id))).toBe("NOT_FOUND");
      expect(await withContext(app.db, parent, (tx) => tx.select().from(examAnswers))).toHaveLength(0);
      expect(await outcome(startExam(app.db, parent, A.id, examId))).toBe("FORBIDDEN");
    });

    it("cancelling ends attempts in progress, keeps them, and stops new starts", async () => {
      const second = await createExam(app.db, admin, A.id, { subjectId: math, ...settings({ title: "Retest" }) });
      await addExamItems(app.db, admin, A.id, second.id, [q.tf!]);
      await setExamTargets(app.db, admin, A.id, second.id, [sectionA, sectionB]);
      await publishExam(app.db, admin, A.id, second.id);
      const a = (await startExam(app.db, s2, A.id, second.id)).attemptId;
      expect(await outcome(cancelExam(app.db, t1, A.id, second.id, "Paper leaked"))).toBe("FORBIDDEN");
      expect(await cancelExam(app.db, admin, A.id, second.id, "Paper leaked")).toEqual({ endedAttempts: 1 });
      const [row] = await owner.db.select().from(examAttempts).where(eq(examAttempts.id, a));
      expect(row).toMatchObject({ status: "submitted", submitKind: "cancelled" });
      expect(await message(startExam(app.db, s1, A.id, second.id))).toMatch(/cancelled/);
      expect(await outcome(cancelExam(app.db, admin, A.id, second.id, "Again"))).toBe("CONFLICT");
      expect((await listMyExams(app.db, s2, A.id)).map((e) => [e.title, e.window])).toEqual([["Retest", "cancelled"]]);
    });

    it("another school sees none of it", async () => {
      const other = B.ctx(B.adminId);
      expect(await withContext(app.db, other, (tx) => tx.select({ id: exams.id }).from(exams))).toHaveLength(0);
      expect(await withContext(app.db, other, (tx) => tx.select({ id: examAttempts.id }).from(examAttempts))).toHaveLength(0);
      expect(await outcome(getExam(app.db, other, B.id, examId))).toBe("NOT_FOUND");
      expect(await outcome(getExam(app.db, other, A.id, examId))).toBe("NOT_FOUND");
    });
  });
});
