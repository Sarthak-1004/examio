import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { feeAdjustments, libraryCopies, libraryLoans, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { decideAdjustment, getStudentAccount } from "../src/services/fees/billing";
import {
  addCopies,
  createTitle,
  getLibrarySettings,
  getTitle,
  issueCopy,
  listChildLoans,
  listMyLoans,
  listOpenLoans,
  markLoanLost,
  parseAccessionList,
  renewLoan,
  returnCopy,
  searchCatalogue,
  setCopyStatus,
  updateLibrarySettings,
} from "../src/services/library/library";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 13.2: library. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("library", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let teacher: RequestContext;
  let s1: RequestContext;
  let parent: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("lba");
    B = await makeSchool("lbb");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@lib.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c = (await createClass(app.db, admin, A.id, { name: "Class 6", sortOrder: 6 })).id;
    const sec = (await createSection(app.db, admin, A.id, { yearId, classId: c, name: "A" })).id;
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Lib", email: `t-${randomUUID().slice(0, 6)}@lib.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    const k1 = await admitStudent(app.db, admin, A.id, { fullName: "Lata", admissionNo: "S-1", sectionId: sec });
    const k2 = await admitStudent(app.db, admin, A.id, { fullName: "Mohan", admissionNo: "S-2", sectionId: sec });
    s1 = A.ctx(k1.userId);
    [id.s1, id.s2] = [k1.studentId, k2.studentId];
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k1.studentId, { fullName: "Parent Lata", phone: "9876500061", relationship: "mother" })).userId);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("settings default and validate; the catalogue takes titles and copies with unique accession numbers", async () => {
    expect(await getLibrarySettings(app.db, admin, A.id)).toEqual({ loanDays: 14, maxRenewals: 2, maxLoansStudent: 3, maxLoansStaff: 10, finePerDayPaise: 0 });
    expect(await outcome(updateLibrarySettings(app.db, admin, A.id, { loanDays: "0", maxRenewals: "1", maxLoansStudent: "2", maxLoansStaff: "5", finePerDay: "2" }))).toBe("VALIDATION");
    await updateLibrarySettings(app.db, admin, A.id, { loanDays: "14", maxRenewals: "1", maxLoansStudent: "2", maxLoansStaff: "5", finePerDay: "2" });
    expect(parseAccessionList("B-1, B-2\nB-3")).toEqual(["B-1", "B-2", "B-3"]);
    expect(await outcome(createTitle(app.db, teacher, A.id, { title: "Wings of Fire" }))).toBe("FORBIDDEN");
    const t = await createTitle(app.db, admin, A.id, { title: "Wings of Fire", author: "A. P. J. Abdul Kalam", isbn: "978-81-7371-146-6", accessionNos: "B-1, B-2", shelf: "R2" });
    id.title = t.id;
    expect(t.copies).toBe(2);
    expect(await outcome(addCopies(app.db, admin, A.id, t.id, { accessionNos: "b-1" }))).toBe("CONFLICT");
    expect(await addCopies(app.db, admin, A.id, t.id, { accessionNos: "B-3, B-4" })).toEqual({ added: 2 });
    expect((await searchCatalogue(app.db, admin, A.id, "kalam")).map((r) => [r.title, r.copies, r.available])).toEqual([["Wings of Fire", 4, 4]]);
  });

  it("issues an available copy once, even when two desks try at the same moment", async () => {
    const r = await issueCopy(app.db, admin, A.id, { accessionNo: "b-1", borrower: "s-1" });
    expect(r).toMatchObject({ borrowerName: "Lata", title: "Wings of Fire", dueOn: addDays(today, 14) });
    expect(await message(issueCopy(app.db, admin, A.id, { accessionNo: "B-1", borrower: "S-2" }))).toMatch(/already on loan/);
    const both = await Promise.allSettled([issueCopy(app.db, admin, A.id, { accessionNo: "B-2", borrower: "S-2" }), issueCopy(app.db, admin2, A.id, { accessionNo: "B-2", borrower: "T-1" })]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await owner.db.select().from(libraryLoans).where(sql`${libraryLoans.status} = 'open' and ${libraryLoans.copyId} = (select id from library_copies where accession_no = 'B-2')`)).toHaveLength(1);
    expect(await outcome(issueCopy(app.db, admin, A.id, { accessionNo: "B-9", borrower: "S-1" }))).toBe("NOT_FOUND");
    expect(await outcome(issueCopy(app.db, admin, A.id, { accessionNo: "B-3", borrower: "X-404" }))).toBe("NOT_FOUND");
  });

  it("limits, overdue blocks and renewals", async () => {
    // Lata may hold 2 books.
    await issueCopy(app.db, admin, A.id, { accessionNo: "B-3", borrower: "S-1" });
    expect(await message(issueCopy(app.db, admin, A.id, { accessionNo: "B-4", borrower: "S-1" }))).toMatch(/the limit/);
    const loans = await listOpenLoans(app.db, admin, A.id, { search: "lata" });
    const b3 = loans.find((l) => l.accessionNo === "B-3")!;
    expect((await renewLoan(app.db, admin, A.id, b3.loanId)).dueOn).toBe(addDays(today, 14));
    expect(await message(renewLoan(app.db, admin, A.id, b3.loanId))).toMatch(/renewed 1 time/);
    // B-1 becomes overdue by 5 days: no renewal, and no new book until it comes back.
    await owner.db.execute(sql`update library_loans set due_on = ${addDays(today, -5)}::date where copy_id = (select id from library_copies where accession_no = 'B-1') and status = 'open'`);
    const b1 = (await listOpenLoans(app.db, admin, A.id, { overdueOnly: true }))[0]!;
    expect(b1).toMatchObject({ accessionNo: "B-1", overdueDays: 5 });
    expect(await message(renewLoan(app.db, admin, A.id, b1.loanId))).toMatch(/overdue/);
    await returnCopy(app.db, admin, A.id, "B-3");
    expect(await message(issueCopy(app.db, admin, A.id, { accessionNo: "B-3", borrower: "S-1" }))).toMatch(/overdue book/);
  });

  it("a late return requests a fine that takes effect only when another administrator approves it", async () => {
    const r = await returnCopy(app.db, admin, A.id, "B-1");
    expect(r).toEqual({ title: "Wings of Fire", daysLate: 5, chargePaise: 1000 });
    const [adj] = await owner.db.select().from(feeAdjustments).where(eq(feeAdjustments.studentId, id.s1!));
    expect(adj).toMatchObject({ kind: "extra_charge", amountPaise: 1000, status: "pending" });
    expect((await getStudentAccount(app.db, admin, A.id, id.s1!)).balancePaise).toBe(0);
    expect(await outcome(decideAdjustment(app.db, admin, A.id, adj!.id, true))).toBe("FORBIDDEN"); // the requester cannot approve
    await decideAdjustment(app.db, admin2, A.id, adj!.id, true);
    expect((await getStudentAccount(app.db, admin, A.id, id.s1!)).balancePaise).toBe(1000);
    expect(await message(returnCopy(app.db, admin, A.id, "B-1"))).toMatch(/not on loan/);
  });

  it("lost books: copy marked lost, an optional replacement charge for students only; copies can be withdrawn or found", async () => {
    await issueCopy(app.db, admin, A.id, { accessionNo: "B-1", borrower: "S-1" });
    const loan = (await listOpenLoans(app.db, admin, A.id, { search: "B-1" }))[0]!;
    expect(await outcome(markLoanLost(app.db, admin, A.id, loan.loanId, "abc"))).toBe("VALIDATION");
    expect(await markLoanLost(app.db, admin, A.id, loan.loanId, "350")).toEqual({ chargePaise: 35000 });
    const staffLoan = (await listOpenLoans(app.db, admin, A.id)).find((l) => l.borrowerKind === "staff");
    if (staffLoan) {
      expect(await outcome(markLoanLost(app.db, admin, A.id, staffLoan.loanId, "100"))).toBe("VALIDATION");
      await markLoanLost(app.db, admin, A.id, staffLoan.loanId, "");
    }
    const d = await getTitle(app.db, admin, A.id, id.title!);
    const b1 = d.copies.find((c) => c.accessionNo === "B-1")!;
    expect(b1.status).toBe("lost");
    expect(await owner.db.select().from(feeAdjustments).where(sql`${feeAdjustments.amountPaise} = 35000 and ${feeAdjustments.status} = 'pending'`)).toHaveLength(1);
    await setCopyStatus(app.db, admin, A.id, b1.id, "available", "Found in the hall");
    const onLoan = (await getTitle(app.db, admin, A.id, id.title!)).copies.find((c) => c.status === "issued");
    if (onLoan) expect(await outcome(setCopyStatus(app.db, admin, A.id, onLoan.id, "withdrawn"))).toBe("CONFLICT");
    expect(d.history.length).toBeGreaterThan(3);
  });

  it("students and parents see only their own loans; staff see theirs; other schools nothing", async () => {
    await issueCopy(app.db, admin, A.id, { accessionNo: "B-4", borrower: "S-2" });
    const mine = await listMyLoans(app.db, s1, A.id);
    expect(mine.every((l) => l.title === "Wings of Fire")).toBe(true);
    expect(mine.map((l) => l.status).sort()).toEqual(["lost", "returned", "returned"]);
    expect((await listChildLoans(app.db, parent, A.id, id.s1!)).length).toBe(3);
    expect(await outcome(listChildLoans(app.db, parent, A.id, id.s2!))).toBe("NOT_FOUND");
    expect(await withContext(app.db, s1, (tx) => tx.select().from(libraryLoans))).toHaveLength(3);
    expect((await withContext(app.db, teacher, (tx) => tx.select().from(libraryLoans))).every((l) => l.staffId !== null)).toBe(true);
    expect(await withContext(app.db, s1, (tx) => tx.update(libraryCopies).set({ status: "available" }).returning())).toHaveLength(0);
    expect(
      await dbError(
        withContext(app.db, s1, (tx) =>
          tx.insert(libraryLoans).values({ schoolId: A.id, copyId: randomUUID(), studentId: id.s1!, issuedBy: String(s1.userId), dueOn: today }),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select().from(libraryLoans))).toHaveLength(0);
    expect(await outcome(searchCatalogue(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");
  });
});
