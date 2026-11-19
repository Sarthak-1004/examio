import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "../src/client";
import { assertDisposableDatabase } from "../src/safety";
import { requireEnv } from "./env";
import { one } from "./pgtools";

/**
 * Migration rehearsal (Phase 15.3): proves that upgrading a database that holds data works, and
 * measures how long it takes.
 *   pnpm ops:migration-rehearsal [--back 5] [--keep]
 *
 * 1. Creates the throwaway local database `examio_migration_rehearsal_test` (dropped first; the
 *    disposable-database guard refuses anything that is not local and named *_test).
 * 2. Applies every migration except the last `--back` (default 5): the previous release.
 * 3. Adds representative rows with the owner connection (a school, users, memberships, a
 *    student, an audit record) and counts every table.
 * 4. Applies the remaining migrations (the upgrade being rehearsed) and the runtime role's grants
 *    (setup-roles, as `pnpm db:migrate` does), timing each step.
 * 5. Verifies: every migration applied; the earlier rows are all still there; row level security
 *    is on for every table; the runtime role cannot bypass it; with no request context the
 *    runtime role sees no tenant rows.
 * 6. Writes a report to .data/rehearsals/ and drops the database (unless --keep).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const keep = process.argv.includes("--keep");
const back = process.argv.includes("--back") ? Number(process.argv[process.argv.indexOf("--back") + 1]) : 5;
if (!Number.isInteger(back) || back < 1) throw new Error("--back must be a positive whole number.");

const DATABASE = "examio_migration_rehearsal_test";
const ownerUrl = new URL(requireEnv("DATABASE_OWNER_URL"));
const appUrl = new URL(requireEnv("DATABASE_URL"));
const target = new URL(ownerUrl);
target.pathname = `/${DATABASE}`;
assertDisposableDatabase(target.toString(), "rehearse migrations in");
const targetApp = new URL(appUrl);
targetApp.pathname = `/${DATABASE}`;

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail });
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

// The previous release: the same folder with the last `back` journal entries removed.
const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
const total = journal.entries.length;
if (back >= total) throw new Error(`There are only ${total} migrations.`);
const oldFolder = fs.mkdtempSync(path.join(os.tmpdir(), "examio-migrations-"));
fs.mkdirSync(path.join(oldFolder, "meta"));
const oldEntries = journal.entries.slice(0, total - back);
fs.writeFileSync(path.join(oldFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
for (const e of oldEntries) fs.copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(oldFolder, `${e.tag}.sql`));

const maintenance = new URL(ownerUrl);
maintenance.pathname = "/postgres";
const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`drop database if exists "${DATABASE}" with (force)`);
  await admin.unsafe(`create database "${DATABASE}"`);
} finally {
  await admin.end();
}

const runSetupRoles = () =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "setup-roles.ts")], {
      env: { ...process.env, DATABASE_OWNER_URL: target.toString() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`setup-roles failed: ${err.split("\n")[0]}`))));
  });

let t = Date.now();
{
  const { db, close } = createDb(target.toString(), { max: 1 });
  await migrate(db, { migrationsFolder: oldFolder });
  await close();
}
const previousSeconds = seconds(t);

const owner = postgres(target.toString(), { max: 1, onnotice: () => {} });
const appRole = postgres(targetApp.toString(), { max: 1, onnotice: () => {} });
try {
  // Representative rows in tables every release has had.
  const [b] = await owner<{ id: string }[]>`insert into boards (name) values ('Rehearsal board') returning id`;
  const [m] = await owner<{ id: string }[]>`insert into mediums (name) values ('Rehearsal medium') returning id`;
  const [s] = await owner<{ id: string }[]>`insert into schools (name, code, board_id, medium_id) values ('Rehearsal School', 'rehearsal', ${b!.id}, ${m!.id}) returning id`;
  const [adminUser] = await owner<{ id: string }[]>`insert into users (full_name, email, password_hash) values ('Rehearsal Admin', 'admin@rehearsal.test', 'x') returning id`;
  const [studentUser] = await owner<{ id: string }[]>`insert into users (full_name, username, password_hash) values ('Rehearsal Student', 'rehearsal.s1', 'x') returning id`;
  await owner`insert into school_memberships (school_id, user_id, role) values (${s!.id}, ${adminUser!.id}, 'school_admin'), (${s!.id}, ${studentUser!.id}, 'student')`;
  await owner`insert into student_profiles (school_id, user_id, admission_no, display_name, admitted_on) values (${s!.id}, ${studentUser!.id}, 'S1', 'Rehearsal Student', current_date)`;
  await owner`insert into audit_events (school_id, actor_user_id, action) values (${s!.id}, ${adminUser!.id}, 'rehearsal.seeded')`;

  const tables = (await owner<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public' order by 1`).map((r) => r.t);
  const before: Record<string, number> = {};
  for (const table of tables) before[table] = one(await owner<{ n: number }[]>`select count(*)::int as n from ${owner(table)}`, table).n;

  t = Date.now();
  {
    const { db, close } = createDb(target.toString(), { max: 1 });
    await migrate(db, { migrationsFolder });
    await close();
  }
  const upgradeSeconds = seconds(t);
  t = Date.now();
  await runSetupRoles();
  const grantsSeconds = seconds(t);

  const { n: applied } = one(await owner<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`, "migrations");
  record("migrations", applied === total, `${applied} of ${total} applied (${total - back} before the upgrade, ${back} in it)`);
  for (const [table, n] of Object.entries(before)) {
    const { n: after } = one(await owner<{ n: number }[]>`select count(*)::int as n from ${owner(table)}`, table);
    if (after !== n) record(`rows:${table}`, false, `${n} before, ${after} after`);
  }
  if (!results.some((r) => r.check.startsWith("rows:"))) record("rows", true, `${Object.values(before).reduce((a, n) => a + n, 0)} rows in ${tables.length} tables kept`);

  const noRls = await owner<{ t: string }[]>`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
  record("row level security", noRls.length === 0, noRls.length === 0 ? "enabled on every table" : `missing on: ${noRls.map((r) => r.t).join(", ")}`);
  const [role] = await owner<{ unsafe: boolean }[]>`select (rolsuper or rolbypassrls) as unsafe from pg_roles where rolname = 'examio_app'`;
  record("runtime role", role?.unsafe === false, role ? (role.unsafe ? "can bypass RLS" : "cannot bypass RLS") : "role missing");
  const leaked = await appRole.begin(async (tx) => {
    await tx`select set_config('app.user_id', '', true), set_config('app.school_id', '', true), set_config('app.platform_admin', 'off', true)`;
    const [r] = await tx<{ n: number }[]>`select (select count(*) from schools)::int + (select count(*) from student_profiles)::int as n`;
    return r?.n ?? -1;
  });
  record("no context, no rows", leaked === 0, `the runtime role saw ${leaked} tenant rows without a request context`);

  const report = {
    at: new Date().toISOString(),
    database: DATABASE,
    previousRelease: oldEntries.at(-1)?.tag,
    upgradedTo: journal.entries.at(-1)?.tag,
    seconds: { previousRelease: previousSeconds, upgrade: upgradeSeconds, grants: grantsSeconds },
    results,
    ok: results.every((r) => r.ok),
  };
  const dir = path.join(root, ".data", "rehearsals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `migration-${report.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.check}: ${r.detail}`);
  console.log(`Previous release (${report.previousRelease}) built in ${previousSeconds} s; upgrade to ${report.upgradedTo} took ${upgradeSeconds} s, grants ${grantsSeconds} s.`);
  console.log(`Report: ${path.relative(root, file)}`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await owner.end();
  await appRole.end();
  fs.rmSync(oldFolder, { recursive: true, force: true });
  if (!keep) {
    const cleanup = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`drop database if exists "${DATABASE}" with (force)`);
    await cleanup.end();
  }
}
