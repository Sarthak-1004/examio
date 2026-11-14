import { assertDisposableDatabase } from "../src/safety";
import { requireEnv } from "./env";

/**
 * Which database a script acts on, chosen by flag:
 *   (none)  development  DATABASE_OWNER_URL / DATABASE_URL
 *   --test  integration  TEST_DATABASE_OWNER_URL / TEST_DATABASE_URL   (must be disposable)
 *   --e2e   browser      E2E_DATABASE_OWNER_URL / E2E_DATABASE_URL     (must be disposable)
 */
export type Target = "dev" | "test" | "e2e";

export function targetFromArgs(argv: readonly string[] = process.argv): Target {
  if (argv.includes("--test")) return "test";
  if (argv.includes("--e2e")) return "e2e";
  return "dev";
}

const PREFIX: Record<Target, string> = { dev: "", test: "TEST_", e2e: "E2E_" };

export function targetUrls(target: Target, purpose: string): { ownerUrl: string; appUrl: string | undefined } {
  const ownerUrl = requireEnv(`${PREFIX[target]}DATABASE_OWNER_URL`);
  const appUrl = process.env[`${PREFIX[target]}DATABASE_URL`];
  if (target !== "dev") {
    assertDisposableDatabase(ownerUrl, purpose);
    if (appUrl) assertDisposableDatabase(appUrl, purpose);
  }
  return { ownerUrl, appUrl };
}
