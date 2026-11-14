// Starts the built app for browser tests with DATABASE_URL pointing at the disposable e2e
// database. Only this process sees the override, so the preparation step that runs before it
// still knows the real development DATABASE_URL and the disposable-database guard can compare
// against it.
import { spawn } from "node:child_process";

const url = process.env.E2E_DATABASE_URL;
if (!url) {
  console.error("E2E_DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}

const child = spawn("pnpm", ["exec", "next", "start", "-p", "3100"], {
  // The browser-test server is a test environment even though `next start` runs in production mode.
  env: { ...process.env, DATABASE_URL: url, EXAMIO_ENV: process.env.EXAMIO_ENV ?? "test", CRON_SECRET: process.env.E2E_CRON_SECRET },
  stdio: "inherit",
  shell: process.platform === "win32",
});
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
