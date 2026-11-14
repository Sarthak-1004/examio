import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, schoolMemberships, schools, users, withContext } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/**
 * Blueprint §6.4 / §15.1: automated tests must attempt cross-tenant reads, updates, deletes.
 * Every query here runs as the restricted app role with RLS in force.
 */
describe("tenant isolation (RLS)", () => {
  let A: Awaited<ReturnType<typeof makeSchool>>;
  let B: Awaited<ReturnType<typeof makeSchool>>;
  let platform: { userId: string; schoolId: null; isPlatformAdmin: true };
  const userIds = { id: users.id };

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("aaa");
    B = await makeSchool("bbb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    await owner.db.insert(auditEvents).values({ schoolId: B.id, actorUserId: B.adminId, action: "secret.b" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("school admin sees only their own school", async () => {
    const rows = await withContext(app.db, A.ctx(A.adminId), (tx) => tx.select().from(schools));
    expect(rows.map((r) => r.id)).toEqual([A.id]);
  });

  it("school admin sees only their own school's users and memberships", async () => {
    const [us, ms] = await withContext(app.db, A.ctx(A.adminId), async (tx) => [
      await tx.select(userIds).from(users),
      await tx.select().from(schoolMemberships),
    ] as const);
    expect(new Set(us.map((u) => u.id))).toEqual(new Set([A.adminId, A.teacherId, A.studentId]));
    expect(ms.every((m) => m.schoolId === A.id)).toBe(true);
    expect(ms).toHaveLength(3);
  });

  it("student sees only themself — not classmates", async () => {
    const [us, ms] = await withContext(app.db, A.ctx(A.studentId), async (tx) => [
      await tx.select(userIds).from(users),
      await tx.select().from(schoolMemberships),
    ] as const);
    expect(us.map((u) => u.id)).toEqual([A.studentId]);
    expect(ms.map((m) => m.userId)).toEqual([A.studentId]);
  });

  it("spoofed context: claiming another school's id grants nothing", async () => {
    const spoof = { userId: A.adminId, schoolId: B.id, isPlatformAdmin: false };
    const [ss, us, ms, au] = await withContext(app.db, spoof, async (tx) => [
      await tx.select().from(schools).where(eq(schools.id, B.id)),
      await tx.select(userIds).from(users).where(eq(users.id, B.studentId)),
      await tx.select().from(schoolMemberships).where(eq(schoolMemberships.schoolId, B.id)),
      await tx.select().from(auditEvents).where(eq(auditEvents.schoolId, B.id)),
    ]);
    expect(ss).toHaveLength(0);
    expect(us).toHaveLength(0);
    expect(ms).toHaveLength(0);
    expect(au).toHaveLength(0);
  });

  it("cannot update or revoke another school's rows", async () => {
    const ctx = A.ctx(A.adminId);
    const updatedSchool = await withContext(app.db, ctx, (tx) =>
      tx.update(schools).set({ name: "hacked" }).where(eq(schools.id, B.id)).returning(),
    );
    const updatedUser = await withContext(app.db, ctx, (tx) =>
      tx.update(users).set({ fullName: "hacked" }).where(eq(users.id, B.studentId)).returning(userIds),
    );
    const revoked = await withContext(app.db, ctx, (tx) =>
      tx.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.schoolId, B.id)).returning(),
    );
    expect(updatedSchool).toHaveLength(0);
    expect(updatedUser).toHaveLength(0);
    expect(revoked).toHaveLength(0);

    const [b] = await owner.db.select().from(schools).where(eq(schools.id, B.id));
    expect(b!.name).toBe("School bbb");
    const bMembers = await owner.db.select().from(schoolMemberships).where(eq(schoolMemberships.schoolId, B.id));
    expect(bMembers).toHaveLength(3);
    expect(bMembers.every((m) => m.status === "active")).toBe(true);
  });

  it("cannot insert a membership into another school", async () => {
    const outsider = await makeUser();
    const err = await withContext(app.db, A.ctx(A.adminId), (tx) =>
      tx.insert(schoolMemberships).values({ schoolId: B.id, userId: outsider, role: "school_admin" }),
    ).catch((e) => e);
    expect(isRlsViolation(err)).toBe(true);
  });

  it("teacher cannot add members (school_admin only)", async () => {
    const outsider = await makeUser();
    const err = await withContext(app.db, A.ctx(A.teacherId), (tx) =>
      tx.insert(schoolMemberships).values({ schoolId: A.id, userId: outsider, role: "school_admin" }),
    ).catch((e) => e);
    expect(isRlsViolation(err)).toBe(true);
  });

  it("school admin cannot create or promote a platform admin", async () => {
    const err = await withContext(app.db, A.ctx(A.adminId), (tx) =>
      tx.insert(users).values({ fullName: "x", email: "x@x.local", passwordHash: "x", isPlatformAdmin: true }),
    ).catch((e) => e);
    expect(isRlsViolation(err)).toBe(true);

    const selfPromote = await withContext(app.db, A.ctx(A.adminId), (tx) =>
      tx.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, A.adminId)),
    ).catch((e) => e);
    expect(isRlsViolation(selfPromote)).toBe(true);
  });

  it("no context at all sees no tenant data", async () => {
    const none = { userId: null, schoolId: null, isPlatformAdmin: false };
    const [ss, us, ms] = await withContext(app.db, none, async (tx) => [
      await tx.select().from(schools),
      await tx.select(userIds).from(users),
      await tx.select().from(schoolMemberships),
    ]);
    expect(ss).toHaveLength(0);
    expect(us).toHaveLength(0);
    expect(ms).toHaveLength(0);
  });

  it("audit log cannot be read across schools or rewritten", async () => {
    const rows = await withContext(app.db, A.ctx(A.adminId), (tx) => tx.select().from(auditEvents));
    expect(rows.every((r) => r.schoolId === A.id)).toBe(true);
    // The runtime role has no UPDATE or DELETE privilege on the audit log: append-only even for platform admins.
    const updated = await withContext(app.db, platform, (tx) =>
      tx.update(auditEvents).set({ action: "tampered" }).returning(),
    ).catch((e) => e);
    expect(isRlsViolation(updated)).toBe(true);
    const deleted = await withContext(app.db, platform, (tx) => tx.delete(auditEvents)).catch((e) => e);
    expect(isRlsViolation(deleted)).toBe(true);
    const [b] = await owner.db.select().from(auditEvents).where(eq(auditEvents.schoolId, B.id));
    expect(b!.action).toBe("secret.b");
  });

  it("platform admin sees all schools", async () => {
    const rows = await withContext(app.db, platform, (tx) => tx.select().from(schools));
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([A.id, B.id]));
  });
});
