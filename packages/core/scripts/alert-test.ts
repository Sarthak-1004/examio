import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createLogger } from "../src/logger";
import { alertSinkFromEnv } from "../src/ops/alerts";

/**
 * Alert rehearsal: sends one clearly labelled test alert through the configured sink
 * (ALERT_SINK), so an operator can confirm alerts reach the right person.
 *   pnpm ops:alert-test
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const log = createLogger({ component: "alert-test" });
const sink = alertSinkFromEnv(process.env, log);
await sink.send({
  key: "rehearsal",
  severity: "warning",
  summary: "Alert rehearsal: this is a test. No action is needed.",
  detail: `Sent ${new Date().toISOString()} with \`pnpm ops:alert-test\`.`,
});
console.log(`Test alert sent through the "${sink.name}" sink.${sink.name === "log" ? " (log only: set ALERT_SINK=webhook to reach a person)" : ""}`);
