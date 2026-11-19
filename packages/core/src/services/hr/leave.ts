import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hrLeaveRequests, hrLeaveTypes, hrStaffAttendance, hrStaffAttendanceChanges, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { schoolToday } from "../../dates";
import { checkViolation, exclusionViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";

/**
 * Staff attendance and leave (Phase 14.2).
 *
 * - Working days: not a weekly off day and not inside a school-calendar holiday. Leave is
 *   counted in working half days.
 * - Leave types with a yearly quota (paid) per academic year; unpaid types have none.
 * - Requests by the staff member (or an administrator for them); pending and approved requests
 *   of one person never overlap (database). Another administrator approves (enough balance
 *   for paid leave) or rejects with a reason; approval marks the register as leave.
 * - The staff register: administrators mark present, absent or half day for a past or current
 *   day; leave marks come only from approved leave; changing a mark needs a reason and is kept.
 */

const MANAGE = "school.hr.manage";
const SELF = "school.hr.self";
export type RegisterStatus = "present" | "absent" | "half_day" | "leave" | "half_leave";
export const halvesToDays = (h: number): string => (h % 2 === 0 ? String(h / 2) : `${(h - 1) / 2}.5`);

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

/** The school's working days from one date to another (inclusive). */
async function workingDays(tx: Tx, schoolId: string, from: string, to: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select d::date::text as day from schools s, generate_series(${from}::date, ${to}::date, interval '1 day') d
    where s.id = ${schoolId}::uuid and not (extract(isodow from d)::int = any(s.weekly_off_days))
      and not exists (select 1 from calendar_events e where e.school_id = s.id and e.kind = 'holiday' and d::date between e.starts_on and e.ends_on)
    order by d`)) as unknown as { day: string }[];
  return rows.map((r) => r.day);
}

async function yearContaining(tx: Tx, schoolId: string, from: string, to: string): Promise<string> {
  const [y] = (await tx.execute(sql`
    select id from academic_years where school_id = ${schoolId}::uuid and starts_on <= ${from}::date and ends_on >= ${to}::date and status <> 'closed'`)) as unknown as { id: string }[];
  if (!y) throw new AppError("VALIDATION", "Leave must fall within one academic year that is not closed.", { fromOn: "Outside the academic year." });
  return y.id;
}

async function staffOf(tx: Tx, schoolId: string, staffId: string) {
  const [p] = (await tx.execute(sql`select id, user_id as "userId", display_name as name, status::text as status from staff_profiles where school_id = ${schoolId}::uuid and id = ${staffId}::uuid`)) as unknown as {
    id: string;
    userId: string;
    name: string;
    status: string;
  }[];
  if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
  return p;
}

async function myStaffId(tx: Tx, schoolId: string): Promise<string | null> {
  const [r] = (await tx.execute(sql`select app_my_staff_id(${schoolId}::uuid) as id`)) as unknown as { id: string | null }[];
  return r?.id ?? null;
}

/* ------------------------------------------------------------------ leave types */

export interface LeaveTypeRow {
  id: string;
  name: string;
  paid: boolean;
  quotaDays: string | null;
  archived: boolean;
}

const quotaField = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.5)?$/, "Days per year: a whole or half number, for example 12 or 7.5.")
  .transform((v) => Math.round(Number(v) * 2))
  .pipe(z.number().max(730, "Days per year: at most 365."));

export async function listLeaveTypes(db: Db, ctx: RequestContext, schoolId: string): Promise<LeaveTypeRow[]> {
  return withCapability(db, ctx, schoolId, SELF, async (tx) => {
    const rows = await tx.select().from(hrLeaveTypes).where(eq(hrLeaveTypes.schoolId, schoolId)).orderBy(sql`${hrLeaveTypes.archivedAt} is not null`, sql`lower(${hrLeaveTypes.name})`);
    return rows.map((r) => ({ id: r.id, name: r.name, paid: r.paid, quotaDays: r.quotaHalves === null ? null : halvesToDays(r.quotaHalves), archived: r.archivedAt !== null }));
  });
}

export async function createLeaveType(db: Db, ctx: RequestContext, schoolId: string, input: { name: string; paid: boolean; quotaDays?: string }): Promise<{ id: string }> {
  const name = parse(trimmed("Name", 1, 60), input.name);
  const quotaHalves = input.paid ? parse(quotaField, input.quotaDays ?? "") : null;
  try {
    return await withCapability(db, ctx, schoolId, MANAGE, async (tx, actor) => {
      const [t] = await tx.insert(hrLeaveTypes).values({ schoolId, name, paid: input.paid, quotaHalves }).returning({ id: hrLeaveTypes.id });
      await audit(tx, { action: "hr.leave_type_added", actorUserId: actor.userId, schoolId, entityType: "hr_leave_type", entityId: t!.id, data: { name, paid: input.paid, quotaHalves } });
      return { id: t!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("hr_leave_types_name")) throw new AppError("CONFLICT", "A leave type with this name already exists.", { name: "Already used." });
    throw e;
  }
}

/** Changes a type's yearly quota (paid types) or archives or restores it. The name and paid flag stay. */
export async function updateLeaveType(db: Db, ctx: RequestContext, schoolId: string, typeId: string, input: { quotaDays?: string; archived?: boolean }): Promise<void> {
  parse(uuidField("Leave type"), typeId);
  await withCapability(db, ctx, schoolId, MANAGE, async (tx, actor) => {
    const [t] = await tx.select().from(hrLeaveTypes).where(and(eq(hrLeaveTypes.schoolId, schoolId), eq(hrLeaveTypes.id, typeId)));
    if (!t) throw new AppError("NOT_FOUND", "Leave type not found.");
    const quotaHalves = t.paid && input.quotaDays !== undefined ? parse(quotaField, input.quotaDays) : t.quotaHalves;
    const archivedAt = input.archived === undefined ? t.archivedAt : input.archived ? sql`now()` : null;
    await tx.update(hrLeaveTypes).set({ quotaHalves, archivedAt }).where(eq(hrLeaveTypes.id, typeId));
    await audit(tx, { action: "hr.leave_type_updated", actorUserId: actor.userId, schoolId, entityType: "hr_leave_type", entityId: typeId, data: { quotaHalves, archived: input.archived ?? null } });
  });
}

/* ------------------------------------------------------------------ balances */

export interface LeaveBalance {
  leaveTypeId: string;
  name: string;
  quotaDays: string;
  approvedDays: string;
  pendingDays: string;
  remainingDays: string;
  remainingHalves: number;
}

async function balancesTx(tx: Tx, schoolId: string, staffId: string, yearId: string): Promise<LeaveBalance[]> {
  const rows = (await tx.execute(sql`
    select t.id as "leaveTypeId", t.name, t.quota_halves as quota,
           coalesce(sum(r.days_halves) filter (where r.status = 'approved'), 0)::int as approved,
           coalesce(sum(r.days_halves) filter (where r.status = 'pending'), 0)::int as pending
    from hr_leave_types t left join hr_leave_requests r on r.leave_type_id = t.id and r.staff_id = ${staffId}::uuid and r.academic_year_id = ${yearId}::uuid
    where t.school_id = ${schoolId}::uuid and t.paid and t.quota_halves is not null and t.archived_at is null
    group by t.id order by lower(t.name)`)) as unknown as { leaveTypeId: string; name: string; quota: number; approved: number; pending: number }[];
  return rows.map((r) => ({
    leaveTypeId: r.leaveTypeId,
    name: r.name,
    quotaDays: halvesToDays(r.quota),
    approvedDays: halvesToDays(r.approved),
    pendingDays: halvesToDays(r.pending),
    remainingDays: halvesToDays(Math.max(0, r.quota - r.approved)),
    remainingHalves: Math.max(0, r.quota - r.approved),
  }));
}

/* ------------------------------------------------------------------ requests */

const requestSchema = z.object({
  leaveTypeId: uuidField("Leave type"),
  fromOn: isoDate("start date"),
  toOn: z.union([z.literal("").transform(() => null), isoDate("end date")]).nullable().optional(),
  halfDay: z.boolean().optional(),
  reason: trimmed("Reason", 3, 300),
});

/**
 * Requests leave for oneself, or (administrators) for a staff member. The working half days are
 * counted now; a paid request must fit in the remaining balance including other pending requests.
 */
export async function requestLeave(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: z.input<typeof requestSchema> & { staffId?: string },
): Promise<{ id: string; days: string }> {
  const v = parse(requestSchema, input);
  const toOn = v.halfDay ? v.fromOn : (v.toOn ?? v.fromOn);
  if (toOn < v.fromOn) throw new AppError("VALIDATION", "The end date cannot be before the start date.", { toOn: "Before the start." });
  try {
    return await withCapability(db, ctx, schoolId, SELF, async (tx, actor) => {
      const mine = await myStaffId(tx, schoolId);
      const staffId = input.staffId ? parse(uuidField("Staff member"), input.staffId) : mine;
      if (!staffId) throw new AppError("NOT_FOUND", "You do not have a staff record in this school.");
      if (staffId !== mine && !actor.roles.includes("school_admin")) throw new AppError("FORBIDDEN", "Only administrators can request leave for someone else.");
      const staff = await staffOf(tx, schoolId, staffId);
      if (staff.status !== "active") throw new AppError("CONFLICT", `${staff.name} has left the school.`);
      const [type] = await tx.select().from(hrLeaveTypes).where(and(eq(hrLeaveTypes.schoolId, schoolId), eq(hrLeaveTypes.id, v.leaveTypeId)));
      if (!type || type.archivedAt) throw new AppError("NOT_FOUND", "Leave type not found.", { leaveTypeId: "Choose a leave type." });
      const yearId = await yearContaining(tx, schoolId, v.fromOn, toOn);
      const days = await workingDays(tx, schoolId, v.fromOn, toOn);
      if (days.length === 0) throw new AppError("VALIDATION", "These dates have no working days.", { fromOn: "No working days." });
      const halves = v.halfDay ? 1 : days.length * 2;
      if (type.paid && type.quotaHalves !== null) {
        const b = (await balancesTx(tx, schoolId, staffId, yearId)).find((x) => x.leaveTypeId === type.id);
        const pendingHalves = b ? Math.round(Number(b.pendingDays) * 2) : 0;
        const left = (b?.remainingHalves ?? type.quotaHalves) - pendingHalves;
        if (halves > left) throw new AppError("CONFLICT", `Only ${halvesToDays(Math.max(0, left))} day(s) of ${type.name} are left, counting pending requests.`, { leaveTypeId: "Not enough balance." });
      }
      const [r] = await tx
        .insert(hrLeaveRequests)
        .values({ schoolId, staffId, leaveTypeId: type.id, academicYearId: yearId, fromOn: v.fromOn, toOn, halfDay: Boolean(v.halfDay), daysHalves: halves, reason: v.reason, requestedBy: actor.userId })
        .returning({ id: hrLeaveRequests.id });
      await audit(tx, { action: "hr.leave_requested", actorUserId: actor.userId, schoolId, entityType: "hr_leave_request", entityId: r!.id, data: { staffId, leaveTypeId: type.id, fromOn: v.fromOn, toOn, halves } });
      return { id: r!.id, days: halvesToDays(halves) };
    });
  } catch (e) {
    if (exclusionViolation(e)?.includes("hr_leave_requests_no_overlap")) throw new AppError("CONFLICT", "This overlaps another pending or approved leave request.", { fromOn: "Overlaps other leave." });
    throw e;
  }
}

async function setLeaveMarks(tx: Tx, schoolId: string, actorUserId: string, req: typeof hrLeaveRequests.$inferSelect, reason: string) {
  const days = req.halfDay ? [req.fromOn] : await workingDays(tx, schoolId, req.fromOn, req.toOn);
  const status: RegisterStatus = req.halfDay ? "half_leave" : "leave";
  for (const on of days) {
    const [old] = await tx.select().from(hrStaffAttendance).where(and(eq(hrStaffAttendance.staffId, req.staffId), eq(hrStaffAttendance.on, on))).for("update");
    if (old) {
      await tx.update(hrStaffAttendance).set({ status, leaveRequestId: req.id, markedBy: actorUserId, markedAt: sql`now()` }).where(and(eq(hrStaffAttendance.staffId, req.staffId), eq(hrStaffAttendance.on, on)));
      if (old.status !== status) await tx.insert(hrStaffAttendanceChanges).values({ schoolId, staffId: req.staffId, on, fromStatus: old.status, toStatus: status, reason, actorUserId });
    } else {
      await tx.insert(hrStaffAttendance).values({ schoolId, staffId: req.staffId, on, status, leaveRequestId: req.id, markedBy: actorUserId });
    }
  }
}

/** Approves (with enough balance for paid leave) or rejects (with a reason) a pending request. */
export async function decideLeave(db: Db, ctx: RequestContext, schoolId: string, requestId: string, approve: boolean, note?: string): Promise<void> {
  parse(uuidField("Leave request"), requestId);
  const why = note?.trim() ? parse(trimmed("Note", 3, 300), note) : null;
  if (!approve && !why) throw new AppError("VALIDATION", "Give a reason for rejecting.", { note: "Required." });
  try {
    await withCapability(db, ctx, schoolId, MANAGE, async (tx, actor) => {
      const [req] = await tx.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.schoolId, schoolId), eq(hrLeaveRequests.id, requestId))).for("update");
      if (!req) throw new AppError("NOT_FOUND", "Leave request not found.");
      if (req.status !== "pending") throw new AppError("CONFLICT", "This request has already been decided.");
      const staff = await staffOf(tx, schoolId, req.staffId);
      if (staff.userId === actor.userId || req.requestedBy === actor.userId) throw new AppError("FORBIDDEN", "Another administrator must decide this request.");
      if (approve) {
        const [type] = await tx.select().from(hrLeaveTypes).where(eq(hrLeaveTypes.id, req.leaveTypeId));
        if (type?.paid && type.quotaHalves !== null) {
          const b = (await balancesTx(tx, schoolId, req.staffId, req.academicYearId)).find((x) => x.leaveTypeId === type.id);
          const left = b?.remainingHalves ?? type.quotaHalves;
          if (req.daysHalves > left) throw new AppError("CONFLICT", `Only ${halvesToDays(left)} day(s) of ${type.name} are left.`);
        }
      }
      await tx
        .update(hrLeaveRequests)
        .set({ status: approve ? "approved" : "rejected", decidedBy: actor.userId, decidedAt: sql`now()`, decisionNote: why })
        .where(eq(hrLeaveRequests.id, requestId));
      if (approve) await setLeaveMarks(tx, schoolId, actor.userId, req, "Leave approved");
      await audit(tx, { action: approve ? "hr.leave_approved" : "hr.leave_rejected", actorUserId: actor.userId, schoolId, entityType: "hr_leave_request", entityId: requestId, data: { staffId: req.staffId } });
    });
  } catch (e) {
    if (checkViolation(e) === "hr_leave_requests_decider") throw new AppError("FORBIDDEN", "Another administrator must decide this request.");
    throw e;
  }
}

/**
 * Cancels a request: staff their own pending ones; administrators pending or approved ones (with
 * a reason). Cancelling approved leave clears its register marks, kept in the history.
 */
export async function cancelLeave(db: Db, ctx: RequestContext, schoolId: string, requestId: string, reason?: string): Promise<void> {
  parse(uuidField("Leave request"), requestId);
  const why = reason?.trim() ? parse(trimmed("Reason", 3, 300), reason) : null;
  await withCapability(db, ctx, schoolId, SELF, async (tx, actor) => {
    // Read first without a lock: a lock applies the update policy, which hides a staff member's
    // own approved request from them and would turn "ask an administrator" into "not found".
    const [seen] = await tx.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.schoolId, schoolId), eq(hrLeaveRequests.id, requestId)));
    if (!seen) throw new AppError("NOT_FOUND", "Leave request not found.");
    const isAdmin = actor.roles.includes("school_admin");
    if (seen.status === "approved" && !isAdmin) throw new AppError("FORBIDDEN", "Ask an administrator to cancel approved leave.");
    const [req] = await tx.select().from(hrLeaveRequests).where(eq(hrLeaveRequests.id, requestId)).for("update");
    if (!req) throw new AppError("NOT_FOUND", "Leave request not found.");
    const own = req.staffId === (await myStaffId(tx, schoolId));
    if (!isAdmin && !own) throw new AppError("NOT_FOUND", "Leave request not found.");
    if (req.status === "approved") {
      if (!isAdmin) throw new AppError("FORBIDDEN", "Ask an administrator to cancel approved leave.");
      if (!why) throw new AppError("VALIDATION", "Give a reason for cancelling approved leave.", { reason: "Required." });
    } else if (req.status !== "pending") {
      throw new AppError("CONFLICT", "This request has already been decided.");
    }
    await tx.update(hrLeaveRequests).set({ status: "cancelled", decidedBy: actor.userId, decidedAt: sql`now()`, decisionNote: why }).where(eq(hrLeaveRequests.id, requestId));
    if (req.status === "approved") {
      const marks = await tx.select().from(hrStaffAttendance).where(eq(hrStaffAttendance.leaveRequestId, requestId)).for("update");
      for (const m of marks) {
        await tx.update(hrStaffAttendance).set({ status: null, leaveRequestId: null, markedBy: actor.userId, markedAt: sql`now()` }).where(and(eq(hrStaffAttendance.staffId, m.staffId), eq(hrStaffAttendance.on, m.on)));
        await tx.insert(hrStaffAttendanceChanges).values({ schoolId, staffId: m.staffId, on: m.on, fromStatus: m.status, toStatus: null, reason: `Leave cancelled: ${why}`.slice(0, 300), actorUserId: actor.userId });
      }
    }
    await audit(tx, { action: "hr.leave_cancelled", actorUserId: actor.userId, schoolId, entityType: "hr_leave_request", entityId: requestId, data: { from: req.status } });
  });
}

export interface LeaveRequestRow {
  id: string;
  staffId: string;
  staff: string;
  type: string;
  paid: boolean;
  fromOn: string;
  toOn: string;
  halfDay: boolean;
  days: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: Date;
  /** Remaining days of this paid type for the year, for pending requests (administrators). */
  remaining: string | null;
}

const requestSelect = sql`
  select r.id, r.staff_id as "staffId", p.display_name || ' (' || p.employee_no || ')' as staff, t.name as type, t.paid, r.from_on::text as "fromOn", r.to_on::text as "toOn",
         r.half_day as "halfDay", r.days_halves as halves, r.reason, r.status::text as status, ru.full_name as "requestedBy", du.full_name as "decidedBy", r.decision_note as "decisionNote",
         r.created_at as "createdAt", r.academic_year_id as "yearId", r.leave_type_id as "typeId", t.quota_halves as quota
  from hr_leave_requests r join staff_profiles p on p.id = r.staff_id join hr_leave_types t on t.id = r.leave_type_id
  join users ru on ru.id = r.requested_by left join users du on du.id = r.decided_by`;

type RawRequest = Omit<LeaveRequestRow, "days" | "remaining"> & { halves: number; yearId: string; typeId: string; quota: number | null };

async function shape(tx: Tx, rows: RawRequest[]): Promise<LeaveRequestRow[]> {
  const out: LeaveRequestRow[] = [];
  for (const r of rows) {
    let remaining: string | null = null;
    if (r.status === "pending" && r.paid && r.quota !== null) {
      const [u] = (await tx.execute(sql`
        select coalesce(sum(days_halves), 0)::int as used from hr_leave_requests
        where staff_id = ${r.staffId}::uuid and leave_type_id = ${r.typeId}::uuid and academic_year_id = ${r.yearId}::uuid and status = 'approved'`)) as unknown as { used: number }[];
      remaining = halvesToDays(Math.max(0, r.quota - (u?.used ?? 0)));
    }
    out.push({
      id: r.id,
      staffId: r.staffId,
      staff: r.staff,
      type: r.type,
      paid: r.paid,
      fromOn: r.fromOn,
      toOn: r.toOn,
      halfDay: r.halfDay,
      days: halvesToDays(r.halves),
      reason: r.reason,
      status: r.status,
      requestedBy: r.requestedBy,
      decidedBy: r.decidedBy,
      decisionNote: r.decisionNote,
      createdAt: new Date(r.createdAt),
      remaining,
    });
  }
  return out;
}

/** Requests for administrators: pending first (oldest first), then recent decisions. */
export async function listLeaveRequests(db: Db, ctx: RequestContext, schoolId: string, f: { status?: string } = {}): Promise<LeaveRequestRow[]> {
  const status = ["pending", "approved", "rejected", "cancelled"].includes(f.status ?? "") ? f.status : null;
  return withCapability(db, ctx, schoolId, MANAGE, async (tx) => {
    const rows = (await tx.execute(sql`${requestSelect}
      where r.school_id = ${schoolId}::uuid ${status ? sql`and r.status = ${status}::hr_leave_status` : sql``}
      order by r.status <> 'pending', case when r.status = 'pending' then r.created_at end, r.from_on desc limit 300`)) as unknown as RawRequest[];
    return shape(tx, rows);
  });
}

export interface MyLeave {
  staffName: string;
  yearName: string | null;
  balances: LeaveBalance[];
  requests: LeaveRequestRow[];
}

/** The signed-in staff member's balances for the current academic year and their requests. */
export async function getMyLeave(db: Db, ctx: RequestContext, schoolId: string): Promise<MyLeave | null> {
  return withCapability(db, ctx, schoolId, SELF, async (tx) => {
    const staffId = await myStaffId(tx, schoolId);
    if (!staffId) return null;
    const staff = await staffOf(tx, schoolId, staffId);
    const [y] = (await tx.execute(sql`select id, name from academic_years where school_id = ${schoolId}::uuid and status = 'current'`)) as unknown as { id: string; name: string }[];
    const balances = y ? await balancesTx(tx, schoolId, staffId, y.id) : [];
    const rows = (await tx.execute(sql`${requestSelect} where r.school_id = ${schoolId}::uuid and r.staff_id = ${staffId}::uuid order by r.from_on desc limit 100`)) as unknown as RawRequest[];
    return { staffName: staff.name, yearName: y?.name ?? null, balances, requests: await shape(tx, rows) };
  });
}

/** One staff member's balances for the current academic year (administrators). */
export async function getStaffLeaveBalances(db: Db, ctx: RequestContext, schoolId: string, staffId: string): Promise<LeaveBalance[]> {
  parse(uuidField("Staff member"), staffId);
  return withCapability(db, ctx, schoolId, MANAGE, async (tx) => {
    await staffOf(tx, schoolId, staffId);
    const [y] = (await tx.execute(sql`select id from academic_years where school_id = ${schoolId}::uuid and status = 'current'`)) as unknown as { id: string }[];
    return y ? balancesTx(tx, schoolId, staffId, y.id) : [];
  });
}

/* ------------------------------------------------------------------ the staff register */

export interface StaffRegister {
  date: string;
  today: string;
  workingDay: boolean;
  rows: { staffId: string; name: string; employeeNo: string; status: RegisterStatus | null; leaveType: string | null; marked: boolean }[];
}

export async function getStaffRegister(db: Db, ctx: RequestContext, schoolId: string, date?: string): Promise<StaffRegister> {
  return withCapability(db, ctx, schoolId, MANAGE, async (tx) => {
    const today = await schoolDay(tx, schoolId);
    const d = date ? parse(isoDate("date"), date) : today;
    const working = (await workingDays(tx, schoolId, d, d)).length === 1;
    const rows = (await tx.execute(sql`
      select p.id as "staffId", p.display_name as name, p.employee_no as "employeeNo", a.status::text as status, t.name as "leaveType", (a.staff_id is not null and a.status is not null) as marked
      from staff_profiles p
      left join hr_staff_attendance a on a.staff_id = p.id and a.on = ${d}::date
      left join hr_leave_requests r on r.id = a.leave_request_id left join hr_leave_types t on t.id = r.leave_type_id
      where p.school_id = ${schoolId}::uuid and (p.status = 'active' or a.status is not null)
        and (p.joined_on is null or p.joined_on <= ${d}::date) and (p.left_on is null or p.left_on >= ${d}::date)
      order by lower(p.display_name)`)) as unknown as StaffRegister["rows"];
    return { date: d, today, workingDay: working, rows };
  });
}

/**
 * Marks the register for one day. New marks need no reason; changing an existing mark needs one
 * and is kept as a correction. Leave marks come only from leave and cannot be changed here.
 */
export async function markStaffRegister(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { date: string; marks: { staffId: string; status: string }[]; reason?: string },
): Promise<{ marked: number; corrected: number; skippedLeave: number }> {
  const date = parse(isoDate("date"), input.date);
  const reason = input.reason?.trim() ? parse(trimmed("Reason", 3, 300), input.reason) : null;
  const marks = input.marks.filter((m) => m.status !== "");
  for (const m of marks) {
    parse(uuidField("Staff member"), m.staffId);
    if (!["present", "absent", "half_day"].includes(m.status)) throw new AppError("VALIDATION", "Mark staff present, absent or half day.");
  }
  return withCapability(db, ctx, schoolId, MANAGE, async (tx, actor) => {
    if (date > (await schoolDay(tx, schoolId))) throw new AppError("VALIDATION", "Days in the future cannot be marked.", { date: "In the future." });
    let marked = 0;
    let corrected = 0;
    let skippedLeave = 0;
    for (const m of marks) {
      await staffOf(tx, schoolId, m.staffId);
      const status = m.status as RegisterStatus;
      const [old] = await tx.select().from(hrStaffAttendance).where(and(eq(hrStaffAttendance.staffId, m.staffId), eq(hrStaffAttendance.on, date))).for("update");
      if (old?.leaveRequestId) {
        skippedLeave++;
        continue;
      }
      if (!old) {
        await tx.insert(hrStaffAttendance).values({ schoolId, staffId: m.staffId, on: date, status, markedBy: actor.userId });
        marked++;
      } else if (old.status !== status) {
        if (old.status !== null && !reason) throw new AppError("VALIDATION", "Changing a mark that was already saved needs a reason.", { reason: "Required for corrections." });
        await tx.update(hrStaffAttendance).set({ status, markedBy: actor.userId, markedAt: sql`now()` }).where(and(eq(hrStaffAttendance.staffId, m.staffId), eq(hrStaffAttendance.on, date)));
        await tx.insert(hrStaffAttendanceChanges).values({ schoolId, staffId: m.staffId, on: date, fromStatus: old.status, toStatus: status, reason: reason ?? "Marked after leave was cancelled", actorUserId: actor.userId });
        if (old.status === null) marked++;
        else corrected++;
      }
    }
    await audit(tx, { action: "hr.register_marked", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { date, marked, corrected } });
    return { marked, corrected, skippedLeave };
  });
}

/** A staff member's own register for a month (YYYY-MM), with any corrections. */
export async function getMyRegister(db: Db, ctx: RequestContext, schoolId: string, month: string): Promise<{ on: string; status: RegisterStatus | null }[]> {
  const m = parse(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month."), month);
  return withCapability(db, ctx, schoolId, SELF, async (tx) => {
    const staffId = await myStaffId(tx, schoolId);
    if (!staffId) return [];
    return (await tx.execute(sql`
      select a.on::text as on, a.status::text as status from hr_staff_attendance a
      where a.staff_id = ${staffId}::uuid and to_char(a.on, 'YYYY-MM') = ${m} order by a.on`)) as unknown as { on: string; status: RegisterStatus | null }[];
  });
}
