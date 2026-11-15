import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { files, homework, homeworkSubmissions, notifications, withContext, type RequestContext } from "@examio/db";
import { addDays, instantToZonedLocal, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { uploadFile } from "../src/files/files";
import { localDiskStorage } from "../src/files/storage";
import { archiveAnnouncement, listAnnouncementsForStaff, listMyNotices, publishAnnouncement } from "../src/services/communication/announcements";
import {
  archiveHomework,
  createHomework,
  getChildHomework,
  getHomeworkForStaff,
  getMyHomework,
  listChildHomework,
  listHomeworkForStaff,
  listMyHomework,
  remindHomework,
  returnFeedback,
  submitHomework,
  updateHomework,
} from "../src/services/communication/homework";
import { createClass, createSection, createSubject, setClassSubjects } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { assignTeacher } from "../src/services/staff/assignments";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount, revokeGuardianLink } from "../src/services/students/guardians";
import { admitStudent, getStudentDetail } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 7: homework, submissions, feedback, notices and their notifications. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const storage = localDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), "examio-hw-test-")));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

describe("homework and notices", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let s7A: string;
  let s7B: string;
  let math: string;
  let t1: RequestContext;
  let t2: RequestContext;
  let k1: { studentId: string; userId: string };
  let k2: { studentId: string; userId: string };
  let k3: { studentId: string; userId: string };
  let parent: { userId: string; ctx: RequestContext };
  let bStudent: string;
  let tomorrow: string;

  const recipientsOf = async (dedupe: string) =>
    new Set((await owner.db.select({ r: notifications.recipientUserId }).from(notifications).where(and(eq(notifications.dedupeKey, dedupe), eq(notifications.channel, "in_app")))).map((x) => x.r));

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("hwa");
    B = await makeSchool("hwb");
    admin = A.ctx(A.adminId);
    const today = schoolToday("Asia/Kolkata");
    tomorrow = `${addDays(today, 1)}T17:00`;
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c7 = (await createClass(app.db, admin, A.id, { name: "Class 7", sortOrder: 7 })).id;
    s7A = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "A" })).id;
    s7B = (await createSection(app.db, admin, A.id, { yearId, classId: c7, name: "B" })).id;
    math = (await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "MATH" })).id;
    await setClassSubjects(app.db, admin, A.id, { yearId, classId: c7, subjectIds: [math] });
    const mkT = async (no: string, sectionId: string) => {
      const t = await createStaffMember(app.db, admin, A.id, { fullName: `Teacher ${no}`, email: `${no.toLowerCase()}-${randomUUID().slice(0, 6)}@hw.test`, employeeNo: no, role: "teacher" });
      await assignTeacher(app.db, admin, A.id, { staffId: t.staffId, sectionId, subjectId: math });
      return A.ctx(t.userId);
    };
    t1 = await mkT("T-1", s7A);
    t2 = await mkT("T-2", s7B);
    const mkS = async (name: string, sectionId: string) => {
      const s = await admitStudent(app.db, admin, A.id, { fullName: `${name} Student`, admissionNo: `HW-${name}`, admittedOn: `${y - 1}-06-01`, sectionId });
      return { studentId: s.studentId, userId: s.userId };
    };
    k1 = await mkS("One", s7A);
    k2 = await mkS("Two", s7A);
    k3 = await mkS("Three", s7B);
    const g = await createGuardianAccount(app.db, admin, A.id, k1.studentId, { fullName: "Parent Of One", email: `p1-${randomUUID().slice(0, 6)}@hw.test`, relationship: "mother" });
    parent = { userId: g.userId, ctx: A.ctx(g.userId) };
    bStudent = (await admitStudent(app.db, B.ctx(B.adminId), B.id, { fullName: "Other School", admissionNo: "HW-B" })).userId;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  describe("homework", () => {
    let hwId: string;

    it("a teacher sets homework for their own section; its students and parents see it and are notified once", async () => {
      expect(await outcome(createHomework(app.db, t1, A.id, { sectionIds: [s7B], subjectId: math, title: "Not mine", dueAt: tomorrow }))).toBe("NOT_FOUND");
      expect(await outcome(createHomework(app.db, t1, A.id, { sectionIds: [s7A], subjectId: math, title: "Past", dueAt: "2020-01-01T10:00" }))).toBe("VALIDATION");
      expect(await outcome(createHomework(app.db, A.ctx(k1.userId), A.id, { sectionIds: [s7A], subjectId: math, title: "x", dueAt: tomorrow }))).toBe("FORBIDDEN");
      const { ids } = await createHomework(app.db, t1, A.id, { sectionIds: [s7A], subjectId: math, title: "Fractions worksheet", instructions: "Do 1-10.", dueAt: tomorrow });
      hwId = ids[0]!;
      // Notified: the section's students and the linked parent; not 7B, not another school.
      const notified = await recipientsOf(`homework:${hwId}`);
      expect(notified).toEqual(new Set([k1.userId, k2.userId, parent.userId]));
      expect(notified.has(k3.userId) || notified.has(bStudent)).toBe(false);
      // A retry of the notification step creates nothing new.
      const [again] = (await withContext(app.db, t1, (tx) => tx.execute(sql`select app_notify_audience('homework', ${hwId}::uuid, 'homework.published', '{"title":"Fractions worksheet","subject":"Mathematics","section":"Class 7 A","dueAt":"2030-01-01T00:00:00Z"}'::jsonb, ${`homework:${hwId}`}) as n`))) as unknown as { n: number }[];
      expect(again!.n).toBe(0);
      // Someone who may not manage the homework cannot trigger notifications for it.
      expect(await outcome(withContext(app.db, t2, (tx) => tx.execute(sql`select app_notify_audience('homework', ${hwId}::uuid, 'homework.published', '{}'::jsonb, 'x')`)))).not.toBe("OK");

      expect((await listMyHomework(app.db, A.ctx(k1.userId), A.id)).map((h) => h.title)).toEqual(["Fractions worksheet"]);
      expect(await listMyHomework(app.db, A.ctx(k3.userId), A.id)).toEqual([]);
      expect(await outcome(getMyHomework(app.db, A.ctx(k3.userId), A.id, hwId))).toBe("NOT_FOUND");
      expect((await listChildHomework(app.db, parent.ctx, A.id, k1.studentId)).map((h) => h.title)).toEqual(["Fractions worksheet"]);
      expect(await listChildHomework(app.db, parent.ctx, A.id, k3.studentId)).toEqual([]);
      expect((await listHomeworkForStaff(app.db, t1, A.id)).map((h) => [h.title, h.students, h.submitted])).toEqual([["Fractions worksheet", 2, 0]]);
      expect(await listHomeworkForStaff(app.db, t2, A.id)).toEqual([]);
      // The due time is stored as an instant and shown back in the school's time zone.
      expect((await getMyHomework(app.db, A.ctx(k1.userId), A.id, hwId)).dueLocal).toBe(tomorrow);
    });

    it("students submit privately and may change it until feedback is returned", async () => {
      const k1ctx = A.ctx(k1.userId);
      expect(await outcome(submitHomework(app.db, k1ctx, A.id, hwId, { body: "" }))).toBe("VALIDATION");
      expect(await submitHomework(app.db, k1ctx, A.id, hwId, { body: "My answers" })).toEqual({ late: false, created: true });
      expect(await submitHomework(app.db, k1ctx, A.id, hwId, { body: "My better answers" })).toEqual({ late: false, created: false });
      // Another student and the other section's teacher cannot read it.
      const seenByK2 = await withContext(app.db, A.ctx(k2.userId), (tx) => tx.select({ id: homeworkSubmissions.id }).from(homeworkSubmissions));
      expect(seenByK2).toHaveLength(0);
      const seenByT2 = await withContext(app.db, t2, (tx) => tx.select({ id: homeworkSubmissions.id }).from(homeworkSubmissions));
      expect(seenByT2).toHaveLength(0);
      // A student cannot submit on someone else's behalf.
      const forged = await withContext(app.db, k1ctx, (tx) => tx.insert(homeworkSubmissions).values({ schoolId: A.id, homeworkId: hwId, studentId: k2.studentId, body: "forged" })).then(() => "inserted", () => "refused");
      expect(forged).toBe("refused");

      const staff = await getHomeworkForStaff(app.db, t1, A.id, hwId);
      const row = staff.rows.find((r) => r.studentId === k1.studentId)!;
      expect(row).toMatchObject({ body: "My better answers", late: false });
      expect(staff.rows.find((r) => r.studentId === k2.studentId)!.submissionId).toBeNull();
      expect(await outcome(getHomeworkForStaff(app.db, t2, A.id, hwId))).toBe("NOT_FOUND");

      await returnFeedback(app.db, t1, A.id, row.submissionId!, "Good work. Check question 7.");
      await returnFeedback(app.db, t1, A.id, row.submissionId!, "Good work. Check question 7 again.");
      expect(await recipientsOf(`feedback:${row.submissionId}`)).toEqual(new Set([k1.userId, parent.userId]));
      const mine = await getMyHomework(app.db, k1ctx, A.id, hwId);
      expect(mine.submission).toMatchObject({ feedback: "Good work. Check question 7 again." });
      expect(mine.canSubmit).toBe(false);
      expect(await outcome(submitHomework(app.db, k1ctx, A.id, hwId, { body: "Changed after feedback" }))).toBe("CONFLICT");
      const direct = await withContext(app.db, k1ctx, (tx) => tx.update(homeworkSubmissions).set({ body: "sneaky" }).where(eq(homeworkSubmissions.id, row.submissionId!)).returning({ id: homeworkSubmissions.id }));
      expect(direct).toHaveLength(0);
      expect((await getChildHomework(app.db, parent.ctx, A.id, k1.studentId, hwId)).submission?.feedback).toContain("question 7");
      expect(await outcome(returnFeedback(app.db, t2, A.id, row.submissionId!, "Not my class"))).toBe("NOT_FOUND");
    });

    it("after the due time only late-friendly homework accepts a first submission, marked late", async () => {
      await owner.db.update(homework).set({ dueAt: new Date(Date.now() - 3600_000) }).where(eq(homework.id, hwId));
      expect(await outcome(submitHomework(app.db, A.ctx(k2.userId), A.id, hwId, { body: "Too late" }))).toBe("CONFLICT");
      const due = instantToZonedLocal(new Date(Date.now() - 3600_000), "Asia/Kolkata");
      await updateHomework(app.db, t1, A.id, hwId, { title: "Fractions worksheet", instructions: "Do 1-10.", dueAt: due, allowLate: true });
      expect(await submitHomework(app.db, A.ctx(k2.userId), A.id, hwId, { body: "Sorry, late" })).toEqual({ late: true, created: true });
    });

    it("attachments and submission files are readable exactly by those who can read the homework or submission", async () => {
      const att = await uploadFile(app.db, t1, storage, { schoolId: A.id, purpose: "homework_attachment", fileName: "sheet.pdf", data: PDF });
      expect(await outcome(uploadFile(app.db, A.ctx(k1.userId), storage, { schoolId: A.id, purpose: "homework_attachment", fileName: "x.pdf", data: PDF }))).toBe("FORBIDDEN");
      expect(await outcome(uploadFile(app.db, t1, storage, { schoolId: A.id, purpose: "homework_submission", fileName: "x.pdf", data: PDF }))).toBe("FORBIDDEN");
      const { ids } = await createHomework(app.db, t1, A.id, { sectionIds: [s7A], subjectId: math, title: "With a sheet", dueAt: tomorrow, fileIds: [att.id] });
      const canSee = async (ctx: RequestContext, fileId: string) => (await withContext(app.db, ctx, (tx) => tx.select({ id: files.id }).from(files).where(eq(files.id, fileId)))).length === 1;
      expect(await canSee(A.ctx(k1.userId), att.id)).toBe(true);
      expect(await canSee(parent.ctx, att.id)).toBe(true);
      expect(await canSee(A.ctx(k3.userId), att.id)).toBe(false);

      const sub = await uploadFile(app.db, A.ctx(k2.userId), storage, { schoolId: A.id, purpose: "homework_submission", fileName: "answer.pdf", data: PDF });
      await submitHomework(app.db, A.ctx(k2.userId), A.id, ids[0]!, { fileIds: [sub.id] });
      expect(await canSee(t1, sub.id)).toBe(true);
      expect(await canSee(A.ctx(k1.userId), sub.id)).toBe(false);
      expect(await canSee(t2, sub.id)).toBe(false);
      // Someone else's upload cannot be attached.
      expect(await outcome(submitHomework(app.db, A.ctx(k1.userId), A.id, ids[0]!, { fileIds: [sub.id] }))).toBe("VALIDATION");
    });

    it("reminders reach only students who have not submitted, once a day; archived homework disappears", async () => {
      const { ids } = await createHomework(app.db, t1, A.id, { sectionIds: [s7A], subjectId: math, title: "Reminder test", dueAt: tomorrow });
      await submitHomework(app.db, A.ctx(k1.userId), A.id, ids[0]!, { body: "Done" });
      const first = await remindHomework(app.db, t1, A.id, ids[0]!);
      expect(first.notified).toBeGreaterThan(0);
      const today = schoolToday("Asia/Kolkata");
      expect(await recipientsOf(`homework-reminder:${ids[0]}:${today}`)).toEqual(new Set([k2.userId]));
      expect((await remindHomework(app.db, t1, A.id, ids[0]!)).notified).toBe(0);
      await archiveHomework(app.db, t1, A.id, ids[0]!);
      expect((await listMyHomework(app.db, A.ctx(k2.userId), A.id)).map((h) => h.id)).not.toContain(ids[0]);
    });
  });

  describe("notices", () => {
    it("administrators address any audience; teachers only their sections; recipients see what is addressed to them", async () => {
      const toParents = await publishAnnouncement(app.db, admin, A.id, { title: "Parents meeting", body: "Saturday 10 am.", audience: "parents" });
      expect(await recipientsOf(`announcement:${toParents.id}`)).toEqual(new Set([parent.userId]));
      const cls = await publishAnnouncement(app.db, t1, A.id, { title: "Bring compasses", body: "Tomorrow.", audience: "section", sectionId: s7A });
      expect(await recipientsOf(`announcement:${cls.id}`)).toEqual(new Set([k1.userId, k2.userId, parent.userId]));
      expect(await outcome(publishAnnouncement(app.db, t1, A.id, { title: "x", body: "y", audience: "everyone" }))).toBe("FORBIDDEN");
      expect(await outcome(publishAnnouncement(app.db, t1, A.id, { title: "x", body: "y", audience: "section", sectionId: s7B }))).toBe("NOT_FOUND");
      expect(await outcome(publishAnnouncement(app.db, A.ctx(k1.userId), A.id, { title: "x", body: "y", audience: "section", sectionId: s7A }))).toBe("FORBIDDEN");
      expect(await outcome(publishAnnouncement(app.db, admin, A.id, { title: "x", body: "y", audience: "section" }))).toBe("VALIDATION");

      expect((await listMyNotices(app.db, parent.ctx, A.id)).map((n) => n.title).sort()).toEqual(["Bring compasses", "Parents meeting"]);
      expect((await listMyNotices(app.db, A.ctx(k1.userId), A.id)).map((n) => n.title)).toEqual(["Bring compasses"]);
      expect(await listMyNotices(app.db, A.ctx(k3.userId), A.id)).toEqual([]);
      expect(await listMyNotices(app.db, B.ctx(B.adminId), B.id)).toEqual([]);

      const staff = await listAnnouncementsForStaff(app.db, t1, A.id);
      expect(staff.find((n) => n.id === cls.id)?.delivery?.recipients).toBe(3);
      expect(staff.find((n) => n.id === toParents.id)).toBeUndefined();
      expect((await listAnnouncementsForStaff(app.db, admin, A.id)).find((n) => n.id === cls.id)?.delivery?.recipients).toBe(3);
      await archiveAnnouncement(app.db, t1, A.id, cls.id);
      expect((await listMyNotices(app.db, A.ctx(k1.userId), A.id)).map((n) => n.title)).toEqual([]);
    });

    it("revoking a guardian link removes the parent's access to the child's homework and notices at once", async () => {
      await publishAnnouncement(app.db, t1, A.id, { title: "Class trip", body: "Friday.", audience: "section", sectionId: s7A });
      expect((await listMyNotices(app.db, parent.ctx, A.id)).map((n) => n.title)).toContain("Class trip");
      const link = (await getStudentDetail(app.db, admin, A.id, k1.studentId)).guardians[0]!;
      await revokeGuardianLink(app.db, admin, A.id, link.linkId);
      expect(await outcome(listChildHomework(app.db, parent.ctx, A.id, k1.studentId))).toBe("NOT_FOUND"); // no membership left: like any outsider
      const rows = await withContext(app.db, parent.ctx, (tx) => tx.select({ id: homework.id }).from(homework));
      expect(rows).toHaveLength(0);
    });
  });
});
