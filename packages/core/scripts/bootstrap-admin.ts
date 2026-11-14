import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "@examio/db";
import { AppError } from "../src/errors";
import { bootstrapPlatformAdmin, type BootstrapMode } from "../src/ops/bootstrap-admin";

/**
 * Creates (or recovers) a platform administrator. Run by an operator who holds the OWNER
 * database credential; the running application cannot do this.
 *
 *   pnpm admin:bootstrap --email admin@example.org --name "Full Name"
 *   pnpm admin:bootstrap --email second@example.org --name "Full Name" --additional
 *   pnpm admin:bootstrap --email admin@example.org --recover
 *
 * No password is accepted or printed. A one-time code is printed once; the administrator
 * enters it at <site>/redeem to choose their own password. Run it from a private terminal,
 * not from a job whose output is stored.
 */
const USAGE = `Usage:
  pnpm admin:bootstrap --email <email> --name "<full name>"               create the first platform administrator
  pnpm admin:bootstrap --email <email> --name "<full name>" --additional  add another platform administrator
  pnpm admin:bootstrap --email <email> --recover                          new one-time code for an existing one`;

/** A mistake in how the command was called; printed without a stack trace. */
class UsageError extends Error {}

function parseArgs(argv: string[]): { email?: string; name?: string; mode: BootstrapMode } {
  let email: string | undefined;
  let name: string | undefined;
  let additional = false;
  let recover = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--email") email = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--additional") additional = true;
    else if (arg === "--recover") recover = true;
    else throw new UsageError(`Unknown argument:${arg}\n\n${USAGE}`);
  }
  if (additional && recover) throw new UsageError(`Use either --additional or --recover, not both.\n\n${USAGE}`);
  return { email, name, mode: recover ? "recover" : additional ? "additional" : "first" };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

let exitCode = 0;
try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) throw new UsageError(`--email is required.\n\n${USAGE}`);
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new UsageError("DATABASE_OWNER_URL is not set. This command needs the owner database connection.");

  const owner = createDb(url, { max: 1 });
  try {
    const result = await bootstrapPlatformAdmin(owner.db, { email: args.email, fullName: args.name, mode: args.mode });
    const what = result.mode === "recover" ? "Recovery code issued for" : "Platform administrator created:";
    console.log(`${what} ${args.email.trim().toLowerCase()}`);
    console.log("");
    console.log(`  One-time code: ${result.code}`);
    console.log(`  Valid until:   ${result.expiresAt.toISOString()}`);
    console.log("");
    console.log("Give the code to that person directly. They open /redeem on the site, enter it and");
    console.log("choose their own password. The code works once and is not stored in readable form.");
  } finally {
    await owner.close();
  }
} catch (e) {
  exitCode = 1;
  // Expected problems are explained in plain words; anything else is unexpected and shown in full.
  if (e instanceof AppError || e instanceof UsageError) console.error(e.message);
  else console.error(e);
}
process.exit(exitCode);
