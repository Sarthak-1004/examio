import "server-only";
import path from "node:path";
import { createLogger, fileStorageFromEnv, paymentProviderFromEnv, type FileStorage, type Logger, type PaymentProvider } from "@examio/core";
import { ensureRootEnv } from "./env";

/** Process-wide services for the web server, created on first use. */
const g = globalThis as unknown as { __examioStorage?: FileStorage; __examioLog?: Logger; __examioPayments?: PaymentProvider };

export function fileStorage(): FileStorage {
  ensureRootEnv();
  return (g.__examioStorage ??= fileStorageFromEnv(process.env, path.resolve(process.cwd(), "../..")));
}

/** The configured online payment provider (sandbox unless PAYMENTS_PROVIDER=razorpay). */
export function paymentProvider(): PaymentProvider {
  ensureRootEnv();
  return (g.__examioPayments ??= paymentProviderFromEnv(process.env));
}

export function serverLog(): Logger {
  return (g.__examioLog ??= createLogger({ component: "web" }));
}
