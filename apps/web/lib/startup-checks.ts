import "server-only";
import { validateRuntimeConfig } from "@examio/core";
import { assertRestrictedRuntimeRole } from "@examio/db";
import { ensureRootEnv } from "./env";
import { db } from "./db";
import { serverLog } from "./runtime";

/**
 * Checks that must hold before the server handles requests:
 * - the configuration is valid for its environment (EXAMIO_ENV); staging and production
 *   additionally require a real scanner, webhook alerts and an explicit proxy setting;
 * - DATABASE_URL uses a role that cannot bypass Row Level Security.
 * Errors stop the server; warnings are logged.
 */
export async function verifyStartup(): Promise<void> {
  ensureRootEnv();
  const log = serverLog();
  const report = validateRuntimeConfig(process.env);
  for (const w of report.warnings) log.warn("config.warning", { message: w });
  if (report.errors.length > 0) {
    for (const e of report.errors) log.error("config.error", { message: e });
    throw new Error(`Configuration is not valid for ${report.env}: ${report.errors.join(" ")}`);
  }
  await assertRestrictedRuntimeRole(db);
}
