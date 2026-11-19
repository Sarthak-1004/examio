import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { RequestContext } from "@examio/db";
import { schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { createApplication } from "../src/services/admissions/admissions";
import { addAssets, allocateAsset, createItem, createLocation, receiveStock } from "../src/services/inventory/inventory";
import { createTitle, issueCopy } from "../src/services/library/library";
import {
  exportApplicationsCsv,
  exportInventoryCsv,
  exportLibraryLoansCsv,
  getAdmissionsSummary,
  getInventorySummary,
  getLibrarySummary,
} from "../src/services/operations/reports";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 13.5: dashboard figures and scoped exports for admissions, library and inventory. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

describe("operations reports", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let teacher: RequestContext;
  const today = schoolToday("Asia/Kolkata");

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("opa");
    B = await makeSchool("opb");
    admin = A.ctx(A.adminId);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c = (await createClass(app.db, admin, A.id, { name: "Class 2", sortOrder: 2 })).id;
    const sec = (await createSection(app.db, admin, A.id, { yearId, classId: c, name: "A" })).id;
    teacher = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Ops", email: `t-${randomUUID().slice(0, 6)}@ops.test`, employeeNo: "T-1", role: "teacher" })).userId);
    await admitStudent(app.db, admin, A.id, { fullName: "Dev", admissionNo: "S-1", sectionId: sec });

    await createApplication(app.db, admin, A.id, { yearId, classId: c, applicantName: "=HYPERLINK(\"x\")", guardianName: "Guardian One", guardianPhone: "9876500081", stage: "applied" });
    await createApplication(app.db, admin, A.id, { yearId, classId: c, applicantName: "Second Child", guardianName: "Guardian Two", guardianEmail: "g2@ops.test", stage: "enquiry" });

    await createTitle(app.db, admin, A.id, { title: "Malgudi Days", author: "R. K. Narayan", accessionNos: "M-1, M-2" });
    await issueCopy(app.db, admin, A.id, { accessionNo: "M-1", borrower: "S-1" });
    await issueCopy(app.db, admin, A.id, { accessionNo: "M-2", borrower: "T-1" });
    await owner.db.execute(sql`update library_loans set due_on = ${today}::date - 3 where copy_id = (select id from library_copies where accession_no = 'M-1')`);

    const store = (await createLocation(app.db, admin, A.id, "Store")).id;
    const tab = (await createItem(app.db, admin, A.id, { name: "Tablet", kind: "asset" })).id;
    await addAssets(app.db, admin, A.id, tab, { tags: "TAB-1, TAB-2", locationId: store });
    await allocateAsset(app.db, admin, A.id, { tag: "TAB-1", staff: "T-1" });
    const paper = (await createItem(app.db, admin, A.id, { name: "Paper", kind: "consumable", unit: "reams", reorderLevel: "10" })).id;
    await receiveStock(app.db, admin, A.id, paper, { locationId: store, quantity: "4" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("dashboard figures per submodule", async () => {
    expect(await getAdmissionsSummary(app.db, admin, A.id)).toEqual({ open: 2, awaitingDecision: 0, approvedNotEnrolled: 0, enrolledThisYear: 0 });
    expect(await getLibrarySummary(app.db, admin, A.id)).toEqual({ titles: 1, copies: 2, onLoan: 2, overdue: 1 });
    expect(await getInventorySummary(app.db, admin, A.id)).toEqual({ items: 2, lowStock: 1, allocated: 1, overdueReturns: 0, underRepair: 0 });
  });

  it("exports are complete, neutralise formulas and are audited", async () => {
    const adm = (await exportApplicationsCsv(app.db, admin, A.id)).split("\r\n");
    expect(adm[0]).toMatch(/^Reference,Applicant,Date of birth,Year,Class,Status,Guardian,Guardian mobile/);
    expect(adm.filter(Boolean)).toHaveLength(3);
    expect(adm.some((l) => l.includes(`"'=HYPERLINK(""x"")"`))).toBe(true);
    expect((await exportApplicationsCsv(app.db, admin, A.id, { status: "enquiry" })).split("\r\n").filter(Boolean)).toHaveLength(2);

    const lib = (await exportLibraryLoansCsv(app.db, admin, A.id)).split("\r\n").filter(Boolean);
    expect(lib).toHaveLength(3);
    const overdue = (await exportLibraryLoansCsv(app.db, admin, A.id, { overdueOnly: true })).split("\r\n").filter(Boolean);
    expect(overdue[1]).toMatch(/^Malgudi Days,R\. K\. Narayan,M-1,Student,S-1,Dev,.*,3,0$/);

    expect((await exportInventoryCsv(app.db, admin, A.id, "assets")).split("\r\n").filter(Boolean).slice(1)).toEqual([
      "Tablet,,TAB-1,,allocated,Store,T-1,Teacher Ops,,",
      "Tablet,,TAB-2,,in_store,Store,,,,",
    ]);
    expect((await exportInventoryCsv(app.db, admin, A.id, "stock")).split("\r\n")[1]).toBe("Paper,,reams,Store,4,10");

    const audits = (await owner.db.execute(sql`select action, count(*)::int as n from audit_events where school_id = ${A.id}::uuid and action like '%.exported' group by action order by action`)) as unknown as { action: string; n: number }[];
    expect(audits).toEqual([
      { action: "admissions.exported", n: 2 },
      { action: "inventory.exported", n: 2 },
      { action: "library.exported", n: 2 },
    ]);
  });

  it("teachers and other schools get neither figures nor files", async () => {
    for (const p of [getAdmissionsSummary(app.db, teacher, A.id), exportLibraryLoansCsv(app.db, teacher, A.id), exportInventoryCsv(app.db, teacher, A.id, "assets")]) {
      expect(await outcome(p)).toBe("FORBIDDEN");
    }
    const other = B.ctx(B.adminId);
    expect(await outcome(exportApplicationsCsv(app.db, other, A.id))).toBe("NOT_FOUND");
    expect(await getLibrarySummary(app.db, other, B.id)).toEqual({ titles: 0, copies: 0, onLoan: 0, overdue: 0 });
    expect((await exportInventoryCsv(app.db, other, B.id, "assets")).split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});
