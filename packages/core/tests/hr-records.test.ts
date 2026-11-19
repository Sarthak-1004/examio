import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { hrDocuments, hrEmploymentEvents, hrPaymentDetails, withContext, type RequestContext } from "@examio/db";
import { schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { uploadFile } from "../src/files/files";
import { localDiskStorage } from "../src/files/storage";
import {
  addHrDocument,
  createHrName,
  getHrRecord,
  listHrNames,
  listHrStaff,
  removeHrDocument,
  setHrNameArchived,
  setPaymentDetails,
  updateEmployment,
} from "../src/services/hr/records";
import { createStaffMember, markStaffLeft, reactivateStaff } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 14.1: HR records. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const storage = localDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), "examio-hr-test-")));
const PDF = Buffer.from("%PDF-1.4\n%test\n");

describe("hr records", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let teacher: RequestContext;
  let clerk: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("hra");
    B = await makeSchool("hrb");
    admin = A.ctx(A.adminId);
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Meena Iyer", email: `t-${randomUUID().slice(0, 6)}@hr.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    id.teacher = t.staffId;
    const t2 = await createStaffMember(app.db, admin, A.id, { fullName: "Ravi Kumar", email: `r-${randomUUID().slice(0, 6)}@hr.test`, employeeNo: "T-2", role: "teacher" });
    id.other = t2.staffId;
    clerk = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Fee Clerk", email: `f-${randomUUID().slice(0, 6)}@hr.test`, employeeNo: "F-1", role: "finance" })).userId);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("departments and designations: unique names, archiving, administrators only", async () => {
    expect(await outcome(createHrName(app.db, teacher, A.id, "department", "Science"))).toBe("FORBIDDEN");
    id.science = (await createHrName(app.db, admin, A.id, "department", "Science")).id;
    id.maths = (await createHrName(app.db, admin, A.id, "department", "Mathematics")).id;
    expect(await outcome(createHrName(app.db, admin, A.id, "department", "science"))).toBe("CONFLICT");
    id.pgt = (await createHrName(app.db, admin, A.id, "designation", "PGT")).id;
    id.tgt = (await createHrName(app.db, admin, A.id, "designation", "TGT")).id;
    await setHrNameArchived(app.db, admin, A.id, "designation", id.tgt, true);
    expect((await listHrNames(app.db, admin, A.id, "designation")).map((d) => [d.name, d.archived])).toEqual([["PGT", false], ["TGT", true]]);
  });

  it("employment changes are kept as dated history; archived names cannot be newly chosen", async () => {
    expect(await outcome(updateEmployment(app.db, admin, A.id, id.teacher!, { employmentType: "permanent", designationId: id.tgt }))).toBe("NOT_FOUND");
    expect(await outcome(updateEmployment(app.db, admin, A.id, id.teacher!, { employmentType: "contract", confirmedOn: today }))).toBe("VALIDATION");
    expect(await updateEmployment(app.db, admin, A.id, id.teacher!, { employmentType: "probation", departmentId: id.science, designationId: id.pgt, effectiveOn: "2025-06-01", noticeDays: "30", emergencyName: "Suresh Iyer", emergencyPhone: "98765 00091" })).toEqual({ changes: 3 });
    // Only what changed is recorded.
    expect(await updateEmployment(app.db, admin, A.id, id.teacher!, { employmentType: "probation", departmentId: id.science, designationId: id.pgt, noticeDays: "60" })).toEqual({ changes: 0 });
    expect(await updateEmployment(app.db, admin, A.id, id.teacher!, { employmentType: "permanent", departmentId: id.maths, designationId: id.pgt, confirmedOn: "2026-06-01", effectiveOn: "2026-06-01", note: "Confirmed after probation" })).toEqual({ changes: 3 });
    const r = await getHrRecord(app.db, admin, A.id, id.teacher!);
    expect(r.employment).toMatchObject({ employmentType: "permanent", department: "Mathematics", designation: "PGT", noticeDays: null, emergencyName: null });
    expect(r.history.map((h) => [h.kind, h.effectiveOn, h.fromValue, h.toValue]).reverse()).toEqual([
      ["employment_type", "2025-06-01", null, "Probation"],
      ["department", "2025-06-01", null, "Science"],
      ["designation", "2025-06-01", null, "PGT"],
      ["employment_type", "2026-06-01", "Probation", "Permanent"],
      ["department", "2026-06-01", "Science", "Mathematics"],
      ["confirmed", "2026-06-01", null, "2026-06-01"],
    ]);
    expect((await listHrStaff(app.db, admin, A.id, { departmentId: id.maths })).map((s) => s.name)).toEqual(["Meena Iyer"]);
    expect((await listHrStaff(app.db, admin, A.id, { employmentType: "permanent", search: "iyer" })).map((s) => s.employeeNo)).toEqual(["T-1"]);
  });

  it("leaving and rejoining appear in the history; history cannot be changed", async () => {
    await markStaffLeft(app.db, admin, A.id, id.other!, { leftOn: today, reason: "Moved city" });
    expect(await outcome(updateEmployment(app.db, admin, A.id, id.other!, { employmentType: "contract" }))).toBe("CONFLICT");
    await reactivateStaff(app.db, admin, A.id, id.other!);
    expect((await getHrRecord(app.db, admin, A.id, id.other!)).history.map((h) => [h.kind, h.note])).toEqual([["rejoined", null], ["left", "Moved city"]]);
    expect(await withContext(app.db, admin, (tx) => tx.update(hrEmploymentEvents).set({ note: "x" }).returning()).then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message))).toMatch(/permission denied/);
  });

  it("payment details: validated, masked in the record, visible to administrators and finance only, not in the audit log", async () => {
    expect(await outcome(setPaymentDetails(app.db, admin, A.id, id.teacher!, { accountHolder: "Meena Iyer", accountNo: "12ab", ifsc: "SBIN0001234" }))).toBe("VALIDATION");
    expect(await outcome(setPaymentDetails(app.db, admin, A.id, id.teacher!, { accountHolder: "Meena Iyer", accountNo: "123456789012", ifsc: "sbin1001234" }))).toBe("VALIDATION");
    await setPaymentDetails(app.db, admin, A.id, id.teacher!, { accountHolder: "Meena Iyer", accountNo: "1234 5678 9012", ifsc: "sbin0001234", pan: "abcde1234f" });
    expect((await getHrRecord(app.db, admin, A.id, id.teacher!)).payment).toMatchObject({ accountLast4: "9012", ifsc: "SBIN0001234", pan: "ABCDE1234F" });
    expect(await withContext(app.db, clerk, (tx) => tx.select().from(hrPaymentDetails))).toHaveLength(1);
    // Since Phase 14.5 a staff member reads their own details (for their payslip), nobody else's.
    expect((await withContext(app.db, teacher, (tx) => tx.select().from(hrPaymentDetails))).map((d) => d.staffId)).toEqual([id.teacher]);
    await setPaymentDetails(app.db, admin, A.id, id.other!, { accountHolder: "Ravi Kumar", accountNo: "555566667777", ifsc: "SBIN0001234" });
    expect((await withContext(app.db, teacher, (tx) => tx.select().from(hrPaymentDetails))).map((d) => d.staffId)).toEqual([id.teacher]);
    expect(await outcome(setPaymentDetails(app.db, clerk, A.id, id.teacher!, { accountHolder: "X", accountNo: "123456", ifsc: "SBIN0001234" }))).toBe("FORBIDDEN");
    const logged = (await owner.db.execute(sql`select count(*)::int as n from audit_events where data::text like '%123456789012%'`)) as unknown as { n: number }[];
    expect(logged[0]!.n).toBe(0);
  });

  it("HR documents are private to administrators and removed by marking", async () => {
    const up = await uploadFile(app.db, admin, storage, { schoolId: A.id, purpose: "hr_document", fileName: "appointment.pdf", data: PDF });
    expect(await outcome(uploadFile(app.db, teacher, storage, { schoolId: A.id, purpose: "hr_document", fileName: "x.pdf", data: PDF }))).toBe("FORBIDDEN");
    const general = await uploadFile(app.db, admin, storage, { schoolId: A.id, purpose: "general", fileName: "g.pdf", data: PDF });
    expect(await outcome(addHrDocument(app.db, admin, A.id, id.teacher!, { kind: "appointment_letter", fileId: general.id }))).toBe("VALIDATION");
    const d = await addHrDocument(app.db, admin, A.id, id.teacher!, { kind: "appointment_letter", fileId: up.id, note: "Signed copy" });
    expect((await getHrRecord(app.db, admin, A.id, id.teacher!)).documents.map((x) => [x.kind, x.fileName])).toEqual([["appointment_letter", "appointment.pdf"]]);
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(hrDocuments))).toHaveLength(0);
    expect(await withContext(app.db, clerk, (tx) => tx.select().from(hrDocuments))).toHaveLength(0);
    await removeHrDocument(app.db, admin, A.id, d.id);
    expect(await outcome(removeHrDocument(app.db, admin, A.id, d.id))).toBe("NOT_FOUND");
    expect((await getHrRecord(app.db, admin, A.id, id.teacher!)).documents).toHaveLength(0);
    expect(await owner.db.select().from(hrDocuments)).toHaveLength(1);
  });

  it("other schools and staff without the capability see nothing", async () => {
    expect(await outcome(getHrRecord(app.db, teacher, A.id, id.teacher!))).toBe("FORBIDDEN");
    expect(await outcome(listHrStaff(app.db, clerk, A.id))).toBe("FORBIDDEN");
    const other = B.ctx(B.adminId);
    expect(await outcome(getHrRecord(app.db, other, B.id, id.teacher!))).toBe("NOT_FOUND");
    expect(await outcome(updateEmployment(app.db, other, B.id, id.teacher!, { employmentType: "contract" }))).toBe("NOT_FOUND");
    expect(await withContext(app.db, other, (tx) => tx.select().from(hrEmploymentEvents))).toHaveLength(0);
    const bDept = (await createHrName(app.db, other, B.id, "department", "Science")).id;
    expect(bDept).not.toBe(id.science);
    // A staff member sees their own employment terms and history, nobody else's.
    const own = await withContext(app.db, teacher, (tx) => tx.execute(sql`select staff_id from hr_employment`));
    expect((own as unknown as { staff_id: string }[]).map((r) => r.staff_id)).toEqual([id.teacher]);
  });
});
