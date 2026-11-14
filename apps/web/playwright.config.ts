import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import nextEnv from "@next/env";

/**
 * Browser tests run against `next start` on a DISPOSABLE database (E2E_DATABASE_URL, a local
 * `*_e2e` database). Before the server starts, `pnpm db:prepare:e2e` drops, recreates, migrates
 * and seeds it, so every run starts from the same synthetic data and never touches the
 * development database.
 *
 * Browser: the installed Microsoft Edge by default. Set E2E_BROWSER_CHANNEL=chromium to use
 * Playwright's bundled Chromium instead (CI does this).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// @next/env is CommonJS; Playwright loads this file as an ES module.
nextEnv.loadEnvConfig(root, false, { info: () => {}, error: console.error });

if (!process.env.E2E_DATABASE_URL) throw new Error("E2E_DATABASE_URL is not set. Browser tests need their own database (see .env.example).");

// Shared secret for the scheduled worker endpoint, generated per run; the server and the tests
// both inherit it from this process.
process.env.E2E_CRON_SECRET ??= randomBytes(32).toString("hex");

const requested = process.env.E2E_BROWSER_CHANNEL ?? "msedge";
const channel = requested === "chromium" ? undefined : requested;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3100", channel, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Edge"], channel } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel } },
  ],
  webServer: {
    command: "pnpm --dir ../.. db:prepare:e2e && node e2e/start-server.mjs",
    url: "http://localhost:3100/login",
    // Reusing a server could silently test against the wrong database; opt in explicitly.
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 180_000,
  },
});
