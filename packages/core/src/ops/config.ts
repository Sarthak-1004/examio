import { emailAdapterFromEnv } from "../notifications/email";
import { parseTrustedProxyHops } from "../client-ip";
import { fileScannerFromEnv } from "../files/scanner";
import { resolveMfaKey } from "../auth/totp";
import { alertSinkFromEnv } from "./alerts";

/**
 * Checks the runtime configuration before a server or worker starts.
 *
 * EXAMIO_ENV names the environment: development (default), test, demo, staging or production.
 * - staging and production must be configured like production: real MFA key, a real malware
 *   scanner, alerts that reach a person, an explicit proxy setting.
 * - demo is a public copy on free hosting with FAKE data only (Vercel + Neon): real MFA key,
 *   no owner credential, explicit proxy setting, but no scanner (uploads stay quarantined) and
 *   a scheduled worker instead of an always-on one.
 * Errors stop the process; warnings are logged.
 */
export type ExamioEnv = "development" | "test" | "demo" | "staging" | "production";
export const EXAMIO_ENVS: readonly ExamioEnv[] = ["development", "test", "demo", "staging", "production"];

export interface ConfigReport {
  env: ExamioEnv;
  errors: string[];
  warnings: string[];
}

export function validateRuntimeConfig(env: NodeJS.ProcessEnv): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = (env.EXAMIO_ENV ?? "development").trim() || "development";
  const examioEnv: ExamioEnv = (EXAMIO_ENVS as readonly string[]).includes(name) ? (name as ExamioEnv) : "development";
  if (examioEnv !== name) errors.push(`EXAMIO_ENV "${name}" is not one of ${EXAMIO_ENVS.join(", ")}.`);
  const strict = examioEnv === "staging" || examioEnv === "production";
  const hosted = strict || examioEnv === "demo";
  const check = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  };

  if (!env.DATABASE_URL) errors.push("DATABASE_URL is not set.");
  if (env.NODE_ENV === "production" && !env.EXAMIO_ENV) {
    warnings.push("EXAMIO_ENV is not set; treating this as development. Set EXAMIO_ENV=production on real deployments so production rules apply.");
  }
  if (hosted && env.DATABASE_OWNER_URL) errors.push(`DATABASE_OWNER_URL must not be available to the running application in ${examioEnv}.`);
  check(() => parseTrustedProxyHops(env.TRUSTED_PROXY_HOPS));
  check(() => resolveMfaKey(env.MFA_ENCRYPTION_KEY, hosted || env.NODE_ENV === "production"));
  if (hosted && env.CRON_SECRET !== undefined && env.CRON_SECRET.length < 32) errors.push("CRON_SECRET must be at least 32 characters.");
  check(() => emailAdapterFromEnv(env.EMAIL_PROVIDER));
  check(() => alertSinkFromEnv(env));

  const pool = env.DATABASE_POOL_MAX;
  if (pool !== undefined && pool !== "" && !(/^\d+$/.test(pool) && Number(pool) >= 1 && Number(pool) <= 100)) {
    errors.push("DATABASE_POOL_MAX must be a whole number from 1 to 100.");
  }

  let scanner: string | null = null;
  check(() => {
    scanner = fileScannerFromEnv(env)?.name ?? null;
  });

  if (strict) {
    if (env.TRUSTED_PROXY_HOPS === undefined || env.TRUSTED_PROXY_HOPS.trim() === "") {
      errors.push("TRUSTED_PROXY_HOPS must be set explicitly in staging and production (0 if no proxy).");
    }
    if (scanner !== "clamav") errors.push("FILE_SCANNER must be clamav in staging and production.");
    if ((env.ALERT_SINK ?? "log") !== "webhook") errors.push("ALERT_SINK must be webhook in staging and production, so alerts reach a person.");
    if ((env.EMAIL_PROVIDER ?? "sandbox") === "sandbox") warnings.push("EMAIL_PROVIDER is sandbox: email notifications are recorded, not sent.");
    if ((env.FILE_STORAGE ?? "local") === "local") warnings.push("FILE_STORAGE is local disk: it must be persistent and backed up with the database.");
  } else if (examioEnv === "demo") {
    if (env.TRUSTED_PROXY_HOPS === undefined || env.TRUSTED_PROXY_HOPS.trim() === "") {
      errors.push("TRUSTED_PROXY_HOPS must be set explicitly in demo (1 on Vercel).");
    }
    if (!env.CRON_SECRET) warnings.push("CRON_SECRET is not set: the scheduled worker endpoint is disabled, so notifications are not delivered.");
    if ((env.ALERT_SINK ?? "log") !== "webhook") warnings.push("ALERT_SINK is log: alerts only appear in the hosting logs.");
    warnings.push("Demo mode: uploads stay quarantined (no scanner) and email is sandboxed. Use fake data only.");
  } else if (scanner === null) {
    warnings.push("No FILE_SCANNER configured: uploads stay quarantined and cannot be downloaded.");
  }
  return { env: examioEnv, errors, warnings };
}
