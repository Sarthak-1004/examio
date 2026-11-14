import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { enrollments, guardianLinks, schoolMemberships, studentProfiles, withContext, type RequestContext } from "@examio/db";
import { login } from "../src/auth/login";
import { redeemAccountCode } from "../src/auth/recovery";
import { schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { uploadFile } from "../src/files/files";
import { localDiskStorage } from "../src/files/storage";
import { acceptMembershipInvitation, createMembershipInvitation } from "../src/services/invitations";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { studentUsername } from "../src/services/students/common";
import {
  changeSection,
  commitPromotion,
  correctEnrollment,
  enrollStudent,
  getSectionRoster,
  numberRollsAlphabetically,
  previewPromotion,
  setRollNo,
} from "../src/services/students/enrollments";
import { createGuardianAccount, createGuardianCode, findSchoolParents, linkExistingGuardian, revokeGuardianLink } from "../src/services/students/guardians";
import { commitStudentImport, mapHeader, previewStudentImport } from "../src/services/students/import";
import { getMyChild, getMyStudentRecord, getTeacherRoster, listMyChildren } from "../src/services/students/portal";
import {
  addStudentProfileForMember,
  admitStudent,
  exportStudentsCsv,
  getStudentDetail,
  listStudentMembersWithoutProfile,
  markStudentLeft,
  readmitStudent,
  searchStudents,
  updateStudentProfile,
} from "../src/services/students/profiles";
import { attachStudentDocument, exportEnrollmentReportCsv, getEnrollmentReport, listStudentDocuments, removeStudentDocument } from "../src/services/students/reports";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 5: students, enrollments, guardians, promotion, import, reports and documents. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const all = { page: 1, pageSize: 100, search: "" };
const storage = localDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), "examio-students-test-")));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

describe("students, enrollments and guardians", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let yearId: string;
  let nextYearId: string;
  let c7: string;
  let s7A: string;
  let s7B: string;
  let s8A: string;
  let sectionInB: string;
  let teacher: { userId: string; staffId: string };
  let y: number;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("stua");
    B = await makeSchool("stub");
    admin = A.ctx(A.adminId);
    y = Number(new Date().toISOString().slice(0, 4));
    yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    nextYearId = (await createAcademicYear(app.db, admin, A.id, { name: "Next year", startsOn: `${y + 1}-04-01`, endsOn: `${y + 2}-03-31` })).id;
    c7 = (await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 })).id;
    const c8 = (await createClass(app.db, admin, A.id, { name: "Class 8", sortOrder: 8 })).id;
    s7A = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "A", capacity: 40 })).id;
    s7B = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "B" })).id;
    s8A = (await createSection(app.db, admin, A.id, { yearId: nextYearId, classId: c8, name: "A" })).id;
    const math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7, subjectIds: [math] });
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Seven A", email: `t7a-${randomUUID().slice(0, 6)}@stu.test`, employeeNo: "T-7A", role: "teacher" });
    teacher = { userId: t.userId, staffId: t.staffId };
    await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId: s7A, subjectId: math });

    const bAdmin = B.ctx(B.adminId);
    const by = (await createAcademicYear(app.db, bAdmin, B.id, { name: "B year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    const bc = (await createClass(app.db, bAdmin, B.id, { name: "Class 7", sortOrder: 7 })).id;
    sectionInB = (await createSection(app.db, bAdmin, B.id, { yearId: by, classId: bc, name: "A" })).id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  let seq = 0;
  const admit = (extra: Partial<Parameters<typeof admitStudent>[3]> = {}) => {
    seq++;
    return admitStudent(app.db, admin, A.id, { fullName: `Student ${String(seq).padStart(3, "0")}`, admissionNo: `ADM-${seq}`, ...extra });
  };

  describe("admission", () => {
    it("creates the account with a username, the record and the enrollment; the code lets the student sign in", async () => {
      const r = await admitStudent(app.db, admin, A.id, { fullName: "Aarav Mehta", admissionNo: "2026/001", dateOfBirth: `${y - 12}-05-10`, sectionId: s7A, rollNo: "1" });
      expect(r.username).toBe("stua.2026-001");
      expect(r.enrollmentId).not.toBeNull();
      await redeemAccountCode(app.db, { code: r.activationCode, newPassword: "Aarav#Learn1" });
      expect((await login(app.db, "STUA.2026-001", "Aarav#Learn1")).userId).toBe(r.userId);
      const d = await getStudentDetail(app.db, admin, A.id, r.studentId);
      expect(d).toMatchObject({ displayName: "Aarav Mehta", admissionNo: "2026/001", status: "active", manageable: true });
      expect(d.enrollments.map((e) => [e.sectionLabel, e.rollNo, e.endsOn])).toEqual([["Class 7 A", 1, null]]);
      // The student sees their own record and class.
      const own = await getMyStudentRecord(app.db, A.ctx(r.userId), A.id);
      expect(own).toMatchObject({ displayName: "Aarav Mehta", sectionLabel: "Class 7 A", rollNo: 1, yearName: "This year" });
    });

    it("refuses duplicate admission numbers (any case), clashing sign-in names, bad dates and other schools' sections", async () => {
      await admit({ admissionNo: "DUP-1" });
      expect(await admit({ admissionNo: "dup-1" }).catch((e: unknown) => (e as Error).message)).toBe("Another student already has this admission number.");
      await admit({ admissionNo: "X/9" });
      expect(await outcome(admit({ admissionNo: "X-9" }))).toBe("CONFLICT"); // same username stua.x-9
      expect(await outcome(admit({ admittedOn: `${y}-01-10`, dateOfBirth: `${y}-02-01` }))).toBe("VALIDATION");
      expect(await outcome(admit({ admissionNo: "bad no!" }))).toBe("VALIDATION");
      expect(await outcome(admit({ sectionId: sectionInB }))).toBe("NOT_FOUND");
      // Nothing half-created by the refused admissions.
      const [n] = (await owner.db.execute(sql`select count(*)::int as n from student_profiles where school_id = ${A.id}::uuid and admission_no in ('dup-1', 'X-9')`)) as unknown as { n: number }[];
      expect(n!.n).toBe(0);
      // The same admission number is fine at another school.
      expect(await outcome(admitStudent(app.db, B.ctx(B.adminId), B.id, { fullName: "Other School", admissionNo: "DUP-1" }))).toBe("OK");
    });

    it("only school admins admit or read students", async () => {
      expect(await outcome(admit({ admissionNo: "T-ONLY" }).then(() => undefined))).toBe("OK");
      expect(await outcome(admitStudent(app.db, A.ctx(A.teacherId), A.id, { fullName: "Nope", admissionNo: "NOPE-1" }))).toBe("FORBIDDEN");
      expect(await outcome(searchStudents(app.db, A.ctx(A.teacherId), A.id, all))).toBe("FORBIDDEN");
      expect(await outcome(searchStudents(app.db, B.ctx(B.adminId), A.id, all))).toBe("NOT_FOUND");
    });

    it("adds student details for an invited student member, and edits them", async () => {
      expect((await listStudentMembersWithoutProfile(app.db, admin, A.id)).map((m) => m.userId)).toContain(A.studentId);
      const { studentId } = await addStudentProfileForMember(app.db, admin, A.id, A.studentId, { displayName: "Fixture Student", admissionNo: "FIX-1", admittedOn: `${y - 1}-06-01` });
      expect((await listStudentMembersWithoutProfile(app.db, admin, A.id)).map((m) => m.userId)).not.toContain(A.studentId);
      await updateStudentProfile(app.db, admin, A.id, studentId, { displayName: "Fixture Student R", admittedOn: `${y - 1}-06-02`, dateOfBirth: `${y - 13}-01-01` });
      expect((await getStudentDetail(app.db, admin, A.id, studentId)).displayName).toBe("Fixture Student R");
      expect(await outcome(addStudentProfileForMember(app.db, admin, A.id, A.teacherId, { displayName: "Teacher", admissionNo: "FIX-2" }))).toBe("NOT_FOUND");
    });
  });

  describe("enrollment", () => {
    it("one open enrollment per year; roll numbers unique in a section; moving section keeps history", async () => {
      const s = await admit();
      await enrollStudent(app.db, admin, A.id, { studentId: s.studentId, sectionId: s7A, rollNo: 30 });
      expect(await outcome(enrollStudent(app.db, admin, A.id, { studentId: s.studentId, sectionId: s7B }))).toBe("CONFLICT");
      const other = await admit();
      expect(await outcome(enrollStudent(app.db, admin, A.id, { studentId: other.studentId, sectionId: s7A, rollNo: 30 }))).toBe("CONFLICT");
      const [e] = await owner.db.select().from(enrollments).where(and(eq(enrollments.studentId, s.studentId), sql`ends_on is null`));
      // Started earlier this year, then moved to 7B today.
      await owner.db.update(enrollments).set({ startsOn: `${y - 1}-06-01` }).where(eq(enrollments.id, e!.id));
      await changeSection(app.db, admin, A.id, { enrollmentId: e!.id, sectionId: s7B });
      const history = (await getStudentDetail(app.db, admin, A.id, s.studentId)).enrollments;
      expect(history.map((h) => [h.sectionLabel, h.endReason])).toEqual([
        ["Class 7 B", null],
        ["Class 7 A", "section_changed"],
      ]);
      expect(await outcome(changeSection(app.db, admin, A.id, { enrollmentId: e!.id, sectionId: s7A }))).toBe("CONFLICT"); // already ended
      expect(await outcome(changeSection(app.db, admin, A.id, { enrollmentId: history[0]!.id, sectionId: s8A }))).toBe("VALIDATION"); // other year
      // Roll 30 in 7A is free again for someone else.
      expect(await outcome(enrollStudent(app.db, admin, A.id, { studentId: other.studentId, sectionId: s7A, rollNo: 30 }))).toBe("OK");
    });

    it("mistakes are corrected, not deleted; roll numbers can be set and numbered alphabetically", async () => {
      const s = await admit({ fullName: "Zoya Wrongsection", sectionId: s7B });
      await correctEnrollment(app.db, admin, A.id, s.enrollmentId!);
      const rows = await owner.db.select().from(enrollments).where(eq(enrollments.studentId, s.studentId));
      expect(rows.map((r) => r.endReason)).toEqual(["corrected"]);
      await enrollStudent(app.db, admin, A.id, { studentId: s.studentId, sectionId: s7A });
      const roster = await getSectionRoster(app.db, admin, A.id, s7A);
      const mine = roster.find((r) => r.studentId === s.studentId)!;
      await setRollNo(app.db, admin, A.id, mine.enrollmentId, 77);
      expect(await outcome(setRollNo(app.db, admin, A.id, mine.enrollmentId, "abc"))).toBe("VALIDATION");
      const { numbered } = await numberRollsAlphabetically(app.db, admin, A.id, s7A);
      const after = await getSectionRoster(app.db, admin, A.id, s7A);
      expect(numbered).toBe(after.length);
      expect(after.map((r) => r.rollNo)).toEqual(after.map((_, i) => i + 1));
      const names = after.map((r) => r.displayName.toLowerCase());
      expect(names).toEqual([...names].sort());
    });

    it("a closed year's enrollments are read-only, also in the database", async () => {
      const s = await admit({ sectionId: s7B });
      await setAcademicYearStatus(app.db, admin, A.id, yearId, "closed");
      try {
        expect(await outcome(correctEnrollment(app.db, admin, A.id, s.enrollmentId!))).toBe("CONFLICT");
        const changed = await withContext(app.db, admin, (tx) => tx.update(enrollments).set({ rollNo: 5 }).where(eq(enrollments.id, s.enrollmentId!)).returning({ id: enrollments.id }));
        expect(changed).toHaveLength(0);
      } finally {
        await owner.db.execute(sql`update academic_years set status = 'current' where id = ${yearId}::uuid`);
      }
    });

    it("leaving ends access and enrollments; readmission restores access", async () => {
      const s = await admit({ sectionId: s7B });
      await owner.db.update(enrollments).set({ startsOn: `${y - 1}-07-01` }).where(eq(enrollments.id, s.enrollmentId!));
      const today = schoolToday("Asia/Kolkata"); // the school's local date, not UTC
      expect(await markStudentLeft(app.db, admin, A.id, s.studentId, { reason: "transferred", leftOn: today })).toEqual({ endedEnrollments: 1 });
      expect(await outcome(markStudentLeft(app.db, admin, A.id, s.studentId, { reason: "withdrawn" }))).toBe("CONFLICT");
      const [m] = await owner.db.select().from(schoolMemberships).where(and(eq(schoolMemberships.userId, s.userId), eq(schoolMemberships.schoolId, A.id)));
      expect(m!.status).toBe("revoked");
      expect(await outcome(getMyStudentRecord(app.db, A.ctx(s.userId), A.id))).toBe("NOT_FOUND");
      const d = await getStudentDetail(app.db, admin, A.id, s.studentId);
      expect(d).toMatchObject({ status: "left", leaveReason: "transferred", leftOn: today });
      expect(d.enrollments[0]).toMatchObject({ endReason: "left", endsOn: today });
      expect(await outcome(enrollStudent(app.db, admin, A.id, { studentId: s.studentId, sectionId: s7A }))).toBe("CONFLICT");
      await readmitStudent(app.db, admin, A.id, s.studentId);
      expect((await getMyStudentRecord(app.db, A.ctx(s.userId), A.id))?.sectionLabel).toBeNull();
    });
  });

  describe("promotion", () => {
    it("moves the chosen students to the next year, skips repeats on retry, and graduates", async () => {
      const p1 = await admit({ fullName: "Promote One", sectionId: s7B });
      const p2 = await admit({ fullName: "Promote Two", sectionId: s7B });
      const stay = await admit({ fullName: "Repeat Year", sectionId: s7B });
      const preview = await previewPromotion(app.db, admin, A.id, { fromSectionId: s7B, toSectionId: s8A });
      expect(preview).toMatchObject({ fromLabel: "Class 7 B", toLabel: "Class 8 A", toYearName: "Next year" });
      expect(preview.rows.filter((r) => [p1.studentId, p2.studentId, stay.studentId].includes(r.studentId)).every((r) => r.state === "ready")).toBe(true);

      const first = await commitPromotion(app.db, admin, A.id, { fromSectionId: s7B, toSectionId: s8A, studentIds: [p1.studentId, p2.studentId] });
      expect(first).toEqual({ promoted: 2, graduated: 0, skipped: 0 });
      const again = await commitPromotion(app.db, admin, A.id, { fromSectionId: s7B, toSectionId: s8A, studentIds: [p1.studentId, p2.studentId] });
      expect(again).toEqual({ promoted: 0, graduated: 0, skipped: 2 });

      const h = (await getStudentDetail(app.db, admin, A.id, p1.studentId)).enrollments;
      expect(h.map((e) => [e.yearName, e.sectionLabel, e.endsOn, e.endReason])).toEqual([
        ["Next year", "Class 8 A", null, null],
        ["This year", "Class 7 B", `${y + 1}-03-31`, "promoted"],
      ]);
      expect((await getStudentDetail(app.db, admin, A.id, stay.studentId)).enrollments.map((e) => e.endReason)).toEqual([null]);
      expect(await outcome(previewPromotion(app.db, admin, A.id, { fromSectionId: s7B, toSectionId: s7A }))).toBe("VALIDATION"); // same year

      const g = await commitPromotion(app.db, admin, A.id, { fromSectionId: s7B, toSectionId: null, studentIds: [stay.studentId] });
      expect(g).toEqual({ promoted: 0, graduated: 1, skipped: 0 });
      expect((await getStudentDetail(app.db, admin, A.id, stay.studentId)).leaveReason).toBe("graduated");
    });
  });

  describe("who sees which student", () => {
    it("a teacher sees only today's students of sections they teach", async () => {
      const inA = await admit({ fullName: "In Seven A", sectionId: s7A });
      const inB = await admit({ fullName: "In Seven B", sectionId: s7B });
      const tctx = A.ctx(teacher.userId);
      const roster = await getTeacherRoster(app.db, tctx, A.id, s7A);
      expect(roster.rows.map((r) => r.studentId)).toContain(inA.studentId);
      expect(await outcome(getTeacherRoster(app.db, tctx, A.id, s7B))).toBe("NOT_FOUND");
      const visible = await withContext(app.db, tctx, (tx) => tx.select({ id: studentProfiles.id }).from(studentProfiles));
      expect(visible.map((v) => v.id)).toContain(inA.studentId);
      expect(visible.map((v) => v.id)).not.toContain(inB.studentId);
      const links = await withContext(app.db, tctx, (tx) => tx.select({ id: guardianLinks.id }).from(guardianLinks));
      expect(links).toHaveLength(0);
      // A teacher with no assignment sees no students at all.
      const none = await withContext(app.db, A.ctx(A.teacherId), (tx) => tx.select({ id: studentProfiles.id }).from(studentProfiles));
      expect(none).toHaveLength(0);
      expect(await outcome(getTeacherRoster(app.db, A.ctx(A.adminId), A.id, s7A))).toBe("FORBIDDEN");
    });

    it("a student sees only themself; another school sees nothing", async () => {
      const me = await admit({ sectionId: s7A });
      const seen = await withContext(app.db, A.ctx(me.userId), (tx) => tx.select({ id: studentProfiles.id }).from(studentProfiles));
      expect(seen.map((s) => s.id)).toEqual([me.studentId]);
      const enr = await withContext(app.db, A.ctx(me.userId), (tx) => tx.select({ id: enrollments.id }).from(enrollments));
      expect(enr.length).toBe(1);
      const fromB = await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select({ id: studentProfiles.id }).from(studentProfiles).where(eq(studentProfiles.schoolId, A.id)));
      expect(fromB).toHaveLength(0);
      expect(await outcome(getStudentDetail(app.db, B.ctx(B.adminId), B.id, me.studentId))).toBe("NOT_FOUND");
    });
  });

  describe("guardians", () => {
    it("a parent account created for a child sees that child only; a sibling is linked explicitly", async () => {
      const child = await admit({ fullName: "Child One", sectionId: s7A });
      const sibling = await admit({ fullName: "Child Two", sectionId: s7B });
      const g = await createGuardianAccount(app.db, admin, A.id, child.studentId, { fullName: "Priya Mehta", phone: "9876500001", relationship: "mother" });
      const pctx = A.ctx(g.userId);
      expect((await listMyChildren(app.db, pctx, A.id)).map((c) => [c.displayName, c.relationship, c.sectionLabel])).toEqual([["Child One", "mother", "Class 7 A"]]);
      expect(await outcome(getMyChild(app.db, pctx, A.id, sibling.studentId))).toBe("NOT_FOUND");
      expect(await outcome(getMyChild(app.db, pctx, A.id, randomUUID()))).toBe("NOT_FOUND");
      // No direct lookup of other children through the database either.
      const seen = await withContext(app.db, pctx, (tx) => tx.select({ id: studentProfiles.id }).from(studentProfiles));
      expect(seen.map((s) => s.id)).toEqual([child.studentId]);
      // A parent cannot link themself to another child.
      const forged = await withContext(app.db, pctx, (tx) =>
        tx.insert(guardianLinks).values({ schoolId: A.id, guardianUserId: g.userId, studentId: sibling.studentId, relationship: "mother", verifiedBy: g.userId }),
      ).then(() => "inserted", () => "refused");
      expect(forged).toBe("refused");

      expect((await findSchoolParents(app.db, admin, A.id, "Priya")).map((p) => p.children)).toEqual([["Child One"]]);
      await linkExistingGuardian(app.db, admin, A.id, sibling.studentId, { guardianUserId: g.userId, relationship: "mother" });
      expect(await outcome(linkExistingGuardian(app.db, admin, A.id, sibling.studentId, { guardianUserId: g.userId, relationship: "mother" }))).toBe("CONFLICT");
      expect(await outcome(linkExistingGuardian(app.db, admin, A.id, sibling.studentId, { guardianUserId: A.teacherId, relationship: "father" }))).toBe("NOT_FOUND");
      expect((await listMyChildren(app.db, pctx, A.id)).map((c) => c.displayName)).toEqual(["Child One", "Child Two"]);
      const detail = await getMyChild(app.db, pctx, A.id, sibling.studentId);
      expect(detail.enrollments.map((e) => e.sectionLabel)).toEqual(["Class 7 B"]);

      // Unlinking one child keeps access to the other; unlinking the last ends the membership.
      const links = (await getStudentDetail(app.db, admin, A.id, child.studentId)).guardians;
      expect(await revokeGuardianLink(app.db, admin, A.id, links[0]!.linkId)).toEqual({ membershipRevoked: false });
      expect((await listMyChildren(app.db, pctx, A.id)).map((c) => c.displayName)).toEqual(["Child Two"]);
      const links2 = (await getStudentDetail(app.db, admin, A.id, sibling.studentId)).guardians;
      expect(await revokeGuardianLink(app.db, admin, A.id, links2[0]!.linkId)).toEqual({ membershipRevoked: true });
      expect(await outcome(listMyChildren(app.db, pctx, A.id))).toBe("NOT_FOUND");
    });

    it("a parent from another school joins with a code that names the child", async () => {
      const child = await admit({ fullName: "Coded Child", sectionId: s7A });
      const parentElsewhere = await makeUser({ fullName: "Ravi Kumar" });
      await owner.db.insert(schoolMemberships).values({ schoolId: B.id, userId: parentElsewhere, role: "parent" });
      const { code } = await createGuardianCode(app.db, admin, A.id, child.studentId, { relationship: "father", recipientLabel: "Ravi Kumar (father)" });
      // The child cannot use a code meant for their parent.
      expect(await outcome(acceptMembershipInvitation(app.db, { userId: child.userId, schoolId: null, isPlatformAdmin: false }, code))).toBe("VALIDATION");
      expect(await acceptMembershipInvitation(app.db, { userId: parentElsewhere, schoolId: null, isPlatformAdmin: false }, code)).toEqual({ schoolId: A.id, role: "parent" });
      expect((await listMyChildren(app.db, A.ctx(parentElsewhere), A.id)).map((c) => [c.displayName, c.relationship])).toEqual([["Coded Child", "father"]]);
      expect((await getStudentDetail(app.db, admin, A.id, child.studentId)).guardians[0]).toMatchObject({ name: "Ravi Kumar", relationship: "father" });

      // Parent invitations must name a child; a code for a child who left is not accepted.
      expect(await outcome(createMembershipInvitation(app.db, admin, A.id, { role: "parent", recipientLabel: "No child" }))).toBe("VALIDATION");
      const leaving = await admit({ fullName: "Leaving Child" });
      const late = await createGuardianCode(app.db, admin, A.id, leaving.studentId, { relationship: "mother", recipientLabel: "Mother" });
      await markStudentLeft(app.db, admin, A.id, leaving.studentId, { reason: "withdrawn" });
      expect(await outcome(acceptMembershipInvitation(app.db, { userId: await makeUser(), schoolId: null, isPlatformAdmin: false }, late.code))).toBe("VALIDATION");
      expect(await outcome(createGuardianCode(app.db, admin, A.id, leaving.studentId, { relationship: "mother", recipientLabel: "Mother" }))).toBe("CONFLICT");
      expect(await outcome(createGuardianCode(app.db, A.ctx(A.teacherId), A.id, child.studentId, { relationship: "mother", recipientLabel: "x y" }))).toBe("FORBIDDEN");
    });
  });

  describe("import", () => {
    const csv = (rows: string[]) => ["Student Name,Adm No,DOB,Class,Section,Roll No,Notes", ...rows].join("\n");

    it("maps common header spellings and shows errors and warnings without saving", async () => {
      expect(mapHeader(["Student Name", "Adm. No", "D.O.B", "Std", "Div", "Roll", "Remarks"]).ignored).toEqual(["Remarks"]);
      await admit({ fullName: "Kiran Rao", admissionNo: "EXIST-1", dateOfBirth: `${y - 12}-01-15`, admittedOn: `${y - 1}-06-01` });
      const p = await previewStudentImport(app.db, admin, A.id, {
        yearId,
        text: csv([
          `Imported One,IMP-1,${y - 12}-03-01,Class 7,A,51,`,
          `Imported Two,IMP-2,,Class 7,Z,,`,
          `Imported Three,EXIST-1,,,,,`,
          `Imported Four,IMP-1,,,,,`,
          `Kiran Rao,IMP-5,${y - 12}-01-15,,,,`,
          `Imported Six,IMP-6,,Class 7,A,51,`,
        ]),
      });
      expect(p.mapping.find((m) => m.field === "admission_no")?.column).toBe("Adm No");
      expect(p.ignoredColumns).toEqual(["Notes"]);
      const byLine = new Map(p.rows.map((r) => [r.line, r]));
      expect(byLine.get(2)!.errors).toEqual([]);
      expect(byLine.get(3)!.errors.join(" ")).toContain('No section "Class 7 Z"');
      expect(byLine.get(4)!.errors.join(" ")).toContain("already exists");
      expect(byLine.get(5)!.errors.join(" ")).toContain("Same admission number as line 2");
      expect(byLine.get(6)!.errors).toEqual([]);
      expect(byLine.get(6)!.warnings.join(" ")).toContain("Possible duplicate: student EXIST-1");
      expect(byLine.get(7)!.errors.join(" ")).toContain("Same class, section and roll number as line 2");
      const [n] = (await owner.db.execute(sql`select count(*)::int as n from student_profiles where admission_no like 'IMP-%'`)) as unknown as { n: number }[];
      expect(n!.n).toBe(0);
    });

    it("imports all rows once; a retry or a concurrent duplicate never creates students twice", async () => {
      const text = csv([`Batch One,BAT-1,,Class 7,B,61,`, `Batch Two,BAT-2,,Class 7,B,62,`, `Batch Three,BAT-3,,,,,`]);
      const p = await previewStudentImport(app.db, admin, A.id, { text, yearId });
      expect(p.invalid).toBe(0);
      const key = randomUUID();
      const [r1, r2] = await Promise.all([
        commitStudentImport(app.db, admin, A.id, { text, yearId, fingerprint: p.fingerprint, idempotencyKey: key }).then((r) => r, (e: unknown) => e),
        commitStudentImport(app.db, admin, A.id, { text, yearId, fingerprint: p.fingerprint, idempotencyKey: key }).then((r) => r, (e: unknown) => e),
      ]);
      const ok = [r1, r2].filter((r): r is Awaited<ReturnType<typeof commitStudentImport>> => !(r instanceof Error));
      expect(ok.length).toBeGreaterThanOrEqual(1);
      const firstResult = ok.find((r) => !r.replayed)!;
      expect(firstResult).toMatchObject({ created: 3, enrolled: 2 });
      expect(firstResult.codes!.map((c) => c.username)).toEqual(["stua.bat-1", "stua.bat-2", "stua.bat-3"]);
      const replay = await commitStudentImport(app.db, admin, A.id, { text, yearId, fingerprint: p.fingerprint, idempotencyKey: key });
      expect(replay).toMatchObject({ created: 3, codes: null, replayed: true });
      const [n] = (await owner.db.execute(sql`select count(*)::int as n from student_profiles where admission_no like 'BAT-%'`)) as unknown as { n: number }[];
      expect(n!.n).toBe(3);
      // A new attempt with a fresh key now fails as a whole: the rows already exist.
      expect(await outcome(commitStudentImport(app.db, admin, A.id, { text, yearId, fingerprint: p.fingerprint, idempotencyKey: randomUUID() }))).toBe("VALIDATION");
    });

    it("refuses a changed file or year, rows with errors, and non-admins", async () => {
      const text = csv([`Change One,CHG-1,,,,,`]);
      const p = await previewStudentImport(app.db, admin, A.id, { text, yearId });
      expect(await outcome(commitStudentImport(app.db, admin, A.id, { text: text + "\nChange Two,CHG-2,,,,,", yearId, fingerprint: p.fingerprint, idempotencyKey: randomUUID() }))).toBe("CONFLICT");
      expect(await outcome(commitStudentImport(app.db, admin, A.id, { text, yearId: nextYearId, fingerprint: p.fingerprint, idempotencyKey: randomUUID() }))).toBe("CONFLICT");
      const bad = csv([`Good Row,GOOD-1,,,,,`, `Bad Row,GOOD-2,,Class 9,A,,`]);
      const pb = await previewStudentImport(app.db, admin, A.id, { text: bad, yearId });
      expect(await outcome(commitStudentImport(app.db, admin, A.id, { text: bad, yearId, fingerprint: pb.fingerprint, idempotencyKey: randomUUID() }))).toBe("VALIDATION");
      const [n] = (await owner.db.execute(sql`select count(*)::int as n from student_profiles where admission_no = 'GOOD-1'`)) as unknown as { n: number }[];
      expect(n!.n).toBe(0);
      expect(await outcome(previewStudentImport(app.db, A.ctx(A.teacherId), A.id, { text, yearId }))).toBe("FORBIDDEN");
    });
  });

  describe("search, reports, export and documents", () => {
    it("searches and filters; the report counts sections; exports neutralise formulas", async () => {
      await admit({ fullName: "=HYPERLINK(evil)", admissionNo: "FORMULA-1", sectionId: s7A });
      const found = await searchStudents(app.db, admin, A.id, { ...all, search: "formula" });
      expect(found.rows.map((r) => [r.admissionNo, r.sectionLabel])).toEqual([["FORMULA-1", "Class 7 A"]]);
      const in7B = await searchStudents(app.db, admin, A.id, { ...all, sectionId: s7B, status: "active" });
      expect(in7B.rows.every((r) => r.sectionLabel === "Class 7 B")).toBe(true);
      const unenrolled = await searchStudents(app.db, admin, A.id, { ...all, enrolled: "none", status: "active" });
      expect(unenrolled.rows.every((r) => r.sectionId === null)).toBe(true);

      const report = await getEnrollmentReport(app.db, admin, A.id);
      const a = report.sections.find((s) => s.sectionId === s7A)!;
      expect(a).toMatchObject({ label: "Class 7 A", capacity: 40 });
      expect(a.enrolled).toBe((await getSectionRoster(app.db, admin, A.id, s7A)).length);
      expect(report.totalEnrolled).toBe(report.sections.reduce((n, s) => n + s.enrolled, 0));
      expect(await exportEnrollmentReportCsv(app.db, admin, A.id)).toContain("Class 7 A,40,");

      const out = await exportStudentsCsv(app.db, admin, A.id, { search: "formula" });
      expect(out).toContain("'=HYPERLINK(evil)");
      expect(await outcome(exportStudentsCsv(app.db, A.ctx(A.teacherId), A.id, { search: "" }))).toBe("FORBIDDEN");
    });

    it("documents are private files visible to administrators only, and are removed without deleting history", async () => {
      const s = await admit({ fullName: "Doc Student" });
      const f = await uploadFile(app.db, admin, storage, { schoolId: A.id, purpose: "student_document", fileName: "birth-certificate.pdf", data: PDF });
      const general = await uploadFile(app.db, admin, storage, { schoolId: A.id, purpose: "general", fileName: "notes.pdf", data: PDF });
      expect(await outcome(attachStudentDocument(app.db, admin, A.id, s.studentId, { fileId: general.id, title: "Notes" }))).toBe("VALIDATION");
      const { id } = await attachStudentDocument(app.db, admin, A.id, s.studentId, { fileId: f.id, title: "Birth certificate" });
      expect((await listStudentDocuments(app.db, admin, A.id, s.studentId)).map((d) => d.title)).toEqual(["Birth certificate"]);
      expect(await outcome(listStudentDocuments(app.db, A.ctx(A.teacherId), A.id, s.studentId))).toBe("FORBIDDEN");
      await removeStudentDocument(app.db, admin, A.id, id);
      expect(await listStudentDocuments(app.db, admin, A.id, s.studentId)).toEqual([]);
      const [row] = (await owner.db.execute(sql`select removed_at is not null as removed from student_documents where id = ${id}::uuid`)) as unknown as { removed: boolean }[];
      expect(row!.removed).toBe(true);
    });
  });

  it("usernames are built from the school code and admission number", () => {
    expect(studentUsername("GVPS", "2026/014")).toBe("gvps.2026-014");
    expect(studentUsername("srv", "--A__1--")).toBe("srv.a-1");
  });
});
