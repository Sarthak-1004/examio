import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountTokens, auditEvents, schoolMemberships, schools, sessions, users, type RequestContext } from "@examio/db";
import { formatCode, generateCode, hashCode, normalizeCode } from "../src/auth/codes";
import { login } from "../src/auth/login";
import { issueAccountCode, purgeExpiredAuthRecords, redeemAccountCode, revokeAccountCodes, revokeUserSessions } from "../src/auth/recovery";
import { SESSION_ABSOLUTE_MAX_MS, SESSION_TTL_MS, createSession, hashToken, validateSession } from "../src/auth/session";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.2: activation and reset codes, session revocation, lifetime and cleanup. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const REASON = "Forgot password; verified in person at the office";
const OLD = "Passw0rd!";

describe("one-time codes", () => {
  it("are 16 unambiguous characters and unique", () => {
    const codes = Array.from({ length: 200 }, generateCode);
    expect(codes.every((c) => /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(200);
    expect(formatCode("ABCDEFGH23456789")).toBe("ABCD-EFGH-2345-6789");
  });

  it("are accepted however they are typed", () => {
    const code = "0A1B2C3D4E5F6G7H";
    for (const typed of ["0a1b-2c3d-4e5f-6g7h", " 0A1B 2C3D 4E5F 6G7H ", "OAIB2C3D4E5F6G7H", "oalb-2c3d-4e5f-6g7h"]) {
      expect(normalizeCode(typed)).toBe(code);
    }
    for (const bad of ["", "ABC", "0A1B2C3D4E5F6G7", "0A1B2C3D4E5F6G7H9", "0A1B2C3D4E5F6G7U", "x".repeat(100)]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });
});

describe("account activation and recovery", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("rca");
    B = await makeSchool("rcb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  /** A fresh student of school A with a known email and the default password. */
  async function student() {
    const email = `${randomUUID()}@rc.local`;
    const id = await makeUser({ email });
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: id, role: "student" });
    return { id, email };
  }
  const issue = (ctx: RequestContext, userId: string, purpose: "activation" | "password_reset" = "password_reset") =>
    issueAccountCode(app.db, ctx, { userId, purpose, reason: REASON });
  const redeem = (code: string, newPassword = "NewPassw0rd#1") => redeemAccountCode(app.db, { code, newPassword });

  it("school admin issues a code; the user redeems it once, is signed out everywhere and signs in with the new password", async () => {
    const s = await student();
    const { token } = await login(app.db, s.email, OLD);
    const { code, expiresAt } = await issue(A.ctx(A.adminId), s.id);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    // Issuing a code changes nothing until it is redeemed.
    expect(await validateSession(app.db, token)).not.toBeNull();

    expect(await redeem(code)).toEqual({ purpose: "password_reset" });
    expect(await validateSession(app.db, token)).toBeNull();
    expect(await outcome(login(app.db, s.email, OLD))).toBe("INVALID_CREDENTIALS");
    expect(await outcome(login(app.db, s.email, "NewPassw0rd#1"))).toBe("OK");

    const [stored] = await owner.db.select().from(accountTokens).where(eq(accountTokens.userId, s.id));
    expect(stored!.tokenHash).toBe(hashCode(normalizeCode(code)!));
    expect(stored!.tokenHash).not.toContain(normalizeCode(code)!);
    expect(stored!.consumedAt).not.toBeNull();
    expect(stored!.schoolId).toBe(A.id);

    const events = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, s.id));
    const issued = events.find((e) => e.action === "account.reset_code_issued");
    expect(issued).toMatchObject({ schoolId: A.id, actorUserId: A.adminId, data: { reason: REASON } });
    expect(events.find((e) => e.action === "auth.password_reset_completed")).toMatchObject({ schoolId: A.id, actorUserId: s.id });
    expect(JSON.stringify(events)).not.toContain(normalizeCode(code)!);
  });

  it("a used code cannot be replayed", async () => {
    const s = await student();
    const { code } = await issue(A.ctx(A.adminId), s.id);
    await redeem(code, "FirstChoice#1");
    expect(await outcome(redeem(code, "SecondChoice#2"))).toBe("VALIDATION");
    expect(await outcome(login(app.db, s.email, "FirstChoice#1"))).toBe("OK");
    expect(await outcome(login(app.db, s.email, "SecondChoice#2"))).toBe("INVALID_CREDENTIALS");
  });

  it("an expired code is refused and changes nothing", async () => {
    const s = await student();
    const { code } = await issue(A.ctx(A.adminId), s.id);
    await owner.db.update(accountTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accountTokens.userId, s.id));
    expect(await outcome(redeem(code))).toBe("VALIDATION");
    expect(await outcome(login(app.db, s.email, OLD))).toBe("OK");
  });

  it("a new code cancels the earlier one, and codes can be cancelled outright", async () => {
    const s = await student();
    const first = await issue(A.ctx(A.adminId), s.id);
    const second = await issue(A.ctx(A.adminId), s.id);
    expect(await outcome(redeem(first.code))).toBe("VALIDATION");

    expect(await revokeAccountCodes(app.db, A.ctx(A.adminId), s.id)).toBe(1);
    expect(await outcome(redeem(second.code))).toBe("VALIDATION");
    expect(await outcome(login(app.db, s.email, OLD))).toBe("OK");
  });

  it("concurrent redemption succeeds exactly once", async () => {
    const s = await student();
    const { code } = await issue(A.ctx(A.adminId), s.id);
    const passwords = ["Race#Password1", "Race#Password2", "Race#Password3", "Race#Password4"];
    const results = await Promise.all(passwords.map((p) => outcome(redeem(code, p))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "VALIDATION")).toHaveLength(3);
    const winner = passwords[results.indexOf("OK")]!;
    expect(await outcome(login(app.db, s.email, winner))).toBe("OK");
  });

  it("a disabled account cannot redeem a code", async () => {
    const s = await student();
    const { code } = await issue(A.ctx(A.adminId), s.id);
    await owner.db.update(users).set({ status: "disabled" }).where(eq(users.id, s.id));
    expect(await outcome(redeem(code))).toBe("VALIDATION");
  });

  it("activation lets a new user choose the first password; nobody else ever knows it", async () => {
    const email = `${randomUUID()}@rc.local`;
    const id = await makeUser({ email, passwordHash: "!", mustChangePassword: true });
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: id, role: "teacher" });
    const { code, expiresAt } = await issue(A.ctx(A.adminId), id, "activation");
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    expect(await redeem(code, "MyFirstPass#1")).toEqual({ purpose: "activation" });
    const { token } = await login(app.db, email, "MyFirstPass#1");
    expect((await validateSession(app.db, token))?.user.mustChangePassword).toBe(false);
  });

  it("rejects weak passwords and malformed codes before touching the code", async () => {
    const s = await student();
    const { code } = await issue(A.ctx(A.adminId), s.id);
    expect(await outcome(redeem(code, "short"))).toBe("VALIDATION");
    expect(await outcome(redeem("not-a-code"))).toBe("VALIDATION");
    expect(await outcome(redeem(formatCode(generateCode())))).toBe("VALIDATION");
    expect(await outcome(redeem(code))).toBe("OK"); // still usable after the failed attempts
  });

  describe("who may issue a code", () => {
    it("school admin: only for users their school alone manages", async () => {
      const ctx = A.ctx(A.adminId);
      const shared = (await student()).id;
      await owner.db.insert(schoolMemberships).values({ schoolId: B.id, userId: shared, role: "student" });
      const fellow = await makeUser();
      await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: fellow, role: "school_admin" });

      for (const target of [B.studentId, B.adminId, shared, fellow, platform.userId!, A.adminId, randomUUID()]) {
        expect(await outcome(issue(ctx, target))).toBe("NOT_FOUND");
      }
      expect(await outcome(issue(ctx, "not-a-uuid"))).toBe("NOT_FOUND");
      expect(await owner.db.select().from(accountTokens).where(eq(accountTokens.userId, B.studentId))).toHaveLength(0);
    });

    it("teachers and students cannot issue codes", async () => {
      expect(await outcome(issue(A.ctx(A.teacherId), A.studentId))).toBe("FORBIDDEN");
      expect(await outcome(issue(A.ctx(A.studentId), A.studentId))).toBe("FORBIDDEN");
      const none: RequestContext = { userId: null, schoolId: A.id, isPlatformAdmin: false };
      expect(await outcome(issue(none, A.studentId))).toBe("FORBIDDEN");
    });

    it("a revoked admin and an admin of a suspended school cannot issue codes", async () => {
      const former = await makeUser();
      await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: former, role: "school_admin", status: "revoked" });
      expect(await outcome(issue(A.ctx(former), A.studentId))).toBe("NOT_FOUND");

      const S = await makeSchool("rcs");
      await owner.db.update(schools).set({ status: "suspended" }).where(eq(schools.id, S.id));
      expect(await outcome(issue(S.ctx(S.adminId), S.studentId))).toBe("NOT_FOUND");
    });

    it("platform admin: for school admins and shared users, never for another platform admin", async () => {
      const { code } = await issue(platform, A.adminId);
      const [stored] = await owner.db.select().from(accountTokens).where(eq(accountTokens.tokenHash, hashCode(normalizeCode(code)!)));
      expect(stored).toMatchObject({ userId: A.adminId, schoolId: null, issuedBy: platform.userId });
      await revokeAccountCodes(app.db, platform, A.adminId);

      const otherRoot = await makeUser({ isPlatformAdmin: true });
      expect(await outcome(issue(platform, otherRoot))).toBe("NOT_FOUND");
      expect(await outcome(issue(platform, platform.userId!))).toBe("NOT_FOUND");
    });

    it("a forged platform flag issues nothing", async () => {
      const forged: RequestContext = { userId: A.teacherId, schoolId: null, isPlatformAdmin: true };
      expect(await outcome(issue(forged, B.studentId))).toBe("NOT_FOUND");
      expect(await outcome(issue(forged, A.studentId))).toBe("NOT_FOUND");
    });

    it("a reason is required and is bounded", async () => {
      const ctx = A.ctx(A.adminId);
      expect(await outcome(issueAccountCode(app.db, ctx, { userId: A.studentId, purpose: "password_reset", reason: "  x " }))).toBe("VALIDATION");
      expect(await outcome(issueAccountCode(app.db, ctx, { userId: A.studentId, purpose: "password_reset", reason: "r".repeat(201) }))).toBe("VALIDATION");
    });

    it("the runtime role cannot read or write the code table, or issue without a context", async () => {
      const read = await app.db.select().from(accountTokens).then(() => null, (e: unknown) => e);
      expect(isRlsViolation(read)).toBe(true);
      const write = await app.db
        .insert(accountTokens)
        .values({ userId: A.studentId, purpose: "password_reset", tokenHash: "0".repeat(64), expiresAt: new Date(Date.now() + 60_000) })
        .then(() => null, (e: unknown) => e);
      expect(isRlsViolation(write)).toBe(true);
      const direct = await app.db
        .execute(sql`select auth_issue_account_token(${A.studentId}::uuid, 'password_reset', ${"0".repeat(64)}, 3600)`)
        .then(() => null, (e: unknown) => e);
      expect(isRlsViolation(direct)).toBe(true);
    });
  });

  describe("session revocation", () => {
    it("a user can sign themself out everywhere", async () => {
      const s = await student();
      const one = await createSession(app.db, s.id);
      const two = await createSession(app.db, s.id);
      expect(await revokeUserSessions(app.db, A.ctx(s.id), s.id)).toBe(2);
      expect(await validateSession(app.db, one.token)).toBeNull();
      expect(await validateSession(app.db, two.token)).toBeNull();
    });

    it("an admin can end sessions only for users they may recover", async () => {
      const s = await student();
      const { token } = await createSession(app.db, s.id);
      expect(await revokeUserSessions(app.db, A.ctx(A.adminId), s.id)).toBe(1);
      expect(await validateSession(app.db, token)).toBeNull();

      const foreign = await createSession(app.db, B.studentId);
      expect(await outcome(revokeUserSessions(app.db, A.ctx(A.adminId), B.studentId))).toBe("NOT_FOUND");
      expect(await outcome(revokeUserSessions(app.db, A.ctx(A.teacherId), A.studentId))).toBe("FORBIDDEN");
      expect(await outcome(revokeUserSessions(app.db, platform, (await makeUser({ isPlatformAdmin: true }))))).toBe("NOT_FOUND");
      expect(await validateSession(app.db, foreign.token)).not.toBeNull();
    });
  });

  describe("session lifetime", () => {
    const age = (token: string, createdMsAgo: number, expiresInMs: number) =>
      owner.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - createdMsAgo), expiresAt: new Date(Date.now() + expiresInMs) })
        .where(eq(sessions.id, hashToken(token)));
    const stored = async (token: string) => (await owner.db.select().from(sessions).where(eq(sessions.id, hashToken(token))))[0];

    it("an active session is renewed for another idle period", async () => {
      const { token } = await createSession(app.db, A.teacherId);
      await age(token, 3600_000, 3600_000);
      const s = await validateSession(app.db, token);
      expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    });

    it("renewal never passes 30 days from sign-in", async () => {
      const { token } = await createSession(app.db, A.teacherId);
      const createdAgo = SESSION_ABSOLUTE_MAX_MS - 2 * 3600_000; // two hours of absolute life left
      await age(token, createdAgo, 3600_000);
      const s = await validateSession(app.db, token);
      const limit = (await stored(token))!.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
      expect(s!.expiresAt.getTime()).toBeLessThanOrEqual(limit);
      expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    });

    it("a session older than 30 days is rejected and removed, even if its idle timer was extended", async () => {
      const { token } = await createSession(app.db, A.teacherId);
      await age(token, SESSION_ABSOLUTE_MAX_MS + 60_000, 5 * 24 * 3600_000);
      expect(await validateSession(app.db, token)).toBeNull();
      expect(await stored(token)).toBeUndefined();
    });
  });

  it("cleanup removes only records that can no longer be used", async () => {
    const live = await createSession(app.db, A.teacherId);
    const dead = await createSession(app.db, A.teacherId);
    await owner.db.update(sessions).set({ expiresAt: new Date(Date.now() - 2 * 24 * 3600_000) }).where(eq(sessions.id, hashToken(dead.token)));

    const s = await student();
    const old = await issue(A.ctx(A.adminId), s.id);
    await owner.db
      .update(accountTokens)
      .set({ expiresAt: new Date(Date.now() - 31 * 24 * 3600_000) })
      .where(eq(accountTokens.tokenHash, hashCode(normalizeCode(old.code)!)));
    const current = await issue(A.ctx(A.adminId), s.id);

    await purgeExpiredAuthRecords(app.db);

    expect(await validateSession(app.db, live.token)).not.toBeNull();
    expect(await owner.db.select().from(sessions).where(eq(sessions.id, hashToken(dead.token)))).toHaveLength(0);
    const remaining = await owner.db.select().from(accountTokens).where(and(eq(accountTokens.userId, s.id)));
    expect(remaining.map((t) => t.tokenHash)).toEqual([hashCode(normalizeCode(current.code)!)]);
  });
});
