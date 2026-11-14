import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schoolMemberships, schools, users, withContext, type RequestContext } from "@examio/db";
import { CAPABILITY_ROLES, PLATFORM_CAPABILITIES, rolesGrant, withCapability, type Capability, type SchoolRole } from "../src/capabilities";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { countMembersByRole, getSchool, listSchoolMembers } from "../src/services/schools";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.5: capability checks for school admin, teacher, student, parent and finance. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const ROLES: SchoolRole[] = ["school_admin", "teacher", "student", "parent", "finance"];

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );

async function member(school: School, ...roles: SchoolRole[]) {
  const id = await makeUser();
  await owner.db.insert(schoolMemberships).values(roles.map((role) => ({ schoolId: school.id, userId: id, role })));
  return id;
}

describe("capability checks", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;
  const actors = {} as Record<SchoolRole, string>;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("cpa");
    B = await makeSchool("cpb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    for (const role of ROLES) actors[role] = await member(A, role);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("the capability map names only real roles and platform capabilities exist", () => {
    for (const roles of Object.values(CAPABILITY_ROLES)) {
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((r) => ROLES.includes(r))).toBe(true);
    }
    expect(PLATFORM_CAPABILITIES.every((c) => c in CAPABILITY_ROLES)).toBe(true);
    expect(rolesGrant([], "school.view")).toBe(false);
    expect(rolesGrant(["student", "teacher"], "school.member_counts.view")).toBe(true);
  });

  it("each role gets exactly its capabilities in its own school", async () => {
    const expected: Record<SchoolRole, [view: string, counts: string, members: string]> = {
      school_admin: ["OK", "OK", "OK"],
      teacher: ["OK", "OK", "FORBIDDEN"],
      student: ["OK", "FORBIDDEN", "FORBIDDEN"],
      parent: ["OK", "FORBIDDEN", "FORBIDDEN"],
      finance: ["OK", "FORBIDDEN", "FORBIDDEN"],
    };
    for (const role of ROLES) {
      const ctx = A.ctx(actors[role]);
      const actual = [
        await outcome(getSchool(app.db, ctx, A.id)),
        await outcome(countMembersByRole(app.db, ctx, A.id)),
        await outcome(listSchoolMembers(app.db, ctx, A.id)),
      ];
      expect([role, ...actual]).toEqual([role, ...expected[role]]);
    }
  });

  it("the service result agrees with the map for every role and capability", async () => {
    for (const capability of Object.keys(CAPABILITY_ROLES) as Capability[]) {
      for (const role of ROLES) {
        const result = await outcome(withCapability(app.db, A.ctx(actors[role]), A.id, capability, async () => null));
        expect([capability, role, result]).toEqual([capability, role, rolesGrant([role], capability) ? "OK" : "FORBIDDEN"]);
      }
    }
  });

  it("passes the database-confirmed actor to the operation", async () => {
    const both = await member(A, "teacher", "parent");
    const actor = await withCapability(app.db, A.ctx(both), A.id, "school.member_counts.view", async (_tx, a) => a);
    expect(actor.userId).toBe(both);
    expect(actor.schoolId).toBe(A.id);
    expect(new Set(actor.roles)).toEqual(new Set(["teacher", "parent"]));
    expect(actor.isPlatformAdmin).toBe(false);
  });

  it("roles held in another school never apply", async () => {
    const mixed = await member(A, "school_admin");
    await owner.db.insert(schoolMemberships).values({ schoolId: B.id, userId: mixed, role: "student" });
    expect(await outcome(listSchoolMembers(app.db, B.ctx(mixed), B.id))).toBe("FORBIDDEN");
    expect(await outcome(listSchoolMembers(app.db, A.ctx(mixed), A.id))).toBe("OK");
    // A context for school A cannot be used to reach school B.
    expect(await outcome(listSchoolMembers(app.db, A.ctx(mixed), B.id))).toBe("NOT_FOUND");
  });

  it("revoked membership, disabled account and suspended school are refused despite a stale context", async () => {
    const revoked = await member(A, "school_admin");
    await owner.db.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, revoked));
    expect(await outcome(getSchool(app.db, A.ctx(revoked), A.id))).toBe("NOT_FOUND");
    expect(await outcome(listSchoolMembers(app.db, A.ctx(revoked), A.id))).toBe("NOT_FOUND");

    const disabled = await member(A, "school_admin");
    await owner.db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled));
    expect(await outcome(getSchool(app.db, A.ctx(disabled), A.id))).toBe("NOT_FOUND");

    const S = await makeSchool("cps");
    expect(await outcome(listSchoolMembers(app.db, S.ctx(S.adminId), S.id))).toBe("OK");
    await owner.db.update(schools).set({ status: "suspended" }).where(eq(schools.id, S.id));
    expect(await outcome(listSchoolMembers(app.db, S.ctx(S.adminId), S.id))).toBe("NOT_FOUND");
    expect(await outcome(getSchool(app.db, S.ctx(S.adminId), S.id))).toBe("NOT_FOUND");
  });

  it("platform administrator holds the listed platform capabilities; a forged flag holds none", async () => {
    expect(await outcome(getSchool(app.db, platform, A.id))).toBe("OK");
    expect(await outcome(listSchoolMembers(app.db, platform, A.id, "school_admin"))).toBe("OK");
    // Not a platform capability: the platform listing uses an aggregate count instead.
    expect(await outcome(countMembersByRole(app.db, platform, B.id))).toBe("FORBIDDEN");

    const forged: RequestContext = { userId: actors.student, schoolId: null, isPlatformAdmin: true };
    expect(await outcome(getSchool(app.db, forged, B.id))).toBe("NOT_FOUND");
    expect(await outcome(listSchoolMembers(app.db, forged, B.id))).toBe("NOT_FOUND");
    // In their own school the forged flag adds nothing to the student's capabilities.
    expect(await outcome(listSchoolMembers(app.db, forged, A.id))).toBe("FORBIDDEN");
  });

  it("the finance and parent roles have no extra database access", async () => {
    for (const role of ["finance", "parent"] as const) {
      const ctx = A.ctx(actors[role]);
      const seen = await withContext(app.db, ctx, (tx) => tx.select({ id: users.id }).from(users));
      expect(seen.map((u) => u.id)).toEqual([actors[role]]);
      const memberships = await withContext(app.db, ctx, (tx) => tx.select().from(schoolMemberships));
      expect(memberships.map((m) => m.userId)).toEqual([actors[role]]);
      const grant = await withContext(app.db, ctx, (tx) =>
        tx.insert(schoolMemberships).values({ schoolId: A.id, userId: actors[role], role: "school_admin" }),
      ).then(() => null, (e: unknown) => e);
      expect(isRlsViolation(grant)).toBe(true);
    }
  });
});
