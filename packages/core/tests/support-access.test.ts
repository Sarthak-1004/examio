import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, schoolMemberships, supportAccessGrants, users, withContext, type RequestContext } from "@examio/db";
import { issueAccountCode } from "../src/auth/recovery";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { listSchoolMembers, listSchools } from "../src/services/schools";
import { endSupportAccess, listSupportAccess, startSupportAccess } from "../src/services/support-access";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.4: platform administrators reach school records only through an audited, time-limited grant. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const REASON = "Ticket 1042: principal reports a teacher cannot sign in";
const ids = { id: users.id };

describe("platform support access", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;
  let otherPlatform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("spa");
    B = await makeSchool("spb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    otherPlatform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    await owner.db.insert(auditEvents).values([
      { schoolId: A.id, actorUserId: A.adminId, action: "school.private_event" },
      { schoolId: null, actorUserId: A.studentId, action: "auth.login" },
      { schoolId: null, actorUserId: A.adminId, action: "auth.login" },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const visibleUsers = async (ctx: RequestContext) => new Set((await withContext(app.db, ctx, (tx) => tx.select(ids).from(users))).map((u) => u.id));
  const visibleMemberships = (ctx: RequestContext) => withContext(app.db, ctx, (tx) => tx.select().from(schoolMemberships));
  const visibleAudit = (ctx: RequestContext) => withContext(app.db, ctx, (tx) => tx.select().from(auditEvents));

  it("without a grant, a platform admin sees only platform admins and school admins", async () => {
    expect(await visibleUsers(platform)).toEqual(new Set([platform.userId, otherPlatform.userId, A.adminId, B.adminId]));
    const memberships = await visibleMemberships(platform);
    expect(memberships.every((m) => m.role === "school_admin")).toBe(true);
    expect(memberships).toHaveLength(2);

    // The school listing still shows size, as an aggregate.
    const listed = await listSchools(app.db, platform);
    expect(listed.find((s) => s.id === A.id)?.memberCount).toBe(3);
    // The member list call is allowed but returns administrators only.
    expect((await listSchoolMembers(app.db, platform, A.id)).map((m) => m.userId)).toEqual([A.adminId]);
  });

  it("without a grant, a platform admin cannot change or recover ordinary school users", async () => {
    const edited = await withContext(app.db, platform, (tx) => tx.update(users).set({ fullName: "Changed" }).where(eq(users.id, A.studentId)).returning(ids));
    expect(edited).toHaveLength(0);
    expect(await outcome(issueAccountCode(app.db, platform, { userId: A.studentId, purpose: "password_reset", reason: REASON }))).toBe("NOT_FOUND");
    const attach = await failure(
      withContext(app.db, platform, (tx) => tx.insert(schoolMemberships).values({ schoolId: A.id, userId: B.studentId, role: "teacher" })),
    );
    expect(isRlsViolation(attach)).toBe(true);
    const revoke = await withContext(app.db, platform, (tx) =>
      tx.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, A.studentId)).returning(),
    );
    expect(revoke).toHaveLength(0);
    // Routine duty is unaffected: school administrators can be recovered.
    expect(await outcome(issueAccountCode(app.db, platform, { userId: A.adminId, purpose: "password_reset", reason: REASON }))).toBe("OK");
  });

  it("without a grant, a platform admin does not read a school's audit log", async () => {
    const actions = (await visibleAudit(platform)).map((e) => `${e.action}:${e.actorUserId}`);
    expect(actions).not.toContain(`school.private_event:${A.adminId}`);
    expect(actions).not.toContain(`auth.login:${A.studentId}`);
    expect(actions).toContain(`auth.login:${A.adminId}`);
  });

  it("a grant opens exactly one school, is audited there, and the school can see it", async () => {
    const { id, expiresAt } = await startSupportAccess(app.db, platform, { schoolId: A.id, reason: REASON });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + 65 * 60_000);

    const seen = await visibleUsers(platform);
    for (const u of [A.adminId, A.teacherId, A.studentId]) expect(seen.has(u)).toBe(true);
    for (const u of [B.teacherId, B.studentId]) expect(seen.has(u)).toBe(false);
    expect((await visibleMemberships(platform)).filter((m) => m.schoolId === B.id).every((m) => m.role === "school_admin")).toBe(true);
    expect((await visibleAudit(platform)).some((e) => e.action === "school.private_event")).toBe(true);
    expect(await outcome(issueAccountCode(app.db, platform, { userId: A.studentId, purpose: "password_reset", reason: REASON }))).toBe("OK");
    expect(await outcome(issueAccountCode(app.db, platform, { userId: B.studentId, purpose: "password_reset", reason: REASON }))).toBe("NOT_FOUND");

    // Recorded in the school's own audit log and visible to its administrators.
    const schoolLog = await visibleAudit(A.ctx(A.adminId));
    expect(schoolLog.find((e) => e.action === "support.access_started")).toMatchObject({
      schoolId: A.id,
      actorUserId: platform.userId,
      entityId: id,
      data: { reason: REASON, minutes: 60 },
    });
    const forSchool = await listSupportAccess(app.db, A.ctx(A.adminId), A.id);
    expect(forSchool[0]).toMatchObject({ id, reason: REASON, active: true, platformUserId: platform.userId });

    // Someone else's grant gives another platform admin nothing.
    expect((await visibleUsers(otherPlatform)).has(A.studentId)).toBe(false);

    await endSupportAccess(app.db, platform, id);
    expect((await visibleUsers(platform)).has(A.studentId)).toBe(false);
    expect((await visibleAudit(A.ctx(A.adminId))).some((e) => e.action === "support.access_ended" && e.entityId === id)).toBe(true);
    expect((await listSupportAccess(app.db, platform, A.id))[0]).toMatchObject({ id, active: false });
  });

  it("a grant stops working when it expires and cannot be extended or reopened", async () => {
    const { id } = await startSupportAccess(app.db, platform, { schoolId: A.id, reason: REASON, minutes: 5 });
    expect((await visibleUsers(platform)).has(A.studentId)).toBe(true);

    const extend = await failure(
      withContext(app.db, platform, (tx) =>
        tx.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() + 24 * 3600_000) }).where(eq(supportAccessGrants.id, id)),
      ),
    );
    expect(isRlsViolation(extend)).toBe(true);

    await owner.db
      .update(supportAccessGrants)
      .set({ createdAt: new Date(Date.now() - 3600_000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(supportAccessGrants.id, id));
    expect((await visibleUsers(platform)).has(A.studentId)).toBe(false);

    await endSupportAccess(app.db, platform, id);
    const reopen = await withContext(app.db, platform, (tx) =>
      tx.update(supportAccessGrants).set({ endedAt: null }).where(eq(supportAccessGrants.id, id)).returning({ id: supportAccessGrants.id }),
    );
    expect(reopen).toHaveLength(0);
    expect(await outcome(endSupportAccess(app.db, platform, id))).toBe("NOT_FOUND");
  });

  it("opening a new grant closes the previous one for the same school", async () => {
    const first = await startSupportAccess(app.db, platform, { schoolId: B.id, reason: REASON });
    const second = await startSupportAccess(app.db, platform, { schoolId: B.id, reason: `${REASON} (continued)` });
    const grants = await owner.db.select().from(supportAccessGrants).where(eq(supportAccessGrants.schoolId, B.id));
    expect(grants.find((g) => g.id === first.id)?.endedAt).not.toBeNull();
    expect(grants.find((g) => g.id === second.id)?.endedAt).toBeNull();
    await endSupportAccess(app.db, platform, second.id);
  });

  it("requires a real reason, a bounded duration and an existing school", async () => {
    const start = (input: Parameters<typeof startSupportAccess>[2]) => outcome(startSupportAccess(app.db, platform, input));
    expect(await start({ schoolId: A.id, reason: "help" })).toBe("VALIDATION");
    expect(await start({ schoolId: A.id, reason: "r".repeat(501) })).toBe("VALIDATION");
    expect(await start({ schoolId: A.id, reason: REASON, minutes: 241 })).toBe("VALIDATION");
    expect(await start({ schoolId: A.id, reason: REASON, minutes: 0 })).toBe("VALIDATION");
    expect(await start({ schoolId: "00000000-0000-4000-8000-000000000000", reason: REASON })).toBe("NOT_FOUND");
    expect(await start({ schoolId: "not-a-uuid", reason: REASON })).toBe("NOT_FOUND");
  });

  it("only platform administrators can open a grant, and only for themselves", async () => {
    expect(await outcome(startSupportAccess(app.db, A.ctx(A.adminId), { schoolId: B.id, reason: REASON }))).toBe("FORBIDDEN");
    const forged: RequestContext = { userId: A.adminId, schoolId: null, isPlatformAdmin: true };
    expect(await outcome(startSupportAccess(app.db, forged, { schoolId: B.id, reason: REASON }))).toBe("NOT_FOUND");

    const row = { schoolId: B.id, reason: REASON, expiresAt: sql`now() + interval '30 minutes'` };
    const attempts: [RequestContext, string, typeof row | (Omit<typeof row, "expiresAt"> & { expiresAt: ReturnType<typeof sql> })][] = [
      [A.ctx(A.adminId), A.adminId, row],
      [forged, A.adminId, row],
      [platform, otherPlatform.userId!, row],
      [platform, platform.userId!, { ...row, expiresAt: sql`now() + interval '5 hours'` }],
    ];
    for (const [ctx, holder, values] of attempts) {
      const err = await failure(withContext(app.db, ctx, (tx) => tx.insert(supportAccessGrants).values({ ...values, platformUserId: holder })));
      expect(err).not.toBeNull();
    }
    expect(await owner.db.select().from(supportAccessGrants).where(and(eq(supportAccessGrants.schoolId, B.id), sql`${supportAccessGrants.endedAt} is null`))).toHaveLength(0);
  });

  it("a grant cannot be ended by someone else or deleted", async () => {
    const { id } = await startSupportAccess(app.db, platform, { schoolId: A.id, reason: REASON });
    expect(await outcome(endSupportAccess(app.db, otherPlatform, id))).toBe("NOT_FOUND");
    expect(await outcome(endSupportAccess(app.db, A.ctx(A.adminId), id))).toBe("FORBIDDEN");
    const remove = await failure(withContext(app.db, platform, (tx) => tx.delete(supportAccessGrants).where(eq(supportAccessGrants.id, id))));
    expect(isRlsViolation(remove)).toBe(true);
    expect((await visibleUsers(platform)).has(A.studentId)).toBe(true);
    await endSupportAccess(app.db, platform, id);
  });

  it("a disabled platform admin's open grant gives no access", async () => {
    const leaving = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    await startSupportAccess(app.db, leaving, { schoolId: A.id, reason: REASON });
    expect((await visibleUsers(leaving)).has(A.studentId)).toBe(true);
    await owner.db.update(users).set({ status: "disabled" }).where(eq(users.id, leaving.userId));
    expect(await visibleUsers(leaving)).toEqual(new Set([leaving.userId]));
  });

  it("support history is visible to the school concerned and to no other school", async () => {
    expect((await listSupportAccess(app.db, A.ctx(A.adminId), A.id)).length).toBeGreaterThan(0);
    expect(await outcome(listSupportAccess(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");
    expect(await outcome(listSupportAccess(app.db, A.ctx(A.teacherId), A.id))).toBe("FORBIDDEN");
    const direct = await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select().from(supportAccessGrants).where(eq(supportAccessGrants.schoolId, A.id)));
    expect(direct).toHaveLength(0);
    const teacher = await withContext(app.db, A.ctx(A.teacherId), (tx) => tx.select().from(supportAccessGrants));
    expect(teacher).toHaveLength(0);
  });
});
