import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { jobs, workerHeartbeats } from "@examio/db";
import { PermanentJobError } from "../src/jobs/queue";
import { createLogger } from "../src/logger";
import { localDiskStorage } from "../src/files/storage";
import { sandboxEmailAdapter } from "../src/notifications/email";
import type { Alert, AlertSink } from "../src/ops/alerts";
import { evaluateHealth, workerStaleSeconds } from "../src/ops/health";
import { createJobHandlers, raiseAlert, runWorkerTick, type WorkerDeps } from "../src/worker";
import { app, owner, truncateAll } from "./helpers";

/** Scheduled worker runs (free hosting): one tick does the work, alerts are sent once per hour. */
describe("worker tick and alerts", () => {
  const sent: Alert[] = [];
  const sink: AlertSink = { name: "memory", send: async (a) => void sent.push(a) };
  const deps: WorkerDeps = {
    db: app.db,
    email: sandboxEmailAdapter(),
    log: createLogger({}, { write: () => {} }),
    storage: localDiskStorage(path.join(os.tmpdir(), "examio-tick-test")),
    scanner: null,
    alerts: sink,
  };
  const tick = (extra: Partial<Parameters<typeof runWorkerTick>[1]> = {}) =>
    runWorkerTick(deps, { workerId: "tick-test", handlers: createJobHandlers(deps), budgetMs: 10_000, checkHealth: false, ...extra });

  beforeAll(truncateAll);
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("reports a heartbeat, schedules housekeeping once per hour and runs it", async () => {
    const r1 = await tick();
    const r2 = await tick();
    expect(r1.succeeded).toBe(1); // maintenance.purge
    expect(r2.claimed).toBe(0); // same hour: not scheduled again
    expect(await owner.db.select().from(jobs).where(eq(jobs.kind, "maintenance.purge"))).toHaveLength(1);
    expect(await owner.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "tick-test"))).toHaveLength(1);
  });

  it("delivers each alert condition at most once per hour, across separate runs", async () => {
    const now = new Date("2026-11-14T10:15:00Z");
    await raiseAlert(app.db, { key: "health:queue", severity: "warning", summary: "Queue slow" }, now);
    await raiseAlert(app.db, { key: "health:queue", severity: "warning", summary: "Queue slow" }, new Date("2026-11-14T10:45:00Z"));
    await raiseAlert(app.db, { key: "health:queue", severity: "warning", summary: "Queue slow" }, new Date("2026-11-14T11:05:00Z"));
    await tick();
    expect(sent.map((a) => a.key)).toEqual(["health:queue", "health:queue"]);
    expect(sent[0]).toMatchObject({ severity: "warning", summary: "Queue slow" });
  });

  it("alerts when a job is dead-lettered, and the health check raises alerts", async () => {
    sent.length = 0;
    await owner.db.execute(sql`delete from jobs where kind = 'alert.send'`);
    const failing = { ...createJobHandlers(deps), "test.fail": async () => { throw new PermanentJobError("broken"); } };
    await owner.db.insert(jobs).values({ kind: "test.fail", payload: {} });
    await tick({ handlers: failing, checkHealth: true, skipWorkerCheck: true });
    await tick({ handlers: failing });
    expect(sent.map((a) => a.key)).toContain("dead:test.fail");
    expect(sent.map((a) => a.key)).toContain("health:dead_jobs");
    expect(sent.map((a) => a.key)).not.toContain("health:worker");
  });

  it("lets a scheduled deployment widen the stalled-worker threshold", () => {
    expect(workerStaleSeconds({})).toBe(300);
    expect(workerStaleSeconds({ WORKER_STALE_SECONDS: "1800" })).toBe(1800);
    expect(workerStaleSeconds({ WORKER_STALE_SECONDS: "5" })).toBe(300);
    const now = Date.now();
    const row = { queued: 0, dead: 0, oldest_due_seconds: 0, last_worker_seen: new Date(now - 700_000), quarantined: 0, oldest_quarantine_seconds: 0 };
    expect(evaluateHealth(row, now).checks[0]!.status).toBe("critical");
    expect(evaluateHealth(row, now, 1800).checks[0]!.status).toBe("ok");
  });
});
