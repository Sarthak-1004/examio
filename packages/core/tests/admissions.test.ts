import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { admissionApplications, admissionEvents, enrollments, studentProfiles, users, withContext, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { uploadFile } from "../src/files/files";
import { localDiskStorage } from "../src/files/storage";
import {
  changeApplicationStatus,
  convertApplication,
  createApplication,
  getApplication,
  listApplications,
  setApplicationDocument,
  updateApplication,
} from "../src/services/admissions/admissions";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 13.1: admissions. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));
const storage = localDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), "examio-adm-test-")));
const PDF = Buffer.from("%PDF-1.4\n%test\n");

describe("admissions", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let yearId: string;
  let c1: string;
  let c2: string;
  let s1A: string;
  let s2A: string;
  let appId: string;
  const base = () => ({ yearId, classId: c1, applicantName: "Meera Nair", dateOfBirth: "2019-05-10", guardianName: "Anil Nair", guardianPhone: "9876511111" });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("ada");
    B = await makeSchool("adb");
    admin = A.ctx(A.adminId);
    const y = Number(new Date().toISOString().slice(0, 4));
    yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    c1 = (await createClass(app.db, admin, A.id, { name: "Class 1", sortOrder: 1 })).id;
    c2 = (await createClass(app.db, admin, A.id, { name: "Class 2", sortOrder: 2 })).id;
    s1A = (await createSection(app.db, admin, A.id, { yearId, classId: c1, name: "A" })).id;
    s2A = (await createSection(app.db, admin, A.id, { yearId, classId: c2, name: "A" })).id;
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("the office records an enquiry with a reference number and a document checklist; others cannot", async () => {
    expect(await outcome(createApplication(app.db, A.ctx(A.teacherId), A.id, base()))).toBe("FORBIDDEN");
    expect(await outcome(createApplication(app.db, admin, A.id, { ...base(), guardianPhone: "" }))).toBe("VALIDATION");
    const r = await createApplication(app.db, admin, A.id, base());
    appId = r.id;
    expect(r.referenceNo).toMatch(/^A\d{2}-0001$/);
    const d = await getApplication(app.db, admin, A.id, appId);
    expect(d.status).toBe("enquiry");
    expect(d.documents.filter((x) => x.required).map((x) => x.kind)).toEqual(["birth_certificate", "photo", "address_proof"]);
    expect(d.events.map((e) => e.to)).toEqual(["enquiry"]);
    expect(await withContext(app.db, A.ctx(A.teacherId), (tx) => tx.select().from(admissionApplications))).toHaveLength(0);
    expect(await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select().from(admissionApplications))).toHaveLength(0);
  });

  it("a likely duplicate application is refused unless confirmed", async () => {
    expect(await message(createApplication(app.db, admin, A.id, { ...base(), dateOfBirth: "", guardianPhone: "9876511111" }))).toMatch(/existing application/);
    const twin = await createApplication(app.db, admin, A.id, { ...base(), confirmNotDuplicate: true });
    expect(twin.referenceNo).toMatch(/-0002$/);
    await changeApplicationStatus(app.db, admin, A.id, twin.id, "withdrawn", "Recorded twice");
  });

  it("status follows the allowed steps; approval needs a date of birth and the required documents", async () => {
    expect(await outcome(changeApplicationStatus(app.db, admin, A.id, appId, "approved"))).toBe("CONFLICT");
    await changeApplicationStatus(app.db, admin, A.id, appId, "applied");
    await changeApplicationStatus(app.db, admin, A.id, appId, "under_review");
    expect(await message(changeApplicationStatus(app.db, admin, A.id, appId, "approved"))).toMatch(/Birth certificate, .*Photograph|Address proof/);
    const up = await uploadFile(app.db, admin, storage, { schoolId: A.id, purpose: "admission_document", fileName: "birth.pdf", data: PDF });
    await setApplicationDocument(app.db, admin, A.id, appId, { kind: "birth_certificate", status: "verified", fileId: up.id });
    await setApplicationDocument(app.db, admin, A.id, appId, { kind: "photo", status: "verified" });
    expect(await outcome(setApplicationDocument(app.db, admin, A.id, appId, { kind: "address_proof", status: "waived" }))).toBe("VALIDATION");
    await setApplicationDocument(app.db, admin, A.id, appId, { kind: "address_proof", status: "waived", note: "Lives in the staff quarters" });
    expect(await outcome(changeApplicationStatus(app.db, admin, A.id, appId, "rejected"))).toBe("VALIDATION"); // needs a reason
    await changeApplicationStatus(app.db, admin, A.id, appId, "approved", "Seat available");
    expect(await outcome(updateApplication(app.db, admin, A.id, appId, base()))).toBe("CONFLICT");
    // The database refuses skipped steps too.
    const other = await createApplication(app.db, admin, A.id, { ...base(), applicantName: "Ravi Iyer", guardianPhone: "9876522222" });
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(admissionApplications).set({ status: "approved", decidedBy: A.adminId, decidedAt: new Date() }).where(eq(admissionApplications.id, other.id))))).toMatch(/admission_transition/);
    const d = await getApplication(app.db, admin, A.id, appId);
    expect(d.events.map((e) => e.to)).toEqual(["approved", "under_review", "applied", "enquiry"]);
  });

  it("conversion creates exactly one student, once, even when requested twice at the same time", async () => {
    expect(await outcome(convertApplication(app.db, admin, A.id, appId, { admissionNo: "ADM-100", sectionId: s2A }))).toBe("VALIDATION"); // wrong class
    const [r1, r2] = await Promise.all([
      convertApplication(app.db, admin, A.id, appId, { admissionNo: "ADM-100", sectionId: s1A, rollNo: 5 }),
      convertApplication(app.db, admin, A.id, appId, { admissionNo: "ADM-100", sectionId: s1A, rollNo: 5 }),
    ]);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);
    expect(r1.studentId).toBe(r2.studentId);
    const created = r1.created ? r1 : r2;
    expect(created.activationCode).toMatch(/^[0-9A-Z]{4}-/);
    expect(created.username).toBe("ada.adm-100");
    expect(await owner.db.select().from(studentProfiles).where(eq(studentProfiles.admissionNo, "ADM-100"))).toHaveLength(1);
    expect(await owner.db.select().from(enrollments).where(eq(enrollments.studentId, r1.studentId))).toHaveLength(1);
    const again = await convertApplication(app.db, admin, A.id, appId, { admissionNo: "ADM-999" });
    expect(again).toMatchObject({ studentId: r1.studentId, created: false, activationCode: null });
    expect(await owner.db.select().from(users).where(eq(users.username, "ada.adm-999"))).toHaveLength(0);
    const d = await getApplication(app.db, admin, A.id, appId);
    expect(d).toMatchObject({ status: "enrolled", studentId: r1.studentId });
    expect(await outcome(changeApplicationStatus(app.db, admin, A.id, appId, "withdrawn", "Too late"))).toBe("CONFLICT");
    expect((await owner.db.select().from(admissionEvents).where(eq(admissionEvents.applicationId, appId))).at(-1)).toBeDefined();
  });

  it("no duplicate identity: an existing student with the same name and birth date, or a taken admission number, is refused", async () => {
    const existing = await admitStudent(app.db, admin, A.id, { fullName: "Kiran Rao", admissionNo: "ADM-200", dateOfBirth: "2019-01-01" });
    const k = await createApplication(app.db, admin, A.id, { yearId, classId: c1, applicantName: "Kiran Rao", dateOfBirth: "2019-01-01", guardianName: "Sita Rao", guardianEmail: "sita@example.test", stage: "applied" });
    expect((await getApplication(app.db, admin, A.id, k.id)).possibleDuplicates.map((x) => x.kind)).toEqual(["student"]);
    await changeApplicationStatus(app.db, admin, A.id, k.id, "under_review");
    for (const kind of ["birth_certificate", "photo", "address_proof"] as const) await setApplicationDocument(app.db, admin, A.id, k.id, { kind, status: "verified" });
    await changeApplicationStatus(app.db, admin, A.id, k.id, "approved");
    expect(await message(convertApplication(app.db, admin, A.id, k.id, { admissionNo: "ADM-201" }))).toMatch(/already on record/);
    expect(await message(convertApplication(app.db, admin, A.id, k.id, { admissionNo: "ADM-200", confirmNotDuplicate: true }))).toMatch(/admission number/);
    const r = await convertApplication(app.db, admin, A.id, k.id, { admissionNo: "ADM-201", confirmNotDuplicate: true });
    expect(r.created).toBe(true);
    expect(r.studentId).not.toBe(existing.studentId);
  });

  it("lists by status with counts and search", async () => {
    const all = await listApplications(app.db, admin, A.id, { yearId });
    expect(all.counts).toMatchObject({ enrolled: 2, withdrawn: 1, enquiry: 1 });
    expect((await listApplications(app.db, admin, A.id, { search: "meera", status: "enrolled" })).rows.map((r) => r.applicantName)).toEqual(["Meera Nair"]);
    expect(await outcome(listApplications(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");
    const [row] = (await owner.db.execute(sql`select count(*)::int as n from admission_applications where school_id = ${A.id}::uuid`)) as unknown as { n: number }[];
    expect(row?.n).toBe(4);
  });
});
