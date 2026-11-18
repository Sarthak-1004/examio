import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import { alertSinkFromEnv, webhookAlertSink } from "../src/ops/alerts";
import { validateRuntimeConfig } from "../src/ops/config";
import { evaluateHealth, getSystemHealth, healthAlerts } from "../src/ops/health";
import { listPlatformAuditEvents, listSchoolAuditEvents } from "../src/services/audit-log";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 2, task 02.5: configuration validation, alerts, health and the audit log viewer. */
const KEY = Buffer.alloc(32, 3).toString("base64");
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

describe("runtime configuration", () => {
  const base = { DATABASE_URL: "postgres://a:b@localhost/x" };

  it("accepts a plain development setup and warns about the missing scanner", () => {
    const r = validateRuntimeConfig(base);
    expect(r).toMatchObject({ env: "development", errors: [] });
    expect(r.warnings.join(" ")).toMatch(/No FILE_SCANNER/);
  });

  it("reports every invalid value", () => {
    const r = validateRuntimeConfig({ EXAMIO_ENV: "prod", TRUSTED_PROXY_HOPS: "x", DATABASE_POOL_MAX: "0", EMAIL_PROVIDER: "smtp", ALERT_SINK: "pager", FILE_SCANNER: "magic" });
    const all = r.errors.join(" | ");
    for (const fragment of ["EXAMIO_ENV", "DATABASE_URL", "TRUSTED_PROXY_HOPS", "DATABASE_POOL_MAX", "EMAIL_PROVIDER", "ALERT_SINK", "FILE_SCANNER"]) {
      expect(all).toContain(fragment);
    }
  });

  it("warns when a production build runs without EXAMIO_ENV", () => {
    const r = validateRuntimeConfig({ ...base, NODE_ENV: "production", MFA_ENCRYPTION_KEY: KEY });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/EXAMIO_ENV is not set/);
  });

  it("holds staging and production to production rules", () => {
    const loose = validateRuntimeConfig({ ...base, EXAMIO_ENV: "production", DATABASE_OWNER_URL: "postgres://o:p@h/x", FILE_SCANNER: "dev-allow" });
    const all = loose.errors.join(" | ");
    for (const fragment of ["DATABASE_OWNER_URL", "MFA_ENCRYPTION_KEY", "TRUSTED_PROXY_HOPS", "dev-allow", "ALERT_SINK"]) expect(all).toContain(fragment);

    const good = validateRuntimeConfig({
      ...base,
      EXAMIO_ENV: "staging",
      MFA_ENCRYPTION_KEY: KEY,
      TRUSTED_PROXY_HOPS: "1",
      FILE_SCANNER: "clamav",
      ALERT_SINK: "webhook",
      ALERT_WEBHOOK_URL: "https://hooks.example.test/abc",
    });
    expect(good.errors).toEqual([]);
    expect(good.warnings.join(" ")).toMatch(/sandbox/);
  });
});

describe("alerts", () => {
  it("posts redacted text to the webhook and reports delivery failures", async () => {
    const received: string[] = [];
    let status = 200;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d));
      req.on("end", () => {
        received.push(body);
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      const sink = alertSinkFromEnv({ ALERT_SINK: "webhook", ALERT_WEBHOOK_URL: url, EXAMIO_ENV: "staging" });
      await sink.send({ key: "k", severity: "critical", summary: "Database down", detail: "postgres://app:hunter2@db/x refused" });
      const payload = JSON.parse(received[0]!) as { text: string };
      expect(payload.text).toContain("[staging] CRITICAL: Database down");
      expect(payload.text).not.toContain("hunter2");

      status = 500;
      await expect(webhookAlertSink(url, "staging").send({ key: "k", severity: "warning", summary: "x" })).rejects.toThrow(/500/);
    } finally {
      server.close();
    }
    expect(() => alertSinkFromEnv({ ALERT_SINK: "webhook" })).toThrow(/ALERT_WEBHOOK_URL/);
    expect(() => alertSinkFromEnv({ ALERT_SINK: "webhook", ALERT_WEBHOOK_URL: "http://hooks.example.test/x" })).toThrow(/https/);
  });
});

describe("health", () => {
  it("rates each check against its threshold", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    const healthy = evaluateHealth({ queued: 2, dead: 0, oldest_due_seconds: 5, last_worker_seen: new Date(now - 20_000), quarantined: 0, oldest_quarantine_seconds: 0 }, now);
    expect(healthy.status).toBe("ok");
    expect(healthAlerts(healthy)).toEqual([]);

    const bad = evaluateHealth({ queued: 40, dead: 3, oldest_due_seconds: 2000, last_worker_seen: new Date(now - 600_000), quarantined: 2, oldest_quarantine_seconds: 3600, exams_in_progress: 9, exams_overdue: 4, oldest_exam_overdue_seconds: 400 }, now);
    expect(Object.fromEntries(bad.checks.map((c) => [c.key, c.status]))).toEqual({ worker: "critical", queue: "critical", dead_jobs: "warning", quarantine: "warning", exam_deadlines: "warning" });
    expect(bad.status).toBe("critical");
    expect(healthAlerts(bad).map((a) => a.key)).toEqual(["health:worker", "health:queue", "health:dead_jobs", "health:quarantine", "health:exam_deadlines"]);

    expect(evaluateHealth(undefined, now).checks.find((c) => c.key === "worker")?.status).toBe("critical");
  });
});

describe("audit log viewer and platform health", () => {
  let A: Awaited<ReturnType<typeof makeSchool>>;
  let B: Awaited<ReturnType<typeof makeSchool>>;
  let platform: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("ada");
    B = await makeSchool("adb");
    platform = { userId: await makeUser({ isPlatformAdmin: true, fullName: "Root" }), schoolId: null, isPlatformAdmin: true };
    await owner.db.insert(auditEvents).values([
      { schoolId: A.id, actorUserId: A.adminId, action: "member.added", createdAt: new Date("2026-11-01T08:00:00Z") },
      { schoolId: A.id, actorUserId: A.teacherId, action: "attendance.saved", createdAt: new Date("2026-11-05T08:00:00Z") },
      { schoolId: B.id, actorUserId: B.adminId, action: "member.added", createdAt: new Date("2026-11-02T08:00:00Z") },
      { schoolId: null, actorUserId: platform.userId, action: "school.created", createdAt: new Date("2026-11-03T08:00:00Z") },
      { schoolId: null, actorUserId: A.studentId, action: "auth.login", createdAt: new Date("2026-11-04T08:00:00Z") },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  const all = { page: 1, pageSize: 25, search: "" };

  it("a school admin reads their school's events only, newest first, with filters", async () => {
    const page = await listSchoolAuditEvents(app.db, A.ctx(A.adminId), A.id, all);
    expect(page.rows.map((r) => r.action)).toEqual(["attendance.saved", "member.added"]);
    expect(page.rows[1]!.actorName).toBe("ada admin");

    expect((await listSchoolAuditEvents(app.db, A.ctx(A.adminId), A.id, { ...all, search: "attend" })).rows).toHaveLength(1);
    expect((await listSchoolAuditEvents(app.db, A.ctx(A.adminId), A.id, { ...all, from: "2026-11-02", to: "2026-11-04" })).total).toBe(0);
    expect((await listSchoolAuditEvents(app.db, A.ctx(A.adminId), A.id, { ...all, from: "2026-11-05", to: "2026-11-05" })).total).toBe(1);
    expect((await listSchoolAuditEvents(app.db, A.ctx(A.adminId), A.id, { ...all, from: "not-a-date" })).total).toBe(2);
  });

  it("teachers, other schools and platform admins cannot read a school's log", async () => {
    expect(code(await listSchoolAuditEvents(app.db, A.ctx(A.teacherId), A.id, all).catch((e) => e))).toBe("FORBIDDEN");
    expect(code(await listSchoolAuditEvents(app.db, B.ctx(B.adminId), A.id, all).catch((e) => e))).toBe("NOT_FOUND");
    expect(code(await listSchoolAuditEvents(app.db, platform, A.id, all).catch((e) => e))).toBe("FORBIDDEN");
  });

  it("platform admins read platform-level events of accounts they may see", async () => {
    const actions = (await listPlatformAuditEvents(app.db, platform, all)).rows.map((r) => r.action);
    expect(actions).toContain("school.created");
    expect(actions).not.toContain("auth.login"); // a student's sign-in is school business
    expect(actions).not.toContain("member.added");
    expect(code(await listPlatformAuditEvents(app.db, A.ctx(A.adminId), all).catch((e) => e))).toBe("FORBIDDEN");
  });

  it("platform health is readable by platform admins only", async () => {
    const health = await getSystemHealth(app.db, platform);
    expect(health.checks.map((c) => c.key)).toEqual(["worker", "queue", "dead_jobs", "quarantine", "exam_deadlines"]);
    expect(code(await getSystemHealth(app.db, A.ctx(A.adminId)).catch((e) => e))).toBe("FORBIDDEN");
    const forged = { userId: A.adminId, schoolId: null, isPlatformAdmin: true };
    expect(code(await getSystemHealth(app.db, forged).catch((e) => e))).toBe("FORBIDDEN");
  });
});

describe("demo environment", () => {
  const base = { DATABASE_URL: "postgres://a:b@host/x", MFA_ENCRYPTION_KEY: KEY, TRUSTED_PROXY_HOPS: "1" };

  it("accepts a free-hosting demo without a scanner and warns about its limits", () => {
    const r = validateRuntimeConfig({ ...base, EXAMIO_ENV: "demo", CRON_SECRET: "s".repeat(40) });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/uploads stay quarantined/);
    expect(r.warnings.join(" ")).toMatch(/ALERT_SINK is log/);
  });

  it("still refuses an owner connection, a missing key or proxy setting, unscanned files and a weak cron secret", () => {
    const r = validateRuntimeConfig({ DATABASE_URL: "postgres://a:b@host/x", EXAMIO_ENV: "demo", DATABASE_OWNER_URL: "postgres://o:p@h/x", FILE_SCANNER: "dev-allow", CRON_SECRET: "short" });
    const all = r.errors.join(" | ");
    for (const fragment of ["DATABASE_OWNER_URL", "MFA_ENCRYPTION_KEY", "TRUSTED_PROXY_HOPS", "dev-allow", "CRON_SECRET"]) expect(all).toContain(fragment);
    expect(validateRuntimeConfig({ ...base, EXAMIO_ENV: "demo" }).warnings.join(" ")).toMatch(/CRON_SECRET is not set/);
  });
});
