import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, RequestContext, Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { schoolToday } from "../../dates";

/**
 * Phase 13.5: dashboard figures and scoped CSV exports for admissions, library and inventory
 * (transport's live in its own module). Each uses the submodule's own capability, so only those
 * who manage that submodule get its figures or files. Every export is audited; CSV cells that
 * look like formulas are neutralised by toCsv.
 */

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

/* ------------------------------------------------------------------ admissions */

export interface AdmissionsSummary {
  open: number;
  awaitingDecision: number;
  approvedNotEnrolled: number;
  enrolledThisYear: number;
}

export async function getAdmissionsSummary(db: Db, ctx: RequestContext, schoolId: string): Promise<AdmissionsSummary> {
  return withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx) => {
    const [r] = (await tx.execute(sql`
      select count(*) filter (where a.status in ('enquiry', 'applied', 'under_review', 'approved'))::int as open,
             count(*) filter (where a.status = 'under_review')::int as "awaitingDecision",
             count(*) filter (where a.status = 'approved')::int as "approvedNotEnrolled",
             count(*) filter (where a.status = 'enrolled' and y.status = 'current')::int as "enrolledThisYear"
      from admission_applications a join academic_years y on y.id = a.academic_year_id
      where a.school_id = ${schoolId}::uuid`)) as unknown as AdmissionsSummary[];
    return r ?? { open: 0, awaitingDecision: 0, approvedNotEnrolled: 0, enrolledThisYear: 0 };
  });
}

const STATUSES = ["enquiry", "applied", "under_review", "approved", "rejected", "withdrawn", "enrolled"] as const;

/** Applications (optionally of one status or year) with guardian contacts. Audited. */
export async function exportApplicationsCsv(db: Db, ctx: RequestContext, schoolId: string, f: { status?: string; yearId?: string } = {}): Promise<string> {
  const status = (STATUSES as readonly string[]).includes(f.status ?? "") ? f.status : undefined;
  const yearId = f.yearId && z.uuid().safeParse(f.yearId).success ? f.yearId : undefined;
  return withCapability(db, ctx, schoolId, "school.admissions.manage", async (tx, actor) => {
    const rows = (await tx.execute(sql`
      select a.reference_no as ref, a.applicant_name as name, a.date_of_birth::text as dob, y.name as year, c.name as class, a.status::text as status,
             a.guardian_name as guardian, a.guardian_phone as phone, a.guardian_email as email, a.previous_school as previous,
             (select count(*)::int from admission_documents d where d.application_id = a.id and d.required and d.status in ('verified', 'waived')) as done,
             (select count(*)::int from admission_documents d where d.application_id = a.id and d.required) as required,
             p.admission_no as "admissionNo", a.created_at::date::text as created, a.updated_at::date::text as updated
      from admission_applications a join academic_years y on y.id = a.academic_year_id join classes c on c.id = a.class_id
      left join student_profiles p on p.id = a.student_id
      where a.school_id = ${schoolId}::uuid ${status ? sql`and a.status = ${status}::admission_status` : sql``} ${yearId ? sql`and a.academic_year_id = ${yearId}::uuid` : sql``}
      order by a.reference_no`)) as unknown as Record<string, string | number | null>[];
    await audit(tx, { action: "admissions.exported", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { rows: rows.length, status: status ?? null, yearId: yearId ?? null } });
    return toCsv([
      ["Reference", "Applicant", "Date of birth", "Year", "Class", "Status", "Guardian", "Guardian mobile", "Guardian email", "Previous school", "Required documents done", "Required documents", "Admission no.", "Recorded", "Updated"],
      ...rows.map((r) => [r.ref, r.name, r.dob, r.year, r.class, r.status, r.guardian, r.phone, r.email, r.previous, r.done, r.required, r.admissionNo, r.created, r.updated]),
    ]);
  });
}

/* ------------------------------------------------------------------ library */

export interface LibrarySummary {
  titles: number;
  copies: number;
  onLoan: number;
  overdue: number;
}

export async function getLibrarySummary(db: Db, ctx: RequestContext, schoolId: string): Promise<LibrarySummary> {
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx) => {
    const t = await schoolDay(tx, schoolId);
    const [r] = (await tx.execute(sql`
      select (select count(*)::int from library_titles where school_id = ${schoolId}::uuid and archived_at is null) as titles,
             (select count(*)::int from library_copies where school_id = ${schoolId}::uuid and status in ('available', 'issued')) as copies,
             (select count(*)::int from library_loans where school_id = ${schoolId}::uuid and status = 'open') as "onLoan",
             (select count(*)::int from library_loans where school_id = ${schoolId}::uuid and status = 'open' and due_on < ${t}::date) as overdue`)) as unknown as LibrarySummary[];
    return r ?? { titles: 0, copies: 0, onLoan: 0, overdue: 0 };
  });
}

/** Books on loan (or only overdue ones) with borrowers. Audited. */
export async function exportLibraryLoansCsv(db: Db, ctx: RequestContext, schoolId: string, f: { overdueOnly?: boolean } = {}): Promise<string> {
  return withCapability(db, ctx, schoolId, "school.library.manage", async (tx, actor) => {
    const t = await schoolDay(tx, schoolId);
    const rows = (await tx.execute(sql`
      select ti.title, ti.author, c.accession_no as acc, case when l.student_id is not null then 'Student' else 'Staff' end as kind,
             coalesce(sp.admission_no, st.employee_no) as number, coalesce(sp.display_name, st.display_name) as borrower,
             l.issued_at::date::text as issued, l.due_on::text as due, greatest(0, ${t}::date - l.due_on)::int as late, l.renewals
      from library_loans l join library_copies c on c.id = l.copy_id join library_titles ti on ti.id = c.title_id
      left join student_profiles sp on sp.id = l.student_id left join staff_profiles st on st.id = l.staff_id
      where l.school_id = ${schoolId}::uuid and l.status = 'open' ${f.overdueOnly ? sql`and l.due_on < ${t}::date` : sql``}
      order by l.due_on, lower(ti.title)`)) as unknown as Record<string, string | number | null>[];
    await audit(tx, { action: "library.exported", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { rows: rows.length, overdueOnly: Boolean(f.overdueOnly) } });
    return toCsv([
      ["Title", "Author", "Accession no.", "Borrower type", "Admission or employee no.", "Borrower", "Issued", "Due", "Days late", "Renewals"],
      ...rows.map((r) => [r.title, r.author, r.acc, r.kind, r.number, r.borrower, r.issued, r.due, r.late, r.renewals]),
    ]);
  });
}

/* ------------------------------------------------------------------ inventory */

export interface InventorySummary {
  items: number;
  lowStock: number;
  allocated: number;
  overdueReturns: number;
  underRepair: number;
}

export async function getInventorySummary(db: Db, ctx: RequestContext, schoolId: string): Promise<InventorySummary> {
  return withCapability(db, ctx, schoolId, "school.inventory.manage", async (tx) => {
    const t = await schoolDay(tx, schoolId);
    const [r] = (await tx.execute(sql`
      select (select count(*)::int from inventory_items where school_id = ${schoolId}::uuid and archived_at is null) as items,
             (select count(*)::int from inventory_items i where i.school_id = ${schoolId}::uuid and i.archived_at is null and i.kind = 'consumable' and i.reorder_level is not null
                and coalesce((select sum(quantity) from inventory_stock s where s.item_id = i.id), 0) <= i.reorder_level) as "lowStock",
             (select count(*)::int from inventory_allocations where school_id = ${schoolId}::uuid and returned_at is null) as allocated,
             (select count(*)::int from inventory_allocations where school_id = ${schoolId}::uuid and returned_at is null and due_on < ${t}::date) as "overdueReturns",
             (select count(*)::int from inventory_assets where school_id = ${schoolId}::uuid and status = 'under_repair') as "underRepair"`)) as unknown as InventorySummary[];
    return r ?? { items: 0, lowStock: 0, allocated: 0, overdueReturns: 0, underRepair: 0 };
  });
}

/** The asset register (every asset with status, location and holder) or consumable balances by location. Audited. */
export async function exportInventoryCsv(db: Db, ctx: RequestContext, schoolId: string, kind: "assets" | "stock"): Promise<string> {
  return withCapability(db, ctx, schoolId, "school.inventory.manage", async (tx, actor) => {
    let csv: string;
    let count: number;
    if (kind === "assets") {
      const rows = (await tx.execute(sql`
        select i.name as item, i.category, a.tag, a.serial_no as serial, a.status::text as status, l.name as location,
               st.employee_no as "employeeNo", st.display_name as holder, al.due_on::text as due, a.note
        from inventory_assets a join inventory_items i on i.id = a.item_id join inventory_locations l on l.id = a.location_id
        left join inventory_allocations al on al.asset_id = a.id and al.returned_at is null left join staff_profiles st on st.id = al.staff_id
        where a.school_id = ${schoolId}::uuid order by lower(i.name), lower(a.tag)`)) as unknown as Record<string, string | null>[];
      count = rows.length;
      csv = toCsv([
        ["Item", "Category", "Tag", "Serial no.", "Status", "Location", "Employee no.", "With", "Return by", "Note"],
        ...rows.map((r) => [r.item, r.category, r.tag, r.serial, r.status, r.location, r.employeeNo, r.holder, r.due, r.note]),
      ]);
    } else {
      const rows = (await tx.execute(sql`
        select i.name as item, i.category, i.unit, l.name as location, s.quantity, i.reorder_level as reorder
        from inventory_stock s join inventory_items i on i.id = s.item_id join inventory_locations l on l.id = s.location_id
        where s.school_id = ${schoolId}::uuid order by lower(i.name), lower(l.name)`)) as unknown as Record<string, string | number | null>[];
      count = rows.length;
      csv = toCsv([["Item", "Category", "Unit", "Location", "Quantity", "Reorder level (item)"], ...rows.map((r) => [r.item, r.category, r.unit, r.location, r.quantity, r.reorder])]);
    }
    await audit(tx, { action: "inventory.exported", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { kind, rows: count } });
    return csv;
  });
}
