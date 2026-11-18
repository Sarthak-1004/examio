import { sql } from "drizzle-orm";
import { withWorkerContext, type Db } from "@examio/db";
import { enqueueJob, runWorkerOnce, workerHeartbeat, type JobHandlers, type WorkerRunResult } from "./jobs/queue";
import type { Logger } from "./logger";
import { fileScanHandler, purgeFiles } from "./files/files";
import type { FileScanner } from "./files/scanner";
import type { FileStorage } from "./files/storage";
import type { EmailAdapter } from "./notifications/email";
import { notificationDeliveryHandler } from "./notifications/notifications";
import type { Alert, AlertSink } from "./ops/alerts";
import { getSystemHealthAsWorker, healthAlerts, workerStaleSeconds } from "./ops/health";
import { finalizeDueExamAttempts } from "./services/exams/taking";

/**
 * Every job kind the worker knows, wired to its dependencies. Adding a job kind means adding
 * its handler here; the worker only claims kinds it has a handler for.
 */
export interface WorkerDeps {
  db: Db;
  email: EmailAdapter;
  log: Logger;
  storage: FileStorage;
  /** Null when no scanner is configured: uploads then stay quarantined. */
  scanner: FileScanner | null;
  /** Where `alert.send` jobs deliver. Without it alerts are only logged. */
  alerts?: AlertSink;
  /** Extra handlers contributed by other modules. */
  extra?: JobHandlers;
}

export function createJobHandlers(deps: WorkerDeps): JobHandlers {
  return {
    "notification.deliver": notificationDeliveryHandler(deps.db, deps.email),
    // Without a scanner the worker does not claim scan jobs, so uploads stay quarantined.
    ...(deps.scanner ? { "file.scan": fileScanHandler(deps.db, deps.storage, deps.scanner) } : {}),
    /** Housekeeping: finished jobs, expired auth records, idempotency records, rate-limit counters, file bytes. */
    "maintenance.purge": async () => {
      await withWorkerContext(deps.db, null, async (tx) => {
        await tx.execute(sql`select job_purge_finished()`);
        await tx.execute(sql`select auth_purge_expired()`);
      });
      await purgeFiles(deps.db, deps.storage);
    },
    "alert.send": async (job) => {
      const p = job.payload;
      const alert: Alert = {
        key: String(p.key ?? "unknown"),
        severity: p.severity === "critical" ? "critical" : "warning",
        summary: String(p.summary ?? ""),
        detail: typeof p.detail === "string" ? p.detail : undefined,
      };
      if (deps.alerts) await deps.alerts.send(alert);
      else deps.log.error("alert", { alertKey: alert.key, severity: alert.severity, summary: alert.summary, detail: alert.detail });
    },
    ...deps.extra,
  };
}

/**
 * Queues an alert for delivery by the worker. Each condition is sent at most once per hour,
 * across every worker process and scheduled run, because the hourly dedupe key makes repeats
 * no-ops. Delivery failures are retried like any other job.
 */
export async function raiseAlert(db: Db, alert: Alert, now = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  await withWorkerContext(db, null, (tx) =>
    enqueueJob(tx, {
      kind: "alert.send",
      payload: { key: alert.key, severity: alert.severity, summary: alert.summary.slice(0, 500), ...(alert.detail ? { detail: alert.detail.slice(0, 2000) } : {}) },
      dedupeKey: `alert:${alert.key}:${hour}`,
      maxAttempts: 5,
    }),
  );
}

/**
 * One round of background work, used by both the long-running worker and the scheduled
 * endpoint on hosting without an always-on process:
 * heartbeat → hourly housekeeping job → finalise overdue exam attempts → run due jobs until none are left or the time budget is
 * spent → health check (alerts for anything not OK, except the worker check when `skipWorkerCheck`).
 */
export async function runWorkerTick(
  deps: WorkerDeps,
  opts: { workerId: string; handlers: JobHandlers; budgetMs: number; checkHealth: boolean; skipWorkerCheck?: boolean },
): Promise<WorkerRunResult> {
  const { db, log } = deps;
  const started = Date.now();
  await workerHeartbeat(db, opts.workerId);
  const hour = new Date().toISOString().slice(0, 13);
  await withWorkerContext(db, null, (tx) => enqueueJob(tx, { kind: "maintenance.purge", payload: {}, dedupeKey: `purge:${hour}`, maxAttempts: 3 }));

  // Exam deadlines: submit attempts whose time is up, on every tick (cheap when none are due).
  try {
    const finalized = await finalizeDueExamAttempts(db);
    if (finalized > 0) log.info("exams.finalized", { attempts: finalized });
  } catch (e) {
    log.error("exams.finalize_failed", { error: e });
  }

  const total: WorkerRunResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  while (Date.now() - started < opts.budgetMs) {
    const r = await runWorkerOnce(db, {
      workerId: opts.workerId,
      handlers: opts.handlers,
      log,
      onDead: async (job, error) => {
        if (job.kind === "alert.send") return; // never alert about failing to alert
        await raiseAlert(db, { key: `dead:${job.kind}`, severity: "warning", summary: `Job ${job.kind} failed permanently after ${job.attempts} attempt(s).`, detail: error });
      },
    });
    total.claimed += r.claimed;
    total.succeeded += r.succeeded;
    total.retried += r.retried;
    total.dead += r.dead;
    if (r.claimed === 0) break;
  }

  if (opts.checkHealth) {
    try {
      const health = await getSystemHealthAsWorker(db, { staleAfterSeconds: workerStaleSeconds(process.env) });
      for (const a of healthAlerts(health)) {
        if (opts.skipWorkerCheck && a.key === "health:worker") continue;
        await raiseAlert(db, a);
      }
    } catch (e) {
      log.error("health.check_failed", { error: e });
    }
  }
  return total;
}
