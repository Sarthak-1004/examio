import { and, eq, ne, sql } from "drizzle-orm";
import { sessions, withContext, type Db, type RequestContext } from "@examio/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { MAX_PASSWORD_LENGTH } from "../normalize";
import { enforceRateLimits, refundRateLimits, type RateLimitRule } from "../rate-limit";
import { passwordSchema } from "../validation";
import { hashPassword, verifyPassword } from "./password";
import { hashToken } from "./session";

interface OwnHashRow extends Record<string, unknown> {
  hash: string | null;
}
interface ChangedRow extends Record<string, unknown> {
  changed: boolean;
}

/**
 * Change your own password. Other sessions of the user are signed out.
 * The runtime database role cannot read or update password hashes directly; the user's own
 * hash is reached only through the reviewed `auth_own_password_hash` / `auth_set_own_password`
 * database helpers, which act on the signed-in user alone.
 */
export async function changeOwnPassword(
  db: Db,
  ctx: RequestContext,
  currentToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!ctx.userId) throw new AppError("FORBIDDEN", "Not signed in.");
  const parsed = passwordSchema.safeParse(newPassword);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]!.message, { newPassword: parsed.error.issues[0]!.message });
  const userId = ctx.userId;
  const wrongCurrent = () => new AppError("VALIDATION", "Current password is incorrect.", { currentPassword: "Incorrect password" });
  if (currentPassword.length > MAX_PASSWORD_LENGTH) throw wrongCurrent();

  // A stolen session must not allow unlimited guesses at the current password.
  // Counted outside the transaction so a failed attempt is not rolled back.
  const rules: RateLimitRule[] = [{ scope: "password-change:user", subject: userId, limit: 8, windowSeconds: 10 * 60 }];
  await enforceRateLimits(db, rules);

  await withContext(db, ctx, async (tx) => {
    const own = (await tx.execute<OwnHashRow>(sql`select auth_own_password_hash() as hash`)) as unknown as OwnHashRow[];
    const hash = own[0]?.hash;
    if (!hash || !(await verifyPassword(currentPassword, hash))) throw wrongCurrent();
    const newHash = await hashPassword(newPassword);
    const result = (await tx.execute<ChangedRow>(sql`select auth_set_own_password(${newHash}) as changed`)) as unknown as ChangedRow[];
    if (result[0]?.changed !== true) throw new AppError("FORBIDDEN", "This account cannot change its password.");
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, hashToken(currentToken))));
    await audit(tx, { action: "auth.password_changed", actorUserId: userId, schoolId: ctx.schoolId });
  });
  await refundRateLimits(db, rules);
}
