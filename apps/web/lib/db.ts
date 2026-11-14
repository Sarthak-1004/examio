import "server-only";
import { createDb, type Db } from "@examio/db";
import { ensureRootEnv } from "./env";

// One pool per server process (survives dev hot-reloads). Created lazily on first use,
// so importing this module (e.g. during `next build`) never opens a connection.
const g = globalThis as unknown as { __examioDb?: Db };

function getDb(): Db {
  if (g.__examioDb) return g.__examioDb;
  ensureRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  g.__examioDb = createDb(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 10) }).db;
  return g.__examioDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb();
    const v = Reflect.get(real, prop, real);
    return typeof v === "function" ? v.bind(real) : v;
  },
});
