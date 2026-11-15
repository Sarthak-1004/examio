import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { practiceAttempts, practiceSetItems, practiceSets, questionVersions, withContext, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { createChapter, createTopic } from "../src/services/questions/curriculum";
import { createQuestion, publishQuestion } from "../src/services/questions/questions";
import {
  getChildPracticeAttempt,
  getChildPracticeProgress,
  getMyPracticeAttempt,
  getMyPracticeProgress,
  listChildPractice,
  listMyPractice,
  savePracticeAnswer,
  startPracticeAttempt,
  submitPracticeAttempt,
} from "../src/services/practice/attempts";
import {
  addPracticeItems,
  addPracticeItemsFromTopic,
  archivePracticeSet,
  assignPracticeSet,
  createPracticeSet,
  getPracticeSet,
  listAssignableSections,
  listPracticeSets,
  publishPracticeSet,
  removePracticeAssignment,
  removePracticeItem,
  updatePracticeSet,
} from "../src/services/practice/sets";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 10: practice sets, attempts, feedback and progress. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("practice", () => {
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
  let sectionA: string;
  let sectionB: string;
  let math: string;
  let sci: string;
  let chapter: string;
  let topic: string;
  const q: Record<string, string> = {};

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("pra");
    B = await makeSchool("prb");
    admin = A.ctx(A.adminId);
    const y = Number(new Date().toISOString().slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c7 = (await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 })).id;
    sectionA = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "A" })).id;
    sectionB = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "B" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7, subjectIds: [math, sci] });
    const mk = async (no: string, subjectId: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@pr.test`, employeeNo: no, role: "teacher" });
      await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId: sectionA, subjectId });
      return A.ctx(t.userId);
    };
    t1 = await mk("T-M", math);
    t2 = await mk("T-S", sci);
    const k1 = await admitStudent(app.db, admin, A.id, { fullName: "Learner One", admissionNo: "PR-1", sectionId: sectionA, rollNo: 1 });
    const k2 = await admitStudent(app.db, admin, A.id, { fullName: "Learner Two", admissionNo: "PR-2", sectionId: sectionB, rollNo: 1 });
    const k3 = await admitStudent(app.db, admin, A.id, { fullName: "Learner Three", admissionNo: "PR-3", sectionId: sectionA, rollNo: 2 });
    s1 = A.ctx(k1.userId);
    s2 = A.ctx(k2.userId);
    s3 = A.ctx(k3.userId);
    s1Id = k1.studentId;
    s2Id = k2.studentId;
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k1.studentId, { fullName: "Parent One", phone: "9876500031", relationship: "father" })).userId);

    chapter = (await createChapter(app.db, admin, A.id, { subjectId: math, name: "Numbers" })).id;
    topic = (await createTopic(app.db, admin, A.id, { chapterId: chapter, name: "Addition" })).id;
    const make = async (key: string, subjectId: string, content: Record<string, unknown>, publish = true, topicId: string | null = topic) => {
      q[key] = (await createQuestion(app.db, admin, A.id, { subjectId, topicId, content: content as never })).id;
      if (publish) await publishQuestion(app.db, admin, A.id, q[key]!);
    };
    await make("mcq", math, { type: "single_choice", stem: "2 + 2 = ?", options: ["2", "3", "4", "5"], correct: "2", marks: "1", negativeMarks: "0.25", explanation: "Count on from 2." });
    await make("tf", math, { type: "true_false", stem: "5 is even.", correct: "false", marks: "2" });
    await make("desc", math, { type: "descriptive", stem: "Explain carrying.", modelAnswer: "Move tens.", marks: "5" }, true, null);
    await make("draft", math, { type: "true_false", stem: "Draft only.", correct: "true" }, false);
    await make("sci", sci, { type: "true_false", stem: "Water boils at 100 C at sea level.", correct: "true" }, true, null);
    for (let i = 1; i <= 4; i++) await make(`extra${i}`, math, { type: "true_false", stem: `Extra statement ${i}.`, correct: "true" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  let setId: string;

  describe("building sets", () => {
    it("teachers of the subject and administrators build sets; others cannot", async () => {
      setId = (await createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "Addition warm-up", feedback: "immediate" })).id;
      expect(await outcome(createPracticeSet(app.db, t2, A.id, { subjectId: math, title: "Not mine", feedback: "immediate" }))).toBe("NOT_FOUND");
      expect(await outcome(createPracticeSet(app.db, s1, A.id, { subjectId: math, title: "Student", feedback: "immediate" }))).toBe("FORBIDDEN");
      expect(await outcome(createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "", feedback: "immediate" }))).toBe("VALIDATION");
      expect(await outcome(createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "x", feedback: "immediate", attemptLimit: "0" }))).toBe("VALIDATION");
      expect(await outcome(getPracticeSet(app.db, t2, A.id, setId))).toBe("NOT_FOUND");
      expect((await listPracticeSets(app.db, t2, A.id)).length).toBe(0);
      expect((await listPracticeSets(app.db, admin, A.id)).map((s) => s.title)).toEqual(["Addition warm-up"]);
    });

    it("only published questions of the set's subject are added, as their locked versions", async () => {
      expect(await message(addPracticeItems(app.db, t1, A.id, setId, [q.draft!]))).toMatch(/Only published questions/);
      expect(await message(addPracticeItems(app.db, t1, A.id, setId, [q.sci!]))).toMatch(/Only published questions/);
      expect(await addPracticeItems(app.db, t1, A.id, setId, [q.mcq!, q.tf!, q.desc!, q.mcq!])).toEqual({ added: 3 });
      expect(await addPracticeItems(app.db, t1, A.id, setId, [q.mcq!])).toEqual({ added: 0 });
      const d = await getPracticeSet(app.db, t1, A.id, setId);
      expect(d.items.map((i) => [i.position, i.type])).toEqual([[1, "single_choice"], [2, "true_false"], [3, "descriptive"]]);
      expect(d.items[0]!.topicPath).toBe("Numbers › Addition");
    });

    it("adds by chapter or topic, removes from a draft, and publishing fixes the questions", async () => {
      const other = (await createPracticeSet(app.db, admin, A.id, { subjectId: math, title: "By chapter", feedback: "immediate" })).id;
      expect(await outcome(publishPracticeSet(app.db, admin, A.id, other))).toBe("CONFLICT");
      expect(await addPracticeItemsFromTopic(app.db, admin, A.id, other, chapter, 2)).toEqual({ added: 2 });
      expect(await addPracticeItemsFromTopic(app.db, admin, A.id, other, topic, 50)).toEqual({ added: 4 });
      expect(await outcome(addPracticeItemsFromTopic(app.db, admin, A.id, other, topic, 5))).toBe("CONFLICT");
      const items = (await getPracticeSet(app.db, admin, A.id, other)).items;
      await removePracticeItem(app.db, admin, A.id, other, items[0]!.id);
      expect((await getPracticeSet(app.db, admin, A.id, other)).items).toHaveLength(5);

      await publishPracticeSet(app.db, t1, A.id, setId);
      expect(await outcome(publishPracticeSet(app.db, t1, A.id, setId))).toBe("CONFLICT");
      expect(await outcome(addPracticeItems(app.db, t1, A.id, setId, [q.extra1!]))).toBe("CONFLICT");
      const first = (await getPracticeSet(app.db, t1, A.id, setId)).items[0]!.id;
      expect(await outcome(removePracticeItem(app.db, t1, A.id, setId, first))).toBe("CONFLICT");
      // The database refuses too: no items added to or removed from a published set.
      const [v] = await owner.db.select({ id: questionVersions.id }).from(questionVersions).where(sql`${questionVersions.questionId} = ${q.extra1!}::uuid`);
      expect(await dbError(withContext(app.db, t1, (tx) => tx.insert(practiceSetItems).values({ schoolId: A.id, setId, questionVersionId: v!.id, position: 9 })))).toMatch(/row-level security/);
      const del = await withContext(app.db, t1, (tx) => tx.delete(practiceSetItems).where(sql`${practiceSetItems.setId} = ${setId}::uuid`).returning({ id: practiceSetItems.id }));
      expect(del).toHaveLength(0);
      // Nor can a published set be returned to draft to change its questions.
      expect(await dbError(withContext(app.db, t1, (tx) => tx.update(practiceSets).set({ status: "draft", publishedAt: null }).where(sql`${practiceSets.id} = ${setId}::uuid`)))).toMatch(/cannot change from published to draft/);
    });

    it("assigns published sets: teachers to sections they teach, administrators anywhere", async () => {
      const draft = (await createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "Unpublished", feedback: "immediate" })).id;
      expect(await outcome(assignPracticeSet(app.db, t1, A.id, draft, { sectionId: sectionA }))).toBe("CONFLICT");
      expect((await listAssignableSections(app.db, t1, A.id, setId)).map((s) => s.label)).toEqual(["Class 7 A"]);
      expect((await listAssignableSections(app.db, admin, A.id, setId)).map((s) => s.label)).toEqual(["Class 7 A", "Class 7 B"]);
      expect(await outcome(assignPracticeSet(app.db, t1, A.id, setId, { sectionId: sectionB }))).toBe("NOT_FOUND");
      expect(await outcome(assignPracticeSet(app.db, t1, A.id, setId, { sectionId: sectionA, closesAt: "2020-01-01T10:00" }))).toBe("VALIDATION");
      expect(await outcome(assignPracticeSet(app.db, t1, A.id, setId, { sectionId: sectionA, opensAt: "2099-01-02T10:00", closesAt: "2099-01-01T10:00" }))).toBe("VALIDATION");
      await assignPracticeSet(app.db, t1, A.id, setId, { sectionId: sectionA });
      expect(await outcome(assignPracticeSet(app.db, t1, A.id, setId, { sectionId: sectionA }))).toBe("CONFLICT");
      expect((await listAssignableSections(app.db, t1, A.id, setId))).toEqual([]);
    });
  });

  describe("taking practice", () => {
    let attempt: string;

    it("students of the assigned section see it; others and the bank stay hidden", async () => {
      const mine = await listMyPractice(app.db, s1, A.id);
      expect(mine.map((m) => [m.title, m.itemCount, m.open, m.attemptsUsed])).toEqual([["Addition warm-up", 3, true, 0]]);
      expect(await listMyPractice(app.db, s2, A.id)).toEqual([]);
      expect(await outcome(startPracticeAttempt(app.db, s2, A.id, setId))).toBe("NOT_FOUND");
      // Learners never read items or question versions directly.
      expect(await withContext(app.db, s1, (tx) => tx.select().from(practiceSetItems))).toHaveLength(0);
      expect(await withContext(app.db, s1, (tx) => tx.select({ id: questionVersions.id }).from(questionVersions))).toHaveLength(0);
      const rows = (await withContext(app.db, s1, (tx) => tx.execute(sql`select * from app_practice_items(${setId}::uuid)`))) as unknown as Record<string, unknown>[];
      expect(rows).toHaveLength(3);
      expect(Object.keys(rows[0]!)).not.toContain("answer_key");
      expect(JSON.stringify(rows)).not.toContain("Count on");
      expect((await withContext(app.db, s2, (tx) => tx.execute(sql`select * from app_practice_items(${setId}::uuid)`))) as unknown as unknown[]).toHaveLength(0);
    });

    it("starting twice resumes the same attempt; answers are checked and revisioned", async () => {
      const a = await startPracticeAttempt(app.db, s1, A.id, setId);
      expect(a.resumed).toBe(false);
      attempt = a.attemptId;
      expect(await startPracticeAttempt(app.db, s1, A.id, setId)).toEqual({ attemptId: attempt, resumed: true });
      const view = await getMyPracticeAttempt(app.db, s1, A.id, attempt);
      expect(view.canAnswer).toBe(true);
      expect(JSON.stringify(view)).not.toContain("correct");
      const [mcq, tf, desc] = view.items;
      expect(await outcome(savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "z" }, expectedRevision: 0 }))).toBe("VALIDATION");
      expect(await outcome(savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: tf!.itemId, response: { choice: "a" }, expectedRevision: 0 }))).toBe("VALIDATION");
      expect(await savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "a" }, expectedRevision: 0 })).toEqual({ revision: 1 });
      expect(await outcome(savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "c" }, expectedRevision: 0 }))).toBe("CONFLICT");
      expect(await savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "c" }, expectedRevision: 1 })).toEqual({ revision: 2 });
      await savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: tf!.itemId, response: { value: true }, expectedRevision: 0 });
      await savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: desc!.itemId, response: { text: "Carry the ten." }, expectedRevision: 0 });
      // Another student cannot touch the attempt.
      expect(await outcome(savePracticeAnswer(app.db, s3, A.id, attempt, { itemId: mcq!.itemId, response: { choice: "a" }, expectedRevision: 2 }))).toBe("NOT_FOUND");
      expect(await outcome(getMyPracticeAttempt(app.db, s3, A.id, attempt))).toBe("NOT_FOUND");
      // No feedback before submission, even through the database function.
      expect((await withContext(app.db, s1, (tx) => tx.execute(sql`select * from app_practice_feedback(${attempt}::uuid)`))) as unknown as unknown[]).toHaveLength(0);
    });

    it("scores are written only by submission, from the answer keys", async () => {
      expect(await dbError(withContext(app.db, s1, (tx) => tx.update(practiceAttempts).set({ scoreX100: 9999 }).where(sql`${practiceAttempts.id} = ${attempt}::uuid`)))).toMatch(/permission denied/);
      expect(await dbError(withContext(app.db, s1, (tx) => tx.execute(sql`update practice_answers set is_correct = true where attempt_id = ${attempt}::uuid`)))).toMatch(/permission denied/);
      expect(await dbError(withContext(app.db, s3, (tx) => tx.execute(sql`select practice_submit(${attempt}::uuid)`)))).toMatch(/attempt not found/);

      expect(await submitPracticeAttempt(app.db, s1, A.id, attempt)).toEqual({ alreadySubmitted: false });
      expect(await submitPracticeAttempt(app.db, s1, A.id, attempt)).toEqual({ alreadySubmitted: true });
      const view = await getMyPracticeAttempt(app.db, s1, A.id, attempt);
      // MCQ correct (+1), true/false wrong (no negative marks), descriptive not scored.
      expect(view.score).toEqual({ scoreX100: 100, maxX100: 300, correct: 1, scored: 2 });
      expect(view.released).toBe(true);
      expect(view.items.map((i) => i.result?.isCorrect ?? null)).toEqual([true, false, null]);
      expect(view.items[0]!.result).toMatchObject({ answerKey: { correct: "c" }, explanation: "Count on from 2.", scoreX100: 100 });
      expect(view.items[2]!.result?.answerKey).toEqual({ modelAnswer: "Move tens." });
      expect(view.canAnswer).toBe(false);
      expect(await outcome(savePracticeAnswer(app.db, s1, A.id, attempt, { itemId: view.items[0]!.itemId, response: { choice: "a" }, expectedRevision: 2 }))).toBe("CONFLICT");
    });

    it("negative marks apply to wrong answers; the total never drops below zero", async () => {
      const a = (await startPracticeAttempt(app.db, s1, A.id, setId)).attemptId;
      const items = (await getMyPracticeAttempt(app.db, s1, A.id, a)).items;
      await savePracticeAnswer(app.db, s1, A.id, a, { itemId: items[0]!.itemId, response: { choice: "a" }, expectedRevision: 0 });
      await submitPracticeAttempt(app.db, s1, A.id, a);
      const v = await getMyPracticeAttempt(app.db, s1, A.id, a);
      expect(v.items[0]!.result?.scoreX100).toBe(-25);
      expect(v.score).toMatchObject({ scoreX100: 0, correct: 0 });
      expect(v.attemptNo).toBe(2);
    });

    it("attempt limits and the assignment window are enforced on the server", async () => {
      await updatePracticeSet(app.db, t1, A.id, setId, { title: "Addition warm-up", feedback: "immediate", attemptLimit: "2" });
      expect(await message(startPracticeAttempt(app.db, s1, A.id, setId))).toMatch(/used all 2 attempts/);

      const later = (await createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "Opens later", feedback: "immediate" })).id;
      await addPracticeItems(app.db, t1, A.id, later, [q.extra1!]);
      await publishPracticeSet(app.db, t1, A.id, later);
      await assignPracticeSet(app.db, t1, A.id, later, { sectionId: sectionA, opensAt: "2099-01-01T09:00" });
      expect(await message(startPracticeAttempt(app.db, s3, A.id, later))).toMatch(/not opened/);
      // Students cannot insert an attempt directly outside the window either.
      const [asg] = (await owner.db.execute(sql`select id from practice_assignments where set_id = ${later}::uuid`)) as unknown as { id: string }[];
      const [me] = (await owner.db.execute(sql`select id from student_profiles where admission_no = 'PR-3'`)) as unknown as { id: string }[];
      expect(await dbError(withContext(app.db, s3, (tx) => tx.insert(practiceAttempts).values({ schoolId: A.id, setId: later, studentId: me!.id, assignmentId: asg!.id, attemptNo: 1 })))).toMatch(/row-level security/);

      // Closing while an attempt is in progress: no more saving, but submitting still works.
      await owner.db.execute(sql`update practice_assignments set opens_at = null where id = ${asg!.id}::uuid`);
      const a = (await startPracticeAttempt(app.db, s3, A.id, later)).attemptId;
      const item = (await getMyPracticeAttempt(app.db, s3, A.id, a)).items[0]!.itemId;
      await owner.db.execute(sql`update practice_assignments set closes_at = now() - interval '1 minute' where id = ${asg!.id}::uuid`);
      expect(await message(savePracticeAnswer(app.db, s3, A.id, a, { itemId: item, response: { value: true }, expectedRevision: 0 }))).toMatch(/closed/);
      expect(await dbError(withContext(app.db, s3, (tx) => tx.execute(sql`insert into practice_answers (school_id, attempt_id, item_id, response) values (${A.id}::uuid, ${a}::uuid, ${item}::uuid, '{"value": true}')`)))).toMatch(/row-level security/);
      expect(await submitPracticeAttempt(app.db, s3, A.id, a)).toEqual({ alreadySubmitted: false });
      expect(await message(startPracticeAttempt(app.db, s3, A.id, later))).toMatch(/closed/);
    });

    it("after-close feedback stays hidden until the assignment closes", async () => {
      const set2 = (await createPracticeSet(app.db, t1, A.id, { subjectId: math, title: "Feedback later", feedback: "after_close" })).id;
      await addPracticeItems(app.db, t1, A.id, set2, [q.mcq!, q.tf!]);
      await publishPracticeSet(app.db, t1, A.id, set2);
      const asg = (await assignPracticeSet(app.db, t1, A.id, set2, { sectionId: sectionA, closesAt: "2099-01-01T09:00" })).id;
      const a = (await startPracticeAttempt(app.db, s1, A.id, set2)).attemptId;
      const items = (await getMyPracticeAttempt(app.db, s1, A.id, a)).items;
      await savePracticeAnswer(app.db, s1, A.id, a, { itemId: items[0]!.itemId, response: { choice: "c" }, expectedRevision: 0 });
      await submitPracticeAttempt(app.db, s1, A.id, a);
      const hidden = await getMyPracticeAttempt(app.db, s1, A.id, a);
      expect(hidden).toMatchObject({ status: "submitted", released: false, score: null });
      expect(hidden.items.every((i) => i.result === null)).toBe(true);
      expect((await withContext(app.db, s1, (tx) => tx.execute(sql`select * from app_practice_feedback(${a}::uuid)`))) as unknown as unknown[]).toHaveLength(0);
      expect((await listMyPractice(app.db, s1, A.id)).find((r) => r.setId === set2)?.bestBp).toBeNull();
      // Staff see results at once.
      expect((await getPracticeSet(app.db, t1, A.id, set2)).assignments[0]!.students.find((s) => s.studentId === s1Id)?.bestBp).toBe(3333);

      await owner.db.execute(sql`update practice_assignments set closes_at = now() - interval '1 minute' where id = ${asg}::uuid`);
      const shown = await getMyPracticeAttempt(app.db, s1, A.id, a);
      expect(shown).toMatchObject({ released: true, score: { scoreX100: 100, maxX100: 300 } });
    });
  });

  describe("progress, parents and staff views", () => {
    it("progress per topic over released answers, weak below 60% with enough answers", async () => {
      const p = await getMyPracticeProgress(app.db, s1, A.id);
      const addition = p.topics.find((t) => t.topicPath === "Numbers › Addition")!;
      // Attempt 1: mcq right, tf wrong; attempt 2: both wrong; feedback-later set: mcq right, tf blank.
      expect(addition).toMatchObject({ answered: 6, correct: 2, accuracyBp: 3333, standing: "weak" });
      expect(p.attempts.map((a) => a.scoreBp)).toEqual([3333, 0, 3333]);
      const p3 = await getMyPracticeProgress(app.db, s3, A.id);
      expect(p3.topics[0]).toMatchObject({ answered: 1, correct: 0, standing: "too_few" });
    });

    it("parents see their child's practice read-only; nobody else's", async () => {
      const rows = await listChildPractice(app.db, parent, A.id, s1Id);
      expect(rows.map((r) => r.title).sort()).toEqual(["Addition warm-up", "Feedback later", "Opens later"]);
      expect(await outcome(listChildPractice(app.db, parent, A.id, s2Id))).toBe("NOT_FOUND");
      const last = rows.find((r) => r.title === "Addition warm-up")!.lastAttemptId!;
      const v = await getChildPracticeAttempt(app.db, parent, A.id, s1Id, last);
      expect(v).toMatchObject({ canAnswer: false, released: true });
      expect(await outcome(getChildPracticeAttempt(app.db, parent, A.id, s2Id, last))).toBe("NOT_FOUND");
      expect((await getChildPracticeProgress(app.db, parent, A.id, s1Id)).topics.length).toBeGreaterThan(0);
      expect(await outcome(startPracticeAttempt(app.db, parent, A.id, setId))).toBe("FORBIDDEN");
      expect(await outcome(listMyPractice(app.db, parent, A.id))).toBe("FORBIDDEN");
    });

    it("staff see participation and per-question accuracy", async () => {
      const d = await getPracticeSet(app.db, t1, A.id, setId);
      const students = d.assignments[0]!.students;
      expect(students.map((s) => [s.name, s.attempts, s.submitted, s.bestBp])).toEqual([["Learner One", 2, 2, 3333], ["Learner Three", 0, 0, null]]);
      expect(d.items.map((i) => i.correctBp)).toEqual([5000, 0, null]);
      expect(d.assignments[0]!.sectionLabel).toBe("Class 7 A");
    });

    it("unassigning and archiving hide the set from students; attempts are kept", async () => {
      const d = await getPracticeSet(app.db, t1, A.id, setId);
      await removePracticeAssignment(app.db, t1, A.id, d.assignments[0]!.id);
      expect((await listMyPractice(app.db, s1, A.id)).some((r) => r.setId === setId)).toBe(false);
      expect(await outcome(startPracticeAttempt(app.db, s1, A.id, setId))).toBe("NOT_FOUND");
      expect((await getMyPracticeProgress(app.db, s1, A.id)).attempts).toHaveLength(3);
      await archivePracticeSet(app.db, t1, A.id, setId);
      expect(await outcome(archivePracticeSet(app.db, t1, A.id, setId))).toBe("CONFLICT");
      expect(await outcome(updatePracticeSet(app.db, t1, A.id, setId, { title: "x", feedback: "immediate" }))).toBe("CONFLICT");
      expect((await listPracticeSets(app.db, t1, A.id, { status: "archived" })).map((s) => s.title)).toEqual(["Addition warm-up"]);
    });

    it("another school sees none of it", async () => {
      const other = B.ctx(B.adminId);
      expect(await withContext(app.db, other, (tx) => tx.select({ id: practiceSets.id }).from(practiceSets))).toHaveLength(0);
      expect(await withContext(app.db, other, (tx) => tx.select({ id: practiceAttempts.id }).from(practiceAttempts))).toHaveLength(0);
      expect(await outcome(getPracticeSet(app.db, other, B.id, setId))).toBe("NOT_FOUND");
      expect(await outcome(getPracticeSet(app.db, other, A.id, setId))).toBe("NOT_FOUND");
    });
  });
});
