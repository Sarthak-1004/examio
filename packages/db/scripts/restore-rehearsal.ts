import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { RESTORE_REHEARSAL_DATABASE, assertDisposableDatabase } from "../src/safety";
import { requireEnv } from "./env";
import { connectionArgs, findTool, one, run } from "./pgtools";

/**
 * Restore rehearsal: proves a backup can actually be restored, and measures how long it takes.
 *   pnpm ops:restore-rehearsal [--backup <folder>] [--keep]
 *
 * 1. Takes the newest backup in BACKUP_DIR (or --backup).
 * 2. Restores it into the throwaway local database `examio_restore_check` (dropped first).
 * 3. Verifies: migration count and row counts match the manifest; every application table has
 *    row level security on; the runtime role cannot bypass it; with no request context the
 *    runtime role sees no tenant rows; stored file bytes were backed up for every live file.
 * 4. Writes rehearsal.json next to the backup and drops the database (unless --keep).
 * It never starts a worker against the restored copy, so no notification is sent twice.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const backupRoot = process.env.BACKUP_DIR?.trim() || path.join(root, ".data", "backups");
const keep = process.argv.includes("--keep");
const chosen = process.argv.includes("--backup") ? process.argv[process.argv.indexOf("--backup") + 1] : undefined;

const ownerUrl = new URL(requireEnv("DATABASE_OWNER_URL"));
const appUrl = new URL(requireEnv("DATABASE_URL"));
const target = new URL(ownerUrl);
target.pathname = `/${RESTORE_REHEARSAL_DATABASE}`;
assertDisposableDatabase(target.toString(), "restore into", { allowRestoreRehearsal: true });
const targetApp = new URL(appUrl);
targetApp.pathname = `/${RESTORE_REHEARSAL_DATABASE}`;

const backupDir =
  chosen ??
  (fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).filter((d) => fs.existsSync(path.join(backupRoot, d, "manifest.json"))).sort().map((d) => path.join(backupRoot, d)).pop()
    : undefined);
if (!backupDir) throw new Error(`No backup found in ${backupRoot}. Run pnpm ops:backup first.`);
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as {
  migrations: number;
  counts: Record<string, number>;
  serverVersion: string;
};

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail });
const started = Date.now();

const maintenance = new URL(ownerUrl);
maintenance.pathname = "/postgres";
const admin = postgres(maintenance.toString(), { max: 1 });
try {
  await admin.unsafe(`drop database if exists "${RESTORE_REHEARSAL_DATABASE}" with (force)`);
  await admin.unsafe(`create database "${RESTORE_REHEARSAL_DATABASE}"`);
} finally {
  await admin.end();
}

const major = Math.floor(Number(manifest.serverVersion) / 10000);
const { args, env } = connectionArgs(target.toString());
await run(findTool("pg_restore", major), [...args, "--no-owner", "--exit-on-error", path.join(backupDir, "database.dump")], env);
const restoreSeconds = Math.round((Date.now() - started) / 100) / 10;

const owner = postgres(target.toString(), { max: 1 });
const appRole = postgres(targetApp.toString(), { max: 1 });
try {
  // Re-apply the runtime role's privileges, as a real recovery would (pnpm db:migrate does this).
  await owner.unsafe(`grant connect on database "${RESTORE_REHEARSAL_DATABASE}" to examio_app`);
  await owner.unsafe(`grant usage on schema public to examio_app`);

  const { m } = one(await owner<{ m: number }[]>`select count(*)::int as m from drizzle.__drizzle_migrations`, "migrations");
  record("migrations", m === manifest.migrations, `${m} applied, backup had ${manifest.migrations}`);

  for (const [table, expected] of Object.entries(manifest.counts)) {
    const { n } = one(await owner<{ n: number }[]>`select count(*)::int as n from ${owner(table)}`, table);
    record(`rows:${table}`, n === expected, `${n} restored, backup had ${expected}`);
  }

  const noRls = await owner<{ t: string }[]>`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
  record("row level security", noRls.length === 0, noRls.length === 0 ? "enabled on every table" : `missing on: ${noRls.map((r) => r.t).join(", ")}`);

  const [role] = await owner<{ unsafe: boolean }[]>`select (rolsuper or rolbypassrls) as unsafe from pg_roles where rolname = 'examio_app'`;
  record("runtime role", role?.unsafe === false, role ? (role.unsafe ? "can bypass RLS" : "cannot bypass RLS") : "role missing");

  // Table grants are restored with the dump (pg_dump keeps GRANTs), so the runtime role can query.
  const leaked = await appRole.begin(async (tx) => {
    await tx`select set_config('app.user_id', '', true), set_config('app.school_id', '', true), set_config('app.platform_admin', 'off', true)`;
    const [s] = await tx<{ n: number }[]>`select count(*)::int as n from schools`;
    const [u] = await tx<{ n: number }[]>`select count(*)::int as n from users`;
    return (s?.n ?? 0) + (u?.n ?? 0);
  });
  record("tenant isolation", leaked === 0, leaked === 0 ? "no rows visible without a request context" : `${leaked} rows visible without context`);

  const live = await owner<{ key: string }[]>`select storage_key as key from files where purged_at is null`;
  const missing = live.filter((f) => !fs.existsSync(path.join(backupDir, "files", ...f.key.split("/"))));
  record("file bytes", missing.length === 0, `${live.length - missing.length} of ${live.length} live files present in the backup`);
} finally {
  await owner.end();
  await appRole.end();
}

if (!keep) {
  const cleanup = postgres(maintenance.toString(), { max: 1 });
  await cleanup.unsafe(`drop database if exists "${RESTORE_REHEARSAL_DATABASE}" with (force)`);
  await cleanup.end();
}

const ok = results.every((r) => r.ok);
const summary = { backup: path.basename(backupDir), rehearsedAt: new Date().toISOString(), ok, restoreSeconds, totalSeconds: Math.round((Date.now() - started) / 100) / 10, results };
fs.writeFileSync(path.join(backupDir, "rehearsal.json"), JSON.stringify(summary, null, 2));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}: ${r.detail}`);
console.log(`Restore took ${restoreSeconds}s (total ${summary.totalSeconds}s). Result: ${ok ? "PASSED" : "FAILED"}. Recorded in ${path.join(backupDir, "rehearsal.json")}`);
if (!ok) process.exitCode = 1;
