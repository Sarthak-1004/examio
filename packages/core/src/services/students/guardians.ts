import { randomUUID } from "node:crypto";
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { guardianLinks, schoolMemberships, studentProfiles, users, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { issueAccountCodeInTransaction } from "../../auth/recovery";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { emailSchema, phoneSchema } from "../../validation";
import { createMembershipInvitation } from "../invitations";
import { mapSetupError, parse, trimmed, uuidField } from "../setup/common";
import { RELATIONSHIPS } from "./common";

/**
 * Parents and guardians (Phase 5). A parent sees a child only through an active guardian link
 * to that child; the school creates every link:
 * - a new parent account created by the school for the child (activation code handed over);
 * - an existing parent of this school linked to another child (siblings);
 * - a code the school issues for the child, which a parent with an existing Examio account
 *   accepts at /join (accepting is their consent; the code names the child).
 * There is no way for a parent to look up or claim a child themselves.
 */

const relationship = z.enum(RELATIONSHIPS, { message: "Choose the relationship." });

const duplicate: Record<string, [string, string]> = {
  guardian_links_one_active: ["guardianUserId", "This parent is already linked to this student."],
  users_email_unique: ["email", "This email already has an Examio account. Link them if they are already a parent here, or give them a code for this child."],
};

async function activeChild(tx: Tx, schoolId: string, studentId: string): Promise<{ userId: string }> {
  const [p] = await tx.select({ status: studentProfiles.status, userId: studentProfiles.userId }).from(studentProfiles).where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
  if (!p) throw new AppError("NOT_FOUND", "Student not found.");
  if (p.status !== "active") throw new AppError("CONFLICT", "This student has left the school.");
  return { userId: p.userId };
}

const newGuardianSchema = z
  .object({
    fullName: trimmed("Full name", 2, 120),
    email: z.union([z.literal("").transform(() => null), emailSchema]).nullable().optional(),
    phone: z.union([z.literal("").transform(() => null), phoneSchema]).nullable().optional(),
    relationship,
  })
  .refine((v) => v.email || v.phone, { message: "Give an email or a mobile number, so they can sign in.", path: ["email"] });

/** Creates a parent account linked to the child, and a one-time activation code. */
export async function createGuardianAccount(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  studentId: string,
  input: { fullName: string; email?: string | null; phone?: string | null; relationship: string },
): Promise<{ userId: string; activationCode: string; codeExpiresAt: Date }> {
  parse(uuidField("Student"), studentId);
  const d = parse(newGuardianSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.guardians.manage", async (tx, actor) => {
      await activeChild(tx, schoolId, studentId);
      const userId = randomUUID();
      await tx.insert(users).values({ id: userId, fullName: d.fullName, email: d.email ?? null, phone: d.phone ?? null, passwordHash: "!" });
      await tx.insert(schoolMemberships).values({ schoolId, userId, role: "parent" });
      const [link] = await tx
        .insert(guardianLinks)
        .values({ schoolId, guardianUserId: userId, studentId, relationship: d.relationship, verifiedBy: actor.userId })
        .returning({ id: guardianLinks.id });
      const code = await issueAccountCodeInTransaction(tx, { ...ctx, schoolId }, { userId, purpose: "activation", reason: "New parent account created by a school administrator" });
      await audit(tx, { action: "guardian.created", actorUserId: actor.userId, schoolId, entityType: "guardian_link", entityId: link!.id, data: { studentId, relationship: d.relationship } });
      return { userId, activationCode: code.code, codeExpiresAt: code.expiresAt };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/** Links an existing parent of this school to another child (for example a sibling). */
export async function linkExistingGuardian(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  studentId: string,
  input: { guardianUserId: string; relationship: string },
): Promise<{ linkId: string }> {
  parse(uuidField("Student"), studentId);
  parse(uuidField("Parent"), input.guardianUserId);
  const rel = parse(relationship, input.relationship);
  try {
    return await withCapability(db, ctx, schoolId, "school.guardians.manage", async (tx, actor) => {
      const child = await activeChild(tx, schoolId, studentId);
      if (child.userId === input.guardianUserId) throw new AppError("VALIDATION", "A student cannot be their own guardian.");
      const [m] = await tx
        .select({ id: schoolMemberships.id })
        .from(schoolMemberships)
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, input.guardianUserId), eq(schoolMemberships.role, "parent"), eq(schoolMemberships.status, "active")));
      if (!m) throw new AppError("NOT_FOUND", "This person is not a parent at this school. Create an account for them, or give them a code for this child.");
      const [link] = await tx
        .insert(guardianLinks)
        .values({ schoolId, guardianUserId: input.guardianUserId, studentId, relationship: rel, verifiedBy: actor.userId })
        .returning({ id: guardianLinks.id });
      await audit(tx, { action: "guardian.linked", actorUserId: actor.userId, schoolId, entityType: "guardian_link", entityId: link!.id, data: { studentId, relationship: rel } });
      return { linkId: link!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

/** A one-time code for this child, for a parent who already has an Examio account (accepted at /join). */
export async function createGuardianCode(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  studentId: string,
  input: { relationship: string; recipientLabel: string },
): Promise<{ code: string; expiresAt: Date }> {
  parse(uuidField("Student"), studentId);
  const rel = parse(relationship, input.relationship);
  // Both checks: guardian management (here) and invitation management (inside).
  await withCapability(db, ctx, schoolId, "school.guardians.manage", async () => undefined);
  const r = await createMembershipInvitation(db, ctx, schoolId, { role: "parent", recipientLabel: input.recipientLabel, studentId, relationship: rel });
  return { code: r.code, expiresAt: r.expiresAt };
}

/**
 * Ends a guardian link. If the parent has no other active link in the school, their parent
 * membership is revoked too, so they keep no access to the school.
 */
export async function revokeGuardianLink(db: Db, ctx: RequestContext, schoolId: string, linkId: string): Promise<{ membershipRevoked: boolean }> {
  parse(uuidField("Link"), linkId);
  return withCapability(db, ctx, schoolId, "school.guardians.manage", async (tx, actor) => {
    const [link] = await tx
      .update(guardianLinks)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(guardianLinks.schoolId, schoolId), eq(guardianLinks.id, linkId), isNull(guardianLinks.revokedAt)))
      .returning({ guardianUserId: guardianLinks.guardianUserId, studentId: guardianLinks.studentId });
    if (!link) throw new AppError("NOT_FOUND", "Link not found or already ended.");
    const [other] = await tx
      .select({ id: guardianLinks.id })
      .from(guardianLinks)
      .where(and(eq(guardianLinks.schoolId, schoolId), eq(guardianLinks.guardianUserId, link.guardianUserId), isNull(guardianLinks.revokedAt)))
      .limit(1);
    let membershipRevoked = false;
    if (!other) {
      const r = await tx
        .update(schoolMemberships)
        .set({ status: "revoked" })
        .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, link.guardianUserId), eq(schoolMemberships.role, "parent"), eq(schoolMemberships.status, "active")))
        .returning({ id: schoolMemberships.id });
      membershipRevoked = r.length > 0;
    }
    await audit(tx, { action: "guardian.unlinked", actorUserId: actor.userId, schoolId, entityType: "guardian_link", entityId: linkId, data: { studentId: link.studentId, membershipRevoked } });
    return { membershipRevoked };
  });
}

/** Active parents of the school matching a search, for linking siblings. */
export async function findSchoolParents(db: Db, ctx: RequestContext, schoolId: string, search: string): Promise<{ userId: string; fullName: string; email: string | null; phone: string | null; children: string[] }[]> {
  const q = search.trim().slice(0, 100);
  if (q.length < 2) return [];
  return withCapability(db, ctx, schoolId, "school.guardians.manage", async (tx) => {
    const rows = await tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        // Qualified on purpose: an unqualified column would resolve to the subquery's own table.
        children: sql<string[]>`coalesce((select array_agg(p.display_name order by p.display_name) from guardian_links g join student_profiles p on p.id = g.student_id
          where g.school_id = "school_memberships"."school_id" and g.guardian_user_id = "school_memberships"."user_id" and g.revoked_at is null), '{}')`,
      })
      .from(schoolMemberships)
      .innerJoin(users, eq(users.id, schoolMemberships.userId))
      .where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.role, "parent"), eq(schoolMemberships.status, "active"), or(ilike(users.fullName, likePattern(q)), ilike(users.email, likePattern(q)), ilike(users.phone, likePattern(q)))))
      .orderBy(asc(users.fullName))
      .limit(20);
    return rows;
  });
}
