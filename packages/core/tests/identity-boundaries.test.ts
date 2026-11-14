import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  assertRestrictedRuntimeRole,
  auditEvents,
  boards,
  schoolMemberships,
  schools,
  sessions,
  users,
  withContext,
  type RequestContext,
} from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { createSession, deleteSession, hashToken, validateSession } from "../src/auth/session";
import { countMembersByRole, getSchool, listSchoolMembers, listSchools, setSchoolStatus } from "../src/services/schools";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/**
 * Phase 1, task 01.1: identity, membership grant, privilege and tenant boundary rules.
 * Everything under test runs as the restricted application role; the owner connection only
 * arranges fixtures and reads ground truth.
 */
type School = Awaited<ReturnType<typeof makeSchool>>;

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
/** Resolves to the error a statement fails with, or null when it succeeds. */
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const userId = { id: users.id };

async function member(school: School, role: "school_admin" | "teacher" | "student" | "parent", status: "active" | "revoked" = "active") {
  const id = await makeUser();
  await owner.db.insert(schoolMemberships).values({ schoolId: school.id, userId: id, role, status });
  return id;
}

describe("identity and membership boundaries", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("ida");
    B = await makeSchool("idb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  describe("database role and privileges", () => {
    it("accepts the application role and refuses the owner role as a runtime connection", async () => {
      await expect(assertRestrictedRuntimeRole(app.db)).resolves.toBeUndefined();
      await expect(assertRestrictedRuntimeRole(owner.db)).rejects.toThrow(/restricted application role/);
    });

    it("PUBLIC cannot execute any helper function; the application role can", async () => {
      const open = await owner.db.execute(sql`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('public', p.oid, 'execute')`);
      expect(open).toHaveLength(0);
      const closed = await owner.db.execute(sql`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and not has_function_privilege('examio_app', p.oid, 'execute')`);
      expect(closed).toHaveLength(0);
    });

    it("cannot read password hashes", async () => {
      const err = await failure(
        withContext(app.db, A.ctx(A.adminId), (tx) => tx.select({ hash: users.passwordHash }).from(users)),
      );
      expect(isRlsViolation(err)).toBe(true);
    });

    it("cannot delete users, memberships or schools, even as platform admin", async () => {
      for (const run of [
        (c: RequestContext) => withContext(app.db, c, (tx) => tx.delete(users).where(eq(users.id, A.studentId))),
        (c: RequestContext) => withContext(app.db, c, (tx) => tx.delete(schoolMemberships).where(eq(schoolMemberships.schoolId, A.id))),
        (c: RequestContext) => withContext(app.db, c, (tx) => tx.delete(schools).where(eq(schools.id, A.id))),
      ]) {
        expect(isRlsViolation(await failure(run(platform)))).toBe(true);
        expect(isRlsViolation(await failure(run(A.ctx(A.adminId))))).toBe(true);
      }
      expect(await owner.db.select(userId).from(users).where(eq(users.id, A.studentId))).toHaveLength(1);
    });

    it("cannot change a membership's school, user or role, or a school's code", async () => {
      const ctx = A.ctx(A.adminId);
      const where = and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.userId, A.teacherId));
      expect(isRlsViolation(await failure(withContext(app.db, ctx, (tx) => tx.update(schoolMemberships).set({ role: "school_admin" }).where(where))))).toBe(true);
      expect(isRlsViolation(await failure(withContext(app.db, ctx, (tx) => tx.update(schoolMemberships).set({ userId: A.adminId }).where(where))))).toBe(true);
      expect(isRlsViolation(await failure(withContext(app.db, ctx, (tx) => tx.update(schoolMemberships).set({ schoolId: B.id }).where(where))))).toBe(true);
      expect(isRlsViolation(await failure(withContext(app.db, platform, (tx) => tx.update(schools).set({ code: "zzz" }).where(eq(schools.id, A.id)))))).toBe(true);
    });
  });

  describe("platform privilege", () => {
    it("a forged platform flag grants nothing without a platform administrator account", async () => {
      const forged: RequestContext = { userId: A.adminId, schoolId: null, isPlatformAdmin: true };
      const seen = await withContext(app.db, forged, (tx) => tx.select({ id: schools.id }).from(schools));
      expect(seen.map((s) => s.id)).toEqual([A.id]);
      expect(isRlsViolation(await failure(withContext(app.db, forged, (tx) => tx.insert(boards).values({ name: "Forged" }))))).toBe(true);

      const anonymous: RequestContext = { userId: null, schoolId: null, isPlatformAdmin: true };
      expect(await withContext(app.db, anonymous, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);
      expect(await withContext(app.db, anonymous, (tx) => tx.select(userId).from(users))).toHaveLength(0);
    });

    it("a disabled platform administrator loses platform access", async () => {
      const disabled = await makeUser({ isPlatformAdmin: true, status: "disabled" });
      const ctx: RequestContext = { userId: disabled, schoolId: null, isPlatformAdmin: true };
      expect(await withContext(app.db, ctx, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);
    });

    it("platform administrators cannot be created, promoted or edited through the runtime role", async () => {
      const create = failure(
        withContext(app.db, platform, (tx) =>
          tx.insert(users).values({ fullName: "New Root", email: "root2@test.local", passwordHash: "x", isPlatformAdmin: true }),
        ),
      );
      expect(isRlsViolation(await create)).toBe(true);

      const promote = failure(withContext(app.db, platform, (tx) => tx.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, A.teacherId))));
      expect(isRlsViolation(await promote)).toBe(true);

      const other = await makeUser({ isPlatformAdmin: true });
      const edited = await withContext(app.db, platform, (tx) =>
        tx.update(users).set({ passwordHash: "takeover" }).where(eq(users.id, other)).returning(userId),
      );
      expect(edited).toHaveLength(0);
    });

    it("only a platform administrator changes school status; a school admin may edit the profile", async () => {
      const ctx = A.ctx(A.adminId);
      const renamed = await withContext(app.db, ctx, (tx) =>
        tx.update(schools).set({ address: "1 Test Road" }).where(eq(schools.id, A.id)).returning({ id: schools.id }),
      );
      expect(renamed).toHaveLength(1);

      const C = await makeSchool("idc");
      await owner.db.update(schools).set({ status: "onboarding" }).where(eq(schools.id, C.id));
      const selfActivate = failure(withContext(app.db, C.ctx(C.adminId), (tx) => tx.update(schools).set({ status: "active" }).where(eq(schools.id, C.id))));
      expect(isRlsViolation(await selfActivate)).toBe(true);
      const [c] = await owner.db.select().from(schools).where(eq(schools.id, C.id));
      expect(c!.status).toBe("onboarding");

      await setSchoolStatus(app.db, platform, C.id, "active");
      const [after] = await owner.db.select().from(schools).where(eq(schools.id, C.id));
      expect(after!.status).toBe("active");
    });
  });

  describe("membership grants", () => {
    it("school admin creates a new user and adds them to their own school", async () => {
      const id = randomUUID();
      await withContext(app.db, A.ctx(A.adminId), async (tx) => {
        await tx.insert(users).values({ id, fullName: "New Teacher", email: `${id}@test.local`, passwordHash: "x" });
        await tx.insert(schoolMemberships).values({ schoolId: A.id, userId: id, role: "teacher" });
      });
      const rows = await owner.db.select().from(schoolMemberships).where(eq(schoolMemberships.userId, id));
      expect(rows.map((m) => [m.schoolId, m.role, m.status])).toEqual([[A.id, "teacher", "active"]]);
    });

    it("school admin cannot attach a user who belongs to another school", async () => {
      for (const victim of [B.adminId, B.teacherId, B.studentId]) {
        const err = await failure(
          withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(schoolMemberships).values({ schoolId: A.id, userId: victim, role: "student" })),
        );
        expect(isRlsViolation(err)).toBe(true);
      }
      const leaked = await owner.db.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.userId, B.adminId)));
      expect(leaked).toHaveLength(0);
    });

    it("school admin cannot attach a platform administrator or a disabled account", async () => {
      const disabled = await makeUser({ status: "disabled" });
      for (const target of [platform.userId!, disabled]) {
        const err = await failure(
          withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(schoolMemberships).values({ schoolId: A.id, userId: target, role: "teacher" })),
        );
        expect(isRlsViolation(err)).toBe(true);
      }
    });

    it("school admin revokes members of their own school only", async () => {
      const target = await member(A, "teacher");
      const own = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, target)).returning(),
      );
      expect(own).toHaveLength(1);

      const foreign = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, B.teacherId)).returning(),
      );
      expect(foreign).toHaveLength(0);
    });

    it("re-activating a membership follows the same rule as a new grant", async () => {
      const moved = await member(A, "teacher", "revoked");
      await owner.db.insert(schoolMemberships).values({ schoolId: B.id, userId: moved, role: "teacher" });
      const err = await failure(
        withContext(app.db, A.ctx(A.adminId), (tx) =>
          tx.update(schoolMemberships).set({ status: "active" }).where(and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.userId, moved))),
        ),
      );
      expect(isRlsViolation(err)).toBe(true);

      const local = await member(A, "teacher", "revoked");
      const restored = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(schoolMemberships).set({ status: "active" }).where(and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.userId, local))).returning(),
      );
      expect(restored).toHaveLength(1);
    });
  });

  describe("identity writes", () => {
    const rename = (ctx: RequestContext, target: string) =>
      withContext(app.db, ctx, (tx) => tx.update(users).set({ fullName: "Changed" }).where(eq(users.id, target)).returning(userId));

    it("school admin manages a user who belongs to their school alone", async () => {
      expect(await rename(A.ctx(A.adminId), A.studentId)).toHaveLength(1);
      const reset = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(users).set({ passwordHash: "reset", mustChangePassword: true }).where(eq(users.id, A.studentId)).returning(userId),
      );
      expect(reset).toHaveLength(1);
    });

    it("school admin cannot change the identity of a user shared with another school", async () => {
      const shared = await member(A, "teacher");
      await owner.db.insert(schoolMemberships).values({ schoolId: B.id, userId: shared, role: "teacher" });

      // Still visible on the roster, but credentials and profile are out of reach for both schools.
      expect(await withContext(app.db, A.ctx(A.adminId), (tx) => tx.select(userId).from(users).where(eq(users.id, shared)))).toHaveLength(1);
      expect(await rename(A.ctx(A.adminId), shared)).toHaveLength(0);
      expect(await rename(B.ctx(B.adminId), shared)).toHaveLength(0);
      const takeover = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(users).set({ passwordHash: "takeover" }).where(eq(users.id, shared)).returning(userId),
      );
      expect(takeover).toHaveLength(0);

      // Each school can still withdraw its own membership.
      const revoked = await withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.update(schoolMemberships).set({ status: "revoked" }).where(and(eq(schoolMemberships.schoolId, A.id), eq(schoolMemberships.userId, shared))).returning(),
      );
      expect(revoked).toHaveLength(1);
      // A no longer has an active link, so it still cannot manage the identity.
      expect(await rename(A.ctx(A.adminId), shared)).toHaveLength(0);
    });

    it("school admin cannot change a fellow school admin, a platform admin or themself", async () => {
      const fellow = await member(A, "school_admin");
      expect(await rename(A.ctx(A.adminId), fellow)).toHaveLength(0);
      expect(await rename(A.ctx(A.adminId), platform.userId!)).toHaveLength(0);
      expect(await rename(A.ctx(A.adminId), A.adminId)).toHaveLength(0);
    });

    it("teachers and students cannot change any identity, including their own", async () => {
      expect(await rename(A.ctx(A.teacherId), A.studentId)).toHaveLength(0);
      expect(await rename(A.ctx(A.teacherId), A.teacherId)).toHaveLength(0);
      const selfEnable = await withContext(app.db, A.ctx(A.studentId), (tx) =>
        tx.update(users).set({ email: "mine@test.local", status: "active", mustChangePassword: false }).where(eq(users.id, A.studentId)).returning(userId),
      );
      expect(selfEnable).toHaveLength(0);
    });

    it("teachers and students cannot create users", async () => {
      for (const actor of [A.teacherId, A.studentId]) {
        const err = await failure(
          withContext(app.db, A.ctx(actor), (tx) => tx.insert(users).values({ fullName: "x", email: `${randomUUID()}@test.local`, passwordHash: "x" })),
        );
        expect(isRlsViolation(err)).toBe(true);
      }
    });
  });

  describe("revoked, disabled and suspended access", () => {
    it("a revoked school admin loses school access immediately", async () => {
      const former = await member(A, "school_admin", "revoked");
      const ctx = A.ctx(former);
      expect(await withContext(app.db, ctx, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);
      expect((await withContext(app.db, ctx, (tx) => tx.select(userId).from(users))).map((u) => u.id)).toEqual([former]);
      const grant = failure(withContext(app.db, ctx, (tx) => tx.insert(schoolMemberships).values({ schoolId: A.id, userId: former, role: "teacher" })));
      expect(isRlsViolation(await grant)).toBe(true);
      const reactivate = await withContext(app.db, ctx, (tx) =>
        tx.update(schoolMemberships).set({ status: "active" }).where(eq(schoolMemberships.userId, former)).returning(),
      );
      expect(reactivate).toHaveLength(0);
    });

    it("a disabled account holds no school role", async () => {
      const off = await member(A, "school_admin");
      await owner.db.update(users).set({ status: "disabled" }).where(eq(users.id, off));
      const ctx = A.ctx(off);
      expect(await withContext(app.db, ctx, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);
      expect(await withContext(app.db, ctx, (tx) => tx.update(users).set({ fullName: "x" }).where(eq(users.id, A.studentId)).returning(userId))).toHaveLength(0);
    });

    it("members of a suspended school lose read and write access even with a live context", async () => {
      const S = await makeSchool("ids");
      const { token } = await createSession(app.db, S.adminId);
      expect((await validateSession(app.db, token))?.memberships).toHaveLength(1);

      await setSchoolStatus(app.db, platform, S.id, "suspended");

      expect((await validateSession(app.db, token))?.memberships).toHaveLength(0);
      const ctx = S.ctx(S.adminId); // a stale context still naming the suspended school
      expect(await withContext(app.db, ctx, (tx) => tx.select({ id: schools.id }).from(schools))).toHaveLength(0);
      expect((await withContext(app.db, ctx, (tx) => tx.select(userId).from(users))).map((u) => u.id)).toEqual([S.adminId]);
      expect(await withContext(app.db, ctx, (tx) => tx.update(users).set({ fullName: "x" }).where(eq(users.id, S.studentId)).returning(userId))).toHaveLength(0);
      const grant = failure(
        withContext(app.db, ctx, async (tx) => {
          const id = randomUUID();
          await tx.insert(users).values({ id, fullName: "Late", email: `${id}@test.local`, passwordHash: "x" });
        }),
      );
      expect(isRlsViolation(await grant)).toBe(true);
      expect(await withContext(app.db, ctx, (tx) => tx.select().from(auditEvents))).toHaveLength(0);
    });
  });

  describe("sessions", () => {
    it("are visible to and writable by their own user only", async () => {
      const mine = await createSession(app.db, A.teacherId);
      const theirs = await createSession(app.db, B.teacherId);

      const none: RequestContext = { userId: null, schoolId: null, isPlatformAdmin: false };
      expect(await withContext(app.db, none, (tx) => tx.select().from(sessions))).toHaveLength(0);
      expect(await app.db.select().from(sessions)).toHaveLength(0);

      const own = await withContext(app.db, A.ctx(A.teacherId), (tx) => tx.select().from(sessions));
      expect(own.map((s) => s.id)).toEqual([hashToken(mine.token)]);
      expect(await withContext(app.db, platform, (tx) => tx.select().from(sessions))).toHaveLength(0);

      const stolen = await withContext(app.db, A.ctx(A.teacherId), (tx) =>
        tx.delete(sessions).where(eq(sessions.id, hashToken(theirs.token))).returning(),
      );
      expect(stolen).toHaveLength(0);
      const forged = failure(
        withContext(app.db, A.ctx(A.teacherId), (tx) =>
          tx.insert(sessions).values({ id: hashToken("forged"), userId: B.teacherId, expiresAt: new Date(Date.now() + 60_000) }),
        ),
      );
      expect(isRlsViolation(await forged)).toBe(true);

      expect((await validateSession(app.db, theirs.token))?.user.id).toBe(B.teacherId);
      await deleteSession(app.db, mine.token);
      expect(await validateSession(app.db, mine.token)).toBeNull();
      expect(await owner.db.select().from(sessions).where(eq(sessions.id, hashToken(mine.token)))).toHaveLength(0);
    });
  });

  describe("audit log", () => {
    it("actor cannot be forged and another school's log cannot be written", async () => {
      const asOther = failure(
        withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(auditEvents).values({ schoolId: A.id, actorUserId: A.teacherId, action: "forged" })),
      );
      expect(isRlsViolation(await asOther)).toBe(true);
      const platformAsOther = failure(
        withContext(app.db, platform, (tx) => tx.insert(auditEvents).values({ schoolId: A.id, actorUserId: A.adminId, action: "forged" })),
      );
      expect(isRlsViolation(await platformAsOther)).toBe(true);
      const otherSchool = failure(
        withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(auditEvents).values({ schoolId: B.id, actorUserId: A.adminId, action: "forged" })),
      );
      expect(isRlsViolation(await otherSchool)).toBe(true);

      await withContext(app.db, A.ctx(A.adminId), (tx) => tx.insert(auditEvents).values({ schoolId: A.id, actorUserId: A.adminId, action: "genuine" }));
      expect(await owner.db.select().from(auditEvents).where(eq(auditEvents.action, "forged"))).toHaveLength(0);
    });
  });

  describe("service tenant boundaries", () => {
    it("school services refuse another school's identifier", async () => {
      const ctx = A.ctx(A.adminId);
      expect(code(await failure(getSchool(app.db, ctx, B.id)))).toBe("NOT_FOUND");
      expect(code(await failure(listSchoolMembers(app.db, ctx, B.id)))).toBe("NOT_FOUND");
      expect(code(await failure(countMembersByRole(app.db, ctx, B.id)))).toBe("NOT_FOUND");
      expect(code(await failure(getSchool(app.db, ctx, "not-a-uuid")))).toBe("NOT_FOUND");
      expect((await getSchool(app.db, ctx, A.id)).id).toBe(A.id);

      const none: RequestContext = { userId: null, schoolId: A.id, isPlatformAdmin: false };
      expect(code(await failure(getSchool(app.db, none, A.id)))).toBe("FORBIDDEN");
    });

    it("platform services refuse school users and forged platform contexts", async () => {
      expect(code(await failure(listSchools(app.db, A.ctx(A.adminId))))).toBe("FORBIDDEN");
      expect(code(await failure(setSchoolStatus(app.db, A.ctx(A.adminId), B.id, "suspended")))).toBe("FORBIDDEN");

      // The flag passes the service guard, but the database does not recognise the account.
      const forged: RequestContext = { userId: A.adminId, schoolId: null, isPlatformAdmin: true };
      expect(code(await failure(setSchoolStatus(app.db, forged, B.id, "suspended")))).toBe("NOT_FOUND");
      const [b] = await owner.db.select().from(schools).where(eq(schools.id, B.id));
      expect(b!.status).toBe("active");

      expect(code(await failure(setSchoolStatus(app.db, platform, randomUUID(), "suspended")))).toBe("NOT_FOUND");
      expect((await listSchools(app.db, platform)).length).toBeGreaterThanOrEqual(2);
    });
  });
});
