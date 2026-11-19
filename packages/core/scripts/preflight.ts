import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { createDb } from "@examio/db";
import { validateRuntimeConfig } from "../src/ops/config";

/**
 * Pre-flight check of a deployment's settings (Phase 15.3). Prints pass/fail lines naming
 * settings, never their values.
 *   pnpm ops:preflight [--settings <path>] [--as staging|production] [--connect]
 *
 * - Reads the settings file (default: the repository's .env) into this process only.
 * - Applies the same rules the web server and worker apply at start-up (validateRuntimeConfig),
 *   as the environment in the file, or as --as.
 * - --connect: connects with DATABASE_URL and checks the runtime role cannot bypass row level
 *   security; if DATABASE_OWNER_URL is also in the file (migration environments only), reports
 *   migrations applied against those in this revision.
 * Exit code 1 when anything fails.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const envFile = path.resolve(root, arg("--settings") ?? ".env");
if (!fs.existsSync(envFile)) throw new Error(`No settings file at ${path.relative(root, envFile)}.`);
const env: NodeJS.ProcessEnv = {};
config({ path: envFile, processEnv: env as Record<string, string>, quiet: true });
const as = arg("--as");
if (as) env.EXAMIO_ENV = as;

let failed = false;
const line = (ok: boolean, text: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
};

const report = validateRuntimeConfig(env);
console.log(`Settings: ${path.relative(root, envFile)} checked as ${report.env}.`);
if (report.errors.length === 0) line(true, "start-up rules: no errors");
for (const e of report.errors) line(false, e);
for (const w of report.warnings) console.log(`WARN  ${w}`);

if (process.argv.includes("--connect")) {
  if (!env.DATABASE_URL) {
    line(false, "DATABASE_URL is not set, so nothing to connect to.");
  } else {
    const app = createDb(env.DATABASE_URL, { max: 1 });
    try {
      const [r] = (await app.db.execute(sql`select (rolsuper or rolbypassrls) as unsafe from pg_roles where rolname = current_user`)) as unknown as { unsafe: boolean }[];
      line(r?.unsafe === false, r?.unsafe === false ? "runtime role cannot bypass row level security" : "runtime role can bypass row level security");
    } catch (e) {
      line(false, `could not connect with DATABASE_URL (${(e as { code?: string }).code ?? "error"})`);
    } finally {
      await app.close();
    }
    if (env.DATABASE_OWNER_URL) {
      const journal = JSON.parse(fs.readFileSync(path.join(root, "packages", "db", "migrations", "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
      const owner = createDb(env.DATABASE_OWNER_URL, { max: 1 });
      try {
        const [m] = (await owner.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { n: number }[];
        const pending = journal.entries.length - (m?.n ?? 0);
        line(pending >= 0, pending === 0 ? `migrations up to date (${m?.n})` : pending > 0 ? `${pending} migration(s) to apply before deploying this revision` : "the database is ahead of this revision");
      } catch (e) {
        line(false, `could not read migrations with DATABASE_OWNER_URL (${(e as { code?: string }).code ?? "error"})`);
      } finally {
        await owner.close();
      }
    }
  }
}
console.log(failed ? "Result: NOT READY." : "Result: ready.");
if (failed) process.exitCode = 1;
