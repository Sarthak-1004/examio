import postgres from "postgres";
import { targetFromArgs, targetUrls } from "./target";

/**
 * Drops and recreates a database, then the caller migrates it (see root `pnpm db:reset`).
 * --test and --e2e targets must pass the disposable-database guard (local, *_test / *_e2e, and
 * not the development database). The development target only checks that it is local.
 */
const target = targetFromArgs();
const url = new URL(targetUrls(target, "drop").ownerUrl);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error(`Refusing to reset non-local database ${url.hostname}`);
const dbName = url.pathname.slice(1);
url.pathname = "/postgres";
const sql = postgres(url.toString(), { max: 1 });
await sql.unsafe(`drop database if exists "${dbName}" with (force)`);
await sql.unsafe(`create database "${dbName}"`);
await sql.end();
console.log(`Recreated database ${dbName}.`);
