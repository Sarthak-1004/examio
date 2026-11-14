import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountTokens, auditEvents, users } from "@examio/db";
import { normalizeCode } from "../src/auth/codes";
import { login } from "../src/auth/login";
import { redeemAccountCode } from "../src/auth/recovery";
import { contextFor, validateSession } from "../src/auth/session";
import { AppError } from "../src/errors";
import { bootstrapPlatformAdmin } from "../src/ops/bootstrap-admin";
import { listSchools } from "../src/services/schools";
import { app, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.4: the first production administrator is created by an operator, without a shared password. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );

describe("platform administrator bootstrap", () => {
  beforeAll(truncateAll);
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("creates the first administrator with a one-time code and no usable password", async () => {
    const result = await bootstrapPlatformAdmin(owner.db, { email: " Root@Examio.Test ", fullName: "Root Admin", mode: "first" });
    expect(result.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    const [user] = await owner.db.select().from(users).where(eq(users.id, result.userId));
    expect(user).toMatchObject({ email: "root@examio.test", isPlatformAdmin: true, status: "active" });
    // Nobody can sign in until the code is redeemed, whatever password is tried.
    for (const guess of ["", "!", "password", "ChangeMe!2026"]) {
      expect(await outcome(login(app.db, "root@examio.test", guess))).toBe("INVALID_CREDENTIALS");
    }
    const [token] = await owner.db.select().from(accountTokens).where(eq(accountTokens.userId, result.userId));
    expect(token!.tokenHash).not.toContain(normalizeCode(result.code)!);
    expect(token).toMatchObject({ purpose: "activation", issuedBy: null, schoolId: null });
    const events = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, result.userId));
    expect(events.map((e) => e.action)).toEqual(["platform_admin.bootstrapped"]);

    // The administrator chooses their own password and gains platform access.
    await redeemAccountCode(app.db, { code: result.code, newPassword: "Chosen#ByAdmin1" });
    const { token: session } = await login(app.db, "root@examio.test", "Chosen#ByAdmin1");
    const s = (await validateSession(app.db, session))!;
    expect(s.user.isPlatformAdmin).toBe(true);
    expect(await outcome(listSchools(app.db, contextFor(s)))).toBe("OK");
  });

  it("refuses to create a second 'first' administrator", async () => {
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "two@examio.test", fullName: "Second", mode: "first" }))).toBe("CONFLICT");
    expect(await owner.db.select().from(users).where(eq(users.email, "two@examio.test"))).toHaveLength(0);
  });

  it("adds another administrator only when asked explicitly, and never promotes an existing account", async () => {
    const added = await bootstrapPlatformAdmin(owner.db, { email: "two@examio.test", fullName: "Second Admin", mode: "additional" });
    expect((await owner.db.select().from(users).where(eq(users.id, added.userId)))[0]!.isPlatformAdmin).toBe(true);

    const ordinary = await makeUser({ email: "teacher@school.test" });
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "teacher@school.test", fullName: "Teacher", mode: "additional" }))).toBe("CONFLICT");
    expect((await owner.db.select().from(users).where(eq(users.id, ordinary)))[0]!.isPlatformAdmin).toBe(false);
  });

  it("recovery issues a new code for an existing administrator and cancels the old one", async () => {
    const first = await bootstrapPlatformAdmin(owner.db, { email: "three@examio.test", fullName: "Third Admin", mode: "additional" });
    const again = await bootstrapPlatformAdmin(owner.db, { email: "three@examio.test", mode: "recover" });
    expect(again.userId).toBe(first.userId);
    expect(await outcome(redeemAccountCode(app.db, { code: first.code, newPassword: "Chosen#ByAdmin1" }))).toBe("VALIDATION");
    expect(await outcome(redeemAccountCode(app.db, { code: again.code, newPassword: "Chosen#ByAdmin2" }))).toBe("OK");
    expect(await outcome(login(app.db, "three@examio.test", "Chosen#ByAdmin2"))).toBe("OK");
  });

  it("recovery is refused for ordinary, unknown and disabled accounts", async () => {
    await makeUser({ email: "student@school.test" });
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "student@school.test", mode: "recover" }))).toBe("NOT_FOUND");
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "nobody@examio.test", mode: "recover" }))).toBe("NOT_FOUND");
    await makeUser({ email: "gone@examio.test", isPlatformAdmin: true, status: "disabled" });
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "gone@examio.test", mode: "recover" }))).toBe("NOT_FOUND");
  });

  it("validates its input and cannot run on the application connection", async () => {
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "not-an-email", fullName: "X Y", mode: "additional" }))).toBe("VALIDATION");
    expect(await outcome(bootstrapPlatformAdmin(owner.db, { email: "four@examio.test", mode: "additional" }))).toBe("VALIDATION");
    // The runtime role cannot create platform administrators, so the same call fails there.
    const viaApp = await bootstrapPlatformAdmin(app.db, { email: "four@examio.test", fullName: "Fourth", mode: "additional" }).then(
      () => "OK",
      () => "REFUSED",
    );
    expect(viaApp).toBe("REFUSED");
    expect(await owner.db.select().from(users).where(eq(users.email, "four@examio.test"))).toHaveLength(0);
  });
});
