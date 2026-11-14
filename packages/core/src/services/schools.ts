import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  boards,
  mediums,
  schoolMemberships,
  schools,
  users,
  withContext,
  type Db,
  type RequestContext,
} from "@examio/db";
import { audit } from "../audit";
import { requirePlatformAdmin, requireUuid } from "../authz";
import { withCapability, type SchoolRole } from "../capabilities";
import { hashPassword } from "../auth/password";
import { uniqueViolation } from "../db-errors";
import { AppError } from "../errors";
import { likePattern, toPage, type Page, type PageRequest } from "../paging";
import { createSchoolSchema, lookupNameSchema, type CreateSchoolInput } from "../validation";

function validationError(issues: { path: PropertyKey[]; message: string }[]): AppError {
  const fields: Record<string, string> = {};
  for (const i of issues) fields[i.path.join(".")] ??= i.message;
  return new AppError("VALIDATION", issues[0]?.message ?? "Invalid input.", fields);
}

/* ------------------------------------------------------------ lookups */

export async function listBoards(db: Db, ctx: RequestContext, opts: { includeInactive?: boolean } = {}) {
  return withContext(db, ctx, (tx) =>
    tx.select().from(boards).where(opts.includeInactive ? undefined : eq(boards.active, true)).orderBy(asc(boards.name)),
  );
}

export async function listMediums(db: Db, ctx: RequestContext, opts: { includeInactive?: boolean } = {}) {
  return withContext(db, ctx, (tx) =>
    tx.select().from(mediums).where(opts.includeInactive ? undefined : eq(mediums.active, true)).orderBy(asc(mediums.name)),
  );
}

export async function addLookup(db: Db, ctx: RequestContext, kind: "board" | "medium", rawName: string) {
  requirePlatformAdmin(ctx);
  const parsed = lookupNameSchema.safeParse(rawName);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const table = kind === "board" ? boards : mediums;
  try {
    await withContext(db, ctx, async (tx) => {
      const id = randomUUID();
      await tx.insert(table).values({ id, name: parsed.data });
      await audit(tx, { action: `${kind}.created`, actorUserId: ctx.userId, entityType: kind, entityId: id, data: { name: parsed.data } });
    });
  } catch (e) {
    if (uniqueViolation(e) !== null) throw new AppError("CONFLICT", `A ${kind} named "${parsed.data}" already exists.`);
    throw e;
  }
}

export async function setLookupActive(db: Db, ctx: RequestContext, kind: "board" | "medium", id: string, active: boolean) {
  requirePlatformAdmin(ctx);
  requireUuid(id, kind === "board" ? "Board" : "Medium");
  const table = kind === "board" ? boards : mediums;
  await withContext(db, ctx, async (tx) => {
    const updated = await tx.update(table).set({ active }).where(eq(table.id, id)).returning({ id: table.id });
    if (updated.length === 0) throw new AppError("NOT_FOUND", `${kind === "board" ? "Board" : "Medium"} not found.`);
    await audit(tx, { action: `${kind}.${active ? "activated" : "deactivated"}`, actorUserId: ctx.userId, entityType: kind, entityId: id });
  });
}

/* ------------------------------------------------------------ schools */

const schoolListColumns = {
  id: schools.id,
  name: schools.name,
  code: schools.code,
  status: schools.status,
  board: boards.name,
  medium: mediums.name,
  createdAt: schools.createdAt,
  // Aggregate only: the platform listing does not read who the members are.
  memberCount: sql<number>`coalesce(platform_school_member_count(${schools.id}), 0)`,
};

export type SchoolStatus = "onboarding" | "active" | "suspended";
export type SchoolListRow = {
  id: string;
  name: string;
  code: string;
  status: SchoolStatus;
  board: string;
  medium: string;
  createdAt: Date;
  memberCount: number;
};

/** Platform listing of every school. School users read their own school through getSchool. */
export async function listSchools(db: Db, ctx: RequestContext): Promise<SchoolListRow[]> {
  requirePlatformAdmin(ctx);
  return withContext(db, ctx, (tx) =>
    tx
      .select(schoolListColumns)
      .from(schools)
      .innerJoin(boards, eq(boards.id, schools.boardId))
      .innerJoin(mediums, eq(mediums.id, schools.mediumId))
      .orderBy(desc(schools.createdAt), asc(schools.id)),
  );
}

/**
 * Paginated platform listing with search on name or code and an optional status filter.
 * Ordering is stable (newest first, then id) so pages never repeat or skip rows.
 */
export async function searchSchools(
  db: Db,
  ctx: RequestContext,
  req: PageRequest & { status?: SchoolStatus },
): Promise<Page<SchoolListRow>> {
  requirePlatformAdmin(ctx);
  const filters: SQL[] = [];
  if (req.search) {
    const pattern = likePattern(req.search);
    const match = or(ilike(schools.name, pattern), ilike(schools.code, pattern));
    if (match) filters.push(match);
  }
  if (req.status) filters.push(eq(schools.status, req.status));
  const where = filters.length > 0 ? and(...filters) : undefined;

  return withContext(db, ctx, async (tx) => {
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(schools).where(where);
    const rows = await tx
      .select(schoolListColumns)
      .from(schools)
      .innerJoin(boards, eq(boards.id, schools.boardId))
      .innerJoin(mediums, eq(mediums.id, schools.mediumId))
      .where(where)
      .orderBy(desc(schools.createdAt), asc(schools.id))
      .limit(req.pageSize)
      .offset((req.page - 1) * req.pageSize);
    return toPage(rows, count?.n ?? 0, req);
  });
}

export async function getSchool(db: Db, ctx: RequestContext, schoolId: string) {
  const row = await withCapability(db, ctx, schoolId, "school.view", async (tx) => {
    const [s] = await tx
      .select({
        id: schools.id,
        name: schools.name,
        code: schools.code,
        status: schools.status,
        timezone: schools.timezone,
        address: schools.address,
        contactEmail: schools.contactEmail,
        contactPhone: schools.contactPhone,
        board: boards.name,
        medium: mediums.name,
        createdAt: schools.createdAt,
      })
      .from(schools)
      .innerJoin(boards, eq(boards.id, schools.boardId))
      .innerJoin(mediums, eq(mediums.id, schools.mediumId))
      .where(eq(schools.id, schoolId));
    return s;
  });
  if (!row) throw new AppError("NOT_FOUND", "School not found.");
  return row;
}

export async function listSchoolMembers(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  role?: SchoolRole,
) {
  return withCapability(db, ctx, schoolId, "school.members.view", (tx) =>
    tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        username: users.username,
        role: schoolMemberships.role,
        status: schoolMemberships.status,
      })
      .from(schoolMemberships)
      .innerJoin(users, eq(users.id, schoolMemberships.userId))
      .where(
        role
          ? sql`${schoolMemberships.schoolId} = ${schoolId} and ${schoolMemberships.role} = ${role}`
          : eq(schoolMemberships.schoolId, schoolId),
      )
      .orderBy(asc(users.fullName)),
  );
}

export async function countMembersByRole(db: Db, ctx: RequestContext, schoolId: string) {
  const rows = await withCapability(db, ctx, schoolId, "school.member_counts.view", (tx) =>
    tx
      .select({ role: schoolMemberships.role, n: sql<number>`count(*)::int` })
      .from(schoolMemberships)
      .where(sql`${schoolMemberships.schoolId} = ${schoolId} and ${schoolMemberships.status} = 'active'`)
      .groupBy(schoolMemberships.role),
  );
  return Object.fromEntries(rows.map((r) => [r.role, r.n])) as Partial<Record<string, number>>;
}

/** Super admin creates a school tenant together with its first School Admin account. */
export async function createSchoolWithAdmin(db: Db, ctx: RequestContext, input: CreateSchoolInput) {
  requirePlatformAdmin(ctx);
  const parsed = createSchoolSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const d = parsed.data;
  const schoolId = randomUUID();
  const adminId = randomUUID();
  const passwordHash = await hashPassword(d.admin.password);

  try {
    await withContext(db, ctx, async (tx) => {
      await tx.insert(schools).values({
        id: schoolId,
        name: d.name,
        code: d.code,
        boardId: d.boardId,
        mediumId: d.mediumId,
        timezone: d.timezone,
        address: d.address ?? null,
        contactEmail: d.contactEmail ?? null,
        contactPhone: d.contactPhone ?? null,
      });
      await tx.insert(users).values({
        id: adminId,
        fullName: d.admin.fullName,
        email: d.admin.email ?? null,
        phone: d.admin.phone ?? null,
        passwordHash,
        mustChangePassword: true,
      });
      await tx.insert(schoolMemberships).values({ schoolId, userId: adminId, role: "school_admin" });
      await audit(tx, {
        action: "school.created",
        actorUserId: ctx.userId,
        schoolId,
        entityType: "school",
        entityId: schoolId,
        data: { name: d.name, code: d.code, adminUserId: adminId },
      });
    });
  } catch (e) {
    const c = uniqueViolation(e);
    if (c !== null) {
      if (c.includes("code")) throw new AppError("CONFLICT", `School code "${d.code}" is already taken.`, { code: "Already taken" });
      if (c.includes("email")) throw new AppError("CONFLICT", "That admin email is already registered.", { "admin.email": "Already registered" });
      throw new AppError("CONFLICT", "A record with these details already exists.");
    }
    throw e;
  }
  return { schoolId, adminUserId: adminId };
}

export async function setSchoolStatus(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  status: "onboarding" | "active" | "suspended",
) {
  requirePlatformAdmin(ctx);
  requireUuid(schoolId, "School");
  await withContext(db, ctx, async (tx) => {
    const updated = await tx.update(schools).set({ status }).where(eq(schools.id, schoolId)).returning({ id: schools.id });
    if (updated.length === 0) throw new AppError("NOT_FOUND", "School not found.");
    await audit(tx, { action: "school.status_changed", actorUserId: ctx.userId, schoolId, entityType: "school", entityId: schoolId, data: { status } });
  });
}
