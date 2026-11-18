import { sql } from "drizzle-orm";
import { withContext, type Db } from "@examio/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_PASSWORD_LENGTH,
  canonicalLoginKey,
  isPhoneLike,
  normalizeIdentifier,
  normalizePhone,
} from "../normalize";
import { enforceRateLimits, refundRateLimits, type RateLimitRule } from "../rate-limit";
import { getDummyHash, verifyPassword } from "./password";
import { purgeExpiredAuthRecords } from "./recovery";
import { createSession, userHasMfa } from "./session";

interface LoginRow extends Record<string, unknown> {
  id: string;
  password_hash: string;
  status: "active" | "disabled";
}

export interface LoginOptions {
  /**
   * The client address, only when it comes from a trusted source (see clientIpFromForwardedFor).
   * Pass null when it cannot be established; address-based limits are then skipped.
   */
  clientIp?: string | null;
}

/**
 * Limits count failed sign-ins only: a successful sign-in gives its own attempt back, and
 * never clears earlier failures. Provisional values. The per-address limit is deliberately
 * high because a whole school can sit behind one address (computer labs) and mistyped
 * passwords are common at exam start.
 */
const WINDOW_SECONDS = 10 * 60;
/** Failed attempts on one account from one address. */
const LIMIT_PER_ACCOUNT_AND_IP = 8;
/** Failed attempts on one account from anywhere; bounds guessing spread across many addresses. */
const LIMIT_PER_ACCOUNT = 30;
/** Failed attempts from one address across all accounts. */
const LIMIT_PER_IP = 300;

const SCOPE_ACCOUNT = "login:account";
const SCOPE_ACCOUNT_IP = "login:account-ip";
const SCOPE_IP = "login:ip";

const invalidCredentials = () => new AppError("INVALID_CREDENTIALS", "Incorrect login or password.");

/**
 * Sign in with email, username or mobile number + password.
 * If a phone number is shared (siblings) and the password matches more than one account,
 * the user is asked to sign in with their username instead.
 *
 * Failed attempts are rate limited here, so no caller can bypass it. Known and unknown
 * identifiers are limited identically and fail with the same error.
 */
export async function login(
  db: Db,
  identifier: string,
  password: string,
  opts: LoginOptions = {},
): Promise<{ token: string; expiresAt: Date; userId: string; mfaRequired: boolean }> {
  // Bound untrusted input before it is hashed, stored as a key or sent to the database.
  if (identifier.length > MAX_IDENTIFIER_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw invalidCredentials();
  const ident = normalizeIdentifier(identifier);
  const phone = isPhoneLike(identifier) ? normalizePhone(identifier) : null;
  if (!ident || !password) throw invalidCredentials();

  const accountKey = canonicalLoginKey(identifier);
  const clientIp = opts.clientIp ?? null;
  const rules: RateLimitRule[] = [
    { scope: SCOPE_ACCOUNT, subject: accountKey, limit: LIMIT_PER_ACCOUNT, windowSeconds: WINDOW_SECONDS },
  ];
  if (clientIp) {
    rules.push(
      { scope: SCOPE_ACCOUNT_IP, subject: `${accountKey}\n${clientIp}`, limit: LIMIT_PER_ACCOUNT_AND_IP, windowSeconds: WINDOW_SECONDS },
      { scope: SCOPE_IP, subject: clientIp, limit: LIMIT_PER_IP, windowSeconds: WINDOW_SECONDS },
    );
  }
  await enforceRateLimits(db, rules);

  const rows = (await db.execute<LoginRow>(sql`select * from auth_find_login(${ident}, ${phone})`)) as unknown as LoginRow[];

  if (rows.length === 0) {
    await verifyPassword(password, await getDummyHash());
    throw invalidCredentials();
  }

  const matches: LoginRow[] = [];
  for (const r of rows) {
    if (await verifyPassword(password, r.password_hash)) matches.push(r);
  }
  if (matches.length === 0) throw invalidCredentials();
  if (matches.length > 1) {
    throw new AppError(
      "AMBIGUOUS_LOGIN",
      "More than one account uses this mobile number. Please sign in with your username.",
    );
  }
  const user = matches[0]!;
  if (user.status !== "active") throw new AppError("ACCOUNT_DISABLED", "This account has been disabled. Contact your school.");

  // Housekeeping for deployments where the background worker is not running (it does the same
  // hourly): occasionally clear records that expired long ago. Never touches anything usable.
  if (Math.random() < 0.02) await purgeExpiredAuthRecords(db);

  // With an authenticator enrolled the password alone only opens a short-lived pending session;
  // completeMfaChallenge() turns it into a real one.
  const mfaRequired = await userHasMfa(db, user.id);
  const session = await createSession(db, user.id, { pendingMfa: mfaRequired });
  await withContext(db, { userId: user.id, schoolId: null, isPlatformAdmin: false }, (tx) =>
    audit(tx, { action: mfaRequired ? "auth.password_accepted" : "auth.login", actorUserId: user.id }),
  );

  await refundRateLimits(db, rules);

  return { ...session, userId: user.id, mfaRequired };
}
