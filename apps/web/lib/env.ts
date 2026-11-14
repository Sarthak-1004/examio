import "server-only";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

let loaded = false;

/**
 * The repository keeps one `.env` at its root, two levels above this app. Next.js only loads
 * the app directory's env files, and caches that result, so the root file is loaded here
 * explicitly (forced past the cache). Variables already present in the process, such as those
 * set by a hosting platform or by the browser-test runner, always win.
 */
export function ensureRootEnv(): void {
  if (loaded) return;
  loaded = true;
  loadEnvConfig(path.resolve(process.cwd(), "../.."), process.env.NODE_ENV !== "production", { info: () => {}, error: console.error }, true);
}
