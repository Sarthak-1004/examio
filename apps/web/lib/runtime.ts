import "server-only";
import path from "node:path";
import { createLogger, fileStorageFromEnv, type FileStorage, type Logger } from "@examio/core";
import { ensureRootEnv } from "./env";

/** Process-wide services for the web server, created on first use. */
const g = globalThis as unknown as { __examioStorage?: FileStorage; __examioLog?: Logger };

export function fileStorage(): FileStorage {
  ensureRootEnv();
  return (g.__examioStorage ??= fileStorageFromEnv(process.env, path.resolve(process.cwd(), "../..")));
}

export function serverLog(): Logger {
  return (g.__examioLog ??= createLogger({ component: "web" }));
}
