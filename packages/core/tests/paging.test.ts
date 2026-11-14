import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schools, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { DEFAULT_PAGE_SIZE, likePattern, parsePageRequest } from "../src/paging";
import { searchSchools } from "../src/services/schools";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 2, task 02.1: shared list parameters and the paginated school listing. */
describe("list parameters", () => {
  it("parses page, size and search from the URL with safe fallbacks", () => {
    expect(parsePageRequest({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE, search: "" });
    expect(parsePageRequest({ page: "3", size: "50", q: "  green  " })).toEqual({ page: 3, pageSize: 50, search: "green" });
    for (const page of ["0", "-1", "abc", "1.5", "9999999"]) expect(parsePageRequest({ page }).page).toBe(1);
    for (const size of ["7", "1000", "x"]) expect(parsePageRequest({ size }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageRequest({ page: ["2", "5"], q: ["a", "b"] })).toMatchObject({ page: 2, search: "a" });
    expect(parsePageRequest({ q: "x".repeat(500) }).search).toHaveLength(100);
  });

  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});

describe("school search", () => {
  let platform: RequestContext;
  beforeAll(async () => {
    await truncateAll();
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    for (const code of ["pga", "pgb", "pgc", "pgd", "pge"]) await makeSchool(code);
    await owner.db.update(schools).set({ name: "Green 100% Academy", status: "suspended" }).where(eq(schools.code, "pgc"));
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("pages through every school exactly once in a stable order", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const p = await searchSchools(app.db, platform, { page, pageSize: 2, search: "" });
      expect(p.total).toBe(5);
      expect(p.pageCount).toBe(3);
      seen.push(...p.rows.map((r) => r.code));
    }
    expect(seen.sort()).toEqual(["pga", "pgb", "pgc", "pgd", "pge"]);
    expect((await searchSchools(app.db, platform, { page: 9, pageSize: 2, search: "" })).rows).toHaveLength(0);
  });

  it("searches name or code, treats wildcards literally and filters by status", async () => {
    const codes = async (search: string, status?: "suspended") =>
      (await searchSchools(app.db, platform, { page: 1, pageSize: 25, search, status })).rows.map((r) => r.code);
    expect(await codes("PGB")).toEqual(["pgb"]);
    expect(await codes("100%")).toEqual(["pgc"]);
    expect(await codes("%")).toEqual(["pgc"]);
    expect(await codes("", "suspended")).toEqual(["pgc"]);
    const none = await searchSchools(app.db, platform, { page: 1, pageSize: 25, search: "nothing-matches" });
    expect(none).toMatchObject({ total: 0, pageCount: 1, rows: [] });
  });

  it("is a platform-only listing", async () => {
    const S = await makeSchool("pgx");
    const err = await searchSchools(app.db, S.ctx(S.adminId), { page: 1, pageSize: 25, search: "" }).catch((e: unknown) => e);
    expect(err instanceof AppError && err.code).toBe("FORBIDDEN");
  });
});
