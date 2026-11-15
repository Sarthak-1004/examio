import { sql } from "drizzle-orm";
import type { Db, RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { AppError } from "../../errors";
import { isoDate, parse } from "../setup/common";

/** Finance reports (Phase 8): collections, outstanding by class, defaulters, reconciliation check. */

export interface CollectionsReport {
  from: string;
  to: string;
  byMethod: { method: string; count: number; totalPaise: number }[];
  byDay: { day: string; totalPaise: number }[];
  totalPaise: number;
  refundsPaise: number;
}

export async function getCollections(db: Db, ctx: RequestContext, schoolId: string, input: { from: string; to: string }): Promise<CollectionsReport> {
  const from = parse(isoDate("start date"), input.from);
  const to = parse(isoDate("end date"), input.to);
  if (from > to) throw new AppError("VALIDATION", "The start date must not be after the end date.");
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) => {
    const range = sql`(p.captured_at at time zone s.timezone)::date between ${from}::date and ${to}::date`;
    const byMethod = (await tx.execute(sql`
      select p.method::text as method, count(*)::int as count, sum(p.amount_paise)::int as "totalPaise"
      from payments p join schools s on s.id = p.school_id
      where p.school_id = ${schoolId}::uuid and p.status = 'captured' and ${range}
      group by p.method order by p.method`)) as unknown as CollectionsReport["byMethod"];
    const byDay = (await tx.execute(sql`
      select (p.captured_at at time zone s.timezone)::date::text as day, sum(p.amount_paise)::int as "totalPaise"
      from payments p join schools s on s.id = p.school_id
      where p.school_id = ${schoolId}::uuid and p.status = 'captured' and ${range}
      group by 1 order by 1`)) as unknown as CollectionsReport["byDay"];
    const [refunds] = (await tx.execute(sql`
      select coalesce(sum(e.amount_paise), 0)::int as total from ledger_entries e join schools s on s.id = e.school_id
      where e.school_id = ${schoolId}::uuid and e.kind = 'refund' and (e.created_at at time zone s.timezone)::date between ${from}::date and ${to}::date`)) as unknown as { total: number }[];
    return { from, to, byMethod, byDay, totalPaise: byMethod.reduce((a, m) => a + m.totalPaise, 0), refundsPaise: refunds?.total ?? 0 };
  });
}

export interface OutstandingRow {
  classId: string | null;
  className: string;
  students: number;
  outstandingPaise: number;
  overduePaise: number;
}

/** Outstanding balances per class (students' current class in the current year). */
export async function getOutstandingByClass(db: Db, ctx: RequestContext, schoolId: string): Promise<OutstandingRow[]> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) =>
    (await tx.execute(sql`
      with bal as (
        select i.student_id, sum(l.amount_paise) as balance,
               sum(l.amount_paise) filter (where i.due_on < (now() at time zone s.timezone)::date) as overdue
        from invoices i join ledger_entries l on l.invoice_id = i.id join schools s on s.id = i.school_id
        where i.school_id = ${schoolId}::uuid and i.status = 'open'
        group by i.student_id
      )
      select c.id as "classId", coalesce(c.name, 'No current class') as "className", count(*) filter (where b.balance > 0)::int as students,
             coalesce(sum(greatest(b.balance, 0)), 0)::int as "outstandingPaise", coalesce(sum(greatest(b.overdue, 0)), 0)::int as "overduePaise"
      from bal b
      left join enrollments e on e.student_id = b.student_id and e.ends_on is null
        and e.academic_year_id in (select id from academic_years where school_id = ${schoolId}::uuid and status = 'current')
      left join sections sec on sec.id = e.section_id left join classes c on c.id = sec.class_id
      group by c.id, c.name, c.sort_order order by c.sort_order nulls last, c.name`)) as unknown as OutstandingRow[],
  );
}

export interface DefaulterRow {
  studentId: string;
  displayName: string;
  admissionNo: string;
  className: string | null;
  overduePaise: number;
  oldestDueOn: string;
}

export async function getDefaulters(db: Db, ctx: RequestContext, schoolId: string): Promise<DefaulterRow[]> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) =>
    (await tx.execute(sql`
      with od as (
        select i.student_id, i.due_on, (select coalesce(sum(l.amount_paise), 0) from ledger_entries l where l.invoice_id = i.id) as balance
        from invoices i join schools s on s.id = i.school_id
        where i.school_id = ${schoolId}::uuid and i.status = 'open' and i.due_on < (now() at time zone s.timezone)::date
      )
      select p.id as "studentId", p.display_name as "displayName", p.admission_no as "admissionNo",
             (select c.name || ' ' || sec.name from enrollments e join sections sec on sec.id = e.section_id join classes c on c.id = sec.class_id
              where e.student_id = p.id and e.ends_on is null order by e.starts_on desc limit 1) as "className",
             sum(od.balance)::int as "overduePaise", min(od.due_on)::text as "oldestDueOn"
      from od join student_profiles p on p.id = od.student_id
      where od.balance > 0
      group by p.id, p.display_name, p.admission_no
      order by sum(od.balance) desc limit 500`)) as unknown as DefaulterRow[],
  );
}

export async function exportDefaultersCsv(db: Db, ctx: RequestContext, schoolId: string): Promise<string> {
  const rows = await getDefaulters(db, ctx, schoolId);
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx, actor) => {
    await audit(tx, { action: "fees.defaulters_exported", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { rows: rows.length } });
    return toCsv([["admission_no", "name", "class", "overdue_inr", "oldest_due_on"], ...rows.map((r) => [r.admissionNo, r.displayName, r.className, (r.overduePaise / 100).toFixed(2), r.oldestDueOn])]);
  });
}

export async function exportCollectionsCsv(db: Db, ctx: RequestContext, schoolId: string, input: { from: string; to: string }): Promise<string> {
  const r = await getCollections(db, ctx, schoolId, input);
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx, actor) => {
    const list = (await tx.execute(sql`
      select p.receipt_no as receipt, (p.captured_at at time zone s.timezone)::text as at, st.admission_no as adm, st.display_name as name, i.number as invoice,
             p.method::text as method, p.reference, p.amount_paise as amount
      from payments p join schools s on s.id = p.school_id join student_profiles st on st.id = p.student_id join invoices i on i.id = p.invoice_id
      where p.school_id = ${schoolId}::uuid and p.status = 'captured' and (p.captured_at at time zone s.timezone)::date between ${r.from}::date and ${r.to}::date
      order by p.captured_at`)) as unknown as { receipt: string; at: string; adm: string; name: string; invoice: string; method: string; reference: string | null; amount: number }[];
    await audit(tx, { action: "fees.collections_exported", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { from: r.from, to: r.to, rows: list.length } });
    return toCsv([["receipt_no", "received_at", "admission_no", "name", "invoice", "method", "reference", "amount_inr"], ...list.map((x) => [x.receipt, x.at.slice(0, 19), x.adm, x.name, x.invoice, x.method, x.reference, (x.amount / 100).toFixed(2)])]);
  });
}

/**
 * Reconciliation check: for every invoice, the ledger balance must equal total − payments +
 * late fees ± approved adjustments and reversals. Returns invoices where the stored pieces do not
 * add up (should always be empty), plus pending online payments.
 */
export async function getReconciliation(db: Db, ctx: RequestContext, schoolId: string): Promise<{ mismatches: { invoiceNumber: string; detail: string }[]; pendingOnline: number; failedOnline: number }> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) => {
    const mismatches = (await tx.execute(sql`
      select i.number as "invoiceNumber",
             'charged ' || coalesce(sum(l.amount_paise) filter (where l.kind = 'charge'), 0) || ' vs invoice total ' || i.total_paise as detail
      from invoices i left join ledger_entries l on l.invoice_id = i.id
      where i.school_id = ${schoolId}::uuid
      group by i.id
      having coalesce(sum(l.amount_paise) filter (where l.kind = 'charge'), 0) <> i.total_paise
      union all
      select i.number, 'payment ' || p.receipt_no || ' credited ' || coalesce(-sum(l.amount_paise), 0) || ' vs ' || p.amount_paise
      from payments p join invoices i on i.id = p.invoice_id left join ledger_entries l on l.payment_id = p.id and l.kind = 'payment'
      where p.school_id = ${schoolId}::uuid and p.status = 'captured'
      group by i.number, p.id
      having coalesce(-sum(l.amount_paise), 0) <> p.amount_paise`)) as unknown as { invoiceNumber: string; detail: string }[];
    const [c] = (await tx.execute(sql`
      select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'failed')::int as failed
      from payments where school_id = ${schoolId}::uuid and method = 'online'`)) as unknown as { pending: number; failed: number }[];
    return { mismatches, pendingOnline: c?.pending ?? 0, failedOnline: c?.failed ?? 0 };
  });
}

