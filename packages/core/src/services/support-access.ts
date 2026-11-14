import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schools, supportAccessGrants, users, withContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { queueSchoolAdminNotification } from "../notifications/notifications";
import { audit } from "../audit";
import { requirePlatformAdmin, requireUuid } from "../authz";
import { withCapability } from "../capabilities";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";

/**
 * Audited, time-limited support access.
 *
 * A platform administrator routinely sees schools, lookups, platform administrators and school
 * administrators, which is what onboarding and account recovery need. To see or act on anything
 * else in a school they open a grant for that one school with a reason. The grant:
 * - lasts at most 4 hours and cannot be extended (a new grant must be opened);
 * - is recorded in the school's audit log, with the reason;
 * - is visible to that school's administrators.
 * The database enforces the access itself; this service only opens and closes grants.
 */
export const SUPPORT_ACCESS_DEFAULT_MINUTES = 60;
export const SUPPORT_ACCESS_MAX_MINUTES = 240;

const startSchema = z.object({
  schoolId: z.uuid(),
  reason: z.string().trim().min(10, "Describe why access is needed (at least 10 characters).").max(500, "Keep the reason under 500 characters."),
  minutes: z.number().int().min(5).max(SUPPORT_ACCESS_MAX_MINUTES).default(SUPPORT_ACCESS_DEFAULT_MINUTES),
});
export type StartSupportAccessInput = z.input<typeof startSchema>;

export async function startSupportAccess(
  db: Db,
  ctx: RequestContext,
  input: StartSupportAccessInput,
): Promise<{ id: string; expiresAt: Date }> {
  requirePlatformAdmin(ctx);
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.path[0] === "schoolId") throw new AppError("NOT_FOUND", "School not found.");
    throw new AppError("VALIDATION", issue.message, { [String(issue.path[0] ?? "reason")]: issue.message });
  }
  const { schoolId, reason, minutes } = parsed.data;
  const id = randomUUID();

  try {
    return await withContext(db, ctx, async (tx) => {
      const [school] = await tx.select({ id: schools.id }).from(schools).where(eq(schools.id, schoolId));
      if (!school) throw new AppError("NOT_FOUND", "School not found.");

      // One open grant per administrator and school: opening a new one closes the previous one.
      await tx
        .update(supportAccessGrants)
        .set({ endedAt: sql`now()` })
        .where(and(eq(supportAccessGrants.schoolId, schoolId), eq(supportAccessGrants.platformUserId, ctx.userId), isNull(supportAccessGrants.endedAt)));

      const [grant] = await tx
        .insert(supportAccessGrants)
        .values({ id, schoolId, platformUserId: ctx.userId, reason, expiresAt: sql`now() + make_interval(mins => ${minutes}::integer)` })
        .returning({ expiresAt: supportAccessGrants.expiresAt });
      if (!grant) throw new Error("support access grant was not created");

      await audit(tx, {
        action: "support.access_started",
        actorUserId: ctx.userId,
        schoolId,
        entityType: "support_access_grant",
        entityId: id,
        data: { reason, minutes },
      });

      // Tell the school's administrators, in the app and by email (sandboxed until a provider
      // is configured). Queued in this transaction: no grant without a notice, and no notice
      // without a grant.
      const [me] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, ctx.userId));
      await queueSchoolAdminNotification(tx, {
        schoolId,
        channels: ["in_app", "email"],
        template: "support.access_started",
        params: { reason, expiresAt: grant.expiresAt.toISOString(), by: me?.name ?? "A platform administrator" },
        dedupeKey: `support:${id}`,
      });
      return { id, expiresAt: grant.expiresAt };
    });
  } catch (e) {
    // The database does not recognise the caller as a platform administrator.
    if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "Only platform administrators can do this.");
    throw e;
  }
}

/** End your own open grant early. */
export async function endSupportAccess(db: Db, ctx: RequestContext, grantId: string): Promise<void> {
  requirePlatformAdmin(ctx);
  requireUuid(grantId, "Support access");
  await withContext(db, ctx, async (tx) => {
    const ended = await tx
      .update(supportAccessGrants)
      .set({ endedAt: sql`now()` })
      .where(and(eq(supportAccessGrants.id, grantId), eq(supportAccessGrants.platformUserId, ctx.userId), isNull(supportAccessGrants.endedAt)))
      .returning({ schoolId: supportAccessGrants.schoolId });
    const grant = ended[0];
    if (!grant) throw new AppError("NOT_FOUND", "Support access not found or already ended.");
    await audit(tx, {
      action: "support.access_ended",
      actorUserId: ctx.userId,
      schoolId: grant.schoolId,
      entityType: "support_access_grant",
      entityId: grantId,
    });
  });
}

const grantColumns = {
  id: supportAccessGrants.id,
  schoolId: supportAccessGrants.schoolId,
  platformUserId: supportAccessGrants.platformUserId,
  reason: supportAccessGrants.reason,
  createdAt: supportAccessGrants.createdAt,
  expiresAt: supportAccessGrants.expiresAt,
  endedAt: supportAccessGrants.endedAt,
};

export type SupportAccessGrant = {
  id: string;
  schoolId: string;
  platformUserId: string;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  /** True while the grant gives access: not ended and not expired. */
  active: boolean;
};

/**
 * Support access history for one school, newest first. Readable by platform administrators
 * and by that school's own administrators.
 */
export async function listSupportAccess(db: Db, ctx: RequestContext, schoolId: string, limit = 20): Promise<SupportAccessGrant[]> {
  requireUuid(schoolId, "School");
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const query = (tx: Tx) =>
    tx.select(grantColumns).from(supportAccessGrants).where(eq(supportAccessGrants.schoolId, schoolId)).orderBy(desc(supportAccessGrants.createdAt)).limit(bounded);
  let rows: Awaited<ReturnType<typeof query>>;
  if (ctx.isPlatformAdmin) {
    requirePlatformAdmin(ctx);
    rows = await withContext(db, ctx, query);
  } else {
    rows = await withCapability(db, ctx, schoolId, "school.support_access.view", query);
  }
  const now = Date.now();
  return rows.map((r) => ({ ...r, active: r.endedAt === null && r.expiresAt.getTime() > now }));
}
