import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, membershipInvitations, schoolMemberships, schools, users, withContext, type RequestContext } from "@examio/db";
import { formatCode, generateCode, hashCode, normalizeCode } from "../src/auth/codes";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import {
  acceptMembershipInvitation,
  createMembershipInvitation,
  listMembershipInvitations,
  revokeMembershipInvitation,
} from "../src/services/invitations";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.2: membership invitations give a shared identity a consented link to a second school. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const me = (userId: string): RequestContext => ({ userId, schoolId: null, isPlatformAdmin: false });

describe("membership invitations", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("iva");
    B = await makeSchool("ivb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const invite = (school: School, role: "teacher" | "student" | "parent" | "finance" = "teacher", by = school.adminId) =>
    createMembershipInvitation(app.db, school.ctx(by), school.id, { role, recipientLabel: "Mr. Rao, visiting teacher" });
  const membershipsOf = (userId: string, school: School) =>
    owner.db.select().from(schoolMemberships).where(and(eq(schoolMemberships.userId, userId), eq(schoolMemberships.schoolId, school.id)));

  it("a person from another school accepts while signed in and gains exactly the invited membership", async () => {
    const { id, code, expiresAt } = await invite(A, "teacher");
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

    // Until they accept, the school cannot attach them itself.
    const direct = await failure(
      withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(schoolMemberships).values({ schoolId: A.id, userId: B.teacherId, role: "teacher" })),
    );
    expect(isRlsViolation(direct)).toBe(true);

    expect(await acceptMembershipInvitation(app.db, me(B.teacherId), code)).toEqual({ schoolId: A.id, role: "teacher" });
    expect((await membershipsOf(B.teacherId, A)).map((m) => [m.role, m.status])).toEqual([["teacher", "active"]]);
    expect(await membershipsOf(B.teacherId, B)).toHaveLength(1);

    const [row] = await owner.db.select().from(membershipInvitations).where(eq(membershipInvitations.id, id));
    expect(row).toMatchObject({ acceptedBy: B.teacherId, invitedBy: A.adminId, schoolId: A.id });
    expect(row!.tokenHash).toBe(hashCode(normalizeCode(code)!));

    const events = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(events.map((e) => [e.action, e.actorUserId, e.schoolId]).sort()).toEqual(
      [
        ["membership.invitation_accepted", B.teacherId, A.id],
        ["membership.invitation_created", A.adminId, A.id],
      ].sort(),
    );

    // The identity is now shared: school A sees them on its roster but cannot edit the account.
    const edited = await withContext(app.db, A.ctx(A.adminId), (tx) =>
      tx.update(users).set({ passwordHash: "takeover" }).where(eq(users.id, B.teacherId)).returning({ id: users.id }),
    );
    expect(edited).toHaveLength(0);
  });

  it("a code works once, for one person", async () => {
    const { code } = await invite(A, "parent");
    expect(await outcome(acceptMembershipInvitation(app.db, me(B.studentId), code))).toBe("OK");
    expect(await outcome(acceptMembershipInvitation(app.db, me(B.studentId), code))).toBe("VALIDATION");
    expect(await outcome(acceptMembershipInvitation(app.db, me(B.adminId), code))).toBe("VALIDATION");
    expect(await membershipsOf(B.adminId, A)).toHaveLength(0);
  });

  it("concurrent acceptance by different people succeeds exactly once", async () => {
    const { code } = await invite(A, "parent");
    const people = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const results = await Promise.all(people.map((p) => outcome(acceptMembershipInvitation(app.db, me(p), code))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    const joined = await owner.db.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.role, "parent")));
    expect(people.filter((p) => joined.some((m) => m.userId === p))).toHaveLength(1);
  });

  it("expired, revoked and unknown codes are refused identically", async () => {
    const person = await makeUser();
    const expired = await invite(A);
    await owner.db.update(membershipInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(membershipInvitations.id, expired.id));
    const revoked = await invite(A);
    await revokeMembershipInvitation(app.db, A.ctx(A.adminId), A.id, revoked.id);

    for (const code of [expired.code, revoked.code, formatCode(generateCode()), "nonsense"]) {
      expect(await outcome(acceptMembershipInvitation(app.db, me(person), code))).toBe("VALIDATION");
    }
    expect(await membershipsOf(person, A)).toHaveLength(0);
    // A closed invitation cannot be revoked again.
    expect(await outcome(revokeMembershipInvitation(app.db, A.ctx(A.adminId), A.id, revoked.id))).toBe("NOT_FOUND");
  });

  it("an accepted invitation is history and cannot be revoked", async () => {
    const person = await makeUser();
    const { id, code } = await invite(A, "finance");
    await acceptMembershipInvitation(app.db, me(person), code);
    expect(await outcome(revokeMembershipInvitation(app.db, A.ctx(A.adminId), A.id, id))).toBe("NOT_FOUND");
    const tamper = await withContext(app.db, A.ctx(A.adminId), (tx) =>
      tx.update(membershipInvitations).set({ revokedAt: new Date() }).where(eq(membershipInvitations.id, id)).returning({ id: membershipInvitations.id }),
    );
    expect(tamper).toHaveLength(0);
    expect((await membershipsOf(person, A)).map((m) => m.role)).toEqual(["finance"]);
  });

  it("accepting restores a previously revoked membership of the same role", async () => {
    const person = await makeUser();
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: person, role: "teacher", status: "revoked" });
    const { code } = await invite(A, "teacher");
    await acceptMembershipInvitation(app.db, me(person), code);
    expect((await membershipsOf(person, A)).map((m) => [m.role, m.status])).toEqual([["teacher", "active"]]);
  });

  it("school-admin membership is never offered by invitation", async () => {
    const asAdmin = createMembershipInvitation(app.db, A.ctx(A.adminId), A.id, {
      role: "school_admin" as "teacher",
      recipientLabel: "Someone",
    });
    expect(await outcome(asAdmin)).toBe("VALIDATION");

    const direct = await failure(
      withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.insert(membershipInvitations).values({
          schoolId: A.id,
          role: "school_admin",
          tokenHash: hashCode(generateCode()),
          recipientLabel: "Someone",
          invitedBy: A.adminId,
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      ),
    );
    expect(direct).not.toBeNull();
    expect(await owner.db.select().from(membershipInvitations).where(eq(membershipInvitations.role, "school_admin"))).toHaveLength(0);
  });

  it("platform administrators and signed-out callers cannot accept", async () => {
    const { code } = await invite(A);
    expect(await outcome(acceptMembershipInvitation(app.db, platform, code))).toBe("FORBIDDEN");
    expect(await outcome(acceptMembershipInvitation(app.db, { userId: null, schoolId: null, isPlatformAdmin: false }, code))).toBe("FORBIDDEN");
    // The refused attempts did not use the code up.
    expect(await outcome(acceptMembershipInvitation(app.db, me(await makeUser()), code))).toBe("OK");
  });

  it("an invitation to a suspended school cannot be accepted", async () => {
    const S = await makeSchool("ivs");
    const { code } = await invite(S);
    await owner.db.update(schools).set({ status: "suspended" }).where(eq(schools.id, S.id));
    const person = await makeUser();
    expect(await outcome(acceptMembershipInvitation(app.db, me(person), code))).toBe("VALIDATION");
    expect(await membershipsOf(person, S)).toHaveLength(0);
  });

  describe("who may manage invitations", () => {
    it("only the school's own administrators create, list and revoke", async () => {
      const { id } = await invite(A);
      for (const actor of [A.teacherId, A.studentId]) {
        expect(await outcome(invite(A, "teacher", actor))).toBe("FORBIDDEN");
        expect(await outcome(listMembershipInvitations(app.db, A.ctx(actor), A.id))).toBe("FORBIDDEN");
        expect(await outcome(revokeMembershipInvitation(app.db, A.ctx(actor), A.id, id))).toBe("FORBIDDEN");
      }
      // Another school's admin, with their own context or a forged one.
      expect(await outcome(listMembershipInvitations(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");
      expect(await outcome(revokeMembershipInvitation(app.db, B.ctx(B.adminId), A.id, id))).toBe("NOT_FOUND");
      expect(await outcome(revokeMembershipInvitation(app.db, B.ctx(B.adminId), B.id, id))).toBe("NOT_FOUND");
      expect(await outcome(listMembershipInvitations(app.db, platform, A.id))).toBe("FORBIDDEN");

      const mine = await listMembershipInvitations(app.db, A.ctx(A.adminId), A.id);
      expect(mine.some((i) => i.id === id)).toBe(true);
      expect(mine.every((i) => !("tokenHash" in i))).toBe(true);
      const [still] = await owner.db.select().from(membershipInvitations).where(eq(membershipInvitations.id, id));
      expect(still!.revokedAt).toBeNull();
    });

    it("the database isolates invitations by school and hides the code hash", async () => {
      const { id } = await invite(A);
      const cols = { id: membershipInvitations.id };
      for (const ctx of [B.ctx(B.adminId), { userId: B.adminId, schoolId: A.id, isPlatformAdmin: false }, A.ctx(A.teacherId), platform]) {
        expect(await withContext(app.db, ctx, (tx) => tx.select(cols).from(membershipInvitations))).toHaveLength(0);
        const revoked = await withContext(app.db, ctx, (tx) =>
          tx.update(membershipInvitations).set({ revokedAt: new Date() }).where(eq(membershipInvitations.id, id)).returning(cols),
        );
        expect(revoked).toHaveLength(0);
      }

      const admin = A.ctx(A.adminId);
      const hash = await failure(withContext(app.db, admin, (tx) => tx.select({ h: membershipInvitations.tokenHash }).from(membershipInvitations)));
      expect(isRlsViolation(hash)).toBe(true);
      const selfAccept = await failure(
        withContext(app.db, admin, (tx) => tx.update(membershipInvitations).set({ acceptedBy: A.adminId, acceptedAt: new Date() }).where(eq(membershipInvitations.id, id))),
      );
      expect(isRlsViolation(selfAccept)).toBe(true);
      const remove = await failure(withContext(app.db, admin, (tx) => tx.delete(membershipInvitations).where(eq(membershipInvitations.id, id))));
      expect(isRlsViolation(remove)).toBe(true);
    });

    it("the database refuses forged inviters, other schools and over-long lifetimes", async () => {
      const base = { role: "teacher" as const, recipientLabel: "X Y", expiresAt: new Date(Date.now() + 3600_000) };
      const attempts = [
        { ...base, schoolId: B.id, invitedBy: A.adminId },
        { ...base, schoolId: A.id, invitedBy: A.teacherId },
        { ...base, schoolId: A.id, invitedBy: A.adminId, expiresAt: new Date(Date.now() + 30 * 24 * 3600_000) },
        { ...base, schoolId: A.id, invitedBy: A.adminId, acceptedBy: A.adminId, acceptedAt: new Date() },
      ];
      for (const values of attempts) {
        const err = await failure(
          withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(membershipInvitations).values({ ...values, tokenHash: hashCode(generateCode()) })),
        );
        expect(isRlsViolation(err)).toBe(true);
      }
    });
  });

  it("repeated wrong codes are rate limited per user", async () => {
    const person = await makeUser();
    const { code } = await invite(A);
    for (let i = 0; i < 10; i++) expect(await outcome(acceptMembershipInvitation(app.db, me(person), formatCode(generateCode())))).toBe("VALIDATION");
    expect(await outcome(acceptMembershipInvitation(app.db, me(person), code))).toBe("RATE_LIMITED");
    expect(await membershipsOf(person, A)).toHaveLength(0);
  });
});
