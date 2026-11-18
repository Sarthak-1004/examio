import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { membershipInvitations, studentProfiles, withContext, type Db, type RequestContext } from "@examio/db";
import { audit } from "../audit";
import { formatCode, generateCode, hashCode, normalizeCode } from "../auth/codes";
import { requireSignedIn, requireUuid } from "../authz";
import { withCapability, type SchoolRole } from "../capabilities";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";
import { enforceRateLimits, refundRateLimits, type RateLimitRule } from "../rate-limit";

/**
 * Membership invitations: how a school links someone who already has an account, such as a
 * teacher or parent known to another school. A school administrator cannot attach such an
 * identity directly; the person accepts the invitation while signed in, which is their consent.
 *
 * The code is handed over by the school (no email or SMS), shown once and stored only as a hash.
 * School-administrator membership is never offered by invitation.
 */
export const INVITATION_TTL_SECONDS = 48 * 60 * 60;

const createSchema = z
  .object({
    role: z.enum(["teacher", "student", "parent", "finance"], { message: "Choose a role for the invitation." }),
    recipientLabel: z.string().trim().min(2, "Say who the invitation is for.").max(200, "Keep the name under 200 characters."),
    /** Parent invitations name the child; accepting creates the verified guardian link. */
    studentId: z.uuid({ message: "Student not found." }).optional(),
    relationship: z.enum(["mother", "father", "guardian", "other"], { message: "Choose the relationship." }).optional(),
  })
  .refine((v) => v.role !== "parent" || (v.studentId && v.relationship), { message: "A parent invitation is issued from the child's page, so it names the child.", path: ["role"] })
  .refine((v) => v.role === "parent" || (!v.studentId && !v.relationship), { message: "Only parent invitations name a child.", path: ["role"] });
export type CreateInvitationInput = z.input<typeof createSchema>;

export async function createMembershipInvitation(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: CreateInvitationInput,
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError("VALIDATION", issue.message, { [String(issue.path[0] ?? "role")]: issue.message });
  }
  const { role, recipientLabel, studentId, relationship } = parsed.data;

  return withCapability(db, ctx, schoolId, "school.invitations.manage", async (tx, actor) => {
    if (studentId) {
      const [child] = await tx
        .select({ status: studentProfiles.status })
        .from(studentProfiles)
        .where(and(eq(studentProfiles.schoolId, schoolId), eq(studentProfiles.id, studentId)));
      if (!child) throw new AppError("NOT_FOUND", "Student not found.");
      if (child.status !== "active") throw new AppError("CONFLICT", "This student has left the school.");
    }
    const id = randomUUID();
    const code = generateCode();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
    await tx.insert(membershipInvitations).values({
      id,
      schoolId,
      role,
      tokenHash: hashCode(code),
      recipientLabel,
      invitedBy: actor.userId,
      expiresAt,
      studentId: studentId ?? null,
      relationship: relationship ?? null,
    });
    await audit(tx, {
      action: "membership.invitation_created",
      actorUserId: actor.userId,
      schoolId,
      entityType: "membership_invitation",
      entityId: id,
      data: { role, studentId: studentId ?? null },
    });
    return { id, code: formatCode(code), expiresAt };
  });
}

export async function listMembershipInvitations(db: Db, ctx: RequestContext, schoolId: string) {
  return withCapability(db, ctx, schoolId, "school.invitations.manage", (tx) =>
    tx
      .select({
        id: membershipInvitations.id,
        role: membershipInvitations.role,
        recipientLabel: membershipInvitations.recipientLabel,
        invitedBy: membershipInvitations.invitedBy,
        expiresAt: membershipInvitations.expiresAt,
        acceptedBy: membershipInvitations.acceptedBy,
        acceptedAt: membershipInvitations.acceptedAt,
        revokedAt: membershipInvitations.revokedAt,
        createdAt: membershipInvitations.createdAt,
      })
      .from(membershipInvitations)
      .where(eq(membershipInvitations.schoolId, schoolId))
      .orderBy(desc(membershipInvitations.createdAt)),
  );
}

/** Cancel an invitation that has not been accepted. Accepted invitations are history. */
export async function revokeMembershipInvitation(db: Db, ctx: RequestContext, schoolId: string, invitationId: string): Promise<void> {
  requireUuid(invitationId, "Invitation");
  await withCapability(db, ctx, schoolId, "school.invitations.manage", async (tx, actor) => {
    const revoked = await tx
      .update(membershipInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(membershipInvitations.id, invitationId),
          eq(membershipInvitations.schoolId, schoolId),
          isNull(membershipInvitations.acceptedAt),
          isNull(membershipInvitations.revokedAt),
        ),
      )
      .returning({ id: membershipInvitations.id });
    if (revoked.length === 0) throw new AppError("NOT_FOUND", "Invitation not found or no longer open.");
    await audit(tx, {
      action: "membership.invitation_revoked",
      actorUserId: actor.userId,
      schoolId,
      entityType: "membership_invitation",
      entityId: invitationId,
    });
  });
}

interface AcceptedRow extends Record<string, unknown> {
  joined_school_id: string;
  joined_role: SchoolRole;
}

const invalidInvitation = () =>
  new AppError("VALIDATION", "This invitation code is not valid. It may have expired, been used or been cancelled.", {
    code: "Code not valid",
  });

/**
 * The signed-in user accepts an invitation and gains exactly the invited membership.
 * Expired, used, cancelled and unknown codes all fail identically.
 */
export async function acceptMembershipInvitation(
  db: Db,
  ctx: RequestContext,
  code: string,
): Promise<{ schoolId: string; role: SchoolRole }> {
  requireSignedIn(ctx);
  const rules: RateLimitRule[] = [{ scope: "invitation-accept:user", subject: ctx.userId, limit: 10, windowSeconds: 10 * 60 }];
  await enforceRateLimits(db, rules);

  const normalized = normalizeCode(code);
  if (!normalized) throw invalidInvitation();

  let rows: AcceptedRow[];
  try {
    rows = await withContext(db, ctx, async (tx) =>
      (await tx.execute<AcceptedRow>(
        sql`select joined_school_id, joined_role from auth_accept_membership_invitation(${hashCode(normalized)})`,
      )) as unknown as AcceptedRow[],
    );
  } catch (e) {
    if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "This account cannot accept school invitations.");
    throw e;
  }
  const row = rows[0];
  if (!row) throw invalidInvitation();

  await refundRateLimits(db, rules);
  return { schoolId: row.joined_school_id, role: row.joined_role };
}
