import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { files, questions, questionVersions, teacherAssignments, topics, withContext, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { uploadFile } from "../src/files/files";
import { localDiskStorage } from "../src/files/storage";
import { archiveTopic, createChapter, createTopic, getCurriculum, listAuthorableSubjects } from "../src/services/questions/curriculum";
import { commitQuestionImport, previewQuestionImport } from "../src/services/questions/import";
import {
  archiveQuestion,
  createQuestion,
  getQuestion,
  learnerView,
  parseMarks,
  publishQuestion,
  searchQuestions,
  sendBackQuestion,
  submitForReview,
  updateQuestion,
  validateContent,
} from "../src/services/questions/questions";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 9: curriculum and question bank. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const storage = localDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), "examio-q-test-")));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const all = { page: 1, pageSize: 50, search: "" };
const mcq = (stem: string, extra: Record<string, unknown> = {}) => ({ type: "single_choice", stem, options: ["2", "3", "4", "5"], correct: "2", marks: "1", ...extra });

describe("curriculum and question bank", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let t1: RequestContext;
  let t2: RequestContext;
  let t1Staff: string;
  let math: string;
  let sci: string;
  let student: RequestContext;
  let parent: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("qba");
    B = await makeSchool("qbb");
    admin = A.ctx(A.adminId);
    const y = Number(new Date().toISOString().slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c7 = (await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 })).id;
    const s7 = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "A" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7, subjectIds: [math, sci] });
    const mk = async (no: string, subjectId: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@qb.test`, employeeNo: no, role: "teacher" });
      await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId: s7, subjectId });
      return { ctx: A.ctx(t.userId), staffId: t.staffId };
    };
    const m = await mk("T-M", math);
    t1 = m.ctx;
    t1Staff = m.staffId;
    t2 = (await mk("T-S", sci)).ctx;
    const k = await admitStudent(app.db, admin, A.id, { fullName: "Learner One", admissionNo: "QB-1", sectionId: s7 });
    student = A.ctx(k.userId);
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k.studentId, { fullName: "Parent One", phone: "9876500021", relationship: "mother" })).userId);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("content rules per type; marks in hundredths; the learner view has no answer key", () => {
    expect(parseMarks("0.5")).toBe(50);
    expect(parseMarks("100")).toBe(10000);
    expect(parseMarks("100.01")).toBeNull();
    expect(parseMarks("1.234")).toBeNull();
    const c = validateContent({ ...mcq("2 + 2 = ?"), explanation: "Count on.", negativeMarks: "0.25" });
    expect(c).toMatchObject({ type: "single_choice", answerKey: { correct: "c" }, marksX100: 100, negativeMarksX100: 25 });
    expect(c.options!.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    const lv = learnerView(c);
    expect(JSON.stringify(lv)).not.toContain("answer");
    expect(JSON.stringify(lv)).not.toContain("Count on");
    expect(Object.keys(lv).sort()).toEqual(["imageFileId", "marksX100", "negativeMarksX100", "options", "stem", "type"]);
    const bad = (input: Parameters<typeof validateContent>[0]) => {
      try {
        validateContent(input);
        return "OK";
      } catch (e) {
        return Object.keys((e as AppError).fields ?? {})[0];
      }
    };
    expect(bad({ type: "single_choice", stem: "x", options: ["only"], correct: "0" })).toBe("options");
    expect(bad({ type: "single_choice", stem: "x", options: ["a", "A"], correct: "0" })).toBe("options");
    expect(bad({ type: "single_choice", stem: "x", options: ["a", "b"] })).toBe("correct");
    expect(bad({ type: "true_false", stem: "x" })).toBe("correct");
    expect(bad({ type: "descriptive", stem: "x", negativeMarks: "1" })).toBe("negativeMarks");
    expect(bad({ ...mcq("x"), negativeMarks: "2" })).toBe("negativeMarks");
    expect(bad({ type: "true_false", stem: "", correct: "true" })).toBe("stem");
    expect(validateContent({ type: "true_false", stem: "The sun is a star.", correct: "true" }).answerKey).toEqual({ correct: true });
    expect(validateContent({ type: "descriptive", stem: "Explain photosynthesis.", modelAnswer: "Plants make food...", marks: "5" }).answerKey).toEqual({ modelAnswer: "Plants make food..." });
  });

  describe("curriculum", () => {
    it("teachers manage chapters and topics of subjects they teach; everyone in the school reads them", async () => {
      expect((await listAuthorableSubjects(app.db, t1, A.id)).map((s) => s.code)).toEqual(["MATH"]);
      expect((await listAuthorableSubjects(app.db, admin, A.id)).map((s) => s.code)).toEqual(["MATH", "SCI"]);
      const ch = await createChapter(app.db, t1, A.id, { subjectId: math, name: "Fractions" });
      await createTopic(app.db, t1, A.id, { chapterId: ch.id, name: "Adding fractions" });
      expect(await outcome(createChapter(app.db, t1, A.id, { subjectId: math, name: "fractions" }))).toBe("CONFLICT");
      expect(await outcome(createChapter(app.db, t1, A.id, { subjectId: sci, name: "Plants" }))).toBe("NOT_FOUND");
      expect(await outcome(createChapter(app.db, student, A.id, { subjectId: math, name: "x" }))).toBe("FORBIDDEN");
      expect((await getCurriculum(app.db, t1, A.id, math)).map((c) => [c.name, c.topics.map((t) => t.name)])).toEqual([["Fractions", ["Adding fractions"]]]);
      // A topic cannot hang under another subject's chapter, even written directly.
      const sciCh = await createChapter(app.db, t2, A.id, { subjectId: sci, name: "Plants" });
      const cross = await owner.db.insert(topics).values({ schoolId: A.id, subjectId: math, level: "topic", parentId: sciCh.id, name: "Cross" }).then(() => "inserted", () => "refused");
      expect(cross).toBe("refused");
      const seen = await withContext(app.db, student, (tx) => tx.select({ id: topics.id }).from(topics));
      expect(seen.length).toBeGreaterThan(0);
      expect(await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select({ id: topics.id }).from(topics))).toHaveLength(0);
    });
  });

  describe("questions", () => {
    let qid: string;

    it("a teacher drafts and submits; only an administrator publishes, which locks the version", async () => {
      const ch = (await getCurriculum(app.db, t1, A.id, math))[0]!;
      qid = (await createQuestion(app.db, t1, A.id, { subjectId: math, topicId: ch.topics[0]!.id, content: mcq("2 + 2 = ?") })).id;
      expect(await outcome(createQuestion(app.db, t1, A.id, { subjectId: sci, content: mcq("x") }))).toBe("NOT_FOUND");
      await submitForReview(app.db, t1, A.id, qid);
      expect(await outcome(submitForReview(app.db, t1, A.id, qid))).toBe("CONFLICT");
      expect(await outcome(publishQuestion(app.db, t1, A.id, qid))).toBe("FORBIDDEN");
      const direct = await withContext(app.db, t1, (tx) => tx.update(questions).set({ status: "published" }).where(eq(questions.id, qid))).then(() => "updated", () => "refused");
      expect(direct).toBe("refused");
      await sendBackQuestion(app.db, admin, A.id, qid);
      await submitForReview(app.db, t1, A.id, qid);
      expect(await publishQuestion(app.db, admin, A.id, qid)).toEqual({ revision: 1 });
      const d = await getQuestion(app.db, t1, A.id, qid);
      expect(d).toMatchObject({ status: "published", currentRevision: 1, publishedRevision: 1, topicPath: "Fractions › Adding fractions" });
      expect(d.versions[0]!.locked).toBe(true);
    });

    it("editing a published question creates a new version; the published one never changes", async () => {
      const r = await updateQuestion(app.db, t1, A.id, qid, { content: mcq("Two plus two equals?") });
      expect(r).toEqual({ revision: 2, newVersion: true });
      expect(await updateQuestion(app.db, t1, A.id, qid, { content: mcq("Two plus two equals what?") })).toEqual({ revision: 2, newVersion: false });
      const d = await getQuestion(app.db, t1, A.id, qid);
      expect(d).toMatchObject({ status: "draft", currentRevision: 2, publishedRevision: 1 });
      expect(d.versions.map((v) => [v.revision, v.stem, v.locked])).toEqual([
        [2, "Two plus two equals what?", false],
        [1, "2 + 2 = ?", true],
      ]);
      // The locked version cannot be changed, even directly through the database.
      const v1 = d.versions[1]!.id;
      const edit = await withContext(app.db, admin, (tx) => tx.update(questionVersions).set({ stem: "changed" }).where(eq(questionVersions.id, v1)).returning({ id: questionVersions.id }));
      expect(edit).toHaveLength(0);
      await publishQuestion(app.db, admin, A.id, qid);
      expect((await getQuestion(app.db, admin, A.id, qid)).publishedRevision).toBe(2);
    });

    it("only teachers of the subject and administrators see questions; learners see nothing of the bank", async () => {
      expect(await outcome(getQuestion(app.db, t2, A.id, qid))).toBe("NOT_FOUND");
      expect((await searchQuestions(app.db, t2, A.id, all)).total).toBe(0);
      for (const ctx of [student, parent]) {
        expect(await withContext(app.db, ctx, (tx) => tx.select({ id: questionVersions.id }).from(questionVersions))).toHaveLength(0);
        expect(await withContext(app.db, ctx, (tx) => tx.select({ id: questions.id }).from(questions))).toHaveLength(0);
      }
      expect(await outcome(searchQuestions(app.db, student, A.id, all))).toBe("FORBIDDEN");
      expect(await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select({ id: questions.id }).from(questions))).toHaveLength(0);
      // A teacher whose assignment has ended loses access.
      await owner.db.update(teacherAssignments).set({ startsOn: sql`current_date - 30`, endsOn: sql`current_date - 1` }).where(eq(teacherAssignments.staffId, t1Staff));
      try {
        expect(await outcome(getQuestion(app.db, t1, A.id, qid))).toBe("NOT_FOUND");
      } finally {
        await owner.db.update(teacherAssignments).set({ endsOn: null }).where(eq(teacherAssignments.staffId, t1Staff));
      }
    });

    it("search filters by chapter (including its topics), type, difficulty, status and text; archive keeps the question", async () => {
      const ch = (await getCurriculum(app.db, t1, A.id, math))[0]!;
      await createQuestion(app.db, t1, A.id, { subjectId: math, topicId: ch.id, content: { type: "true_false", stem: "1/2 equals 2/4.", correct: "true", difficulty: "easy" } });
      await createQuestion(app.db, t1, A.id, { subjectId: math, content: { type: "descriptive", stem: "Explain equivalent fractions.", marks: "3", difficulty: "hard" } });
      expect((await searchQuestions(app.db, t1, A.id, { ...all, topicId: ch.id })).total).toBe(2);
      expect((await searchQuestions(app.db, t1, A.id, { ...all, type: "descriptive" })).rows.map((r) => r.marksX100)).toEqual([300]);
      expect((await searchQuestions(app.db, t1, A.id, { ...all, difficulty: "easy" })).total).toBe(1);
      expect((await searchQuestions(app.db, t1, A.id, { ...all, search: "equivalent" })).total).toBe(1);
      expect((await searchQuestions(app.db, t1, A.id, { ...all, status: "published" })).total).toBe(1);
      await archiveQuestion(app.db, admin, A.id, qid, true);
      expect((await searchQuestions(app.db, t1, A.id, all)).rows.map((r) => r.id)).not.toContain(qid);
      expect(await outcome(updateQuestion(app.db, t1, A.id, qid, { content: mcq("x") }))).toBe("CONFLICT");
      expect(await outcome(archiveQuestion(app.db, t1, A.id, qid, false))).toBe("FORBIDDEN");
      await archiveQuestion(app.db, admin, A.id, qid, false);
      expect((await getQuestion(app.db, admin, A.id, qid)).status).toBe("published");
      await archiveTopic(app.db, t1, A.id, ch.id, true);
      expect(await outcome(createQuestion(app.db, t1, A.id, { subjectId: math, topicId: ch.topics[0]!.id, content: mcq("x") }))).toBe("CONFLICT"); // archived with its chapter
      await archiveTopic(app.db, t1, A.id, ch.id, false);
      await archiveTopic(app.db, t1, A.id, ch.topics[0]!.id, false);
    });

    it("question images are visible to those who can see the question", async () => {
      const img = await uploadFile(app.db, t1, storage, { schoolId: A.id, purpose: "question_image", fileName: "figure.png", data: PNG });
      const { id } = await createQuestion(app.db, t1, A.id, { subjectId: math, content: { ...mcq("Which shape is shown?"), imageFileId: img.id } });
      const t1Colleague = await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Two Math", email: `tm2-${randomUUID().slice(0, 6)}@qb.test`, employeeNo: "T-M2", role: "teacher" });
      const sec = (await owner.db.execute(sql`select section_id from teacher_assignments where staff_id = ${t1Staff}::uuid limit 1`)) as unknown as { section_id: string }[];
      await assignTeacher(app.db, admin, A.id, { staffId: t1Colleague.staffId, sectionId: sec[0]!.section_id, subjectId: math });
      const canSee = async (ctx: RequestContext) => (await withContext(app.db, ctx, (tx) => tx.select({ id: files.id }).from(files).where(eq(files.id, img.id)))).length === 1;
      expect(await canSee(A.ctx(t1Colleague.userId))).toBe(true);
      expect(await canSee(t2)).toBe(false);
      expect(await canSee(student)).toBe(false);
      expect((await getQuestion(app.db, admin, A.id, id)).versions[0]!.imageFileId).toBe(img.id);
      expect(await outcome(createQuestion(app.db, t1, A.id, { subjectId: math, content: { ...mcq("x"), imageFileId: randomUUID() } }))).toBe("VALIDATION");
    });
  });

  describe("import", () => {
    const header = "Subject,Chapter,Topic,Type,Difficulty,Marks,Question,Option A,Option B,Option C,Option D,Answer,Explanation";

    it("checks every row like the editor and explains what to fix; nothing is saved", async () => {
      const text = [
        header,
        "MATH,Fractions,Adding fractions,MCQ,easy,1,1/2 + 1/2 = ?,1,2,1/4,0,A,Same denominators",
        "Science,Plants,,tf,,1,Plants make food.,,,,,true,",
        "MATH,Decimals,,mcq,,1,0.1 + 0.2 = ?,0.3,0.12,,,C,",
        "History,,,descriptive,,5,Explain.,,,,,,",
        "MATH,Geometry,Angles,tf,,1,A right angle is 90 degrees.,,,,,yes,",
      ].join("\n");
      const p = await previewQuestionImport(app.db, t1, A.id, { text, createMissing: false, submit: false });
      const byLine = new Map(p.rows.map((r) => [r.line, r.errors.join(" ")]));
      expect(byLine.get(2)).toBe("");
      expect(byLine.get(3)).toContain("you do not teach it");
      expect(byLine.get(4)).toContain('No chapter "Decimals"');
      expect(byLine.get(5)).toContain('No subject "History"');
      expect(byLine.get(6)).toContain('No chapter "Geometry"');
      const created = await previewQuestionImport(app.db, t1, A.id, { text: [header, "MATH,Decimals,,mcq,,1,0.1 + 0.2 = ?,0.3,0.12,,,C,"].join("\n"), createMissing: true, submit: false });
      expect(created.rows[0]!.errors.join(" ")).toContain("letter of the correct option"); // C is an empty option
      expect((await searchQuestions(app.db, t1, A.id, { ...all, search: "1/2 + 1/2" })).total).toBe(0);
    });

    it("imports all rows once (creating missing chapters when asked); a repeat or a changed file never duplicates", async () => {
      const text = [header, "MATH,Geometry,Angles,tf,,1,A right angle is 90 degrees.,,,,,yes,", "math,Geometry,Angles,mcq,medium,2,Angles in a triangle add up to?,90,180,270,360,B,", "MATH,Fractions,,descriptive,hard,4,Explain why 2/4 = 1/2.,,,,,,"].join("\n");
      const p = await previewQuestionImport(app.db, t1, A.id, { text, createMissing: true, submit: true });
      expect(p.invalid).toBe(0);
      expect(p.willCreate).toEqual(['Chapter "Geometry"', 'Topic "Geometry › Angles"']);
      const key = randomUUID();
      const r = await commitQuestionImport(app.db, t1, A.id, { text, createMissing: true, submit: true, fingerprint: p.fingerprint, idempotencyKey: key });
      expect(r).toEqual({ created: 3, topicsCreated: 2, replayed: false });
      expect((await commitQuestionImport(app.db, t1, A.id, { text, createMissing: true, submit: true, fingerprint: p.fingerprint, idempotencyKey: key })).replayed).toBe(true);
      expect((await searchQuestions(app.db, t1, A.id, { ...all, status: "in_review" })).total).toBe(3);
      expect((await getCurriculum(app.db, t1, A.id, math)).find((c) => c.name === "Geometry")?.topics.map((t) => t.name)).toEqual(["Angles"]);
      expect(await message(commitQuestionImport(app.db, t1, A.id, { text: text + "\nMATH,,,tf,,1,Extra.,,,,,true,", createMissing: true, submit: true, fingerprint: p.fingerprint, idempotencyKey: randomUUID() }))).toContain("changed after the check");
      expect(await outcome(previewQuestionImport(app.db, student, A.id, { text, createMissing: false, submit: false }))).toBe("FORBIDDEN");
    });
  });
});
