import { sql } from "drizzle-orm";
import type { Db, RequestContext } from "@examio/db";
import { withCapability } from "../../capabilities";
import { payslipTx, type Payslip } from "../payroll/approval";
import { parse, uuidField } from "../setup/common";

/**
 * Staff self-service (Phase 14.5): one's own employment record and payslips. Payslips come only
 * from approved or paid runs; drafts and colleagues' records are never visible (enforced by the
 * database policies of migration 0031 as well as here).
 */

const SELF = "school.hr.self";

export interface MyPayslipRow {
  id: string;
  month: string;
  netPaise: number;
  runStatus: "approved" | "paid";
  paidOn: string | null;
}

export async function listMyPayslips(db: Db, ctx: RequestContext, schoolId: string): Promise<MyPayslipRow[]> {
  return withCapability(db, ctx, schoolId, SELF, async (tx) =>
    (await tx.execute(sql`
      select s.id, to_char(r.period_start, 'YYYY-MM') as month, s.net_paise::float8 as "netPaise", r.status::text as "runStatus", pm.paid_on::text as "paidOn"
      from payroll_slips s join payroll_runs r on r.id = s.run_id
      left join payroll_payments pm on pm.slip_id = s.id and pm.voided_at is null
      where s.school_id = ${schoolId}::uuid and s.included and r.status <> 'draft' and s.staff_id = app_my_staff_id(${schoolId}::uuid)
      order by r.period_start desc limit 60`)) as unknown as MyPayslipRow[],
  );
}

/** One of the signed-in staff member's own payslips from an approved or paid run. */
export async function getMyPayslip(db: Db, ctx: RequestContext, schoolId: string, slipId: string): Promise<Payslip> {
  parse(uuidField("Payslip"), slipId);
  return withCapability(db, ctx, schoolId, SELF, (tx) => payslipTx(tx, schoolId, slipId, true));
}

export interface MyEmployment {
  name: string;
  employeeNo: string;
  joinedOn: string | null;
  employmentType: string | null;
  department: string | null;
  designation: string | null;
  confirmedOn: string | null;
  history: { kind: string; effectiveOn: string; fromValue: string | null; toValue: string | null }[];
}

/** The signed-in staff member's own employment terms and history (no payment details, no documents). */
export async function getMyEmployment(db: Db, ctx: RequestContext, schoolId: string): Promise<MyEmployment | null> {
  return withCapability(db, ctx, schoolId, SELF, async (tx) => {
    const [r] = (await tx.execute(sql`
      select p.id, p.display_name as name, p.employee_no as "employeeNo", p.joined_on::text as "joinedOn", e.employment_type::text as "employmentType",
             d.name as department, g.name as designation, e.confirmed_on::text as "confirmedOn"
      from staff_profiles p left join hr_employment e on e.staff_id = p.id
      left join hr_departments d on d.id = e.department_id left join hr_designations g on g.id = e.designation_id
      where p.school_id = ${schoolId}::uuid and p.id = app_my_staff_id(${schoolId}::uuid)`)) as unknown as (Omit<MyEmployment, "history"> & { id: string })[];
    if (!r) return null;
    const history = (await tx.execute(sql`
      select kind, effective_on::text as "effectiveOn", from_value as "fromValue", to_value as "toValue"
      from hr_employment_events where staff_id = ${r.id}::uuid order by at desc limit 50`)) as unknown as MyEmployment["history"];
    const { id: _id, ...rest } = r;
    return { ...rest, history };
  });
}
