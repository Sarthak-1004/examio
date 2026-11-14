import { sql } from "drizzle-orm";
import { withWorkerContext, type Db } from "@examio/db";
import type { JobHandlers } from "./jobs/queue";
import type { Logger } from "./logger";
import { fileScanHandler, purgeFiles } from "./files/files";
import type { FileScanner } from "./files/scanner";
import type { FileStorage } from "./files/storage";
import type { EmailAdapter } from "./notifications/email";
import { notificationDeliveryHandler } from "./notifications/notifications";

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
  /** Extra handlers contributed by other modules (for example file scanning). */
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
    ...deps.extra,
  };
}
