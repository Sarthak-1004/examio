import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { assertDisposableDatabase } from "@examio/db";

/**
 * Applies migrations + role grants to the test database once per run.
 * Refuses to start unless both test URLs point at a disposable database: the suite truncates
 * every table it uses.
 */
export default function setup() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  config({ path: path.resolve(here, "../../../.env"), quiet: true });
  for (const name of ["TEST_DATABASE_OWNER_URL", "TEST_DATABASE_URL"] as const) {
    const url = process.env[name];
    if (!url) throw new Error(`${name} is not set (see .env.example).`);
    assertDisposableDatabase(url, "run integration tests against");
  }
  const dbPkg = path.resolve(here, "../../db");
  execSync("pnpm migrate:test", { cwd: dbPkg, stdio: "inherit" });
}
