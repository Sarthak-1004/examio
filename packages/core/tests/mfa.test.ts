import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditEvents, schoolMemberships, schools, userMfa, userMfaRecoveryCodes, withContext, type RequestContext } from "@examio/db";
import { login } from "../src/auth/login";
import { beginMfaEnrollment, completeMfaChallenge, confirmMfaEnrollment, disableOwnMfa, getPendingMfa } from "../src/auth/mfa";
import { issueAccountCode, redeemAccountCode } from "../src/auth/recovery";
import { contextFor, validateSession } from "../src/auth/session";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  matchTotp,
  resolveMfaKey,
  totpCode,
  totpStep,
} from "../src/auth/totp";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { listSchools } from "../src/services/schools";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.4: two-step sign-in with an authenticator app. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const KEY = resolveMfaKey(undefined, false);
const PW = "Passw0rd!";
/** A code for a step the server has not accepted yet: `offset` 0 is now, 1 is the next step. */
const codeFor = (secret: string, offset = 0) => totpCode(secret, totpStep() + offset);

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC values are 8 digits; the last 6 are what a 6-digit app shows.
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(secret, Math.floor(20000000000 / 30))).toBe("353130");
  });

  it("accepts the current, previous and next step only", () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    for (const d of [-1, 0, 1]) expect(matchTotp(secret, totpCode(secret, step + d), now)).toBe(step + d);
    for (const d of [-2, 2, 50]) expect(matchTotp(secret, totpCode(secret, step + d), now)).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5x"]) expect(matchTotp(secret, bad, now)).toBeNull();
    expect(matchTotp(secret, ` ${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)} `, now)).toBe(step);
  });

  it("round-trips base32 and encrypted secrets, and rejects the wrong key or tampering", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);

    const stored = encryptSecret(KEY, secret);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(KEY, stored)).toBe(secret);
    expect(encryptSecret(KEY, secret)).not.toBe(stored);
    expect(() => decryptSecret(Buffer.alloc(32, 7), stored)).toThrow();
    expect(() => decryptSecret(KEY, stored.slice(0, -2) + "AA")).toThrow();
  });

  it("requires a real key in production", () => {
    expect(() => resolveMfaKey(undefined, true)).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(() => resolveMfaKey("dG9vLXNob3J0", true)).toThrow(/32 bytes/);
    expect(resolveMfaKey(Buffer.alloc(32, 1).toString("base64"), true)).toHaveLength(32);
  });
});

describe("two-step sign-in", () => {
  let A: School;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("mfa");
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const self = (userId: string): RequestContext => ({ userId, schoolId: null, isPlatformAdmin: false });

  async function schoolAdmin() {
    const email = `${randomUUID()}@mfa.local`;
    const id = await makeUser({ email });
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: id, role: "school_admin" });
    return { id, email };
  }
  /** Enrols and returns the secret and backup codes. The enrolment code uses the current step. */
  async function enrol(userId: string, label = "user") {
    const { secret, otpauthUri } = await beginMfaEnrollment(app.db, self(userId), KEY, label);
    const { recoveryCodes } = await confirmMfaEnrollment(app.db, self(userId), KEY, codeFor(secret));
    return { secret, otpauthUri, recoveryCodes };
  }

  it("enrolment needs a correct first code and stores the secret encrypted", async () => {
    const u = await schoolAdmin();
    const { secret, otpauthUri } = await beginMfaEnrollment(app.db, self(u.id), KEY, u.email);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain("issuer=Examio");

    // Not enforced until confirmed: sign-in is still password only.
    expect((await login(app.db, u.email, PW)).mfaRequired).toBe(false);
    expect(await outcome(confirmMfaEnrollment(app.db, self(u.id), KEY, "000000"))).toBe("VALIDATION");

    const { recoveryCodes } = await confirmMfaEnrollment(app.db, self(u.id), KEY, codeFor(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const [row] = await owner.db.select().from(userMfa).where(eq(userMfa.userId, u.id));
    expect(row!.confirmedAt).not.toBeNull();
    expect(row!.secretEnc).not.toContain(secret);
    expect(decryptSecret(KEY, row!.secretEnc)).toBe(secret);
    const stored = await owner.db.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, u.id));
    expect(stored).toHaveLength(10);
    expect(stored.some((r) => recoveryCodes.some((c) => r.codeHash.includes(c.replace(/-/g, ""))))).toBe(false);
    expect((await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, u.id))).map((e) => e.action)).toContain("auth.mfa_enabled");

    // A confirmed authenticator cannot be silently replaced.
    expect(await outcome(beginMfaEnrollment(app.db, self(u.id), KEY, u.email))).toBe("CONFLICT");
    expect(await outcome(confirmMfaEnrollment(app.db, self(u.id), KEY, codeFor(secret, 1)))).toBe("CONFLICT");
  });

  it("after enrolment the password alone does not sign in", async () => {
    const u = await schoolAdmin();
    const { secret } = await enrol(u.id);

    const first = await login(app.db, u.email, PW);
    expect(first.mfaRequired).toBe(true);
    expect(first.expiresAt.getTime()).toBeLessThan(Date.now() + 11 * 60_000);
    expect(await validateSession(app.db, first.token)).toBeNull();
    expect(await getPendingMfa(app.db, first.token)).toEqual({ userId: u.id });

    expect(await outcome(completeMfaChallenge(app.db, first.token, "000000", KEY))).toBe("VALIDATION");
    expect(await validateSession(app.db, first.token)).toBeNull();

    const done = await completeMfaChallenge(app.db, first.token, codeFor(secret, 1), KEY);
    expect(done.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    const session = await validateSession(app.db, first.token);
    expect(session?.user.id).toBe(u.id);
    expect(session?.mfaEnabled).toBe(true);
    expect(await getPendingMfa(app.db, first.token)).toBeNull();
    // A finished challenge cannot be completed again.
    expect(await outcome(completeMfaChallenge(app.db, first.token, codeFor(secret, 1), KEY))).toBe("FORBIDDEN");
  });

  it("a code is accepted once, even for a new sign-in or concurrently", async () => {
    const u = await schoolAdmin();
    const { secret } = await enrol(u.id);
    const code = codeFor(secret, 1);

    const one = await login(app.db, u.email, PW);
    const two = await login(app.db, u.email, PW);
    const results = await Promise.all([outcome(completeMfaChallenge(app.db, one.token, code, KEY)), outcome(completeMfaChallenge(app.db, two.token, code, KEY))]);
    expect(results.sort()).toEqual(["OK", "VALIDATION"]);

    const three = await login(app.db, u.email, PW);
    expect(await outcome(completeMfaChallenge(app.db, three.token, code, KEY))).toBe("VALIDATION");
    // The code used at enrolment (current step) is older than the last accepted one.
    expect(await outcome(completeMfaChallenge(app.db, three.token, codeFor(secret), KEY))).toBe("VALIDATION");
  });

  it("a backup code works once in place of the app", async () => {
    const u = await schoolAdmin();
    const { recoveryCodes } = await enrol(u.id);
    const backup = recoveryCodes[0]!;

    const one = await login(app.db, u.email, PW);
    await completeMfaChallenge(app.db, one.token, backup.toLowerCase().replace(/-/g, " "), KEY);
    expect(await validateSession(app.db, one.token)).not.toBeNull();

    const two = await login(app.db, u.email, PW);
    expect(await outcome(completeMfaChallenge(app.db, two.token, backup, KEY))).toBe("VALIDATION");
    expect(await outcome(completeMfaChallenge(app.db, two.token, recoveryCodes[1]!, KEY))).toBe("OK");
    const events = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, u.id));
    expect(events.filter((e) => e.action === "auth.mfa_recovery_code_used")).toHaveLength(2);
  });

  it("another user's code or backup code is useless", async () => {
    const u = await schoolAdmin();
    const other = await schoolAdmin();
    await enrol(u.id);
    const theirs = await enrol(other.id);
    const pending = await login(app.db, u.email, PW);
    expect(await outcome(completeMfaChallenge(app.db, pending.token, codeFor(theirs.secret, 1), KEY))).toBe("VALIDATION");
    expect(await outcome(completeMfaChallenge(app.db, pending.token, theirs.recoveryCodes[0]!, KEY))).toBe("VALIDATION");
  });

  it("wrong codes are rate limited and an expired pending sign-in is refused", async () => {
    const u = await schoolAdmin();
    const { secret } = await enrol(u.id);
    const pending = await login(app.db, u.email, PW);
    for (let i = 0; i < 5; i++) expect(await outcome(completeMfaChallenge(app.db, pending.token, "111111", KEY))).toBe("VALIDATION");
    expect(await outcome(completeMfaChallenge(app.db, pending.token, codeFor(secret, 1), KEY))).toBe("RATE_LIMITED");

    const late = await schoolAdmin();
    const lateSecret = (await enrol(late.id)).secret;
    const stale = await login(app.db, late.email, PW);
    await owner.db.execute(sql`update sessions set expires_at = now() - interval '1 second' where user_id = ${late.id}::uuid`);
    expect(await outcome(completeMfaChallenge(app.db, stale.token, codeFor(lateSecret, 1), KEY))).toBe("FORBIDDEN");
    expect(await outcome(completeMfaChallenge(app.db, "not-a-token", "123456", KEY))).toBe("FORBIDDEN");
  });

  it("only administrators can enrol", async () => {
    for (const actor of [A.teacherId, A.studentId]) {
      expect(await outcome(beginMfaEnrollment(app.db, self(actor), KEY, "x"))).toBe("FORBIDDEN");
    }
    expect(await outcome(beginMfaEnrollment(app.db, { userId: null, schoolId: null, isPlatformAdmin: false }, KEY, "x"))).toBe("FORBIDDEN");
    const former = await makeUser();
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: former, role: "school_admin", status: "revoked" });
    expect(await outcome(beginMfaEnrollment(app.db, self(former), KEY, "x"))).toBe("FORBIDDEN");
  });

  it("a school admin can turn it off with a current code", async () => {
    const u = await schoolAdmin();
    const { secret } = await enrol(u.id);
    expect(await outcome(disableOwnMfa(app.db, self(u.id), KEY, "000000"))).toBe("VALIDATION");
    await disableOwnMfa(app.db, self(u.id), KEY, codeFor(secret, 1));
    expect(await owner.db.select().from(userMfa).where(eq(userMfa.userId, u.id))).toHaveLength(0);
    expect(await owner.db.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, u.id))).toHaveLength(0);
    expect((await login(app.db, u.email, PW)).mfaRequired).toBe(false);
  });

  it("the runtime role cannot read or write the authenticator tables", async () => {
    for (const run of [
      () => app.db.select().from(userMfa),
      () => app.db.select().from(userMfaRecoveryCodes),
      () => app.db.insert(userMfa).values({ userId: A.adminId, secretEnc: "x".repeat(20), confirmedAt: new Date() }),
      () => withContext(app.db, A.ctx(A.adminId), (tx) => tx.delete(userMfa)),
    ]) {
      expect(isRlsViolation(await run().then(() => null, (e: unknown) => e))).toBe(true);
    }
  });

  describe("platform administrators", () => {
    it("have no platform access until an authenticator is confirmed, and cannot turn it off", async () => {
      const email = `${randomUUID()}@mfa.local`;
      const id = await makeUser({ email, isPlatformAdmin: true }, { mfa: false });

      const { token, mfaRequired } = await login(app.db, email, PW);
      expect(mfaRequired).toBe(false);
      const session = (await validateSession(app.db, token))!;
      expect(session.user.isPlatformAdmin).toBe(true);
      expect(session.mfaEnabled).toBe(false);
      const ctx = contextFor(session);
      // The service guard passes on the flag, but the database grants nothing.
      expect(await listSchools(app.db, ctx)).toHaveLength(0);
      expect(await withContext(app.db, ctx, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);

      const { secret } = await enrol(id, email);
      expect((await listSchools(app.db, ctx)).length).toBeGreaterThan(0);

      expect(await outcome(disableOwnMfa(app.db, self(id), KEY, codeFor(secret, 1)))).toBe("FORBIDDEN");
      expect(await owner.db.select().from(userMfa).where(eq(userMfa.userId, id))).toHaveLength(1);
      expect((await login(app.db, email, PW)).mfaRequired).toBe(true);
    });
  });

  it("an account reset code removes the authenticator (lost-device recovery)", async () => {
    const platform: RequestContext = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    const u = await schoolAdmin();
    await enrol(u.id);
    const { code } = await issueAccountCode(app.db, platform, { userId: u.id, purpose: "password_reset", reason: "Lost phone; verified by call-back" });
    await redeemAccountCode(app.db, { code, newPassword: "Recovered#Pass1" });

    expect(await owner.db.select().from(userMfa).where(eq(userMfa.userId, u.id))).toHaveLength(0);
    expect(await owner.db.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, u.id))).toHaveLength(0);
    const again = await login(app.db, u.email, "Recovered#Pass1");
    expect(again.mfaRequired).toBe(false);
    expect(await validateSession(app.db, again.token)).not.toBeNull();
  });
});
