import { sql } from "drizzle-orm";
import { withContext, withWorkerContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { requirePlatformAdmin } from "../authz";
import { isRlsViolation } from "../db-errors";
import { AppError } from "../errors";
import type { Alert } from "./alerts";

/**
 * Operational health. Thresholds (provisional, see OPERATIONS.md):
 * - worker not seen for 5 minutes: critical;
 * - a due job waiting 10 minutes: warning (30 minutes: critical);
 * - any dead-lettered job: warning;
 * - a file in quarantine for 30 minutes: warning (scanner missing or down).
 */
export type CheckStatus = "ok" | "warning" | "critical";

export interface HealthCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface SystemHealth {
  status: CheckStatus;
  checks: HealthCheck[];
  checkedAt: Date;
}

interface Row extends Record<string, unknown> {
  queued: string | number;
  dead: string | number;
  oldest_due_seconds: number;
  last_worker_seen: string | Date | null;
  quarantined: string | number;
  oldest_quarantine_seconds: number;
}

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus => (a === "critical" || b === "critical" ? "critical" : a === "warning" || b === "warning" ? "warning" : "ok");
const minutes = (s: number) => `${Math.round(s / 60)} min`;

async function read(tx: Tx): Promise<Row | undefined> {
  const rows = (await tx.execute<Row>(sql`select j.queued, j.dead, j.oldest_due_seconds, j.last_worker_seen, f.quarantined, f.oldest_quarantine_seconds
    from job_stats() j cross join file_stats() f`)) as unknown as Row[];
  return rows[0];
}

export function evaluateHealth(row: Row | undefined, now = Date.now()): SystemHealth {
  const checks: HealthCheck[] = [];
  const seen = row?.last_worker_seen ? new Date(row.last_worker_seen).getTime() : null;
  const silentFor = seen === null ? null : Math.max(0, Math.round((now - seen) / 1000));
  checks.push({
    key: "worker",
    label: "Background worker",
    status: silentFor === null || silentFor > 300 ? "critical" : "ok",
    detail: silentFor === null ? "Has never reported in. Start it with pnpm worker." : silentFor > 300 ? `Last seen ${minutes(silentFor)} ago.` : "Running.",
  });
  const due = Number(row?.oldest_due_seconds ?? 0);
  checks.push({
    key: "queue",
    label: "Job queue",
    status: due > 1800 ? "critical" : due > 600 ? "warning" : "ok",
    detail: `${Number(row?.queued ?? 0)} waiting; oldest due job has waited ${minutes(due)}.`,
  });
  const dead = Number(row?.dead ?? 0);
  checks.push({ key: "dead_jobs", label: "Failed jobs", status: dead > 0 ? "warning" : "ok", detail: dead > 0 ? `${dead} job(s) need attention.` : "None." });
  const quarantine = Number(row?.oldest_quarantine_seconds ?? 0);
  checks.push({
    key: "quarantine",
    label: "File scanning",
    status: quarantine > 1800 ? "warning" : "ok",
    detail: `${Number(row?.quarantined ?? 0)} file(s) waiting; oldest for ${minutes(quarantine)}.`,
  });
  return { status: checks.reduce<CheckStatus>((s, c) => worst(s, c.status), "ok"), checks, checkedAt: new Date(now) };
}

export async function getSystemHealth(db: Db, ctx: RequestContext): Promise<SystemHealth> {
  requirePlatformAdmin(ctx);
  try {
    return evaluateHealth(await withContext(db, ctx, read));
  } catch (e) {
    if (isRlsViolation(e)) throw new AppError("FORBIDDEN", "Only platform administrators can do this.");
    throw e;
  }
}

export async function getSystemHealthAsWorker(db: Db): Promise<SystemHealth> {
  return evaluateHealth(await withWorkerContext(db, null, read));
}

/** Alerts for every check that is not ok. */
export function healthAlerts(health: SystemHealth): Alert[] {
  return health.checks
    .filter((c) => c.status !== "ok")
    .map((c) => ({ key: `health:${c.key}`, severity: c.status === "critical" ? "critical" : "warning", summary: `${c.label}: ${c.detail}` }));
}

/**
 * Public liveness check: can this server reach its database? Reveals nothing else.
 */
export async function databaseReachable(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
