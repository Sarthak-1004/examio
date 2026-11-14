import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { rateLimitBuckets, users } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { clientIpFromForwardedFor, parseTrustedProxyHops } from "../src/client-ip";
import { canonicalLoginKey } from "../src/normalize";
import { hitRateLimit } from "../src/rate-limit";
import { login } from "../src/auth/login";
import { changeOwnPassword } from "../src/auth/password-change";
import { contextFor, validateSession } from "../src/auth/session";
import { app, makeUser, owner, truncateAll } from "./helpers";

/** Phase 1, task 01.3: shared rate limits, canonical account keys, bounded input, trusted proxy handling. */
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
const attempt = (identifier: string, password: string, clientIp?: string) =>
  login(app.db, identifier, password, { clientIp }).then(
    () => "OK",
    (e: unknown) => code(e),
  );
const GOOD = "Passw0rd!";
const BAD = "wrong-password";

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("trusted proxy handling", () => {
  it("parses TRUSTED_PROXY_HOPS strictly", () => {
    expect(parseTrustedProxyHops(undefined)).toBe(0);
    expect(parseTrustedProxyHops("")).toBe(0);
    expect(parseTrustedProxyHops("2")).toBe(2);
    for (const bad of ["-1", "1.5", "abc", "6", "1e1"]) expect(() => parseTrustedProxyHops(bad)).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("ignores the header entirely when no proxy is trusted", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 0)).toBeNull();
    expect(clientIpFromForwardedFor(null, 1)).toBeNull();
  });

  it("uses the entry written by the trusted proxy, not a client-supplied one", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 1)).toBe("203.0.113.7");
    // The client sent a forged first entry; the proxy appended the real peer address.
    expect(clientIpFromForwardedFor("10.10.10.10, 203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("10.10.10.10, 203.0.113.7, 192.0.2.1", 2)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("2001:DB8::1", 1)).toBe("2001:db8::1");
  });

  it("returns null for a short header or a value that is not an address", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 2)).toBeNull();
    expect(clientIpFromForwardedFor("not-an-ip", 1)).toBeNull();
    expect(clientIpFromForwardedFor("203.0.113.7, <script>", 1)).toBeNull();
    expect(clientIpFromForwardedFor("1.1.1.1,".repeat(500), 1)).toBeNull();
  });
});

describe("canonical account keys", () => {
  it("gives every format of a phone number the same key", () => {
    const keys = ["9876543210", "+91 98765-43210", "09876543210", "(98765) 43210"].map(canonicalLoginKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("ignores case, surrounding space and Unicode width for emails and usernames", () => {
    expect(canonicalLoginKey("  Teacher@LGN.local ")).toBe(canonicalLoginKey("teacher@lgn.local"));
    expect(canonicalLoginKey("ｔｅａｃｈｅｒ@lgn.local")).toBe(canonicalLoginKey("teacher@lgn.local"));
    expect(canonicalLoginKey("teacher@lgn.local")).not.toBe(canonicalLoginKey("teacher2@lgn.local"));
  });
});

describe("shared rate limiter", () => {
  beforeAll(truncateAll);

  it("allows exactly the limit under concurrent attempts", async () => {
    const rule = { scope: "test:concurrent", subject: randomUUID(), limit: 5, windowSeconds: 60 };
    const results = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit(app.db, rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const blocked = results.filter((r) => !r.allowed);
    expect(blocked.every((r) => r.retryAfterSec > 0 && r.retryAfterSec <= 60)).toBe(true);
  });

  it("opens again when the window ends", async () => {
    const rule = { scope: "test:window", subject: randomUUID(), limit: 1, windowSeconds: 1 };
    expect((await hitRateLimit(app.db, rule)).allowed).toBe(true);
    expect((await hitRateLimit(app.db, rule)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await hitRateLimit(app.db, rule)).allowed).toBe(true);
  });

  it("rejects invalid limits", async () => {
    await expect(hitRateLimit(app.db, { scope: "test:bad", subject: "x", limit: 0, windowSeconds: 60 })).rejects.toThrow();
    await expect(hitRateLimit(app.db, { scope: "test:bad", subject: "x", limit: 1, windowSeconds: 0 })).rejects.toThrow();
  });

  it("stores only hashed keys and gives the runtime role no direct table access", async () => {
    await hitRateLimit(app.db, { scope: "test:secret", subject: "someone@example.test", limit: 5, windowSeconds: 60 });
    const rows = await owner.db.select().from(rateLimitBuckets);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key))).toBe(true);

    const read = await app.db.select().from(rateLimitBuckets).then(() => null, (e: unknown) => e);
    expect(isRlsViolation(read)).toBe(true);
    const wipe = await app.db.delete(rateLimitBuckets).then(() => null, (e: unknown) => e);
    expect(isRlsViolation(wipe)).toBe(true);
    const open = await owner.db.execute(sql`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'rate_limit%' and has_function_privilege('public', p.oid, 'execute')`);
    expect(open).toHaveLength(0);
  });
});

describe("sign-in limits", () => {
  beforeAll(truncateAll);

  const account = async () => {
    const email = `${randomUUID()}@limit.local`;
    const id = await makeUser({ email });
    return { id, email };
  };

  it("blocks an account from one address after 8 failures, even with the correct password", async () => {
    const { email } = await account();
    const ip = "198.51.100.1";
    for (let i = 0; i < 8; i++) expect(await attempt(email, BAD, ip)).toBe("INVALID_CREDENTIALS");
    expect(await attempt(email, GOOD, ip)).toBe("RATE_LIMITED");
    // Another address is not locked out by the first one.
    expect(await attempt(email, GOOD, "198.51.100.2")).toBe("OK");
  });

  it("counts every format of the same phone number together", async () => {
    await makeUser({ email: null, username: `u${Date.now()}`, phone: "9812345678" });
    const ip = "198.51.100.3";
    const formats = ["9812345678", "+91 98123 45678", "098123-45678", "(98123) 45678"];
    for (let i = 0; i < 8; i++) expect(await attempt(formats[i % formats.length]!, BAD, ip)).toBe("INVALID_CREDENTIALS");
    expect(await attempt("+919812345678", GOOD, ip)).toBe("RATE_LIMITED");
  });

  it("limits unknown identifiers exactly like real accounts", async () => {
    const ghost = `${randomUUID()}@limit.local`;
    const ip = "198.51.100.4";
    for (let i = 0; i < 8; i++) expect(await attempt(ghost, BAD, ip)).toBe("INVALID_CREDENTIALS");
    expect(await attempt(ghost, BAD, ip)).toBe("RATE_LIMITED");
  });

  it("successful sign-ins neither consume the limit nor erase earlier failures", async () => {
    const { email } = await account();
    const ip = "198.51.100.5";
    for (let i = 0; i < 5; i++) expect(await attempt(email, BAD, ip)).toBe("INVALID_CREDENTIALS");
    for (let i = 0; i < 10; i++) expect(await attempt(email, GOOD, ip)).toBe("OK");
    for (let i = 0; i < 3; i++) expect(await attempt(email, BAD, ip)).toBe("INVALID_CREDENTIALS");
    expect(await attempt(email, GOOD, ip)).toBe("RATE_LIMITED");
  });

  it("bounds guessing on one account spread across many addresses", async () => {
    const { email } = await account();
    for (let i = 0; i < 30; i++) expect(await attempt(email, BAD, `203.0.113.${i + 1}`)).toBe("INVALID_CREDENTIALS");
    expect(await attempt(email, GOOD, "203.0.113.200")).toBe("RATE_LIMITED");
  });

  it("applies only the account-wide limit when the client address is not trusted", async () => {
    const { email } = await account();
    for (let i = 0; i < 8; i++) expect(await attempt(email, BAD)).toBe("INVALID_CREDENTIALS");
    expect(await attempt(email, GOOD)).toBe("OK");
  });

  it("rejects oversized input without counting or looking it up", async () => {
    const before = (await owner.db.select().from(rateLimitBuckets)).length;
    expect(await attempt(`${"a".repeat(250)}@x.co`, GOOD)).toBe("INVALID_CREDENTIALS");
    expect(await attempt("someone@limit.local", "p".repeat(129))).toBe("INVALID_CREDENTIALS");
    expect((await owner.db.select().from(rateLimitBuckets)).length).toBe(before);
  });
});

describe("password change limits", () => {
  beforeAll(truncateAll);

  it("blocks guessing the current password with a live session", async () => {
    const email = `${randomUUID()}@limit.local`;
    const id = await makeUser({ email });
    const { token } = await login(app.db, email, GOOD);
    const ctx = contextFor((await validateSession(app.db, token))!);
    const change = (current: string) =>
      changeOwnPassword(app.db, ctx, token, current, "BrandNewPass#1").then(() => "OK", (e: unknown) => code(e));

    expect(await change("x".repeat(129))).toBe("VALIDATION");
    for (let i = 0; i < 8; i++) expect(await change(BAD)).toBe("VALIDATION");
    expect(await change(GOOD)).toBe("RATE_LIMITED");

    // The password is unchanged and the failed attempts did not sign the user out.
    expect(await validateSession(app.db, token)).not.toBeNull();
    const [u] = await owner.db.select({ mustChange: users.mustChangePassword }).from(users).where(eq(users.id, id));
    expect(u).toBeTruthy();
    expect(await attempt(email, GOOD)).toBe("OK");
  });
});
