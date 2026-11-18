import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schoolMemberships, staffProfiles, teacherAssignments, users, withContext, type RequestContext } from "@examio/db";
import { login } from "../src/auth/login";
import { redeemAccountCode } from "../src/auth/recovery";
import { neutralizeCell, parseCsv, toCsv } from "../src/csv";
import { AppError } from "../src/errors";
import { createSection, createSubject, setClassSubjects, createClass } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher, endAssignment, getMyTeaching, listYearTeaching, setClassTeacher, teachesSection } from "../src/services/staff/assignments";
import { commitStaffImport, parseStaffCsv, previewStaffImport } from "../src/services/staff/import";
import {
  addStaffProfileForMember,
  createStaffMember,
  exportStaffCsv,
  getStaffDetail,
  listMembersWithoutProfile,
  markStaffLeft,
  reactivateStaff,
  searchStaff,
  updateStaffProfile,
} from "../src/services/staff/profiles";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 4: staff management and assignment-based access. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const all = { page: 1, pageSize: 50, search: "" };

describe("staff management", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let yearId: string;
  let sectionA: string;
  let sectionB: string;
  let math: string;
  let sci: string;
  let otherSubject: string;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("sfa");
    B = await makeSchool("sfb");
    admin = A.ctx(A.adminId);
    const today = new Date().toISOString().slice(0, 10);
    const y = Number(today.slice(0, 4));
    const year = await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` });
    yearId = year.id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c7 = await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 });
    sectionA = (await createSection(app.db, admin, A.id, { yearId, classId: c7.id, name: "A" })).id;
    sectionB = (await createSection(app.db, admin, A.id, { yearId, classId: c7.id, name: "B" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    sci = (await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" })).id;
    otherSubject = (await createSubject(app.db, admin, A.id, { name: "French", code: "FRE" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7.id, subjectIds: [math, sci] });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const newTeacher = async (no: string, extra: Partial<Parameters<typeof createStaffMember>[3]> = {}) =>
    createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@staff.test`, employeeNo: no, role: "teacher", ...extra });

  describe("staff lifecycle", () => {
    it("creates the account, membership and profile, and the activation code lets them sign in", async () => {
      const email = `meera-${randomUUID().slice(0, 6)}@staff.test`;
      const r = await createStaffMember(app.db, admin, A.id, { fullName: "Meera Iyer", email, employeeNo: "T-001", role: "teacher", jobTitle: "Maths teacher", joinedOn: "2024-06-01" });
      expect(r.activationCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      expect(await outcome(login(app.db, email, "anything"))).toBe("INVALID_CREDENTIALS"); // no password yet
      await redeemAccountCode(app.db, { code: r.activationCode, newPassword: "Meera#Teach1" });
      expect((await login(app.db, email, "Meera#Teach1")).userId).toBe(r.userId);
      const detail = await getStaffDetail(app.db, admin, A.id, r.staffId);
      expect(detail).toMatchObject({ displayName: "Meera Iyer", employeeNo: "T-001", roles: ["teacher"], status: "active", jobTitle: "Maths teacher", manageable: true });
    });

    it("refuses duplicates, missing contact details and the admin role", async () => {
      expect(await outcome(newTeacher("t-001"))).toBe("CONFLICT"); // employee numbers ignore case
      expect(await outcome(createStaffMember(app.db, admin, A.id, { fullName: "No Contact", employeeNo: "T-900", role: "teacher" }))).toBe("VALIDATION");
      expect(await outcome(createStaffMember(app.db, admin, A.id, { fullName: "Boss", email: "boss@staff.test", employeeNo: "T-901", role: "school_admin" as "teacher" }))).toBe("VALIDATION");
      expect(await outcome(createStaffMember(app.db, admin, A.id, { fullName: "Bad No", email: "x@staff.test", employeeNo: "T 902", role: "teacher" }))).toBe("VALIDATION");
      // An email that already has an account anywhere (here: school B's admin) cannot be reused.
      const [bAdmin] = await owner.db.select({ email: users.email }).from(users).where(eq(users.id, B.adminId));
      expect(await outcome(createStaffMember(app.db, admin, A.id, { fullName: "Taken", email: bAdmin!.email!, employeeNo: "T-903", role: "teacher" }))).toBe("CONFLICT");
      expect(await owner.db.select().from(staffProfiles).where(eq(staffProfiles.employeeNo, "T-903"))).toHaveLength(0);
    });

    it("adds staff details for an invited member; their other school is untouched", async () => {
      const shared = await makeUser({ fullName: "Ravi Shared" });
      await owner.db.insert(schoolMemberships).values([
        { schoolId: B.id, userId: shared, role: "teacher" },
        { schoolId: A.id, userId: shared, role: "teacher" },
      ]);
      expect((await listMembersWithoutProfile(app.db, admin, A.id)).map((m) => m.userId)).toContain(shared);
      const { staffId } = await addStaffProfileForMember(app.db, admin, A.id, shared, { employeeNo: "T-050", displayName: "Ravi Shared" });
      expect((await listMembersWithoutProfile(app.db, admin, A.id)).map((m) => m.userId)).not.toContain(shared);
      expect((await getStaffDetail(app.db, admin, A.id, staffId)).manageable).toBe(false);

      await markStaffLeft(app.db, admin, A.id, staffId, { reason: "Moved to the other campus" });
      const memberships = await owner.db.select().from(schoolMemberships).where(eq(schoolMemberships.userId, shared));
      expect(Object.fromEntries(memberships.map((m) => [m.schoolId === A.id ? "A" : "B", m.status]))).toEqual({ A: "revoked", B: "active" });
      expect(await outcome(addStaffProfileForMember(app.db, admin, A.id, A.studentId, { employeeNo: "T-051", displayName: "Student" }))).toBe("NOT_FOUND");
    });

    it("updates details, refuses leaving twice or marking yourself, and can bring someone back", async () => {
      const t = await newTeacher("T-002");
      await updateStaffProfile(app.db, admin, A.id, t.staffId, { employeeNo: "T-002", displayName: "Anil Kumar", jobTitle: "Science", joinedOn: "2025-01-01" });
      expect(await outcome(markStaffLeft(app.db, admin, A.id, t.staffId, { leftOn: "2024-01-01", reason: "Left" }))).toBe("VALIDATION");
      await markStaffLeft(app.db, admin, A.id, t.staffId, { reason: "Resigned" });
      expect(await outcome(markStaffLeft(app.db, admin, A.id, t.staffId, { reason: "Again" }))).toBe("CONFLICT");
      const [m] = await owner.db.select().from(schoolMemberships).where(eq(schoolMemberships.userId, t.userId));
      expect(m!.status).toBe("revoked");
      await reactivateStaff(app.db, admin, A.id, t.staffId);
      const [back] = await owner.db.select().from(schoolMemberships).where(eq(schoolMemberships.userId, t.userId));
      expect(back!.status).toBe("active");
      expect((await getStaffDetail(app.db, admin, A.id, t.staffId)).status).toBe("active");

      const [me] = await owner.db.insert(staffProfiles).values({ schoolId: A.id, userId: A.adminId, employeeNo: "ADM-1", displayName: "Admin" }).returning({ id: staffProfiles.id });
      expect(await outcome(markStaffLeft(app.db, admin, A.id, me!.id, { reason: "Oops" }))).toBe("CONFLICT");
    });
  });

  describe("assignments", () => {
    let t1: Awaited<ReturnType<typeof newTeacher>>;
    let t2: Awaited<ReturnType<typeof newTeacher>>;
    beforeAll(async () => {
      t1 = await newTeacher("T-101");
      t2 = await newTeacher("T-102");
    });

    it("assigns subjects the class studies, allows co-teaching, refuses duplicates and other subjects", async () => {
      const a = await assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionA, subjectId: math });
      expect(a.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionA, subjectId: math }))).toBe("CONFLICT");
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: t2.staffId, sectionId: sectionA, subjectId: math }))).toBe("OK");
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionA, subjectId: otherSubject }))).toBe("CONFLICT");
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionB, subjectId: sci, startsOn: "1999-01-01" }))).toBe("VALIDATION");
      const teaching = await listYearTeaching(app.db, admin, A.id, yearId);
      const sec = teaching.find((s) => s.sectionId === sectionA)!;
      expect(sec.subjects.find((s) => s.subjectId === math)!.teachers.map((t) => t.name).sort()).toEqual(["Teacher T-101", "Teacher T-102"]);
    });

    it("only active staff with the teacher role can be assigned", async () => {
      const fin = await createStaffMember(app.db, admin, A.id, { fullName: "Fin Person", email: `fin-${randomUUID().slice(0, 6)}@staff.test`, employeeNo: "F-001", role: "finance" });
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: fin.staffId, sectionId: sectionB, subjectId: math }))).toBe("CONFLICT");
      const gone = await newTeacher("T-103");
      await markStaffLeft(app.db, admin, A.id, gone.staffId, { reason: "Left" });
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: gone.staffId, sectionId: sectionB, subjectId: math }))).toBe("CONFLICT");
    });

    it("class teacher: one at a time, replaced from a later date", async () => {
      const first = await setClassTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionB, startsOn: `${new Date().getFullYear() - 1}-07-01` });
      expect(first.replaced).toBe(false);
      expect(await outcome(setClassTeacher(app.db, admin, A.id, { staffId: t1.staffId, sectionId: sectionB }))).toBe("CONFLICT");
      const second = await setClassTeacher(app.db, admin, A.id, { staffId: t2.staffId, sectionId: sectionB });
      expect(second.replaced).toBe(true);
      const sec = (await listYearTeaching(app.db, admin, A.id, yearId)).find((s) => s.sectionId === sectionB)!;
      expect(sec.classTeacher?.staffId).toBe(t2.staffId);
    });

    it("access follows assignments: today, ended, and after leaving", async () => {
      const ctx1 = A.ctx(t1.userId);
      const ctx2 = A.ctx(t2.userId);
      expect(await teachesSection(app.db, ctx1, A.id, sectionA)).toBe(true);
      expect(await teachesSection(app.db, ctx2, A.id, sectionB)).toBe(true); // as class teacher
      expect(await teachesSection(app.db, ctx1, A.id, sectionB)).toBe(false); // class-teacher role ended yesterday
      const mine = await getMyTeaching(app.db, ctx1, A.id);
      expect(mine.subjects.map((s) => `${s.label}:${s.subjectName}`)).toEqual(["Class 7 A:Mathematics"]);

      // Ending the assignment removes access from the end date on.
      const [asg] = await owner.db.select().from(teacherAssignments).where(and(eq(teacherAssignments.staffId, t1.staffId), eq(teacherAssignments.sectionId, sectionA)));
      await owner.db.update(teacherAssignments).set({ startsOn: sql`current_date - 10`, endsOn: null }).where(eq(teacherAssignments.id, asg!.id));
      await endAssignment(app.db, admin, A.id, { kind: "subject", id: asg!.id });
      expect(await outcome(endAssignment(app.db, admin, A.id, { kind: "subject", id: asg!.id }))).toBe("CONFLICT");
      await owner.db.update(teacherAssignments).set({ endsOn: sql`current_date - 1` }).where(eq(teacherAssignments.id, asg!.id));
      expect(await teachesSection(app.db, ctx1, A.id, sectionA)).toBe(false);

      // Leaving ends access everywhere at once.
      await markStaffLeft(app.db, admin, A.id, t2.staffId, { reason: "Left" });
      expect(await outcome(teachesSection(app.db, ctx2, A.id, sectionA))).toBe("NOT_FOUND"); // no longer a member
      const [d] = (await withContext(app.db, A.ctx(t2.userId), (tx) => tx.execute(sql`select app_teaches_section(${sectionA}::uuid, current_date) as ok`))) as unknown as { ok: boolean }[];
      expect(d!.ok).toBe(false);
    });

    it("end dates are validated and a closed year is read-only", async () => {
      const t3 = await newTeacher("T-104");
      const a = await assignTeacher(app.db, admin, A.id, { staffId: t3.staffId, sectionId: sectionB, subjectId: sci });
      expect(await outcome(endAssignment(app.db, admin, A.id, { kind: "subject", id: a.id, endsOn: "1999-01-01" }))).toBe("VALIDATION");
      const next = await createAcademicYear(app.db, admin, A.id, { name: "Next year", startsOn: "2099-04-01", endsOn: "2100-03-31" });
      await setAcademicYearStatus(app.db, admin, A.id, next.id, "current"); // closes this year
      expect(await outcome(assignTeacher(app.db, admin, A.id, { staffId: t3.staffId, sectionId: sectionA, subjectId: sci }))).toBe("CONFLICT");
      expect(await outcome(endAssignment(app.db, admin, A.id, { kind: "subject", id: a.id }))).toBe("CONFLICT");
      const direct = await withContext(app.db, admin, (tx) => tx.update(teacherAssignments).set({ endsOn: sql`current_date` }).where(eq(teacherAssignments.id, a.id)).returning({ id: teacherAssignments.id }));
      expect(direct).toHaveLength(0);
      await setAcademicYearStatus(app.db, admin, A.id, next.id, "closed");
      await setAcademicYearStatus(app.db, admin, A.id, yearId, "planned");
      await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    });
  });

  describe("visibility", () => {
    it("teachers see staff but not students, and only their own staff record and assignments", async () => {
      const t = await newTeacher("T-201");
      const ctx = A.ctx(t.userId);
      const visible = new Set((await withContext(app.db, ctx, (tx) => tx.select({ id: users.id }).from(users))).map((u) => u.id));
      expect(visible.has(A.adminId)).toBe(true);
      expect(visible.has(A.teacherId)).toBe(true);
      expect(visible.has(A.studentId)).toBe(false);
      const roles = (await withContext(app.db, ctx, (tx) => tx.select({ role: schoolMemberships.role }).from(schoolMemberships))).map((m) => m.role);
      expect(roles).not.toContain("student");
      const profiles = await withContext(app.db, ctx, (tx) => tx.select({ userId: staffProfiles.userId }).from(staffProfiles));
      expect(profiles.map((p) => p.userId)).toEqual([t.userId]);
      const asg = await withContext(app.db, ctx, (tx) => tx.select({ id: teacherAssignments.id }).from(teacherAssignments));
      expect(asg).toHaveLength(0);
      // School admins still see everyone in their school.
      expect((await withContext(app.db, admin, (tx) => tx.select({ id: users.id }).from(users))).map((u) => u.id)).toContain(A.studentId);
    });

    it("staff records are admin-only and isolated per school", async () => {
      expect(await outcome(searchStaff(app.db, A.ctx(A.teacherId), A.id, all))).toBe("FORBIDDEN");
      expect(await outcome(searchStaff(app.db, B.ctx(B.adminId), A.id, all))).toBe("NOT_FOUND");
      expect(await outcome(createStaffMember(app.db, A.ctx(A.teacherId), A.id, { fullName: "X Y", email: "xy@staff.test", employeeNo: "X-1", role: "teacher" }))).toBe("FORBIDDEN");
      const anyStaff = (await searchStaff(app.db, admin, A.id, all)).rows[0]!;
      expect(await outcome(getStaffDetail(app.db, B.ctx(B.adminId), B.id, anyStaff.id))).toBe("NOT_FOUND");
      expect(await outcome(markStaffLeft(app.db, B.ctx(B.adminId), B.id, anyStaff.id, { reason: "Hack" }))).toBe("NOT_FOUND");
      expect(await outcome(getMyTeaching(app.db, admin, A.id))).toBe("FORBIDDEN"); // teacher-only view
    });
  });

  describe("search and export", () => {
    it("searches by name, number or email and filters by status and role", async () => {
      expect((await searchStaff(app.db, admin, A.id, { ...all, search: "meera" })).rows.map((r) => r.employeeNo)).toEqual(["T-001"]);
      expect((await searchStaff(app.db, admin, A.id, { ...all, search: "t-10" })).total).toBeGreaterThanOrEqual(3);
      const left = await searchStaff(app.db, admin, A.id, { ...all, status: "left" });
      expect(left.rows.every((r) => r.status === "left")).toBe(true);
      const fin = await searchStaff(app.db, admin, A.id, { ...all, role: "finance" });
      expect(fin.rows.map((r) => r.employeeNo)).toEqual(["F-001"]);
    });

    it("exports CSV with formulas neutralised", async () => {
      const evil = await newTeacher("T-666", { fullName: "=HYPERLINK(\"http://x\")" });
      const csv = await exportStaffCsv(app.db, admin, A.id, { search: "T-666" });
      expect(csv.split("\r\n")[0]).toBe("employee_no,name,job_title,roles,status,email,phone,joined_on,left_on");
      expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
      expect(evil.staffId).toBeTruthy();
    });
  });

  describe("bulk import", () => {
    const header = "name,employee_no,email,phone,role,job_title,joined_on";
    const csv = (rows: string[]) => [header, ...rows].join("\n");
    const good = csv([
      `Asha Rao,IMP-1,asha-${randomUUID().slice(0, 6)}@staff.test,,teacher,English,2025-06-01`,
      `"Verma, Dev",IMP-2,,+91 98111 22233,finance,Accounts,`,
    ]);

    it("previews row errors without saving anything", async () => {
      const bad = csv([
        "A,IMP-9,not-an-email,,teacher,,",
        "Bea Two,IMP-9,bea@staff.test,,principal,,",
        "Cy,T-001,cy@staff.test,,teacher,,2025-13-40",
        ",IMP-8,,,teacher,,",
      ]);
      const p = await previewStaffImport(app.db, admin, A.id, bad);
      expect(p.valid).toBe(0);
      expect(p.rows.map((r) => r.errors.join(" | "))).toEqual([
        "Name must be 2–120 characters. | Email is not valid.",
        'Role must be "teacher" or "finance". | Same employee number as line 2.',
        "Joining date must be YYYY-MM-DD. | A staff member with this employee number already exists.",
        "Name must be 2–120 characters. | Give an email or a mobile number.",
      ]);
      expect((await previewStaffImport(app.db, admin, A.id, "employee_no,email\nX,x@y.z")).fileErrors[0]).toMatch(/no "name" column/);
      expect(await owner.db.select().from(staffProfiles).where(eq(staffProfiles.employeeNo, "IMP-9"))).toHaveLength(0);
    });

    it("imports all rows once; a repeat or a concurrent duplicate never creates employees twice", async () => {
      const p = await previewStaffImport(app.db, admin, A.id, good);
      expect(p).toMatchObject({ valid: 2, invalid: 0 });
      const key = `import-${randomUUID()}`;
      const results = await Promise.all([1, 2, 3].map(() => commitStaffImport(app.db, admin, A.id, { text: good, fingerprint: p.fingerprint, idempotencyKey: key })));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      const first = results.find((r) => !r.replayed)!;
      expect(first.created).toBe(2);
      expect(first.codes!.map((c) => c.employeeNo)).toEqual(["IMP-1", "IMP-2"]);
      expect(results.filter((r) => r.replayed).every((r) => r.codes === null && r.created === 2)).toBe(true);
      expect(await owner.db.select().from(staffProfiles).where(sql`${staffProfiles.employeeNo} like 'IMP-%'`)).toHaveLength(2);

      // A new attempt with a new key is refused by the duplicate employee numbers, atomically.
      expect(await outcome(commitStaffImport(app.db, admin, A.id, { text: good, fingerprint: p.fingerprint, idempotencyKey: `import-${randomUUID()}` }))).toBe("CONFLICT");
      const dev = (await searchStaff(app.db, admin, A.id, { ...all, search: "IMP-2" })).rows[0]!;
      expect(dev).toMatchObject({ displayName: "Verma, Dev", phone: "9811122233", roles: ["finance"] });
    });

    it("refuses a changed file, rows with errors, and is all-or-nothing", async () => {
      const p = await previewStaffImport(app.db, admin, A.id, good);
      expect(await outcome(commitStaffImport(app.db, admin, A.id, { text: `${good}\nNew,IMP-3,n@staff.test,,teacher,,`, fingerprint: p.fingerprint, idempotencyKey: `import-${randomUUID()}` }))).toBe("CONFLICT");
      const withBad = csv([`Ok Person,IMP-4,ok-${randomUUID().slice(0, 6)}@staff.test,,teacher,,`, "Bad,IMP-5,bad,,teacher,,"]);
      const pb = await previewStaffImport(app.db, admin, A.id, withBad);
      expect(await outcome(commitStaffImport(app.db, admin, A.id, { text: withBad, fingerprint: pb.fingerprint, idempotencyKey: `import-${randomUUID()}` }))).toBe("VALIDATION");
      const [bAdmin] = await owner.db.select({ email: users.email }).from(users).where(eq(users.id, B.adminId));
      const clash = csv([`Fresh One,IMP-6,fresh-${randomUUID().slice(0, 6)}@staff.test,,teacher,,`, `Elsewhere,IMP-7,${bAdmin!.email},,teacher,,`]);
      const pc = await previewStaffImport(app.db, admin, A.id, clash);
      expect(pc.valid).toBe(2); // another school's account is not visible to the preview
      expect(await outcome(commitStaffImport(app.db, admin, A.id, { text: clash, fingerprint: pc.fingerprint, idempotencyKey: `import-${randomUUID()}` }))).toBe("CONFLICT");
      expect(await owner.db.select().from(staffProfiles).where(eq(staffProfiles.employeeNo, "IMP-6"))).toHaveLength(0);
    });

    it("only school admins can import", async () => {
      expect(await outcome(previewStaffImport(app.db, A.ctx(A.teacherId), A.id, good))).toBe("FORBIDDEN");
    });
  });

  describe("CSV", () => {
    it("parses quotes, commas, newlines and a BOM, and writes safe cells", () => {
      expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n\n"multi\nline",z')).toEqual([["a", "b"], ["x, y", 'he said "hi"'], ["multi\nline", "z"]]);
      for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx"]) expect(neutralizeCell(v).startsWith("'")).toBe(true);
      expect(neutralizeCell("Plain")).toBe("Plain");
      expect(toCsv([["a,b", 'q"', null, 3]])).toBe('"a,b","q""",,3\r\n');
      // Numbers are data, never formulas: a negative amount stays a number.
      expect(toCsv([[-5, "-5"]])).toBe("-5,'-5\r\n");
      expect(parseStaffCsv("").fileErrors).toEqual(["The file is empty."]);
    });
  });
});
