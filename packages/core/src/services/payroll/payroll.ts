import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { payrollComponents, payrollRuns, payrollSlips, staffSalaries, staffSalaryLines, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { addDays, schoolToday } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { parseRupees } from "../fees/money";
import { workingDays } from "../hr/leave";
import { bpToPercent, isoDate, parse, percentToBp, trimmed, uuidField } from "../setup/common";
import { calculateSlip, type SlipComponentInput, type SlipLine } from "./calc";

/**
 * Payroll (Phase 14.3): school-defined components, salary versions, and monthly runs calculated
 * from attendance and leave. No statutory rules are built in. Administrators set components and
 * salaries; administrators and finance read them and prepare runs. One run per school and month.
 * Each slip stores a copy of every input it used.
 */

const SETUP = "school.payroll.setup";
const PREPARE = "school.payroll.prepare";
const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.");

/** The last day of the month that starts on periodStart (YYYY-MM-01). */
export const monthEnd = (periodStart: string): string => addDays(`${nextMonth(periodStart)}-01`, -1);
function nextMonth(periodStart: string): string {
  const y = Number(periodStart.slice(0, 4));
  const m = Number(periodStart.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ components */

export interface ComponentRow {
  id: string;
  name: string;
  kind: "earning" | "deduction";
  calc: "fixed" | "percent_basic" | "percent_gross";
  prorate: boolean;
  capPaise: number | null;
  sortOrder: number;
  archived: boolean;
}

export async function listComponents(db: Db, ctx: RequestContext, schoolId: string): Promise<ComponentRow[]> {
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const rows = await tx
      .select()
      .from(payrollComponents)
      .where(eq(payrollComponents.schoolId, schoolId))
      .orderBy(sql`${payrollComponents.archivedAt} is not null`, payrollComponents.kind, payrollComponents.sortOrder, sql`lower(${payrollComponents.name})`);
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, calc: r.calc, prorate: r.prorate, capPaise: r.capPaise, sortOrder: r.sortOrder, archived: r.archivedAt !== null }));
  });
}

const componentSchema = z.object({
  name: trimmed("Name", 1, 60),
  kind: z.enum(["earning", "deduction"], { message: "Choose earning or deduction." }),
  calc: z.enum(["fixed", "percent_basic", "percent_gross"], { message: "Choose how it is calculated." }),
  prorate: z.boolean(),
  cap: z.string().optional(),
  sortOrder: z.union([z.literal("").transform(() => 0), z.coerce.number().int().min(0, "Order: 0 to 999.").max(999, "Order: 0 to 999.")]).optional(),
});

function capPaise(calc: string, cap: string | undefined): number | null {
  if (!cap?.trim()) return null;
  if (calc === "fixed") throw new AppError("VALIDATION", "A cap applies only to percentages.", { cap: "Percentages only." });
  const p = parseRupees(cap);
  if (p === null) throw new AppError("VALIDATION", "Cap: enter rupees, for example 1800.", { cap: "Not a valid amount." });
  return p;
}

export async function createComponent(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof componentSchema>): Promise<{ id: string }> {
  const v = parse(componentSchema, input);
  if (v.calc === "percent_gross" && v.kind !== "deduction") throw new AppError("VALIDATION", "Only deductions can be a percentage of gross.", { calc: "Deductions only." });
  const cap = capPaise(v.calc, v.cap);
  try {
    return await withCapability(db, ctx, schoolId, SETUP, async (tx, actor) => {
      const [c] = await tx
        .insert(payrollComponents)
        .values({ schoolId, name: v.name, kind: v.kind, calc: v.calc, prorate: v.calc === "fixed" ? v.prorate : true, capPaise: cap, sortOrder: v.sortOrder ?? 0 })
        .returning({ id: payrollComponents.id });
      await audit(tx, { action: "payroll.component_added", actorUserId: actor.userId, schoolId, entityType: "payroll_component", entityId: c!.id, data: { name: v.name, kind: v.kind, calc: v.calc } });
      return { id: c!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("payroll_components_name")) throw new AppError("CONFLICT", "A component with this name already exists.", { name: "Already used." });
    throw e;
  }
}

/** Archives or restores a component. Its kind and calculation never change; calculated slips keep their copy. */
export async function setComponentArchived(db: Db, ctx: RequestContext, schoolId: string, componentId: string, archived: boolean): Promise<void> {
  parse(uuidField("Component"), componentId);
  await withCapability(db, ctx, schoolId, SETUP, async (tx, actor) => {
    const r = await tx
      .update(payrollComponents)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(and(eq(payrollComponents.schoolId, schoolId), eq(payrollComponents.id, componentId)))
      .returning({ id: payrollComponents.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Component not found.");
    await audit(tx, { action: archived ? "payroll.component_archived" : "payroll.component_restored", actorUserId: actor.userId, schoolId, entityType: "payroll_component", entityId: componentId });
  });
}

/** "₹1,234.50" style value of a component line: rupees for fixed, percent for percentages. */
export function componentValueText(calc: string, value: number): string {
  return calc === "fixed" ? (value / 100).toFixed(2).replace(/\.00$/, "") : `${bpToPercent(value)}%`;
}

/* ------------------------------------------------------------------ salaries */

export interface SalaryRow {
  staffId: string;
  name: string;
  employeeNo: string;
  status: "active" | "left";
  effectiveFrom: string | null;
  basicPaise: number | null;
}

/** Staff with the salary version in effect today (or none). */
export async function listSalaries(db: Db, ctx: RequestContext, schoolId: string): Promise<SalaryRow[]> {
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const today = await schoolDay(tx, schoolId);
    return (await tx.execute(sql`
      select p.id as "staffId", p.display_name as name, p.employee_no as "employeeNo", p.status::text as status, s.effective_from::text as "effectiveFrom", s.basic_paise::float8 as "basicPaise"
      from staff_profiles p
      left join lateral (select effective_from, basic_paise from staff_salaries x where x.staff_id = p.id and x.effective_from <= ${today}::date
                         order by x.effective_from desc, x.created_at desc limit 1) s on true
      where p.school_id = ${schoolId}::uuid and p.status = 'active' order by lower(p.display_name)`)) as unknown as SalaryRow[];
  });
}

export interface SalaryVersion {
  id: string;
  effectiveFrom: string;
  basicPaise: number;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  lines: { componentId: string; name: string; kind: "earning" | "deduction"; calc: "fixed" | "percent_basic" | "percent_gross"; value: number }[];
}

export async function getStaffSalaries(db: Db, ctx: RequestContext, schoolId: string, staffId: string): Promise<{ staffId: string; name: string; employeeNo: string; versions: SalaryVersion[] }> {
  parse(uuidField("Staff member"), staffId);
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const [p] = (await tx.execute(sql`select id, display_name as name, employee_no as "employeeNo" from staff_profiles where school_id = ${schoolId}::uuid and id = ${staffId}::uuid`)) as unknown as { id: string; name: string; employeeNo: string }[];
    if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
    const versions = (await tx.execute(sql`
      select s.id, s.effective_from::text as "effectiveFrom", s.basic_paise::float8 as "basicPaise", s.note, coalesce(u.full_name, 'An administrator') as "createdBy", s.created_at as "createdAt"
      from staff_salaries s left join users u on u.id = s.created_by where s.staff_id = ${staffId}::uuid order by s.effective_from desc, s.created_at desc`)) as unknown as Omit<SalaryVersion, "lines">[];
    const lines = (await tx.execute(sql`
      select l.salary_id as "salaryId", c.id as "componentId", c.name, c.kind::text as kind, c.calc::text as calc, l.value::float8 as value
      from staff_salary_lines l join payroll_components c on c.id = l.component_id join staff_salaries s on s.id = l.salary_id
      where s.staff_id = ${staffId}::uuid order by c.kind, c.sort_order, lower(c.name)`)) as unknown as (SalaryVersion["lines"][number] & { salaryId: string })[];
    return {
      staffId: p.id,
      name: p.name,
      employeeNo: p.employeeNo,
      versions: versions.map((v) => ({ ...v, createdAt: new Date(v.createdAt), lines: lines.filter((l) => l.salaryId === v.id).map(({ salaryId: _s, ...l }) => l) })),
    };
  });
}

/**
 * Adds a salary version from an effective date: monthly basic in rupees and, per component, rupees
 * (fixed) or a percentage. Components left empty are not part of the salary.
 */
export async function addSalaryVersion(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  staffId: string,
  input: { effectiveFrom: string; basic: string; note?: string; lines: { componentId: string; value: string }[] },
): Promise<{ id: string }> {
  parse(uuidField("Staff member"), staffId);
  const effectiveFrom = parse(isoDate("effective date"), input.effectiveFrom);
  const basic = parseRupees(input.basic);
  if (basic === null) throw new AppError("VALIDATION", "Basic: enter monthly rupees, for example 32000.", { basic: "Not a valid amount." });
  const note = input.note?.trim() ? parse(trimmed("Note", 1, 300), input.note) : null;
  return withCapability(db, ctx, schoolId, SETUP, async (tx, actor) => {
    const [p] = (await tx.execute(sql`select id, joined_on::text as "joinedOn" from staff_profiles where school_id = ${schoolId}::uuid and id = ${staffId}::uuid`)) as unknown as { id: string; joinedOn: string | null }[];
    if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
    const components = await tx.select().from(payrollComponents).where(eq(payrollComponents.schoolId, schoolId));
    const values: { componentId: string; value: number }[] = [];
    for (const l of input.lines) {
      if (!l.value.trim()) continue;
      const c = components.find((x) => x.id === l.componentId);
      if (!c || c.archivedAt) throw new AppError("NOT_FOUND", "Component not found.");
      const value = c.calc === "fixed" ? parseRupees(l.value) : percentToBp(l.value);
      if (value === null) throw new AppError("VALIDATION", c.calc === "fixed" ? `${c.name}: enter monthly rupees.` : `${c.name}: enter a percentage from 0 to 100, for example 12.`, { [`c:${c.id}`]: "Not valid." });
      values.push({ componentId: c.id, value });
    }
    const [s] = await tx.insert(staffSalaries).values({ schoolId, staffId, effectiveFrom, basicPaise: basic, note, createdBy: actor.userId }).returning({ id: staffSalaries.id });
    for (const v of values) await tx.insert(staffSalaryLines).values({ salaryId: s!.id, componentId: v.componentId, schoolId, value: v.value });
    // The audit log records that a salary changed, never the amounts.
    await audit(tx, { action: "payroll.salary_added", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId, data: { effectiveFrom, components: values.length } });
    return { id: s!.id };
  });
}

/* ------------------------------------------------------------------ runs */

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

export interface RunRow {
  id: string;
  periodStart: string;
  status: "draft" | "approved" | "paid";
  preparedBy: string;
  calculatedAt: Date | null;
  staff: number;
  netPaise: number;
}

export async function listRuns(db: Db, ctx: RequestContext, schoolId: string): Promise<RunRow[]> {
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const rows = (await tx.execute(sql`
      select r.id, r.period_start::text as "periodStart", r.status::text as status, coalesce(u.full_name, 'A colleague') as "preparedBy", r.calculated_at as "calculatedAt",
             (select count(*)::int from payroll_slips s where s.run_id = r.id and s.included) as staff,
             (select coalesce(sum(s.net_paise), 0)::float8 from payroll_slips s where s.run_id = r.id and s.included) as "netPaise"
      from payroll_runs r left join users u on u.id = r.prepared_by where r.school_id = ${schoolId}::uuid order by r.period_start desc limit 60`)) as unknown as RunRow[];
    return rows.map((r) => ({ ...r, calculatedAt: r.calculatedAt ? new Date(r.calculatedAt) : null }));
  });
}

/** Starts the payroll run for a month. A month has at most one run (database). */
export async function createRun(db: Db, ctx: RequestContext, schoolId: string, month: string): Promise<{ id: string }> {
  const m = parse(monthField, month);
  try {
    return await withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
      const [r] = await tx.insert(payrollRuns).values({ schoolId, periodStart: `${m}-01`, preparedBy: actor.userId }).returning({ id: payrollRuns.id });
      await audit(tx, { action: "payroll.run_created", actorUserId: actor.userId, schoolId, entityType: "payroll_run", entityId: r!.id, data: { month: m } });
      return { id: r!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("payroll_runs_one_per_month")) throw new AppError("CONFLICT", "This month already has a payroll run.", { month: "Already has a run." });
    throw e;
  }
}

interface Eligible {
  staffId: string;
  joinedOn: string | null;
  leftOn: string | null;
  salaryId: string | null;
  effectiveFrom: string | null;
  basicPaise: number | null;
}

/**
 * Calculates (or recalculates) a draft run from the current salaries, components, attendance
 * and leave. Each slip stores a copy of the inputs it used.
 */
export async function calculateRun(db: Db, ctx: RequestContext, schoolId: string, runId: string): Promise<{ included: number; excluded: number }> {
  parse(uuidField("Payroll run"), runId);
  return withCapability(db, ctx, schoolId, PREPARE, async (tx, actor) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.schoolId, schoolId), eq(payrollRuns.id, runId))).for("update");
    if (!run) throw new AppError("NOT_FOUND", "Payroll run not found.");
    if (run.status !== "draft") throw new AppError("CONFLICT", "This run is approved; it cannot be recalculated.");
    const start = run.periodStart;
    const end = monthEnd(start);
    const monthDays = await workingDays(tx, schoolId, start, end);
    const monthWorkingHalves = monthDays.length * 2;

    const staff = (await tx.execute(sql`
      select p.id as "staffId", p.joined_on::text as "joinedOn", p.left_on::text as "leftOn",
             s.id as "salaryId", s.effective_from::text as "effectiveFrom", s.basic_paise::float8 as "basicPaise"
      from staff_profiles p
      left join lateral (select id, effective_from, basic_paise from staff_salaries x where x.staff_id = p.id and x.effective_from <= ${end}::date
                         order by x.effective_from desc, x.created_at desc limit 1) s on true
      where p.school_id = ${schoolId}::uuid and (p.joined_on is null or p.joined_on <= ${end}::date) and (p.left_on is null or p.left_on >= ${start}::date)`)) as unknown as Eligible[];

    const done = new Set<string>();
    for (const p of staff) {
      if (!p.salaryId || p.basicPaise === null) continue;
      const from = p.joinedOn && p.joinedOn > start ? p.joinedOn : start;
      const to = p.leftOn && p.leftOn < end ? p.leftOn : end;
      const days = monthDays.filter((d) => d >= from && d <= to);
      const [lop] = (await tx.execute(sql`
        select coalesce(sum(case a.status when 'absent' then 2 when 'half_day' then 1
                                          when 'leave' then case when t.paid then 0 else 2 end
                                          when 'half_leave' then case when t.paid then 0 else 1 end else 0 end), 0)::int as halves,
               count(*) filter (where a.status = 'absent')::int as absent, count(*) filter (where a.status = 'half_day')::int as "halfDays",
               coalesce(sum(case when a.status in ('leave', 'half_leave') and not t.paid then case a.status when 'leave' then 2 else 1 end end), 0)::int as "unpaidLeaveHalves"
        from hr_staff_attendance a left join hr_leave_requests r on r.id = a.leave_request_id left join hr_leave_types t on t.id = r.leave_type_id
        where a.staff_id = ${p.staffId}::uuid and a.on = any(string_to_array(${days.join(",")}, ',')::date[])`)) as unknown as { halves: number; absent: number; halfDays: number; unpaidLeaveHalves: number }[];
      const components = (await tx.execute(sql`
        select c.id as "componentId", c.name, c.kind::text as kind, c.calc::text as calc, c.prorate, c.cap_paise::float8 as "capPaise", l.value::float8 as value
        from staff_salary_lines l join payroll_components c on c.id = l.component_id
        where l.salary_id = ${p.salaryId}::uuid order by c.kind, c.sort_order, lower(c.name)`)) as unknown as SlipComponentInput[];
      const inputs = {
        monthWorkingHalves,
        workingHalves: days.length * 2,
        lopHalves: Math.min(lop?.halves ?? 0, days.length * 2),
        basicPaise: p.basicPaise,
        components,
      };
      const res = calculateSlip(inputs);
      const snapshot = {
        ...inputs,
        salaryId: p.salaryId,
        effectiveFrom: p.effectiveFrom,
        period: { start, end, from, to },
        lop: { absentDays: lop?.absent ?? 0, halfDays: lop?.halfDays ?? 0, unpaidLeaveHalves: lop?.unpaidLeaveHalves ?? 0 },
      };
      const values = {
        salaryId: p.salaryId,
        included: true,
        monthWorkingHalves,
        workingHalves: inputs.workingHalves,
        lopHalves: inputs.lopHalves,
        payableHalves: res.payableHalves,
        basicPaise: p.basicPaise,
        earnedBasicPaise: res.earnedBasicPaise,
        grossPaise: res.grossPaise,
        deductionsPaise: res.deductionsPaise,
        netPaise: res.netPaise,
        lines: res.lines,
        inputs: snapshot,
        calculatedAt: sql`now()`,
      };
      await tx
        .insert(payrollSlips)
        .values({ schoolId, runId, staffId: p.staffId, ...values })
        .onConflictDoUpdate({ target: [payrollSlips.runId, payrollSlips.staffId], set: values });
      done.add(p.staffId);
    }
    // Staff calculated earlier but no longer in the run (salary removed from the period, dates changed).
    const stale = await tx.select({ staffId: payrollSlips.staffId }).from(payrollSlips).where(and(eq(payrollSlips.runId, runId), eq(payrollSlips.included, true)));
    for (const s of stale) if (!done.has(s.staffId)) await tx.update(payrollSlips).set({ included: false, calculatedAt: sql`now()` }).where(and(eq(payrollSlips.runId, runId), eq(payrollSlips.staffId, s.staffId)));
    await tx.update(payrollRuns).set({ calculatedAt: sql`now()`, calculatedBy: actor.userId }).where(eq(payrollRuns.id, runId));
    await audit(tx, { action: "payroll.run_calculated", actorUserId: actor.userId, schoolId, entityType: "payroll_run", entityId: runId, data: { included: done.size } });
    return { included: done.size, excluded: staff.length - done.size };
  });
}

export interface SlipRow {
  id: string;
  staffId: string;
  name: string;
  employeeNo: string;
  workingDays: string;
  lopDays: string;
  payableDays: string;
  basicPaise: number;
  earnedBasicPaise: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  lines: SlipLine[];
  flagged: boolean;
}

export interface RunDetail {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "approved" | "paid";
  preparedBy: string;
  calculatedAt: Date | null;
  calculatedBy: string | null;
  slips: SlipRow[];
  notIncluded: { staffId: string; name: string; employeeNo: string }[];
  totals: { grossPaise: number; deductionsPaise: number; netPaise: number };
}

const halves = (h: number) => (h % 2 === 0 ? String(h / 2) : `${(h - 1) / 2}.5`);

export async function getRun(db: Db, ctx: RequestContext, schoolId: string, runId: string): Promise<RunDetail> {
  parse(uuidField("Payroll run"), runId);
  return withCapability(db, ctx, schoolId, PREPARE, async (tx) => {
    const [r] = (await tx.execute(sql`
      select r.id, r.period_start::text as "periodStart", r.status::text as status, coalesce(u.full_name, 'A colleague') as "preparedBy", r.calculated_at as "calculatedAt", c.full_name as "calculatedBy"
      from payroll_runs r left join users u on u.id = r.prepared_by left join users c on c.id = r.calculated_by
      where r.school_id = ${schoolId}::uuid and r.id = ${runId}::uuid`)) as unknown as Omit<RunDetail, "slips" | "notIncluded" | "totals" | "periodEnd">[];
    if (!r) throw new AppError("NOT_FOUND", "Payroll run not found.");
    const end = monthEnd(r.periodStart);
    const raw = (await tx.execute(sql`
      select s.id, s.staff_id as "staffId", p.display_name as name, p.employee_no as "employeeNo", s.working_halves as wh, s.lop_halves as lh, s.payable_halves as ph,
             s.basic_paise::float8 as "basicPaise", s.earned_basic_paise::float8 as "earnedBasicPaise", s.gross_paise::float8 as "grossPaise",
             s.deductions_paise::float8 as "deductionsPaise", s.net_paise::float8 as "netPaise", s.lines
      from payroll_slips s join staff_profiles p on p.id = s.staff_id where s.run_id = ${runId}::uuid and s.included order by lower(p.display_name)`)) as unknown as (Omit<SlipRow, "workingDays" | "lopDays" | "payableDays" | "flagged"> & { wh: number; lh: number; ph: number })[];
    const slips = raw.map(({ wh, lh, ph, ...s }) => ({ ...s, workingDays: halves(wh), lopDays: halves(lh), payableDays: halves(ph), flagged: s.netPaise < 0 }));
    const notIncluded = (await tx.execute(sql`
      select p.id as "staffId", p.display_name as name, p.employee_no as "employeeNo" from staff_profiles p
      where p.school_id = ${schoolId}::uuid and (p.joined_on is null or p.joined_on <= ${end}::date) and (p.left_on is null or p.left_on >= ${r.periodStart}::date)
        and not exists (select 1 from payroll_slips s where s.run_id = ${runId}::uuid and s.staff_id = p.id and s.included)
      order by lower(p.display_name)`)) as unknown as RunDetail["notIncluded"];
    const totals = slips.reduce((a, s) => ({ grossPaise: a.grossPaise + s.grossPaise, deductionsPaise: a.deductionsPaise + s.deductionsPaise, netPaise: a.netPaise + s.netPaise }), { grossPaise: 0, deductionsPaise: 0, netPaise: 0 });
    return { ...r, periodEnd: end, calculatedAt: r.calculatedAt ? new Date(r.calculatedAt) : null, slips, notIncluded, totals };
  });
}
