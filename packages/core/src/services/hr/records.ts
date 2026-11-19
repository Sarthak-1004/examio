import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { files, hrDepartments, hrDesignations, hrDocuments, hrEmployment, hrEmploymentEvents, hrPaymentDetails, staffProfiles, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { schoolToday } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { phoneSchema } from "../../validation";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";

/**
 * HR records (Phase 14.1), kept by school administrators.
 *
 * - Departments and designations (archived, never deleted).
 * - One employment record per staff member: type, department, designation, confirmation,
 *   notice period, emergency contact. Each change of type, department, designation or
 *   confirmation adds a dated, append-only employment-history entry; leaving and rejoining
 *   (Phase 4 staff services) add entries too.
 * - Payment details (bank account, IFSC, PAN) for payroll: administrators and finance only;
 *   lists show the account's last four digits.
 * - Private HR documents: administrators only; removed by marking.
 */

const CAP = "school.hr.manage";
export const EMPLOYMENT_TYPES = ["permanent", "probation", "contract", "part_time", "temporary"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const HR_DOCUMENT_KINDS = ["appointment_letter", "id_proof", "qualification", "experience_letter", "address_proof", "other"] as const;
const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

/* ------------------------------------------------------------------ departments and designations */

export type HrListKind = "department" | "designation";
const listTable = (kind: HrListKind) => (kind === "department" ? hrDepartments : hrDesignations);

export interface HrListRow {
  id: string;
  name: string;
  archived: boolean;
  staff: number;
}

export async function listHrNames(db: Db, ctx: RequestContext, schoolId: string, kind: HrListKind): Promise<HrListRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const col = kind === "department" ? sql`e.department_id` : sql`e.designation_id`;
    const table = kind === "department" ? sql`hr_departments` : sql`hr_designations`;
    return (await tx.execute(sql`
      select t.id, t.name, t.archived_at is not null as archived,
             (select count(*)::int from hr_employment e join staff_profiles p on p.id = e.staff_id where ${col} = t.id and p.status = 'active') as staff
      from ${table} t where t.school_id = ${schoolId}::uuid order by t.archived_at is not null, lower(t.name)`)) as unknown as HrListRow[];
  });
}

export async function createHrName(db: Db, ctx: RequestContext, schoolId: string, kind: HrListKind, name: string): Promise<{ id: string }> {
  const v = parse(trimmed(kind === "department" ? "Department" : "Designation", 1, 80), name);
  try {
    return await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const t = listTable(kind);
      const [r] = await tx.insert(t).values({ schoolId, name: v }).returning({ id: t.id });
      await audit(tx, { action: `hr.${kind}_added`, actorUserId: actor.userId, schoolId, entityType: `hr_${kind}`, entityId: r!.id, data: { name: v } });
      return { id: r!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("_name_unique")) throw new AppError("CONFLICT", `A ${kind} with this name already exists.`, { name: "Already used." });
    throw e;
  }
}

export async function setHrNameArchived(db: Db, ctx: RequestContext, schoolId: string, kind: HrListKind, id: string, archived: boolean): Promise<void> {
  parse(uuidField(kind === "department" ? "Department" : "Designation"), id);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const t = listTable(kind);
    const r = await tx.update(t).set({ archivedAt: archived ? sql`now()` : null }).where(and(eq(t.schoolId, schoolId), eq(t.id, id))).returning({ id: t.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", `${kind === "department" ? "Department" : "Designation"} not found.`);
    await audit(tx, { action: archived ? `hr.${kind}_archived` : `hr.${kind}_restored`, actorUserId: actor.userId, schoolId, entityType: `hr_${kind}`, entityId: id });
  });
}

/* ------------------------------------------------------------------ staff list */

export interface HrStaffRow {
  staffId: string;
  name: string;
  employeeNo: string;
  status: "active" | "left";
  employmentType: EmploymentType | null;
  department: string | null;
  designation: string | null;
  joinedOn: string | null;
  hasPaymentDetails: boolean;
}

export async function listHrStaff(db: Db, ctx: RequestContext, schoolId: string, f: { search?: string; departmentId?: string; employmentType?: string; status?: string } = {}): Promise<HrStaffRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const q = f.search?.trim().slice(0, 100) ?? "";
    const dept = f.departmentId && z.uuid().safeParse(f.departmentId).success ? f.departmentId : null;
    const type = (EMPLOYMENT_TYPES as readonly string[]).includes(f.employmentType ?? "") ? f.employmentType : null;
    const status = f.status === "left" ? "left" : f.status === "all" ? null : "active";
    return (await tx.execute(sql`
      select p.id as "staffId", p.display_name as name, p.employee_no as "employeeNo", p.status::text as status, e.employment_type::text as "employmentType",
             d.name as department, g.name as designation, p.joined_on::text as "joinedOn", (pd.staff_id is not null) as "hasPaymentDetails"
      from staff_profiles p left join hr_employment e on e.staff_id = p.id
      left join hr_departments d on d.id = e.department_id left join hr_designations g on g.id = e.designation_id
      left join hr_payment_details pd on pd.staff_id = p.id
      where p.school_id = ${schoolId}::uuid
        ${status ? sql`and p.status = ${status}::staff_status` : sql``}
        ${dept ? sql`and e.department_id = ${dept}::uuid` : sql``}
        ${type ? sql`and e.employment_type = ${type}::hr_employment_type` : sql``}
        ${q ? sql`and (p.display_name ilike ${likePattern(q)} or p.employee_no ilike ${likePattern(q)})` : sql``}
      order by lower(p.display_name) limit 500`)) as unknown as HrStaffRow[];
  });
}

/* ------------------------------------------------------------------ one staff member */

export interface HrRecord {
  staffId: string;
  name: string;
  employeeNo: string;
  jobTitle: string | null;
  status: "active" | "left";
  joinedOn: string | null;
  leftOn: string | null;
  employment: {
    employmentType: EmploymentType;
    departmentId: string | null;
    department: string | null;
    designationId: string | null;
    designation: string | null;
    confirmedOn: string | null;
    noticeDays: number | null;
    emergencyName: string | null;
    emergencyPhone: string | null;
  } | null;
  history: { kind: string; effectiveOn: string; fromValue: string | null; toValue: string | null; note: string | null; actor: string; at: Date }[];
  payment: { accountHolder: string; accountLast4: string; ifsc: string; pan: string | null; updatedAt: Date } | null;
  documents: { id: string; kind: string; fileId: string; fileName: string; fileStatus: string; note: string | null; uploadedAt: Date }[];
}

async function staffRow(tx: Tx, schoolId: string, staffId: string) {
  parse(uuidField("Staff member"), staffId);
  const [p] = await tx.select().from(staffProfiles).where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)));
  if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
  return p;
}

export async function getHrRecord(db: Db, ctx: RequestContext, schoolId: string, staffId: string): Promise<HrRecord> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const p = await staffRow(tx, schoolId, staffId);
    const [e] = (await tx.execute(sql`
      select e.employment_type::text as "employmentType", e.department_id as "departmentId", d.name as department, e.designation_id as "designationId", g.name as designation,
             e.confirmed_on::text as "confirmedOn", e.notice_days as "noticeDays", e.emergency_name as "emergencyName", e.emergency_phone as "emergencyPhone"
      from hr_employment e left join hr_departments d on d.id = e.department_id left join hr_designations g on g.id = e.designation_id
      where e.staff_id = ${staffId}::uuid`)) as unknown as NonNullable<HrRecord["employment"]>[];
    const history = ((await tx.execute(sql`
      select h.kind, h.effective_on::text as "effectiveOn", h.from_value as "fromValue", h.to_value as "toValue", h.note, u.full_name as actor, h.at
      from hr_employment_events h join users u on u.id = h.actor_user_id where h.staff_id = ${staffId}::uuid order by h.at desc limit 200`)) as unknown as HrRecord["history"]).map((h) => ({ ...h, at: new Date(h.at) }));
    const [pay] = await tx.select().from(hrPaymentDetails).where(eq(hrPaymentDetails.staffId, staffId));
    const documents = ((await tx.execute(sql`
      select d.id, d.kind, d.file_id as "fileId", f.original_name as "fileName", f.status::text as "fileStatus", d.note, d.created_at as "uploadedAt"
      from hr_documents d join files f on f.id = d.file_id where d.staff_id = ${staffId}::uuid and d.removed_at is null order by d.created_at desc`)) as unknown as HrRecord["documents"]).map((d) => ({
      ...d,
      uploadedAt: new Date(d.uploadedAt),
    }));
    return {
      staffId: p.id,
      name: p.displayName,
      employeeNo: p.employeeNo,
      jobTitle: p.jobTitle,
      status: p.status,
      joinedOn: p.joinedOn,
      leftOn: p.leftOn,
      employment: e ?? null,
      history,
      payment: pay ? { accountHolder: pay.accountHolder, accountLast4: pay.accountNo.slice(-4), ifsc: pay.ifsc, pan: pay.pan, updatedAt: pay.updatedAt } : null,
      documents,
    };
  });
}

const employmentSchema = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES, { message: "Choose the employment type." }),
  departmentId: z.union([z.literal("").transform(() => null), uuidField("Department")]).nullable().optional(),
  designationId: z.union([z.literal("").transform(() => null), uuidField("Designation")]).nullable().optional(),
  confirmedOn: z.union([z.literal("").transform(() => null), isoDate("confirmation date")]).nullable().optional(),
  noticeDays: z.union([z.literal("").transform(() => null), z.coerce.number().int("Notice period: whole days.").min(0, "Notice period: 0 to 365 days.").max(365, "Notice period: 0 to 365 days.")]).nullable().optional(),
  emergencyName: optionalText("Emergency contact name", 120),
  emergencyPhone: z.union([z.literal("").transform(() => null), phoneSchema]).nullable().optional(),
  effectiveOn: z.union([z.literal("").transform(() => null), isoDate("effective date")]).nullable().optional(),
  note: optionalText("Note", 300),
});

const TYPE_LABEL: Record<EmploymentType, string> = { permanent: "Permanent", probation: "Probation", contract: "Contract", part_time: "Part-time", temporary: "Temporary" };

async function activeName(tx: Tx, schoolId: string, kind: HrListKind, id: string | null | undefined, current: string | null): Promise<{ id: string | null; name: string | null }> {
  if (!id) return { id: null, name: null };
  const t = listTable(kind);
  const [r] = await tx.select().from(t).where(and(eq(t.schoolId, schoolId), eq(t.id, id)));
  // An archived entry may stay on a record that already has it, but cannot be newly chosen.
  if (!r || (r.archivedAt && r.id !== current)) throw new AppError("NOT_FOUND", `${kind === "department" ? "Department" : "Designation"} not found.`, { [`${kind}Id`]: "Choose one from the list." });
  return { id: r.id, name: r.name };
}

/**
 * Saves employment terms. Changes of type, department, designation and confirmation are added
 * to the employment history with the effective date (today if not given).
 */
export async function updateEmployment(db: Db, ctx: RequestContext, schoolId: string, staffId: string, input: z.input<typeof employmentSchema>): Promise<{ changes: number }> {
  const v = parse(employmentSchema, input);
  if (v.confirmedOn && v.employmentType !== "permanent") throw new AppError("VALIDATION", "Only permanent staff have a confirmation date.", { confirmedOn: "Permanent staff only." });
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const p = await staffRow(tx, schoolId, staffId);
    if (p.status !== "active") throw new AppError("CONFLICT", "This staff member has left. Rejoin them first.");
    const [old] = await tx.select().from(hrEmployment).where(eq(hrEmployment.staffId, staffId)).for("update");
    const oldDept = old?.departmentId ? (await tx.select().from(hrDepartments).where(eq(hrDepartments.id, old.departmentId)))[0]?.name ?? null : null;
    const oldDesig = old?.designationId ? (await tx.select().from(hrDesignations).where(eq(hrDesignations.id, old.designationId)))[0]?.name ?? null : null;
    const dept = await activeName(tx, schoolId, "department", v.departmentId, old?.departmentId ?? null);
    const desig = await activeName(tx, schoolId, "designation", v.designationId, old?.designationId ?? null);
    const effectiveOn = v.effectiveOn ?? (await schoolDay(tx, schoolId));
    if (p.joinedOn && effectiveOn < p.joinedOn) throw new AppError("VALIDATION", "The effective date cannot be before the joining date.", { effectiveOn: "Before joining." });

    const changes: { kind: string; from: string | null; to: string | null }[] = [];
    const oldType = (old?.employmentType ?? null) as EmploymentType | null;
    if (oldType !== v.employmentType) changes.push({ kind: "employment_type", from: oldType ? TYPE_LABEL[oldType] : null, to: TYPE_LABEL[v.employmentType] });
    if ((old?.departmentId ?? null) !== dept.id) changes.push({ kind: "department", from: oldDept, to: dept.name });
    if ((old?.designationId ?? null) !== desig.id) changes.push({ kind: "designation", from: oldDesig, to: desig.name });
    if ((old?.confirmedOn ?? null) !== (v.confirmedOn ?? null)) changes.push({ kind: "confirmed", from: old?.confirmedOn ?? null, to: v.confirmedOn ?? null });

    const values = {
      employmentType: v.employmentType,
      departmentId: dept.id,
      designationId: desig.id,
      confirmedOn: v.confirmedOn ?? null,
      noticeDays: v.noticeDays ?? null,
      emergencyName: v.emergencyName ?? null,
      emergencyPhone: v.emergencyPhone ?? null,
      updatedBy: actor.userId,
    };
    if (old) await tx.update(hrEmployment).set({ ...values, updatedAt: sql`now()` }).where(eq(hrEmployment.staffId, staffId));
    else await tx.insert(hrEmployment).values({ staffId, schoolId, ...values });
    for (const c of changes) {
      await tx.insert(hrEmploymentEvents).values({ schoolId, staffId, kind: c.kind, effectiveOn, fromValue: c.from, toValue: c.to, note: v.note ?? null, actorUserId: actor.userId });
    }
    await audit(tx, { action: "hr.employment_updated", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId, data: { changes: changes.map((c) => c.kind), effectiveOn } });
    return { changes: changes.length };
  });
}

/* ------------------------------------------------------------------ payment details */

const paymentSchema = z.object({
  accountHolder: trimmed("Account holder", 1, 120),
  accountNo: z.string().transform((v) => v.replace(/\s+/g, "")).pipe(z.string().regex(/^[0-9]{6,18}$/, "Account number: 6 to 18 digits.")),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC: 11 characters, for example SBIN0001234."),
  pan: z.union([z.literal("").transform(() => null), z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN: 10 characters, for example ABCDE1234F.")]).nullable().optional(),
});

/** Saves salary payment details. The audit log records only that they changed, never the numbers. */
export async function setPaymentDetails(db: Db, ctx: RequestContext, schoolId: string, staffId: string, input: z.input<typeof paymentSchema>): Promise<void> {
  const v = parse(paymentSchema, input);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await staffRow(tx, schoolId, staffId);
    const values = { accountHolder: v.accountHolder, accountNo: v.accountNo, ifsc: v.ifsc, pan: v.pan ?? null, updatedBy: actor.userId };
    await tx
      .insert(hrPaymentDetails)
      .values({ staffId, schoolId, ...values })
      .onConflictDoUpdate({ target: hrPaymentDetails.staffId, set: { ...values, updatedAt: sql`now()` } });
    await audit(tx, { action: "hr.payment_details_changed", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId });
  });
}

/* ------------------------------------------------------------------ documents */

export async function addHrDocument(db: Db, ctx: RequestContext, schoolId: string, staffId: string, input: { kind: string; fileId: string; note?: string }): Promise<{ id: string }> {
  const kind = parse(z.enum(HR_DOCUMENT_KINDS, { message: "Choose the kind of document." }), input.kind);
  const fileId = parse(uuidField("File"), input.fileId);
  const note = parse(optionalText("Note", 300), input.note ?? "");
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await staffRow(tx, schoolId, staffId);
    const [f] = await tx.select().from(files).where(and(eq(files.schoolId, schoolId), eq(files.id, fileId)));
    if (!f || f.deletedAt || f.purpose !== "hr_document") throw new AppError("VALIDATION", "The file was not found. Upload it again.");
    const [d] = await tx.insert(hrDocuments).values({ schoolId, staffId, kind, fileId, note: note ?? null, uploadedBy: actor.userId }).returning({ id: hrDocuments.id });
    await audit(tx, { action: "hr.document_added", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId, data: { kind } });
    return { id: d!.id };
  });
}

export async function removeHrDocument(db: Db, ctx: RequestContext, schoolId: string, documentId: string): Promise<void> {
  parse(uuidField("Document"), documentId);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const r = await tx
      .update(hrDocuments)
      .set({ removedAt: sql`now()`, removedBy: actor.userId })
      .where(and(eq(hrDocuments.schoolId, schoolId), eq(hrDocuments.id, documentId), isNull(hrDocuments.removedAt)))
      .returning({ staffId: hrDocuments.staffId });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Document not found.");
    await audit(tx, { action: "hr.document_removed", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: r[0]!.staffId, data: { documentId } });
  });
}
