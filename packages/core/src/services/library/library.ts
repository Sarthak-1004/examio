import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { feeAdjustments, libraryCopies, libraryLoans, librarySettings, libraryTitles, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays, schoolToday } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { formatPaise, parseRupees } from "../fees/money";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Library (Phase 13.2), run by school administrators.
 *
 * - Catalogue: titles and copies; a copy's accession number is unique in the school (ignoring
 *   case). Copies are available, issued, lost or withdrawn; nothing is deleted.
 * - Borrowers: active students (by admission number) and active staff (by employee number).
 * - Issue: an available copy, a borrower under their limit and with no overdue book; due today
 *   plus the loan period (school time). One open loan per copy, enforced in the database.
 * - Renew while not overdue and under the renewal limit; return; mark lost.
 * - A late return by a student with a late fine configured, or a lost book with a replacement
 *   charge, creates a fee charge request (Phase 8): it reaches the student's account only when
 *   another administrator approves it in Fees. Staff charges are not handled here.
 */

export interface LibrarySettings {
  loanDays: number;
  maxRenewals: number;
  maxLoansStudent: number;
  maxLoansStaff: number;
  finePerDayPaise: number;
}

const DEFAULTS: LibrarySettings = { loanDays: 14, maxRenewals: 2, maxLoansStudent: 3, maxLoansStaff: 10, finePerDayPaise: 0 };

async function settingsTx(tx: Tx, schoolId: string): Promise<LibrarySettings> {
  const [s] = await tx.select().from(librarySettings).where(eq(librarySettings.schoolId, schoolId));
  return s ? { loanDays: s.loanDays, maxRenewals: s.maxRenewals, maxLoansStudent: s.maxLoansStudent, maxLoansStaff: s.maxLoansStaff, finePerDayPaise: s.finePerDayPaise } : DEFAULTS;
}

async function today(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

export async function getLibrarySettings(db: Db, ctx: RequestContext, schoolId: string): Promise<LibrarySettings> {
  return withCapability(db, ctx, schoolId, "school.library.manage", (tx) => settingsTx(tx, schoolId));
}

const settingsSchema = z.object({
  loanDays: z.coerce.number().int().min(1, "Loan period: 1 to 120 days.").max(120, "Loan period: 1 to 120 days."),
  maxRenewals: z.coerce.number().int().min(0, "Renewals: 0 to 10.").max(10, "Renewals: 0 to 10."),
  maxLoansStudent: z.coerce.number().int().min(1, "Books for students: 1 to 20.").max(20, "Books for students: 1 to 20."),
  maxLoansStaff: z.coerce.number().int().min(1, "Books for staff: 1 to 50.").max(50, "Books for staff: 1 to 50."),
  finePerDay: z.string(),
});

export async function updateLibrarySettings(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof settingsSchema>): Promise<void> {
  const v = parse(settingsSchema, input);
  const fine = v.finePerDay.trim() === "" ? 0 : parseRupees(v.finePerDay);
  if (fine === null || fine > 100_000) throw new AppError("VALIDATION", "Late fine per day: rupees from 0 to 1000.", { finePerDay: "Not valid." });
  await withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const values = { loanDays: v.loanDays, maxRenewals: v.maxRenewals, maxLoansStudent: v.maxLoansStudent, maxLoansStaff: v.maxLoansStaff, finePerDayPaise: fine };
    await tx.insert(librarySettings).values({ schoolId, ...values }).onConflictDoUpdate({ target: librarySettings.schoolId, set: { ...values, updatedAt: sql`now()` } });
    await audit(tx, { action: "library.settings_changed", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: values });
  });
}

/* ------------------------------------------------------------------ catalogue */

const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal("").transform(() => null), schema]).nullable().optional();
const titleSchema = z.object({
  title: trimmed("Title", 1, 200),
  author: optional(trimmed("Author", 1, 200)),
  isbn: optional(z.string().trim().toUpperCase().regex(/^[0-9X-]{10,17}$/, "ISBN: 10 or 13 digits, hyphens allowed.")),
  publisher: optional(trimmed("Publisher", 1, 200)),
  category: optional(trimmed("Category", 1, 80)),
});
const accession = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/, "Accession number: up to 30 letters, digits, / _ or -.");

/** Splits "B-001, B-002" or one per line into accession numbers. */
export function parseAccessionList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

async function insertCopies(tx: Tx, schoolId: string, titleId: string, accessionNos: string[], shelf: string | null): Promise<number> {
  const list = accessionNos.map((a) => parse(accession, a));
  if (list.length > 200) throw new AppError("VALIDATION", "At most 200 copies at a time.");
  try {
    for (const a of list) await tx.insert(libraryCopies).values({ schoolId, titleId, accessionNo: a, shelf });
  } catch (e) {
    if (uniqueViolation(e)?.includes("accession")) throw new AppError("CONFLICT", "One of these accession numbers is already used in the library.", { accessionNos: "Already used." });
    throw e;
  }
  return list.length;
}

export async function createTitle(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof titleSchema> & { accessionNos?: string; shelf?: string }): Promise<{ id: string; copies: number }> {
  const v = parse(titleSchema, input);
  const shelf = input.shelf?.trim() ? parse(trimmed("Shelf", 1, 40), input.shelf) : null;
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const [t] = await tx
      .insert(libraryTitles)
      .values({ schoolId, title: v.title, author: v.author ?? null, isbn: v.isbn ?? null, publisher: v.publisher ?? null, category: v.category ?? null, createdBy: actor.userId })
      .returning({ id: libraryTitles.id });
    const copies = input.accessionNos ? await insertCopies(tx, schoolId, t!.id, parseAccessionList(input.accessionNos), shelf) : 0;
    await audit(tx, { action: "library.title_added", actorUserId: actor.userId, schoolId, entityType: "library_title", entityId: t!.id, data: { title: v.title, copies } });
    return { id: t!.id, copies };
  });
}

export async function updateTitle(db: Db, ctx: RequestContext, schoolId: string, titleId: string, input: z.input<typeof titleSchema>): Promise<void> {
  parse(uuidField("Title"), titleId);
  const v = parse(titleSchema, input);
  await withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const r = await tx
      .update(libraryTitles)
      .set({ title: v.title, author: v.author ?? null, isbn: v.isbn ?? null, publisher: v.publisher ?? null, category: v.category ?? null })
      .where(and(eq(libraryTitles.schoolId, schoolId), eq(libraryTitles.id, titleId)))
      .returning({ id: libraryTitles.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Title not found.");
    await audit(tx, { action: "library.title_updated", actorUserId: actor.userId, schoolId, entityType: "library_title", entityId: titleId });
  });
}

export async function addCopies(db: Db, ctx: RequestContext, schoolId: string, titleId: string, input: { accessionNos: string; shelf?: string }): Promise<{ added: number }> {
  parse(uuidField("Title"), titleId);
  const list = parseAccessionList(input.accessionNos);
  if (list.length === 0) throw new AppError("VALIDATION", "Enter at least one accession number.", { accessionNos: "Required." });
  const shelf = input.shelf?.trim() ? parse(trimmed("Shelf", 1, 40), input.shelf) : null;
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const [t] = await tx.select({ archivedAt: libraryTitles.archivedAt }).from(libraryTitles).where(and(eq(libraryTitles.schoolId, schoolId), eq(libraryTitles.id, titleId)));
    if (!t) throw new AppError("NOT_FOUND", "Title not found.");
    if (t.archivedAt) throw new AppError("CONFLICT", "This title is archived.");
    const added = await insertCopies(tx, schoolId, titleId, list, shelf);
    await audit(tx, { action: "library.copies_added", actorUserId: actor.userId, schoolId, entityType: "library_title", entityId: titleId, data: { added } });
    return { added };
  });
}

/** Withdraws a copy that is not on loan (damaged, discarded), or brings a lost or withdrawn copy back. */
export async function setCopyStatus(db: Db, ctx: RequestContext, schoolId: string, copyId: string, to: "withdrawn" | "available", note?: string | null): Promise<void> {
  parse(uuidField("Copy"), copyId);
  const target = parse(z.enum(["withdrawn", "available"]), to);
  const why = note?.trim() ? parse(trimmed("Note", 1, 300), note) : null;
  await withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const [c] = await tx.select().from(libraryCopies).where(and(eq(libraryCopies.schoolId, schoolId), eq(libraryCopies.id, copyId))).for("update");
    if (!c) throw new AppError("NOT_FOUND", "Copy not found.");
    if (c.status === "issued") throw new AppError("CONFLICT", "This copy is on loan. Return it first.");
    if (c.status === target) return;
    await tx.update(libraryCopies).set({ status: target, note: why ?? c.note, updatedAt: sql`now()` }).where(eq(libraryCopies.id, copyId));
    await audit(tx, { action: target === "withdrawn" ? "library.copy_withdrawn" : "library.copy_restored", actorUserId: actor.userId, schoolId, entityType: "library_copy", entityId: copyId, data: { from: c.status, note: why } });
  });
}

export interface TitleRow {
  id: string;
  title: string;
  author: string | null;
  category: string | null;
  copies: number;
  available: number;
  archived: boolean;
}

export async function searchCatalogue(db: Db, ctx: RequestContext, schoolId: string, search = ""): Promise<TitleRow[]> {
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx) => {
    const q = search.trim().slice(0, 100);
    return (await tx.execute(sql`
      select t.id, t.title, t.author, t.category, t.archived_at is not null as archived,
             (select count(*)::int from library_copies c where c.title_id = t.id and c.status <> 'withdrawn') as copies,
             (select count(*)::int from library_copies c where c.title_id = t.id and c.status = 'available') as available
      from library_titles t
      where t.school_id = ${schoolId}::uuid
        ${q ? sql`and (t.title ilike ${likePattern(q)} or t.author ilike ${likePattern(q)} or t.isbn ilike ${likePattern(q)}
                  or exists (select 1 from library_copies c where c.title_id = t.id and c.accession_no ilike ${likePattern(q)}))` : sql``}
      order by t.archived_at is not null, lower(t.title) limit 200`)) as unknown as TitleRow[];
  });
}

export interface TitleDetail {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  category: string | null;
  copies: { id: string; accessionNo: string; shelf: string | null; status: "available" | "issued" | "lost" | "withdrawn"; note: string | null; borrower: string | null; dueOn: string | null; loanId: string | null }[];
  history: { accessionNo: string; borrower: string; issuedAt: Date; dueOn: string; status: string; closedOn: string | null }[];
}

const borrowerName = sql`coalesce(sp.display_name || ' (' || sp.admission_no || ')', st.display_name || ' (' || st.employee_no || ')')`;

export async function getTitle(db: Db, ctx: RequestContext, schoolId: string, titleId: string): Promise<TitleDetail> {
  parse(uuidField("Title"), titleId);
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx) => {
    const [t] = (await tx.execute(sql`select id, title, author, isbn, publisher, category from library_titles where school_id = ${schoolId}::uuid and id = ${titleId}::uuid`)) as unknown as Omit<TitleDetail, "copies" | "history">[];
    if (!t) throw new AppError("NOT_FOUND", "Title not found.");
    const copies = (await tx.execute(sql`
      select c.id, c.accession_no as "accessionNo", c.shelf, c.status::text as status, c.note, ${borrowerName} as borrower, l.due_on::text as "dueOn", l.id as "loanId"
      from library_copies c
      left join library_loans l on l.copy_id = c.id and l.status = 'open'
      left join student_profiles sp on sp.id = l.student_id left join staff_profiles st on st.id = l.staff_id
      where c.title_id = ${titleId}::uuid order by lower(c.accession_no)`)) as unknown as TitleDetail["copies"];
    const history = ((await tx.execute(sql`
      select c.accession_no as "accessionNo", ${borrowerName} as borrower, l.issued_at as "issuedAt", l.due_on::text as "dueOn", l.status::text as status, l.closed_on::text as "closedOn"
      from library_loans l join library_copies c on c.id = l.copy_id
      left join student_profiles sp on sp.id = l.student_id left join staff_profiles st on st.id = l.staff_id
      where c.title_id = ${titleId}::uuid order by l.issued_at desc limit 50`)) as unknown as TitleDetail["history"]).map((h) => ({ ...h, issuedAt: new Date(h.issuedAt) }));
    return { ...t, copies, history };
  });
}

/* ------------------------------------------------------------------ lending */

interface Borrower {
  kind: "student" | "staff";
  id: string;
  name: string;
  limit: number;
}

async function findBorrower(tx: Tx, schoolId: string, identifier: string, settings: LibrarySettings): Promise<Borrower> {
  const key = identifier.trim();
  if (!key) throw new AppError("VALIDATION", "Enter the borrower's admission number or employee number.", { borrower: "Required." });
  const students = (await tx.execute(sql`select id, display_name as name, status::text as status from student_profiles where school_id = ${schoolId}::uuid and lower(admission_no) = lower(${key})`)) as unknown as { id: string; name: string; status: string }[];
  const staff = (await tx.execute(sql`select id, display_name as name, status::text as status from staff_profiles where school_id = ${schoolId}::uuid and lower(employee_no) = lower(${key})`)) as unknown as { id: string; name: string; status: string }[];
  if (students.length && staff.length) throw new AppError("CONFLICT", "That number belongs to both a student and a staff member. Ask the office to make them distinct.");
  const s = students[0];
  if (s) {
    if (s.status !== "active") throw new AppError("CONFLICT", `${s.name} has left the school.`);
    return { kind: "student", id: s.id, name: s.name, limit: settings.maxLoansStudent };
  }
  const st = staff[0];
  if (st) {
    if (st.status !== "active") throw new AppError("CONFLICT", `${st.name} has left the school.`);
    return { kind: "staff", id: st.id, name: st.name, limit: settings.maxLoansStaff };
  }
  throw new AppError("NOT_FOUND", "No student or staff member has that number.", { borrower: "Not found." });
}

async function lockCopy(tx: Tx, schoolId: string, accessionNo: string) {
  const [c] = (await tx.execute(sql`
    select c.id, c.status::text as status, c.title_id as "titleId", t.title from library_copies c join library_titles t on t.id = c.title_id
    where c.school_id = ${schoolId}::uuid and lower(c.accession_no) = lower(${accessionNo.trim()}) for update of c`)) as unknown as { id: string; status: string; titleId: string; title: string }[];
  if (!c) throw new AppError("NOT_FOUND", "No copy has that accession number.", { accessionNo: "Not found." });
  return c;
}

/** Lends a copy (by accession number) to a borrower (admission or employee number). */
export async function issueCopy(db: Db, ctx: RequestContext, schoolId: string, input: { accessionNo: string; borrower: string }): Promise<{ loanId: string; borrowerName: string; title: string; dueOn: string }> {
  try {
    return await withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
      const settings = await settingsTx(tx, schoolId);
      const copy = await lockCopy(tx, schoolId, input.accessionNo);
      if (copy.status !== "available") {
        throw new AppError("CONFLICT", copy.status === "issued" ? "This copy is already on loan." : `This copy is ${copy.status}.`, { accessionNo: "Not available." });
      }
      const b = await findBorrower(tx, schoolId, input.borrower, settings);
      const t = await today(tx, schoolId);
      const col = b.kind === "student" ? sql`student_id` : sql`staff_id`;
      const [c] = (await tx.execute(sql`
        select count(*)::int as open, count(*) filter (where due_on < ${t}::date)::int as overdue
        from library_loans where school_id = ${schoolId}::uuid and ${col} = ${b.id}::uuid and status = 'open'`)) as unknown as { open: number; overdue: number }[];
      if ((c?.overdue ?? 0) > 0) throw new AppError("CONFLICT", `${b.name} has an overdue book. Return it first.`);
      if ((c?.open ?? 0) >= b.limit) throw new AppError("CONFLICT", `${b.name} already has ${b.limit} book(s), the limit.`);
      const dueOn = addDays(t, settings.loanDays);
      const [l] = await tx
        .insert(libraryLoans)
        .values({ schoolId, copyId: copy.id, studentId: b.kind === "student" ? b.id : null, staffId: b.kind === "staff" ? b.id : null, issuedBy: actor.userId, dueOn })
        .returning({ id: libraryLoans.id });
      await tx.update(libraryCopies).set({ status: "issued", updatedAt: sql`now()` }).where(eq(libraryCopies.id, copy.id));
      await audit(tx, { action: "library.issued", actorUserId: actor.userId, schoolId, entityType: "library_loan", entityId: l!.id, data: { copyId: copy.id, borrowerKind: b.kind, borrowerId: b.id, dueOn } });
      return { loanId: l!.id, borrowerName: b.name, title: copy.title, dueOn };
    });
  } catch (e) {
    // Two desks issuing the same copy at once: the second is refused by the database.
    if (uniqueViolation(e)?.includes("library_loans_one_open_per_copy")) throw new AppError("CONFLICT", "This copy is already on loan.");
    throw e;
  }
}

async function requestCharge(tx: Tx, schoolId: string, studentId: string, actorUserId: string, amountPaise: number, reason: string): Promise<string> {
  const [a] = await tx
    .insert(feeAdjustments)
    .values({ schoolId, studentId, kind: "extra_charge", amountPaise, reason: reason.slice(0, 200), requestedBy: actorUserId })
    .returning({ id: feeAdjustments.id });
  await audit(tx, { action: "fees.adjustment_requested", actorUserId, schoolId, entityType: "fee_adjustment", entityId: a!.id, data: { kind: "extra_charge", amountPaise, source: "library" } });
  return a!.id;
}

async function lockOpenLoanByCopy(tx: Tx, schoolId: string, accessionNo: string) {
  const copy = await lockCopy(tx, schoolId, accessionNo);
  const [l] = await tx.select().from(libraryLoans).where(and(eq(libraryLoans.copyId, copy.id), eq(libraryLoans.status, "open"))).for("update");
  if (!l) throw new AppError("CONFLICT", "This copy is not on loan.", { accessionNo: "Not on loan." });
  return { copy, loan: l };
}

/** Takes a copy back. A late return by a student with a late fine set requests a charge for approval. */
export async function returnCopy(db: Db, ctx: RequestContext, schoolId: string, accessionNo: string): Promise<{ title: string; daysLate: number; chargePaise: number }> {
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const { copy, loan } = await lockOpenLoanByCopy(tx, schoolId, accessionNo);
    const settings = await settingsTx(tx, schoolId);
    const t = await today(tx, schoolId);
    const daysLate = Math.max(0, Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${loan.dueOn}T00:00:00Z`)) / 86_400_000));
    let chargeId: string | null = null;
    const chargePaise = loan.studentId && daysLate > 0 ? Math.min(daysLate * settings.finePerDayPaise, 100_000_000) : 0;
    if (loan.studentId && chargePaise > 0) {
      chargeId = await requestCharge(tx, schoolId, loan.studentId, actor.userId, chargePaise, `Library: "${copy.title}" returned ${daysLate} day(s) late`);
    }
    await tx.update(libraryLoans).set({ status: "returned", closedBy: actor.userId, closedAt: sql`now()`, closedOn: t, chargeAdjustmentId: chargeId }).where(eq(libraryLoans.id, loan.id));
    await tx.update(libraryCopies).set({ status: "available", updatedAt: sql`now()` }).where(eq(libraryCopies.id, copy.id));
    await audit(tx, { action: "library.returned", actorUserId: actor.userId, schoolId, entityType: "library_loan", entityId: loan.id, data: { daysLate, chargePaise } });
    return { title: copy.title, daysLate, chargePaise };
  });
}

/** Extends a loan from today, while it is not overdue and under the renewal limit. */
export async function renewLoan(db: Db, ctx: RequestContext, schoolId: string, loanId: string): Promise<{ dueOn: string }> {
  parse(uuidField("Loan"), loanId);
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const [l] = await tx.select().from(libraryLoans).where(and(eq(libraryLoans.schoolId, schoolId), eq(libraryLoans.id, loanId))).for("update");
    if (!l || l.status !== "open") throw new AppError("NOT_FOUND", "Open loan not found.");
    const settings = await settingsTx(tx, schoolId);
    const t = await today(tx, schoolId);
    if (l.dueOn < t) throw new AppError("CONFLICT", "This book is overdue. Return it instead of renewing.");
    if (l.renewals >= settings.maxRenewals) throw new AppError("CONFLICT", `This loan has been renewed ${l.renewals} time(s), the limit.`);
    const dueOn = addDays(t, settings.loanDays);
    await tx.update(libraryLoans).set({ dueOn, renewals: l.renewals + 1 }).where(eq(libraryLoans.id, loanId));
    await audit(tx, { action: "library.renewed", actorUserId: actor.userId, schoolId, entityType: "library_loan", entityId: loanId, data: { dueOn } });
    return { dueOn };
  });
}

/** Closes a loan as lost and marks the copy lost; for a student, an optional replacement charge is requested. */
export async function markLoanLost(db: Db, ctx: RequestContext, schoolId: string, loanId: string, replacementCharge?: string | null): Promise<{ chargePaise: number }> {
  parse(uuidField("Loan"), loanId);
  const text = replacementCharge?.trim() ?? "";
  const charge = text === "" ? 0 : parseRupees(text);
  if (charge === null || charge > 100_000_000) throw new AppError("VALIDATION", "Replacement charge: enter rupees, for example 350.", { charge: "Not valid." });
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const [l] = await tx.select().from(libraryLoans).where(and(eq(libraryLoans.schoolId, schoolId), eq(libraryLoans.id, loanId))).for("update");
    if (!l || l.status !== "open") throw new AppError("NOT_FOUND", "Open loan not found.");
    if (charge > 0 && !l.studentId) throw new AppError("VALIDATION", "Replacement charges are only for students; record a staff loss without a charge.");
    const [t] = (await tx.execute(sql`select t.title from library_copies c join library_titles t on t.id = c.title_id where c.id = ${l.copyId}::uuid`)) as unknown as { title: string }[];
    const chargeId = charge > 0 ? await requestCharge(tx, schoolId, l.studentId!, actor.userId, charge, `Library: "${t?.title ?? "book"}" lost (replacement ${formatPaise(charge)})`) : null;
    await tx.update(libraryLoans).set({ status: "lost", closedBy: actor.userId, closedAt: sql`now()`, closedOn: await today(tx, schoolId), chargeAdjustmentId: chargeId }).where(eq(libraryLoans.id, loanId));
    await tx.update(libraryCopies).set({ status: "lost", updatedAt: sql`now()` }).where(eq(libraryCopies.id, l.copyId));
    await audit(tx, { action: "library.lost", actorUserId: actor.userId, schoolId, entityType: "library_loan", entityId: loanId, data: { chargePaise: charge } });
    return { chargePaise: charge };
  });
}

export interface LoanRow {
  loanId: string;
  title: string;
  accessionNo: string;
  borrower: string;
  borrowerKind: "student" | "staff";
  issuedAt: Date;
  dueOn: string;
  renewals: number;
  overdueDays: number;
}

/** Open loans (all, or overdue only), soonest due first. */
export async function listOpenLoans(db: Db, ctx: RequestContext, schoolId: string, f: { overdueOnly?: boolean; search?: string } = {}): Promise<LoanRow[]> {
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx) => {
    const t = await today(tx, schoolId);
    const q = f.search?.trim().slice(0, 100) ?? "";
    const rows = (await tx.execute(sql`
      select l.id as "loanId", ti.title, c.accession_no as "accessionNo", ${borrowerName} as borrower,
             case when l.student_id is not null then 'student' else 'staff' end as "borrowerKind",
             l.issued_at as "issuedAt", l.due_on::text as "dueOn", l.renewals, greatest(0, ${t}::date - l.due_on)::int as "overdueDays"
      from library_loans l join library_copies c on c.id = l.copy_id join library_titles ti on ti.id = c.title_id
      left join student_profiles sp on sp.id = l.student_id left join staff_profiles st on st.id = l.staff_id
      where l.school_id = ${schoolId}::uuid and l.status = 'open'
        ${f.overdueOnly ? sql`and l.due_on < ${t}::date` : sql``}
        ${q ? sql`and (ti.title ilike ${likePattern(q)} or c.accession_no ilike ${likePattern(q)} or sp.display_name ilike ${likePattern(q)} or sp.admission_no ilike ${likePattern(q)} or st.display_name ilike ${likePattern(q)} or st.employee_no ilike ${likePattern(q)})` : sql``}
      order by l.due_on, ti.title limit 500`)) as unknown as LoanRow[];
    return rows.map((r) => ({ ...r, issuedAt: new Date(r.issuedAt) }));
  });
}

export interface MyLoanRow {
  title: string;
  author: string | null;
  accessionNo: string;
  issuedAt: Date;
  dueOn: string;
  status: "open" | "returned" | "lost";
  closedOn: string | null;
  overdue: boolean;
}

async function loansOf(tx: Tx, schoolId: string, studentId: string): Promise<MyLoanRow[]> {
  const t = await today(tx, schoolId);
  const rows = (await tx.execute(sql`
    select ti.title, ti.author, c.accession_no as "accessionNo", l.issued_at as "issuedAt", l.due_on::text as "dueOn", l.status::text as status, l.closed_on::text as "closedOn",
           (l.status = 'open' and l.due_on < ${t}::date) as overdue
    from library_loans l join library_copies c on c.id = l.copy_id join library_titles ti on ti.id = c.title_id
    where l.school_id = ${schoolId}::uuid and l.student_id = ${studentId}::uuid
    order by (l.status = 'open') desc, l.issued_at desc limit 100`)) as unknown as MyLoanRow[];
  return rows.map((r) => ({ ...r, issuedAt: new Date(r.issuedAt) }));
}

export async function listMyLoans(db: Db, ctx: RequestContext, schoolId: string): Promise<MyLoanRow[]> {
  return withCapability(db, ctx, schoolId, "school.library.view", async (tx) => {
    const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
    if (!me) return [];
    return loansOf(tx, schoolId, me.id);
  });
}

export async function listChildLoans(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<MyLoanRow[]> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const [c] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid and app_is_guardian_of(id)`)) as unknown as { id: string }[];
    if (!c) throw new AppError("NOT_FOUND", "Student not found.");
    return loansOf(tx, schoolId, c.id);
  });
}
