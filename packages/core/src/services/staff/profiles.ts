import { randomUUID } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { hrEmploymentEvents, schoolMemberships, schools, staffProfiles, users, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { issueAccountCodeInTransaction } from "../../auth/recovery";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { schoolToday } from "../../dates";
import { AppError } from "../../errors";
import { likePattern, toPage, type Page, type PageRequest } from "../../paging";
import { emailSchema, phoneSchema } from "../../validation";
import { isoDate, mapSetupError, parse, trimmed, uuidField } from "../setup/common";

/**
 * Staff of a school: employment records (staff_profiles) linked to the person's account and
 * school membership.
 *
 * - New staff: the admin creates the account without a password and gets a one-time activation
 *   code to hand over (48 hours). The person chooses their own password at /redeem.
 * - Someone who already has an Examio account (for example at another school) joins through a
 *   membership invitation; the admin then adds their staff details ("members without a profile").
 * - Roles a school can give: teacher or finance. Additional school administrators are added by
 *   platform support, because a school admin cannot manage a fellow admin's account.
 * - Leaving: status "left", the staff memberships are revoked at once (access ends), open
 *   assignments in open years end on the leaving date. Nothing is deleted.
 */
export type StaffRole = "teacher" | "finance";
const STAFF_MEMBERSHIP_ROLES = ["school_admin", "teacher", "finance"] as const;

const employeeNo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/, "Employee number: up to 30 letters, digits, / _ or -, starting with a letter or digit.");
const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();
const optionalDate = (label: string) => z.union([z.literal("").transform(() => null), isoDate(label)]).nullable().optional();

const newStaffSchema = z
  .object({
    fullName: trimmed("Full name", 2, 120),
    email: z.union([z.literal("").transform(() => null), emailSchema]).nullable().optional(),
    phone: z.union([z.literal("").transform(() => null), phoneSchema]).nullable().optional(),
    employeeNo,
    jobTitle: optionalText("Job title", 80),
    role: z.enum(["teacher", "finance"], { message: "Choose teacher or finance." }),
    joinedOn: optionalDate("joining date"),
  })
  .refine((v) => v.email || v.phone, { message: "Give an email or a mobile number, so they can sign in.", path: ["email"] });
export type NewStaffInput = z.input<typeof newStaffSchema>;

const profileSchema = z.object({
  employeeNo,
  displayName: trimmed("Name", 2, 120),
  jobTitle: optionalText("Job title", 80),
  joinedOn: optionalDate("joining date"),
});
export type StaffProfileInput = z.input<typeof profileSchema>;

const duplicate = {
  staff_profiles_school_employee_no_unique: ["employeeNo", "Another staff member already has this employee number."] as [string, string],
  staff_profiles_school_user_unique: ["userId", "This person already has a staff profile here."] as [string, string],
  users_email_unique: ["email", "This email already has an Examio account. Send them an invitation instead."] as [string, string],
};

async function schoolTimezone(tx: Tx, schoolId: string): Promise<string> {
  const [s] = await tx.select({ tz: schools.timezone }).from(schools).where(eq(schools.id, schoolId));
  return s?.tz ?? "Asia/Kolkata";
}

/** Creates the account, the membership and the staff profile, and a one-time activation code. */
export async function createStaffMember(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: NewStaffInput,
): Promise<{ staffId: string; userId: string; activationCode: string; codeExpiresAt: Date }> {
  const d = parse(newStaffSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      // The id is generated here: the new account is not visible to the admin (no membership yet),
      // so the database cannot return it. No usable password: it is set with the activation code.
      const user = { id: randomUUID() };
      await tx.insert(users).values({ id: user.id, fullName: d.fullName, email: d.email ?? null, phone: d.phone ?? null, passwordHash: "!" });
      await tx.insert(schoolMemberships).values({ schoolId, userId: user!.id, role: d.role });
      const [profile] = await tx
        .insert(staffProfiles)
        .values({ schoolId, userId: user!.id, employeeNo: d.employeeNo, displayName: d.fullName, jobTitle: d.jobTitle ?? null, joinedOn: d.joinedOn ?? null })
        .returning({ id: staffProfiles.id });
      const code = await issueAccountCodeInTransaction(tx, { ...ctx, schoolId }, { userId: user!.id, purpose: "activation", reason: "New staff account created by a school administrator" });
      await audit(tx, { action: "staff.created", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: profile!.id, data: { role: d.role, employeeNo: d.employeeNo } });
      return { staffId: profile!.id, userId: user!.id, activationCode: code.code, codeExpiresAt: code.expiresAt };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/** Adds staff details for someone who is already a staff member of the school (e.g. joined by invitation). */
export async function addStaffProfileForMember(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  userId: string,
  input: StaffProfileInput,
): Promise<{ staffId: string }> {
  parse(uuidField("Person"), userId);
  const d = parse(profileSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      const [m] = await tx
        .select({ id: schoolMemberships.id })
        .from(schoolMemberships)
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, userId), eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, [...STAFF_MEMBERSHIP_ROLES])));
      if (!m) throw new AppError("NOT_FOUND", "This person is not a staff member of the school.");
      const [profile] = await tx
        .insert(staffProfiles)
        .values({ schoolId, userId, employeeNo: d.employeeNo, displayName: d.displayName, jobTitle: d.jobTitle ?? null, joinedOn: d.joinedOn ?? null })
        .returning({ id: staffProfiles.id });
      await audit(tx, { action: "staff.profile_added", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: profile!.id, data: { employeeNo: d.employeeNo } });
      return { staffId: profile!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

export async function updateStaffProfile(db: Db, ctx: RequestContext, schoolId: string, staffId: string, input: StaffProfileInput): Promise<void> {
  parse(uuidField("Staff member"), staffId);
  const d = parse(profileSchema, input);
  try {
    await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      const updated = await tx
        .update(staffProfiles)
        .set({ employeeNo: d.employeeNo, displayName: d.displayName, jobTitle: d.jobTitle ?? null, joinedOn: d.joinedOn ?? null, updatedAt: sql`now()` })
        .where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)))
        .returning({ id: staffProfiles.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", "Staff member not found.");
      await audit(tx, { action: "staff.updated", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId, data: { employeeNo: d.employeeNo } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/**
 * Marks a staff member as having left: access ends at once (staff memberships revoked), open
 * assignments and class-teacher roles in open years end on the leaving date (or on their start
 * date if they had not started). Their other schools are untouched.
 */
export async function markStaffLeft(db: Db, ctx: RequestContext, schoolId: string, staffId: string, input: { leftOn?: string; reason: string }): Promise<{ endedAssignments: number }> {
  parse(uuidField("Staff member"), staffId);
  const reason = parse(trimmed("Reason", 3, 200), input.reason);
  return withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
    const [p] = await tx.select().from(staffProfiles).where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)));
    if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
    if (p.status === "left") throw new AppError("CONFLICT", "This staff member has already left.");
    if (p.userId === actor.userId) throw new AppError("CONFLICT", "You cannot mark yourself as left.");
    const leftOn = input.leftOn ? parse(isoDate("leaving date"), input.leftOn) : schoolToday(await schoolTimezone(tx, schoolId));
    if (p.joinedOn && leftOn < p.joinedOn) throw new AppError("VALIDATION", "The leaving date cannot be before the joining date.");

    await tx.update(staffProfiles).set({ status: "left", leftOn, updatedAt: sql`now()` }).where(eq(staffProfiles.id, staffId));
    await tx
      .update(schoolMemberships)
      .set({ status: "revoked" })
      .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, p.userId), inArray(schoolMemberships.role, [...STAFF_MEMBERSHIP_ROLES])));
    const ended = await tx.execute(sql`
      update teacher_assignments a set ends_on = greatest(a.starts_on, ${leftOn}::date)
      where a.school_id = ${schoolId}::uuid and a.staff_id = ${staffId}::uuid and a.ends_on is null and app_year_open(a.academic_year_id)
      returning a.id`);
    await tx.execute(sql`
      update class_teachers c set ends_on = greatest(c.starts_on, ${leftOn}::date)
      where c.school_id = ${schoolId}::uuid and c.staff_id = ${staffId}::uuid and c.ends_on is null and app_year_open(c.academic_year_id)`);
    // Employment history (Phase 14.1).
    await tx.insert(hrEmploymentEvents).values({ schoolId, staffId, kind: "left", effectiveOn: leftOn, note: reason, actorUserId: actor.userId });
    await audit(tx, { action: "staff.left", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId, data: { leftOn, reason, endedAssignments: ended.length } });
    return { endedAssignments: ended.length };
  });
}

/** Brings back a staff member who left: profile active and their staff memberships restored. */
export async function reactivateStaff(db: Db, ctx: RequestContext, schoolId: string, staffId: string): Promise<void> {
  parse(uuidField("Staff member"), staffId);
  try {
    await withCapability(db, ctx, schoolId, "school.staff.manage", async (tx, actor) => {
      const [p] = await tx.select().from(staffProfiles).where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)));
      if (!p) throw new AppError("NOT_FOUND", "Staff member not found.");
      if (p.status === "active") throw new AppError("CONFLICT", "This staff member is already active.");
      await tx.update(staffProfiles).set({ status: "active", leftOn: null, updatedAt: sql`now()` }).where(eq(staffProfiles.id, staffId));
      await tx
        .update(schoolMemberships)
        .set({ status: "active" })
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, p.userId), inArray(schoolMemberships.role, ["teacher", "finance"])));
      await tx.insert(hrEmploymentEvents).values({ schoolId, staffId, kind: "rejoined", effectiveOn: schoolToday(await schoolTimezone(tx, schoolId)), actorUserId: actor.userId });
      await audit(tx, { action: "staff.reactivated", actorUserId: actor.userId, schoolId, entityType: "staff", entityId: staffId });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Restoring a membership is refused when the person now belongs to another school.
    mapSetupError(e);
  }
}

export interface StaffListRow {
  id: string;
  userId: string;
  displayName: string;
  employeeNo: string;
  jobTitle: string | null;
  status: "active" | "left";
  email: string | null;
  phone: string | null;
  roles: string[];
}

// Qualified column names on purpose: unqualified ones would resolve to the subquery's own table.
const rolesSql = sql<string[]>`coalesce((
  select array_agg(m.role::text order by m.role) from school_memberships m
  where m.school_id = "staff_profiles"."school_id" and m.user_id = "staff_profiles"."user_id" and m.role in ('school_admin', 'teacher', 'finance')
), '{}')`;

const listColumns = {
  id: staffProfiles.id,
  userId: staffProfiles.userId,
  displayName: staffProfiles.displayName,
  employeeNo: staffProfiles.employeeNo,
  jobTitle: staffProfiles.jobTitle,
  status: staffProfiles.status,
  email: users.email,
  phone: users.phone,
  roles: rolesSql,
};

function staffFilters(schoolId: string, f: { search: string; status?: "active" | "left"; role?: string }): SQL | undefined {
  const parts: SQL[] = [eq(staffProfiles.schoolId, schoolId)];
  if (f.search) {
    const p = likePattern(f.search);
    const m = or(ilike(staffProfiles.displayName, p), ilike(staffProfiles.employeeNo, p), ilike(users.email, p), ilike(users.phone, p), ilike(staffProfiles.jobTitle, p));
    if (m) parts.push(m);
  }
  if (f.status) parts.push(eq(staffProfiles.status, f.status));
  if (f.role && (STAFF_MEMBERSHIP_ROLES as readonly string[]).includes(f.role)) {
    parts.push(sql`exists (select 1 from school_memberships m where m.school_id = "staff_profiles"."school_id" and m.user_id = "staff_profiles"."user_id" and m.role = ${f.role}::membership_role)`);
  }
  return and(...parts);
}

export async function searchStaff(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  req: PageRequest & { status?: "active" | "left"; role?: string },
): Promise<Page<StaffListRow>> {
  return withCapability(db, ctx, schoolId, "school.staff.view", async (tx) => {
    const where = staffFilters(schoolId, req);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId)).where(where);
    const rows = await tx
      .select(listColumns)
      .from(staffProfiles)
      .innerJoin(users, eq(users.id, staffProfiles.userId))
      .where(where)
      .orderBy(asc(staffProfiles.displayName), asc(staffProfiles.id))
      .limit(req.pageSize)
      .offset((req.page - 1) * req.pageSize);
    return toPage(rows, count?.n ?? 0, req);
  });
}

export interface StaffAssignmentRow {
  id: string;
  kind: "subject" | "class_teacher";
  yearId: string;
  yearName: string;
  sectionId: string;
  sectionLabel: string;
  subjectName: string | null;
  startsOn: string;
  endsOn: string | null;
  yearClosed: boolean;
}

export interface StaffDetail extends StaffListRow {
  joinedOn: string | null;
  leftOn: string | null;
  /** True when the account belongs to this school alone, so the school may reset its access. */
  manageable: boolean;
  assignments: StaffAssignmentRow[];
}

export async function getStaffDetail(db: Db, ctx: RequestContext, schoolId: string, staffId: string): Promise<StaffDetail> {
  parse(uuidField("Staff member"), staffId);
  return withCapability(db, ctx, schoolId, "school.staff.view", async (tx) => {
    const [row] = await tx
      .select({ ...listColumns, joinedOn: staffProfiles.joinedOn, leftOn: staffProfiles.leftOn, manageable: sql<boolean>`app_can_manage_user(${staffProfiles.userId})` })
      .from(staffProfiles)
      .innerJoin(users, eq(users.id, staffProfiles.userId))
      .where(and(eq(staffProfiles.schoolId, schoolId), eq(staffProfiles.id, staffId)));
    if (!row) throw new AppError("NOT_FOUND", "Staff member not found.");
    const assignments = (await tx.execute(sql`
      select a.id, 'subject' as kind, y.id as year_id, y.name as year_name, s.id as section_id, c.name || ' ' || s.name as section_label,
             sub.name as subject_name, a.starts_on::text as starts_on, a.ends_on::text as ends_on, (y.status = 'closed') as year_closed
      from teacher_assignments a
      join sections s on s.id = a.section_id join classes c on c.id = s.class_id
      join academic_years y on y.id = a.academic_year_id join subjects sub on sub.id = a.subject_id
      where a.school_id = ${schoolId}::uuid and a.staff_id = ${staffId}::uuid
      union all
      select t.id, 'class_teacher', y.id, y.name, s.id, c.name || ' ' || s.name, null, t.starts_on::text, t.ends_on::text, (y.status = 'closed')
      from class_teachers t
      join sections s on s.id = t.section_id join classes c on c.id = s.class_id
      join academic_years y on y.id = t.academic_year_id
      where t.school_id = ${schoolId}::uuid and t.staff_id = ${staffId}::uuid
      order by 9 nulls first, 8 desc`)) as unknown as {
      id: string; kind: "subject" | "class_teacher"; year_id: string; year_name: string; section_id: string; section_label: string;
      subject_name: string | null; starts_on: string; ends_on: string | null; year_closed: boolean;
    }[];
    return {
      ...row,
      assignments: assignments.map((a) => ({
        id: a.id,
        kind: a.kind,
        yearId: a.year_id,
        yearName: a.year_name,
        sectionId: a.section_id,
        sectionLabel: a.section_label,
        subjectName: a.subject_name,
        startsOn: a.starts_on,
        endsOn: a.ends_on,
        yearClosed: a.year_closed,
      })),
    };
  });
}

/** Staff members of the school (active admin/teacher/finance memberships) who have no staff profile yet. */
export async function listMembersWithoutProfile(db: Db, ctx: RequestContext, schoolId: string): Promise<{ userId: string; fullName: string; email: string | null; roles: string[] }[]> {
  return withCapability(db, ctx, schoolId, "school.staff.view", async (tx) => {
    const rows = await tx
      .select({ userId: users.id, fullName: users.fullName, email: users.email, role: schoolMemberships.role })
      .from(schoolMemberships)
      .innerJoin(users, eq(users.id, schoolMemberships.userId))
      .leftJoin(staffProfiles, and(eq(staffProfiles.schoolId, schoolMemberships.schoolId), eq(staffProfiles.userId, schoolMemberships.userId)))
      .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, [...STAFF_MEMBERSHIP_ROLES]), isNull(staffProfiles.id)))
      .orderBy(asc(users.fullName));
    const byUser = new Map<string, { userId: string; fullName: string; email: string | null; roles: string[] }>();
    for (const r of rows) {
      const e = byUser.get(r.userId) ?? { userId: r.userId, fullName: r.fullName, email: r.email, roles: [] };
      e.roles.push(r.role);
      byUser.set(r.userId, e);
    }
    return [...byUser.values()];
  });
}

/** CSV of the school's staff matching the filters. Audited; formulas neutralised. */
export async function exportStaffCsv(db: Db, ctx: RequestContext, schoolId: string, f: { search: string; status?: "active" | "left"; role?: string }): Promise<string> {
  return withCapability(db, ctx, schoolId, "school.staff.view", async (tx, actor) => {
    const rows = await tx
      .select({ ...listColumns, joinedOn: staffProfiles.joinedOn, leftOn: staffProfiles.leftOn })
      .from(staffProfiles)
      .innerJoin(users, eq(users.id, staffProfiles.userId))
      .where(staffFilters(schoolId, f))
      .orderBy(asc(staffProfiles.displayName))
      .limit(5000);
    await audit(tx, { action: "staff.exported", actorUserId: actor.userId, schoolId, entityType: "staff", data: { rows: rows.length, filters: { search: f.search || null, status: f.status ?? null, role: f.role ?? null } } });
    return toCsv([
      ["employee_no", "name", "job_title", "roles", "status", "email", "phone", "joined_on", "left_on"],
      ...rows.map((r) => [r.employeeNo, r.displayName, r.jobTitle, r.roles.join(" "), r.status, r.email, r.phone, r.joinedOn, r.leftOn]),
    ]);
  });
}

export { schoolTimezone };
