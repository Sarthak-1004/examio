import { config } from "dotenv";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withWorkerContext, assertRestrictedRuntimeRole, createDb } from "@examio/db";
import { enqueueJob, runWorkerOnce, workerHeartbeat } from "../src/jobs/queue";
import { createLogger } from "../src/logger";
import { emailAdapterFromEnv } from "../src/notifications/email";
import { fileScannerFromEnv } from "../src/files/scanner";
import { fileStorageFromEnv } from "../src/files/storage";
import { alertSinkFromEnv, throttledAlerts } from "../src/ops/alerts";
import { validateRuntimeConfig } from "../src/ops/config";
import { getSystemHealthAsWorker, healthAlerts } from "../src/ops/health";
import { createJobHandlers } from "../src/worker";

/**
 * Background worker. Runs due jobs (notifications, file scans, housekeeping), reports a
 * heartbeat, checks system health every 5 minutes and raises alerts.
 *
 *   pnpm worker          keep running until stopped (Ctrl+C)
 *   pnpm worker --once   run what is due now, then exit (for a scheduler such as cron)
 *
 * Uses DATABASE_URL (the restricted application role), never the owner connection.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const once = process.argv.includes("--once");
const workerId = `${hostname()}:${process.pid}`.slice(0, 100);
const log = createLogger({ component: "worker", workerId });

const report = validateRuntimeConfig(process.env);
for (const w of report.warnings) log.warn("config.warning", { message: w });
if (report.errors.length > 0) {
  for (const e of report.errors) log.error("config.error", { message: e });
  process.exit(1);
}

const { db, close } = createDb(process.env.DATABASE_URL!, { max: 4 });
await assertRestrictedRuntimeRole(db);
const alert = throttledAlerts(alertSinkFromEnv(process.env, log), log);
const handlers = createJobHandlers({
  db,
  email: emailAdapterFromEnv(process.env.EMAIL_PROVIDER),
  log,
  storage: fileStorageFromEnv(process.env, root),
  scanner: fileScannerFromEnv(process.env),
});

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

const HEARTBEAT_MS = 30_000;
const HEALTH_MS = 5 * 60_000;
let lastHeartbeat = 0;
let lastHealth = 0;

async function scheduleMaintenance() {
  // One housekeeping job per hour, whatever the number of workers (dedupe key per hour).
  const hour = new Date().toISOString().slice(0, 13);
  await withWorkerContext(db, null, (tx) => enqueueJob(tx, { kind: "maintenance.purge", payload: {}, dedupeKey: `purge:${hour}`, maxAttempts: 3 }));
}

async function checkHealth() {
  const health = await getSystemHealthAsWorker(db);
  for (const a of healthAlerts(health).filter((x) => x.key !== "health:worker")) await alert(a);
}

log.info("worker.started", { once, kinds: Object.keys(handlers), env: report.env });
try {
  do {
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      await workerHeartbeat(db, workerId);
      await scheduleMaintenance();
      lastHeartbeat = now;
    }
    const result = await runWorkerOnce(db, {
      workerId,
      handlers,
      log,
      onDead: async (job, error) => {
        await alert({ key: `dead:${job.kind}`, severity: "warning", summary: `Job ${job.kind} failed permanently after ${job.attempts} attempt(s).`, detail: error });
      },
    });
    if (result.claimed > 0) log.info("worker.batch", { ...result });
    if (now - lastHealth >= HEALTH_MS) {
      await checkHealth().catch((e: unknown) => log.error("health.check_failed", { error: e }));
      lastHealth = now;
    }
    if (once && result.claimed === 0) break;
    if (result.claimed === 0) await new Promise((r) => setTimeout(r, 2000));
  } while (!stopping);
} catch (e) {
  log.error("worker.crashed", { error: e });
  await alert({ key: "worker:crash", severity: "critical", summary: "The background worker stopped after an unexpected error.", detail: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
} finally {
  await close();
  log.info("worker.stopped");
}
