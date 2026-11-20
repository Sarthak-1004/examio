import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, type RequestContext } from "@examio/db";
import { instantToZonedLocal } from "../../src/dates";
import { addExamItems, createExam, publishExam, setExamTargets, submitExamForApproval } from "../../src/services/exams/exams";
import { getMyExamAttempt, saveExamAnswer, startExam, submitExam } from "../../src/services/exams/taking";
import { createQuestion, publishQuestion } from "../../src/services/questions/questions";
import { createClass, createSection, createSubject, setClassSubjects } from "../../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../../src/services/setup/years";
import { assignTeacher } from "../../src/services/staff/assignments";
import { createStaffMember } from "../../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "../helpers";

/**
 * Exam load test (Phase 15.4; the Phase 11 benchmark). Runs against the disposable integration
 * test database (TEST_DATABASE_*; the helpers refuse anything else) and EMPTIES it first.
 *   pnpm load:exam [--students 500] [--questions 20] [--pool 20]
 *
 * Simulates every student taking one exam at once: open the attempt, load its questions, save
 * one answer per question in turn, submit. Measures each step's latency (p50/p95/p99), the
 * whole run's throughput and errors. It calls the same services the website calls, through the
 * restricted runtime role and RLS, with a connection pool like one web instance's; it does not
 * include HTTP, page rendering or sign-in, so real-world latency is higher.
 */
const arg = (name: string, d: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : d);
const STUDENTS = arg("--students", 500);
const QUESTIONS = arg("--questions", 20);
const POOL = arg("--pool", 20);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const local = (ms: number) => instantToZonedLocal(new Date(Date.now() + ms), "Asia/Kolkata");
const timings: Record<string, number[]> = { start: [], view: [], save: [], submit: [] };
const errors: Record<string, number> = {};
async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } catch (e) {
    errors[step] = (errors[step] ?? 0) + 1;
    throw e;
  } finally {
    timings[step]!.push(performance.now() - t);
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10 : 0;
};

console.log(`Setting up ${STUDENTS} students and a ${QUESTIONS}-question exam (this empties the test database)…`);
const setupStarted = Date.now();
await truncateAll();
const A = await makeSchool("load");
const admin = A.ctx(A.adminId);
const y = Number(new Date().toISOString().slice(0, 4));
const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "Load year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
const classId = (await createClass(app.db, admin, A.id, { name: "Class 10", sortOrder: 10 })).id;
const sectionId = (await createSection(app.db, admin, A.id, { yearId, classId, name: "A" })).id;
const math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
await setClassSubjects(app.db, admin, A.id, { yearId, classId, subjectIds: [math] });
const t = await createStaffMember(app.db, admin, A.id, { fullName: "Load Teacher", email: `load-${randomUUID().slice(0, 6)}@load.test`, employeeNo: "T-1", role: "teacher" });
await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId, subjectId: math });
const teacher = A.ctx(t.userId);

// Students are inserted directly (admitting thousands through the service would dominate the run).
const users: string[] = [];
for (let i = 0; i < STUDENTS; i += 500) {
  const batch = Array.from({ length: Math.min(500, STUDENTS - i) }, (_, k) => i + k);
  const rows = (await owner.db.execute(sql`
    with u as (
      insert into users (full_name, username, password_hash)
      select 'Load Student ' || n, 'load.s' || n, 'x' from unnest(${sql.raw(`array[${batch.join(",")}]`)}::int[]) n returning id, username
    ), m as (insert into school_memberships (school_id, user_id, role) select ${A.id}::uuid, id, 'student' from u)
    insert into student_profiles (school_id, user_id, admission_no, display_name, admitted_on)
    select ${A.id}::uuid, u.id, upper(replace(u.username, 'load.', '')), 'Load Student', current_date from u returning user_id, id`)) as unknown as { user_id: string; id: string }[];
  await owner.db.execute(sql`
    insert into enrollments (school_id, student_id, academic_year_id, section_id, starts_on)
    select ${A.id}::uuid, x, ${yearId}::uuid, ${sectionId}::uuid, current_date from unnest(${sql.raw(`array[${rows.map((r) => `'${r.id}'`).join(",")}]`)}::uuid[]) x`);
  users.push(...rows.map((r) => r.user_id));
}

const questions: string[] = [];
for (let i = 0; i < QUESTIONS; i++) {
  const id = (await createQuestion(app.db, admin, A.id, { subjectId: math, content: { type: "single_choice", stem: `Question ${i + 1}`, options: ["1", "2", "3", "4"], correct: "1", marks: "1" } as never })).id;
  await publishQuestion(app.db, admin, A.id, id);
  questions.push(id);
}
const examId = (await createExam(app.db, teacher, A.id, { subjectId: math, title: "Load test", instructions: "", opensAt: local(-60_000), closesAt: local(3 * 3600_000), durationMinutes: 120, attemptLimit: 1, negativeMarking: false })).id;
await addExamItems(app.db, teacher, A.id, examId, questions);
await setExamTargets(app.db, teacher, A.id, examId, [sectionId]);
await submitExamForApproval(app.db, teacher, A.id, examId);
await publishExam(app.db, admin, A.id, examId);
const setupSeconds = Math.round((Date.now() - setupStarted) / 100) / 10;

// The run: one connection pool like a web instance's, every student at once.
const pool = createDb(process.env.TEST_DATABASE_URL!, { max: POOL });
let completed = 0;
const started = performance.now();
await Promise.all(
  users.map(async (userId) => {
    const ctx: RequestContext = A.ctx(userId);
    try {
      const { attemptId } = await timed("start", () => startExam(pool.db, ctx, A.id, examId));
      const view = await timed("view", () => getMyExamAttempt(pool.db, ctx, A.id, attemptId));
      for (const item of view.items) {
        const choice = item.options?.[Math.floor(Math.random() * item.options.length)]?.id ?? "a";
        await timed("save", () => saveExamAnswer(pool.db, ctx, A.id, attemptId, { itemId: item.itemId, response: { choice }, expectedRevision: item.revision }));
      }
      await timed("submit", () => submitExam(pool.db, ctx, A.id, attemptId));
      completed++;
    } catch {
      // Counted in errors.
    }
  }),
);
const runSeconds = (performance.now() - started) / 1000;
const [check] = (await owner.db.execute(sql`
  select count(*) filter (where status = 'submitted')::int as submitted, (select count(*)::int from exam_answers a join exam_attempts t on t.id = a.attempt_id where t.exam_id = ${examId}::uuid) as answers
  from exam_attempts where exam_id = ${examId}::uuid`)) as unknown as { submitted: number; answers: number }[];
await pool.close();

const operations = Object.values(timings).reduce((a, xs) => a + xs.length, 0);
const report = {
  at: new Date().toISOString(),
  students: STUDENTS,
  questions: QUESTIONS,
  pool: POOL,
  setupSeconds,
  runSeconds: Math.round(runSeconds * 10) / 10,
  operationsPerSecond: Math.round(operations / runSeconds),
  completed,
  submitted: check?.submitted ?? 0,
  answersStored: check?.answers ?? 0,
  errors,
  latencyMs: Object.fromEntries(Object.entries(timings).map(([k, xs]) => [k, { count: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) }])),
};
const dir = path.join(root, ".data", "load");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `exam-load-${report.at.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${path.relative(root, file)}`);
await app.close();
await owner.close();
if (completed !== STUDENTS || report.answersStored !== STUDENTS * QUESTIONS) process.exitCode = 1;
