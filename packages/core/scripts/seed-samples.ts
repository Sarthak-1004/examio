import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schools, schoolMemberships, users, type RequestContext } from "@examio/db";
import { hashPassword } from "../src/auth/password";
import { schoolToday } from "../src/dates";
import { assignTeacher, setClassTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { createClass, createSection, createSubject, listClasses, listClassSubjects, listSections, listSubjects, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, listAcademicYears, setAcademicYearStatus } from "../src/services/setup/years";

/**
 * Sample accounts for LOCAL DEVELOPMENT (`pnpm db:seed:samples`, after `pnpm db:seed`).
 *
 * Adds, in the Green Valley demo school: a current academic year (if none), Class 6 A with
 * Mathematics and English, a teacher (Mathematics, class teacher of 6 A), a finance clerk, two
 * students enrolled in 6 A and a parent linked to the first student. Every account uses the
 * public password below. Idempotent: existing accounts are left alone.
 *
 * Fake data only. Refuses to run outside development (EXAMIO_ENV) and against the hosted demo.
 * Goes through the application services, so every business rule applies.
 */
const PASSWORD = "Demo@1234";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const env = (process.env.EXAMIO_ENV ?? "development").trim() || "development";
if (env !== "development") throw new Error(`Sample accounts are for local development only (EXAMIO_ENV is "${env}").`);
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) throw new Error("Set DATABASE_OWNER_URL and DATABASE_URL (see .env.example).");
for (const u of [ownerUrl, appUrl]) {
  const host = new URL(u).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Sample accounts are only added to a local database.");
}

const owner = createDb(ownerUrl, { max: 1 });
const app = createDb(appUrl, { max: 2 });

const [school] = await owner.db.select({ id: schools.id, timezone: schools.timezone }).from(schools).where(eq(schools.code, "gvps"));
const [principal] = await owner.db.select({ id: users.id }).from(users).where(eq(users.email, "principal@gvps.demo"));
if (!school || !principal) throw new Error("Run `pnpm db:seed` first: the Green Valley demo school was not found.");
const schoolId = school.id;
const admin: RequestContext = { userId: principal.id, schoolId, isPlatformAdmin: false };
const today = schoolToday(school.timezone);
const hash = await hashPassword(PASSWORD);
const created: string[] = [];

async function userId(where: { email?: string; username?: string }): Promise<string | null> {
  const [u] = await owner.db
    .select({ id: users.id })
    .from(users)
    .where(where.email ? eq(users.email, where.email) : eq(users.username, where.username!));
  return u?.id ?? null;
}

/** Gives a freshly created sample account its public password (no activation code needed). */
async function setPassword(id: string): Promise<void> {
  await owner.db.update(users).set({ passwordHash: hash, mustChangePassword: false }).where(eq(users.id, id));
}

// Academic year: use the current one, or create one covering today (April to March).
let year = (await listAcademicYears(app.db, admin, schoolId)).find((y) => y.status === "current");
if (!year) {
  const y = Number(today.slice(0, 4));
  const startYear = today.slice(5) >= "04-01" ? y : y - 1;
  const name = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  const existing = (await listAcademicYears(app.db, admin, schoolId)).find((x) => x.name === name);
  const id = existing?.id ?? (await createAcademicYear(app.db, admin, schoolId, { name, startsOn: `${startYear}-04-01`, endsOn: `${startYear + 1}-03-31` })).id;
  await setAcademicYearStatus(app.db, admin, schoolId, id, "current");
  year = (await listAcademicYears(app.db, admin, schoolId)).find((x) => x.id === id)!;
  created.push(`academic year ${name}`);
}

// Class 6 A with Mathematics and English.
const classId = (await listClasses(app.db, admin, schoolId)).find((c) => c.name === "Class 6")?.id ?? (await createClass(app.db, admin, schoolId, { name: "Class 6", sortOrder: 6 })).id;
const sectionId =
  (await listSections(app.db, admin, schoolId, year.id)).find((s) => s.classId === classId && s.name === "A")?.id ??
  (await createSection(app.db, admin, schoolId, { yearId: year.id, classId, name: "A", capacity: 40 })).id;
const subjects = await listSubjects(app.db, admin, schoolId);
const math = subjects.find((s) => s.code === "MATH")?.id ?? (await createSubject(app.db, admin, schoolId, { name: "Mathematics", code: "MATH" })).id;
const english = subjects.find((s) => s.code === "ENG")?.id ?? (await createSubject(app.db, admin, schoolId, { name: "English", code: "ENG" })).id;
const mapped = (await listClassSubjects(app.db, admin, schoolId, year.id)).find((m) => m.classId === classId)?.subjectIds ?? [];
if (!mapped.includes(math) || !mapped.includes(english)) {
  await setClassSubjects(app.db, admin, schoolId, { yearId: year.id, classId, subjectIds: [...new Set([...mapped, math, english])] });
}

// Teacher: Mathematics in 6 A and class teacher.
if (!(await userId({ email: "teacher@gvps.demo" }))) {
  const t = await createStaffMember(app.db, admin, schoolId, { fullName: "Ravi Kumar", email: "teacher@gvps.demo", employeeNo: "T-100", role: "teacher", jobTitle: "Mathematics teacher" });
  await setPassword(t.userId);
  const start = year.startsOn > today ? year.startsOn : today;
  await assignTeacher(app.db, admin, schoolId, { staffId: t.staffId, sectionId, subjectId: math, startsOn: start });
  await setClassTeacher(app.db, admin, schoolId, { staffId: t.staffId, sectionId, startsOn: start });
  created.push("teacher teacher@gvps.demo");
}

// Finance clerk.
if (!(await userId({ email: "finance@gvps.demo" }))) {
  const f = await createStaffMember(app.db, admin, schoolId, { fullName: "Meena Iyer", email: "finance@gvps.demo", employeeNo: "F-100", role: "finance", jobTitle: "Accounts" });
  await setPassword(f.userId);
  created.push("finance finance@gvps.demo");
}

// Two students in 6 A.
const students: { name: string; admissionNo: string; roll: number }[] = [
  { name: "Aarav Shah", admissionNo: "S-001", roll: 1 },
  { name: "Diya Patel", admissionNo: "S-002", roll: 2 },
];
let aarav: string | null = null;
for (const st of students) {
  const username = `gvps.${st.admissionNo.toLowerCase()}`;
  const existing = await userId({ username });
  if (existing) {
    if (st.admissionNo === "S-001") {
      const [p] = (await owner.db.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = ${existing}::uuid`)) as unknown as { id: string }[];
      aarav = p?.id ?? null;
    }
    continue;
  }
  const r = await admitStudent(app.db, admin, schoolId, { fullName: st.name, admissionNo: st.admissionNo, sectionId, rollNo: st.roll });
  await setPassword(r.userId);
  if (st.admissionNo === "S-001") aarav = r.studentId;
  created.push(`student ${username}`);
}

// A parent of the first student.
if (aarav && !(await userId({ email: "parent@gvps.demo" }))) {
  const g = await createGuardianAccount(app.db, admin, schoolId, aarav, { fullName: "Sunita Shah", email: "parent@gvps.demo", phone: "9000000011", relationship: "mother" });
  await setPassword(g.userId);
  created.push("parent parent@gvps.demo");
}

// Sanity check: every sample account is an active member of the school.
const [count] = (await owner.db
  .select({ n: sql<number>`count(*)::int` })
  .from(schoolMemberships)
  .innerJoin(users, eq(users.id, schoolMemberships.userId))
  .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.status, "active"), sql`${users.email} in ('teacher@gvps.demo', 'finance@gvps.demo', 'parent@gvps.demo') or ${users.username} in ('gvps.s-001', 'gvps.s-002')`))) as { n: number }[];

await owner.close();
await app.close();
console.log(created.length ? `Added: ${created.join(", ")}.` : "Sample accounts already exist; nothing added.");
console.log(`Sample accounts active in Green Valley: ${count?.n ?? 0} (password for all: ${PASSWORD}).`);
