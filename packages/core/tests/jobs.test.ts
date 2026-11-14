import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditEvents, jobs, withContext, withWorkerContext, type RequestContext } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { getJobStats, listJobs, retryDeadJob } from "../src/jobs/admin";
import { PermanentJobError, enqueueJob, retryDelaySeconds, runWorkerOnce, workerHeartbeat, type ClaimedJob } from "../src/jobs/queue";
import { createLogger } from "../src/logger";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 2, task 02.4: durable job processing with retries, dead letters and lease recovery. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const quiet = createLogger({}, { write: () => {} });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
const jobRow = async (id: string) => (await owner.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
/** Makes a queued job due now (retries are scheduled in the future). */
const makeDue = (id: string) => owner.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));

describe("background jobs", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("jba");
    B = await makeSchool("jbb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
  });
  beforeEach(async () => {
    await owner.db.execute(sql`truncate jobs`);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const enqueue = (ctx: RequestContext, kind = "test.echo", extra: Partial<Parameters<typeof enqueueJob>[1]> = {}) =>
    withContext(app.db, ctx, (tx) => enqueueJob(tx, { kind, payload: { n: 1 }, schoolId: ctx.schoolId, ...extra }));
  const run = (handlers: Record<string, (j: ClaimedJob) => Promise<void>>, extra: Partial<Parameters<typeof runWorkerOnce>[1]> = {}) =>
    runWorkerOnce(app.db, { workerId: "test-worker", handlers, log: quiet, ...extra });

  it("a job exists only if the business transaction commits", async () => {
    const rolledBack = await failure(
      withContext(app.db, A.ctx(A.adminId), async (tx) => {
        await enqueueJob(tx, { kind: "test.echo", payload: {}, schoolId: A.id });
        throw new Error("business change failed");
      }),
    );
    expect(rolledBack).toBeInstanceOf(Error);
    expect(await owner.db.select().from(jobs)).toHaveLength(0);
    await enqueue(A.ctx(A.adminId));
    expect(await owner.db.select().from(jobs)).toHaveLength(1);
  });

  it("the same dedupe key returns the existing job", async () => {
    const first = await enqueue(A.ctx(A.adminId), "test.echo", { dedupeKey: "once" });
    const again = await enqueue(A.ctx(A.adminId), "test.echo", { dedupeKey: "once" });
    expect(again).toBe(first);
    expect(await owner.db.select().from(jobs)).toHaveLength(1);
    expect(await enqueue(A.ctx(A.adminId), "test.other", { dedupeKey: "once" })).not.toBe(first);
  });

  it("runs a job once and records success", async () => {
    const id = await enqueue(A.ctx(A.adminId));
    const seen: ClaimedJob[] = [];
    const result = await run({ "test.echo": async (j) => void seen.push(j) });
    expect(result).toEqual({ claimed: 1, succeeded: 1, retried: 0, dead: 0 });
    expect(seen[0]).toMatchObject({ id, kind: "test.echo", payload: { n: 1 }, schoolId: A.id, attempts: 1 });
    expect(await jobRow(id)).toMatchObject({ status: "succeeded", lockedBy: null });
    expect((await run({ "test.echo": async () => {} })).claimed).toBe(0);
  });

  it("a failing job is retried later with backoff, then dead-lettered", async () => {
    const id = await enqueue(A.ctx(A.adminId), "test.flaky", { maxAttempts: 3 });
    const dead: string[] = [];
    const flaky = { "test.flaky": async () => { throw new Error("provider timeout postgres://u:secretpw@db/x"); } };

    expect(await run(flaky, { onDead: (j) => void dead.push(j.id) })).toMatchObject({ retried: 1, dead: 0 });
    let row = await jobRow(id);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(row.lastError).toContain("provider timeout");
    expect(row.lastError).not.toContain("secretpw");
    // Not due yet: nothing to claim.
    expect((await run(flaky)).claimed).toBe(0);

    await makeDue(id);
    expect(await run(flaky, { onDead: (j) => void dead.push(j.id) })).toMatchObject({ retried: 1 });
    await makeDue(id);
    expect(await run(flaky, { onDead: (j) => void dead.push(j.id) })).toMatchObject({ dead: 1 });
    row = await jobRow(id);
    expect(row).toMatchObject({ status: "dead", attempts: 3 });
    expect(row.finishedAt).not.toBeNull();
    expect(dead).toEqual([id]);
  });

  it("a permanent failure goes straight to dead; an unknown kind is never claimed", async () => {
    const id = await enqueue(A.ctx(A.adminId), "test.bad");
    expect(await run({ "test.bad": async () => { throw new PermanentJobError("payload invalid"); } })).toMatchObject({ dead: 1 });
    expect(await jobRow(id)).toMatchObject({ status: "dead", attempts: 1, lastError: "PermanentJobError: payload invalid" });

    const orphan = await enqueue(A.ctx(A.adminId), "test.nobody");
    expect((await run({ "test.echo": async () => {} })).claimed).toBe(0);
    expect(await jobRow(orphan)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("a job held by a worker that died is claimed again after its lease", async () => {
    const id = await enqueue(A.ctx(A.adminId), "test.echo", { maxAttempts: 2 });
    const stuck = await withWorkerContext(app.db, null, (tx) => tx.execute(sql`select * from job_claim('dead-worker', array['test.echo'], 5, 60)`));
    expect(stuck).toHaveLength(1);
    // Lease still valid: nobody else can take it.
    expect((await run({ "test.echo": async () => {} })).claimed).toBe(0);

    await owner.db.update(jobs).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    expect(await run({ "test.echo": async () => {} })).toMatchObject({ claimed: 1, succeeded: 1 });
    // The dead worker cannot complete a job it no longer holds.
    const late = await withWorkerContext(app.db, null, (tx) => tx.execute(sql`select job_complete(${id}::uuid, 'dead-worker') as ok`));
    expect((late as unknown as { ok: boolean }[])[0]?.ok).toBe(false);
  });

  it("a lease that expires during the final attempt dead-letters the job", async () => {
    const id = await enqueue(A.ctx(A.adminId), "test.echo", { maxAttempts: 1 });
    await withWorkerContext(app.db, null, (tx) => tx.execute(sql`select * from job_claim('dead-worker', array['test.echo'], 5, 60)`));
    await owner.db.update(jobs).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    expect((await run({ "test.echo": async () => {} })).claimed).toBe(0);
    expect(await jobRow(id)).toMatchObject({ status: "dead" });
  });

  it("concurrent workers never run the same job twice", async () => {
    for (let i = 0; i < 20; i++) await enqueue(A.ctx(A.adminId), "test.count");
    const runs = new Map<string, number>();
    const handler = { "test.count": async (j: ClaimedJob) => void runs.set(j.id, (runs.get(j.id) ?? 0) + 1) };
    const results = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((w) => runWorkerOnce(app.db, { workerId: w, handlers: handler, maxJobs: 10, log: quiet })),
    );
    expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(20);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect(runs.size).toBe(20);
  });

  it("enqueueing for a school requires belonging to it; claiming requires the worker", async () => {
    const foreign = await failure(withContext(app.db, A.ctx(A.adminId), (tx) => enqueueJob(tx, { kind: "test.echo", payload: {}, schoolId: B.id })));
    expect(isRlsViolation(foreign)).toBe(true);
    const outsider = await failure(withContext(app.db, { userId: null, schoolId: null, isPlatformAdmin: false }, (tx) => enqueueJob(tx, { kind: "test.echo", payload: {}, schoolId: A.id })));
    expect(isRlsViolation(outsider)).toBe(true);
    await withContext(app.db, platform, (tx) => enqueueJob(tx, { kind: "test.echo", payload: {}, schoolId: B.id }));

    for (const ctx of [A.ctx(A.adminId), platform]) {
      const claim = await failure(withContext(app.db, ctx, (tx) => tx.execute(sql`select * from job_claim('web', array['test.echo'], 5, 60)`)));
      expect(isRlsViolation(claim)).toBe(true);
    }
    const read = await failure(withContext(app.db, platform, (tx) => tx.select().from(jobs)));
    expect(isRlsViolation(read)).toBe(true);
  });

  it("rejects oversized payloads and malformed kinds", async () => {
    expect(await failure(enqueue(A.ctx(A.adminId), "test.echo", { payload: { blob: "x".repeat(9000) } }))).not.toBeNull();
    expect(await failure(enqueue(A.ctx(A.adminId), "Bad Kind!"))).not.toBeNull();
    expect(await owner.db.select().from(jobs)).toHaveLength(0);
  });

  it("platform admins see counts and dead letters and can retry them; nobody else can", async () => {
    const id = await enqueue(A.ctx(A.adminId), "test.bad");
    await run({ "test.bad": async () => { throw new PermanentJobError("broken"); } });
    await enqueue(A.ctx(A.adminId), "test.later", { runAt: new Date(Date.now() - 60_000) });
    await workerHeartbeat(app.db, "test-worker");

    const stats = await getJobStats(app.db, platform);
    expect(stats).toMatchObject({ queued: 1, running: 0, dead: 1 });
    expect(stats.oldestDueSeconds).toBeGreaterThanOrEqual(59);
    expect(stats.lastWorkerSeen).not.toBeNull();

    const dead = await listJobs(app.db, platform, "dead");
    expect(dead.map((j) => [j.id, j.kind, j.lastError])).toEqual([[id, "test.bad", "PermanentJobError: broken"]]);
    expect(dead[0]).not.toHaveProperty("payload");

    for (const ctx of [A.ctx(A.adminId), { userId: A.adminId, schoolId: null, isPlatformAdmin: true }]) {
      expect(code(await failure(getJobStats(app.db, ctx)))).toBe("FORBIDDEN");
      expect(code(await failure(retryDeadJob(app.db, ctx, id)))).toBe("FORBIDDEN");
    }

    await retryDeadJob(app.db, platform, id);
    expect(await jobRow(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(code(await failure(retryDeadJob(app.db, platform, id)))).toBe("NOT_FOUND");
    const audit = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit.map((e) => [e.action, e.actorUserId])).toEqual([["job.retried", platform.userId]]);
    expect(await run({ "test.bad": async () => {} })).toMatchObject({ succeeded: 1 });
    expect(code(await failure(retryDeadJob(app.db, platform, randomUUID())))).toBe("NOT_FOUND");
  });

  it("backoff grows, is capped and is spread by jitter", () => {
    expect(retryDelaySeconds(1, () => 0.5)).toBe(30);
    expect(retryDelaySeconds(2, () => 0.5)).toBe(60);
    expect(retryDelaySeconds(5, () => 0.5)).toBe(480);
    expect(retryDelaySeconds(20, () => 0.5)).toBe(3600);
    expect(retryDelaySeconds(1, () => 0)).toBe(15);
    expect(retryDelaySeconds(1, () => 0.999)).toBe(45);
  });
});
