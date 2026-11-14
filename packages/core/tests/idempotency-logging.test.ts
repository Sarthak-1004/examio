import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { idempotencyRecords, withContext, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { requestFingerprint, withIdempotency } from "../src/idempotency";
import { createLogger, redact, redactText } from "../src/logger";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 2: retried operations run once (02.4); logs never carry secrets (02.5). */
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

describe("idempotent operations", () => {
  let S: Awaited<ReturnType<typeof makeSchool>>;
  beforeAll(async () => {
    await truncateAll();
    S = await makeSchool("idm");
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const call = (ctx: RequestContext, key: string, request: unknown, effect: () => void) =>
    withContext(app.db, ctx, (tx) =>
      withIdempotency(tx, ctx, { operation: "test.create", key, request }, async () => {
        effect();
        return { createdId: "r-1" };
      }),
    );

  it("runs once per key and replays the first result", async () => {
    let runs = 0;
    const first = await call(S.ctx(S.adminId), "key-0001-abcd", { a: 1, b: 2 }, () => runs++);
    const again = await call(S.ctx(S.adminId), "key-0001-abcd", { b: 2, a: 1 }, () => runs++);
    expect(first).toEqual({ result: { createdId: "r-1" }, replayed: false });
    expect(again).toEqual({ result: { createdId: "r-1" }, replayed: true });
    expect(runs).toBe(1);
  });

  it("refuses a reused key with a different request, and malformed keys", async () => {
    await call(S.ctx(S.adminId), "key-0002-abcd", { a: 1 }, () => {});
    expect(code(await call(S.ctx(S.adminId), "key-0002-abcd", { a: 2 }, () => {}).catch((e) => e))).toBe("CONFLICT");
    for (const bad of ["short", "has spaces in it", "x".repeat(129)]) {
      expect(code(await call(S.ctx(S.adminId), bad, {}, () => {}).catch((e) => e))).toBe("VALIDATION");
    }
  });

  it("concurrent duplicates run once", async () => {
    let runs = 0;
    const results = await Promise.all([1, 2, 3, 4].map(() => call(S.ctx(S.adminId), "key-0003-race", { x: 1 }, () => runs++)));
    expect(runs).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("keys are private to the user and nothing is stored when the operation fails", async () => {
    let runs = 0;
    await call(S.ctx(S.teacherId), "key-0001-abcd", { a: 1, b: 2 }, () => runs++);
    expect(runs).toBe(1); // another user's identical key is a separate record

    const failed = await withContext(app.db, S.ctx(S.adminId), (tx) =>
      withIdempotency(tx, S.ctx(S.adminId), { operation: "test.create", key: "key-0004-fail", request: {} }, async () => {
        throw new Error("boom");
      }),
    ).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(await owner.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, "key-0004-fail"))).toHaveLength(0);
    const visible = await withContext(app.db, S.ctx(S.teacherId), (tx) => tx.select().from(idempotencyRecords));
    expect(visible.every((r) => r.actorUserId === S.teacherId)).toBe(true);
  });

  it("fingerprints ignore key order and undefined values", () => {
    expect(requestFingerprint({ a: 1, b: { c: [1, 2], d: undefined } })).toBe(requestFingerprint({ b: { c: [1, 2] }, a: 1 }));
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: "1" }));
  });
});

describe("redacting logger", () => {
  it("removes sensitive fields and masks credentials in text", () => {
    const out = redact({
      password: "hunter2",
      sessionToken: "abc",
      userEmail: "a@b.c",
      nested: { mfaCode: "123456", ok: "visible" },
      message: "connect postgres://app:sup3rsecret@db.internal:5432/examio failed; Authorization: Bearer abc.def.ghi",
      list: ["ABCD-EFGH-2345-6789", "f".repeat(64)],
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.sessionToken).toBe("[redacted]");
    expect(out.userEmail).toBe("[redacted]");
    expect(out.nested).toEqual({ mfaCode: "[redacted]", ok: "visible" });
    expect(out.message).not.toContain("sup3rsecret");
    expect(out.message).toContain("postgres://app:[redacted]@db.internal");
    expect(out.message).toContain("Bearer [redacted]");
    expect(out.list).toEqual(["[redacted-code]", "[redacted-hex]"]);
  });

  it("writes one JSON line per event and respects the level", () => {
    const lines: string[] = [];
    const log = createLogger({ component: "test" }, { level: "info", write: (_l, line) => lines.push(line) });
    log.debug("ignored");
    log.child({ jobId: "j1" }).error("job.failed", { error: new Error("token=" + "z".repeat(50)) });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "error", event: "job.failed", component: "test", jobId: "j1" });
    expect(lines[0]).not.toContain("z".repeat(50));
    expect(redactText("x".repeat(3000)).length).toBeLessThan(2100);
  });
});
