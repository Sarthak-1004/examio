import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { requireEnv } from "./env";
import { connectionArgs, findTool, one, run } from "./pgtools";

/**
 * Takes a backup of the development database (or the database in DATABASE_OWNER_URL) and the
 * file storage folder:
 *   <BACKUP_DIR>/<database>-<timestamp>/database.dump    (pg_dump custom format)
 *                                     /files/            (copy of FILE_STORAGE_DIR)
 *                                     /manifest.json     (row counts and migration count, for the restore check)
 * BACKUP_DIR defaults to <repo>/.data/backups. Usage: pnpm ops:backup
 *
 * This is the local, scriptable baseline. Hosted environments add encrypted, off-site,
 * scheduled backups with point-in-time recovery (OPERATIONS.md); this script does not replace them.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ownerUrl = requireEnv("DATABASE_OWNER_URL");
const backupRoot = process.env.BACKUP_DIR?.trim() || path.join(root, ".data", "backups");
const storageDir = process.env.FILE_STORAGE_DIR?.trim() || path.join(root, ".data", "files");

export const COUNTED_TABLES = ["schools", "users", "school_memberships", "audit_events", "files", "jobs", "notifications"] as const;

const sql = postgres(ownerUrl, { max: 1 });
try {
  const { v } = one(await sql<{ v: string }[]>`select current_setting('server_version_num') as v`, "server version");
  const major = Math.floor(Number(v) / 10000);
  const { db } = one(await sql<{ db: string }[]>`select current_database() as db`, "database name");
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    const { n } = one(await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)}`, t);
    counts[t] = n;
  }
  const { m } = one(await sql<{ m: number }[]>`select count(*)::int as m from drizzle.__drizzle_migrations`, "migrations");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupRoot, `${db}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const { args, env } = connectionArgs(ownerUrl);
  await run(findTool("pg_dump", major), [...args, "--format=custom", "--no-owner", "--file", path.join(dir, "database.dump")], env);
  const fileCount = fs.existsSync(storageDir) ? (fs.cpSync(storageDir, path.join(dir, "files"), { recursive: true }), fs.readdirSync(path.join(dir, "files"), { recursive: true }).length) : 0;

  const manifest = { database: db, takenAt: new Date().toISOString(), serverVersion: v, migrations: m, counts, storageEntries: fileCount, seconds: Math.round((Date.now() - started) / 100) / 10 };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Backup written to ${dir}`);
  console.log(`  ${m} migrations; rows: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(", ")}; ${manifest.seconds}s`);
} finally {
  await sql.end();
}
