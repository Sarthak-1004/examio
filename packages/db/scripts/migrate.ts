import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "../src/client";
import { targetFromArgs, targetUrls } from "./target";

/** Usage: tsx scripts/migrate.ts [--test | --e2e] */
const url = targetUrls(targetFromArgs(), "migrate").ownerUrl;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const { db, close } = createDb(url, { max: 1 });
await migrate(db, { migrationsFolder });
await close();
console.log("Migrations applied.");
