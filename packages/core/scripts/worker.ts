import { config } from "dotenv";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertRestrictedRuntimeRole, createDb } from "@examio/db";
import { createLogger } from "../src/logger";
import { emailAdapterFromEnv } from "../src/notifications/email";
import { fileScannerFromEnv } from "../src/files/scanner";
import { fileStorageFromEnv } from "../src/files/storage";
import { alertSinkFromEnv } from "../src/ops/alerts";
import { validateRuntimeConfig } from "../src/ops/config";
import { createJobHandlers, raiseAlert, runWorkerTick, type WorkerDeps } from "../src/worker";

/**
 * Background worker. Runs due jobs (notifications, file scans, housekeeping, alerts), reports a
 * heartbeat, checks system health every 5 minutes and raises alerts (at most once per condition
 * per hour).
 *
 *   pnpm worker          keep running until stopped (Ctrl+C)
 *   pnpm worker --once   run what is due now, then exit (for a scheduler such as cron)
 *
 * Uses DATABASE_URL (the restricted application role), never the owner connection. On hosting
 * without an always-on process the same work runs through the /internal/worker endpoint.
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
const deps: WorkerDeps = {
  db,
  email: emailAdapterFromEnv(process.env.EMAIL_PROVIDER),
  log,
  storage: fileStorageFromEnv(process.env, root),
  scanner: fileScannerFromEnv(process.env),
  alerts: alertSinkFromEnv(process.env, log),
};
const handlers = createJobHandlers(deps);

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

const HEALTH_MS = 5 * 60_000;
let lastHealth = 0;

log.info("worker.started", { once, kinds: Object.keys(handlers), env: report.env });
try {
  do {
    const checkHealth = Date.now() - lastHealth >= HEALTH_MS;
    // The worker cannot usefully report its own absence; that check is for the scheduler side.
    const result = await runWorkerTick(deps, { workerId, handlers, budgetMs: 30_000, checkHealth, skipWorkerCheck: true });
    if (checkHealth) lastHealth = Date.now();
    if (result.claimed > 0) log.info("worker.batch", { ...result });
    if (once) break;
    if (result.claimed === 0) await new Promise((r) => setTimeout(r, 2000));
  } while (!stopping);
} catch (e) {
  log.error("worker.crashed", { error: e });
  await raiseAlert(db, { key: "worker:crash", severity: "critical", summary: "The background worker stopped after an unexpected error.", detail: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await close();
  log.info("worker.stopped");
}
