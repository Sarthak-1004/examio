import { sql } from "drizzle-orm";
import { z } from "zod";
import { withContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../audit";
import { requireSignedIn, requireUuid } from "../authz";
import { withCapability } from "../capabilities";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";
import { enforceRateLimits, refundRateLimits, type RateLimitRule } from "../rate-limit";
import { passwordSchema } from "../validation";
import { formatCode, generateCode, hashCode, normalizeCode } from "./codes";
import { hashPassword } from "./password";

/**
 * Account activation and password recovery by one-time code.
 *
 * Product decision (2026-11-13): no email or SMS. A school administrator issues a code for a
 * user of their own school and hands it over in person; a platform administrator does the same
 * for school administrators and for users shared between schools. Whoever issues the code is
 * responsible for verifying the person, and records why in the audit log.
 *
 * The code is shown once to the issuer and stored only as a hash. Redeeming it lets the user
 * choose a password, signs them out everywhere and cancels any other outstanding code.
 */
export type AccountCodePurpose = "activation" | "password_reset";

/** Provisional lifetimes: long enough to hand a note to someone, short enough to limit exposure. */
export const ACCOUNT_CODE_TTL_SECONDS: Readonly<Record<AccountCodePurpose, number>> = {
  activation: 48 * 60 * 60,
  password_reset: 24 * 60 * 60,
};

const issueSchema = z.object({
  userId: z.uuid(),
  purpose: z.enum(["activation", "password_reset"]),
  reason: z.string().trim().min(5, "Say briefly why the code is being issued.").max(200, "Keep the reason under 200 characters."),
});
export type IssueAccountCodeInput = z.input<typeof issueSchema>;

interface ExpiresRow extends Record<string, unknown> {
  expires_ms: number;
}

/**
 * Issues a code inside the caller's transaction (used when a code is created together with the
 * account, e.g. new staff). The caller must already have checked the capability.
 */
export async function issueAccountCodeInTransaction(
  tx: Tx,
  ctx: RequestContext,
  input: { userId: string; purpose: AccountCodePurpose; reason: string },
): Promise<{ code: string; expiresAt: Date }> {
  return issueInTransaction(tx, ctx, input);
}

async function issueInTransaction(tx: Tx, ctx: RequestContext, input: z.output<typeof issueSchema>) {
  const code = generateCode();
  let rows: ExpiresRow[];
  try {
    rows = (await tx.execute<ExpiresRow>(sql`
      select (extract(epoch from auth_issue_account_token(
        ${input.userId}::uuid, ${input.purpose}::account_token_purpose, ${hashCode(code)}, ${ACCOUNT_CODE_TTL_SECONDS[input.purpose]}::integer
      )) * 1000)::float8 as expires_ms`)) as unknown as ExpiresRow[];
  } catch (e) {
    // The database refuses users outside the caller's reach; do not reveal whether they exist.
    if (isRlsViolation(e)) throw new AppError("NOT_FOUND", "User not found.");
    throw e;
  }
  const expiresMs = rows[0]?.expires_ms;
  if (typeof expiresMs !== "number") throw new Error("auth_issue_account_token returned no expiry");
  await audit(tx, {
    action: input.purpose === "activation" ? "account.activation_code_issued" : "account.reset_code_issued",
    actorUserId: ctx.userId,
    schoolId: ctx.isPlatformAdmin ? null : ctx.schoolId,
    entityType: "user",
    entityId: input.userId,
    data: { reason: input.reason },
  });
  return { code: formatCode(code), expiresAt: new Date(expiresMs) };
}

/**
 * Issue a one-time code for another user. Any earlier outstanding code for that user stops
 * working. Returns the code exactly once; it cannot be retrieved again.
 */
export async function issueAccountCode(
  db: Db,
  ctx: RequestContext,
  input: IssueAccountCodeInput,
): Promise<{ code: string; expiresAt: Date }> {
  requireSignedIn(ctx);
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.path[0] === "userId") throw new AppError("NOT_FOUND", "User not found.");
    throw new AppError("VALIDATION", issue.message, { [String(issue.path[0] ?? "reason")]: issue.message });
  }
  if (ctx.isPlatformAdmin) return withContext(db, ctx, (tx) => issueInTransaction(tx, ctx, parsed.data));
  if (!ctx.schoolId) throw new AppError("FORBIDDEN", "You do not have permission to do this.");
  return withCapability(db, ctx, ctx.schoolId, "school.accounts.recover", (tx) => issueInTransaction(tx, ctx, parsed.data));
}

interface CountRow extends Record<string, unknown> {
  n: number;
}

async function callForUser(db: Db, ctx: RequestContext, userId: string, fn: "auth_revoke_account_tokens" | "auth_revoke_user_sessions", action: string) {
  requireSignedIn(ctx);
  requireUuid(userId, "User");
  const run = async (tx: Tx) => {
    let rows: CountRow[];
    try {
      const call = fn === "auth_revoke_account_tokens" ? sql`select auth_revoke_account_tokens(${userId}::uuid) as n` : sql`select auth_revoke_user_sessions(${userId}::uuid) as n`;
      rows = (await tx.execute<CountRow>(call)) as unknown as CountRow[];
    } catch (e) {
      if (isRlsViolation(e)) throw new AppError("NOT_FOUND", "User not found.");
      throw e;
    }
    await audit(tx, { action, actorUserId: ctx.userId, schoolId: ctx.isPlatformAdmin ? null : ctx.schoolId, entityType: "user", entityId: userId });
    return Number(rows[0]?.n ?? 0);
  };
  if (ctx.isPlatformAdmin || ctx.userId === userId) return withContext(db, ctx, run);
  if (!ctx.schoolId) throw new AppError("FORBIDDEN", "You do not have permission to do this.");
  return withCapability(db, ctx, ctx.schoolId, "school.accounts.recover", run);
}

/** Cancel every outstanding activation or reset code for a user. Returns how many were cancelled. */
export function revokeAccountCodes(db: Db, ctx: RequestContext, userId: string): Promise<number> {
  return callForUser(db, ctx, userId, "auth_revoke_account_tokens", "account.codes_revoked");
}

/**
 * Sign a user out of every device: yourself, or a user whose account you may recover.
 * Returns how many sessions were ended.
 */
export function revokeUserSessions(db: Db, ctx: RequestContext, userId: string): Promise<number> {
  return callForUser(db, ctx, userId, "auth_revoke_user_sessions", "auth.sessions_revoked");
}

interface PurposeRow extends Record<string, unknown> {
  purpose: AccountCodePurpose;
}
interface RedeemedRow extends Record<string, unknown> {
  user_id: string | null;
}

const invalidCode = () =>
  new AppError("VALIDATION", "This code is not valid. It may have expired or already been used. Ask your school for a new one.", {
    code: "Code not valid",
  });

/**
 * Redeem a one-time code and set a new password. No sign-in is required: possession of the
 * code is the proof. Expired, used, cancelled and unknown codes all fail identically.
 */
export async function redeemAccountCode(
  db: Db,
  input: { code: string; newPassword: string; clientIp?: string | null },
): Promise<{ purpose: AccountCodePurpose }> {
  const password = passwordSchema.safeParse(input.newPassword);
  if (!password.success) {
    const message = password.error.issues[0]!.message;
    throw new AppError("VALIDATION", message, { newPassword: message });
  }

  // Guessing an 80-bit code is infeasible; the limit only stops one address hammering the endpoint.
  const rules: RateLimitRule[] = input.clientIp ? [{ scope: "account-code:ip", subject: input.clientIp, limit: 20, windowSeconds: 10 * 60 }] : [];
  await enforceRateLimits(db, rules);

  const normalized = normalizeCode(input.code);
  if (!normalized) throw invalidCode();
  const tokenHash = hashCode(normalized);

  // Check first, so an invalid code never costs a password hash computation.
  const found = (await db.execute<PurposeRow>(sql`select purpose from auth_check_account_token(${tokenHash})`)) as unknown as PurposeRow[];
  const purpose = found[0]?.purpose;
  if (!purpose) throw invalidCode();

  const newHash = await hashPassword(password.data);
  const redeemed = (await db.execute<RedeemedRow>(
    sql`select auth_redeem_account_token(${tokenHash}, ${newHash}) as user_id`,
  )) as unknown as RedeemedRow[];
  if (!redeemed[0]?.user_id) throw invalidCode(); // lost a race with another redemption

  await refundRateLimits(db, rules);
  return { purpose };
}

/**
 * Deletes sessions, codes and invitations that can no longer be used. Idempotent.
 * The worker runs it hourly; sign-in also runs it occasionally, for deployments without a worker.
 */
export async function purgeExpiredAuthRecords(db: Db): Promise<void> {
  await db.execute(sql`select auth_purge_expired()`);
}
