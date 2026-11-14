import { sql } from "drizzle-orm";
import { withContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../audit";
import { requireSignedIn } from "../authz";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";
import { enforceRateLimits, refundRateLimits, type RateLimitRule } from "../rate-limit";
import { formatCode, generateCode, hashCode, normalizeCode } from "./codes";
import { SESSION_TTL_MS, hashToken, lookupSession } from "./session";
import { decryptSecret, encryptSecret, generateTotpSecret, matchTotp, otpauthUri } from "./totp";

/**
 * Two-step sign-in with an authenticator app (decision 2026-11-14).
 *
 * - Required for platform administrators: the database grants no platform access until the
 *   account has a confirmed authenticator.
 * - Optional for school administrators. Other roles cannot enrol.
 * - A code is accepted once: the database refuses a time step it has already accepted.
 * - Ten single-use backup codes are shown once at enrolment.
 * - A lost device is recovered with an account reset code, which removes the authenticator
 *   (platform administrators: operator command only).
 */
export const MFA_ISSUER = "Examio";
export const MFA_RECOVERY_CODE_COUNT = 10;

interface OwnRow extends Record<string, unknown> {
  secret_enc: string;
  confirmed: boolean;
}
interface BoolRow extends Record<string, unknown> {
  ok: boolean | null;
}
interface ExpiresRow extends Record<string, unknown> {
  expires_ms: number | null;
}

async function own(tx: Tx): Promise<OwnRow | undefined> {
  const rows = (await tx.execute<OwnRow>(sql`select secret_enc, confirmed from auth_mfa_own()`)) as unknown as OwnRow[];
  return rows[0];
}

const attemptRules = (userId: string): RateLimitRule[] => [{ scope: "mfa:user", subject: userId, limit: 5, windowSeconds: 10 * 60 }];
const wrongCode = () => new AppError("VALIDATION", "That code is not correct. Check the app and try again.", { code: "Incorrect code" });
const notAllowed = () => new AppError("FORBIDDEN", "Two-step sign-in is available to platform and school administrators only.");

/**
 * Start enrolment: creates a new secret for the signed-in user and returns it once, for the
 * authenticator app. Nothing is enforced until confirmMfaEnrollment succeeds. Calling it again
 * replaces an unconfirmed secret; a confirmed authenticator cannot be replaced this way.
 */
export async function beginMfaEnrollment(
  db: Db,
  ctx: RequestContext,
  key: Buffer,
  accountLabel: string,
): Promise<{ secret: string; otpauthUri: string }> {
  requireSignedIn(ctx);
  const secret = generateTotpSecret();
  try {
    const started = await withContext(db, ctx, async (tx) => {
      const rows = (await tx.execute<BoolRow>(sql`select auth_mfa_begin(${encryptSecret(key, secret)}) as ok`)) as unknown as BoolRow[];
      return rows[0]?.ok === true;
    });
    if (!started) throw new AppError("CONFLICT", "Two-step sign-in is already set up for this account.");
  } catch (e) {
    if (isRlsViolation(e)) throw notAllowed();
    throw e;
  }
  return { secret, otpauthUri: otpauthUri(MFA_ISSUER, accountLabel.slice(0, 100), secret) };
}

/**
 * Finish enrolment with the first code from the app. Returns the backup codes exactly once.
 */
export async function confirmMfaEnrollment(db: Db, ctx: RequestContext, key: Buffer, code: string): Promise<{ recoveryCodes: string[] }> {
  requireSignedIn(ctx);
  const rules = attemptRules(ctx.userId);
  await enforceRateLimits(db, rules);

  const recovery = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, generateCode);
  try {
    await withContext(db, ctx, async (tx) => {
      const row = await own(tx);
      if (!row) throw new AppError("CONFLICT", "Start setting up two-step sign-in first.");
      if (row.confirmed) throw new AppError("CONFLICT", "Two-step sign-in is already set up for this account.");
      const step = matchTotp(decryptSecret(key, row.secret_enc), code);
      if (step === null) throw wrongCode();
      const hashes = recovery.map(hashCode);
      const done = (await tx.execute<BoolRow>(
        sql`select auth_mfa_confirm(${step}::bigint, array[${sql.join(hashes.map((h) => sql`${h}`), sql`, `)}]::text[]) as ok`,
      )) as unknown as BoolRow[];
      if (done[0]?.ok !== true) throw new AppError("CONFLICT", "Two-step sign-in is already set up for this account.");
    });
  } catch (e) {
    if (isRlsViolation(e)) throw notAllowed();
    throw e;
  }
  await refundRateLimits(db, rules);
  return { recoveryCodes: recovery.map(formatCode) };
}

/**
 * Checks a 6-digit app code or a backup code for the context user, consuming it.
 * Must run inside that user's transaction.
 */
async function consumeSecondFactor(tx: Tx, key: Buffer, code: string): Promise<boolean> {
  const row = await own(tx);
  if (!row || !row.confirmed) return false;
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const step = matchTotp(decryptSecret(key, row.secret_enc), digits);
    if (step === null) return false;
    const accepted = (await tx.execute<BoolRow>(sql`select auth_mfa_accept_step(${step}::bigint) as ok`)) as unknown as BoolRow[];
    return accepted[0]?.ok === true; // false when this code was already used
  }
  const backup = normalizeCode(code);
  if (!backup) return false;
  const used = (await tx.execute<BoolRow>(sql`select auth_mfa_use_recovery_code(${hashCode(backup)}) as ok`)) as unknown as BoolRow[];
  return used[0]?.ok === true;
}

/** The user who has given a correct password and still owes a second factor, if any. */
export async function getPendingMfa(db: Db, token: string): Promise<{ userId: string } | null> {
  const found = await lookupSession(db, hashToken(token));
  if (!found || !found.pendingMfa || found.expiresAt.getTime() <= Date.now()) return null;
  return { userId: found.userId };
}

/**
 * Second step of sign-in: turns the pending session into a real one when the code is right.
 * Accepts a 6-digit authenticator code or a single-use backup code.
 */
export async function completeMfaChallenge(db: Db, token: string, code: string, key: Buffer): Promise<{ expiresAt: Date }> {
  const sessionId = hashToken(token);
  const pending = await getPendingMfa(db, token);
  if (!pending) throw new AppError("FORBIDDEN", "Your sign-in has expired. Please sign in again.");
  if (code.length > 64) throw wrongCode();

  const rules = attemptRules(pending.userId);
  await enforceRateLimits(db, rules);

  const ctx: RequestContext = { userId: pending.userId, schoolId: null, isPlatformAdmin: false };
  const expiresMs = await withContext(db, ctx, async (tx) => {
    if (!(await consumeSecondFactor(tx, key, code))) return null;
    const rows = (await tx.execute<ExpiresRow>(
      sql`select (extract(epoch from auth_session_complete_mfa(${sessionId}, ${Math.floor(SESSION_TTL_MS / 1000)}::integer)) * 1000)::float8 as expires_ms`,
    )) as unknown as ExpiresRow[];
    const ms = rows[0]?.expires_ms;
    if (typeof ms !== "number") throw new AppError("FORBIDDEN", "Your sign-in has expired. Please sign in again.");
    await audit(tx, { action: "auth.login", actorUserId: pending.userId, data: { mfa: true } });
    return ms;
  });
  if (expiresMs === null) throw wrongCode();

  await refundRateLimits(db, rules);
  return { expiresAt: new Date(expiresMs) };
}

/**
 * Turn two-step sign-in off for your own account. Needs a current code. Platform
 * administrators cannot turn it off.
 */
export async function disableOwnMfa(db: Db, ctx: RequestContext, key: Buffer, code: string): Promise<void> {
  requireSignedIn(ctx);
  if (code.length > 64) throw wrongCode();
  const rules = attemptRules(ctx.userId);
  await enforceRateLimits(db, rules);
  try {
    await withContext(db, ctx, async (tx) => {
      if (!(await consumeSecondFactor(tx, key, code))) throw wrongCode();
      const rows = (await tx.execute<BoolRow>(sql`select auth_mfa_disable() as ok`)) as unknown as BoolRow[];
      if (rows[0]?.ok !== true) throw new AppError("CONFLICT", "Two-step sign-in is not set up for this account.");
    });
  } catch (e) {
    if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "Two-step sign-in cannot be turned off for platform administrators.");
    throw e;
  }
  await refundRateLimits(db, rules);
}
