import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions, users } from "@examio/db";
import { AppError } from "../src/errors";
import { login } from "../src/auth/login";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { contextFor, hashToken, validateSession } from "../src/auth/session";
import { changeOwnPassword } from "../src/auth/password-change";
import { createSchoolWithAdmin, listSchools } from "../src/services/schools";
import { app, makeLookups, makeSchool, makeUser, owner, truncateAll } from "./helpers";

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("password hashing", () => {
  it("verifies correct and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("login", () => {
  let S: Awaited<ReturnType<typeof makeSchool>>;
  beforeAll(async () => {
    await truncateAll();
    S = await makeSchool("lgn");
    await owner.db.update(users).set({ email: "teacher@lgn.local", phone: "9876543210" }).where(eq(users.id, S.teacherId));
  });

  it("signs in by email (case-insensitive), username and phone (any format)", async () => {
    for (const id of ["Teacher@LGN.local", "+91 98765-43210", "09876543210"]) {
      const r = await login(app.db, id, "Passw0rd!");
      expect(r.userId).toBe(S.teacherId);
    }
    const r = await login(app.db, "LGN1001", "Passw0rd!");
    expect(r.userId).toBe(S.studentId);
  });

  it("rejects wrong password and unknown users with the same error", async () => {
    expect(code(await login(app.db, "teacher@lgn.local", "nope").catch((e) => e))).toBe("INVALID_CREDENTIALS");
    expect(code(await login(app.db, "ghost@lgn.local", "Passw0rd!").catch((e) => e))).toBe("INVALID_CREDENTIALS");
  });

  it("siblings sharing a phone: different passwords work, identical passwords ask for username", async () => {
    const sib1 = await makeUser({ email: null, username: "lgn2001", phone: "9123456789", passwordHash: await hashPassword("sibling-one") });
    const sib2 = await makeUser({ email: null, username: "lgn2002", phone: "9123456789", passwordHash: await hashPassword("sibling-two") });
    expect((await login(app.db, "9123456789", "sibling-one")).userId).toBe(sib1);
    expect((await login(app.db, "9123456789", "sibling-two")).userId).toBe(sib2);

    await makeUser({ email: null, username: "lgn3001", phone: "9111111111" });
    await makeUser({ email: null, username: "lgn3002", phone: "9111111111" });
    expect(code(await login(app.db, "9111111111", "Passw0rd!").catch((e) => e))).toBe("AMBIGUOUS_LOGIN");
    expect((await login(app.db, "lgn3002", "Passw0rd!")).userId).toBeTruthy();
  });

  it("disabled accounts cannot sign in", async () => {
    await makeUser({ email: "off@lgn.local", status: "disabled" });
    expect(code(await login(app.db, "off@lgn.local", "Passw0rd!").catch((e) => e))).toBe("ACCOUNT_DISABLED");
  });

  it("session round-trip: validate, stores only a hash, context resolves the school", async () => {
    const { token } = await login(app.db, "teacher@lgn.local", "Passw0rd!");
    const [stored] = await owner.db.select().from(sessions).where(eq(sessions.id, hashToken(token)));
    expect(stored).toBeTruthy();
    expect(stored!.id).not.toBe(token);

    const s = await validateSession(app.db, token);
    expect(s?.user.id).toBe(S.teacherId);
    expect(s?.memberships).toEqual([expect.objectContaining({ schoolId: S.id, role: "teacher" })]);
    expect(contextFor(s!).schoolId).toBe(S.id);
    // Asking for a school the user doesn't belong to is ignored.
    expect(contextFor(s!, "00000000-0000-0000-0000-000000000000").schoolId).toBe(S.id);

    expect(await validateSession(app.db, "not-a-real-token")).toBeNull();
  });

  it("expired sessions are rejected", async () => {
    const { token } = await login(app.db, "teacher@lgn.local", "Passw0rd!");
    await owner.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, hashToken(token)));
    expect(await validateSession(app.db, token)).toBeNull();
  });

  it("changing password signs out other sessions", async () => {
    const a = await login(app.db, "teacher@lgn.local", "Passw0rd!");
    const b = await login(app.db, "teacher@lgn.local", "Passw0rd!");
    const ctx = contextFor((await validateSession(app.db, a.token))!);
    await changeOwnPassword(app.db, ctx, a.token, "Passw0rd!", "NewPassw0rd!");
    expect(await validateSession(app.db, a.token)).not.toBeNull();
    expect(await validateSession(app.db, b.token)).toBeNull();
    expect((await login(app.db, "teacher@lgn.local", "NewPassw0rd!")).userId).toBe(S.teacherId);
  });
});

describe("school onboarding", () => {
  beforeAll(async () => {
    await truncateAll();
  });

  it("platform admin creates a school with its first admin, who can then sign in", async () => {
    const superId = await makeUser({ isPlatformAdmin: true });
    const ctx = { userId: superId, schoolId: null, isPlatformAdmin: true };
    const { boardId, mediumId } = await makeLookups();
    const { schoolId } = await createSchoolWithAdmin(app.db, ctx, {
      name: "New School",
      code: "NEW01",
      boardId,
      mediumId,
      admin: { fullName: "Principal", email: "p@new.local", phone: "", password: "Welcome@123" },
    });
    expect((await listSchools(app.db, ctx)).map((s) => s.code)).toEqual(["new01"]);

    const { token } = await login(app.db, "p@new.local", "Welcome@123");
    const s = await validateSession(app.db, token);
    expect(s?.memberships).toEqual([expect.objectContaining({ schoolId, role: "school_admin" })]);
    expect(s?.user.mustChangePassword).toBe(true);

    const dup = await createSchoolWithAdmin(app.db, ctx, {
      name: "Dup", code: "new01", boardId, mediumId,
      admin: { fullName: "Other Principal", email: "x@new.local", password: "Welcome@123" },
    }).catch((e) => e);
    expect(code(dup)).toBe("CONFLICT");
  });

  it("non-platform admin cannot create schools; bad input is rejected", async () => {
    const S = await makeSchool("onb");
    const { boardId, mediumId } = await makeLookups();
    const input = { name: "Nope", code: "nope", boardId, mediumId, admin: { fullName: "X", email: "n@x.local", password: "Welcome@123" } };
    expect(code(await createSchoolWithAdmin(app.db, S.ctx(S.adminId), input).catch((e) => e))).toBe("FORBIDDEN");

    const superCtx = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    const bad = await createSchoolWithAdmin(app.db, superCtx, { ...input, code: "has space", admin: { fullName: "X", password: "short" } }).catch((e) => e);
    expect(code(bad)).toBe("VALIDATION");
  });
});
