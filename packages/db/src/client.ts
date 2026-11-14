import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: opts.max ?? 10, prepare: false });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

/**
 * Refuses a runtime connection that could bypass Row Level Security: a superuser, a role with
 * BYPASSRLS, or a role that owns (or inherits ownership of) application tables.
 * Call once at server start with the application connection.
 */
export async function assertRestrictedRuntimeRole(db: Db): Promise<void> {
  const rows = (await db.execute<{ unsafe: boolean }>(sql`
    select (
      r.rolsuper or r.rolbypassrls
      or exists (
        select 1 from pg_tables t
        where t.schemaname = 'public' and pg_has_role(current_user, t.tableowner, 'USAGE')
      )
    ) as unsafe
    from pg_roles r where r.rolname = current_user`)) as unknown as { unsafe: boolean }[];
  if (rows.length !== 1 || rows[0]!.unsafe !== false) {
    throw new Error(
      "DATABASE_URL must use the restricted application role (see .env.example). The current role can bypass Row Level Security.",
    );
  }
}

/**
 * Who is making this request. Derived server-side from the session — never from the browser.
 * RLS policies read these values via app_user_id(), app_school_id(), app_is_platform_admin().
 */
export interface RequestContext {
  userId: string | null;
  schoolId: string | null;
  isPlatformAdmin: boolean;
}

/**
 * Run `fn` as the background worker: no user, optionally scoped to one school, with
 * `app.worker` on so the job_* / notification_* database functions accept the call.
 * Only the worker process may use this; never call it while handling a web request.
 */
export async function withWorkerContext<T>(db: Db, schoolId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', '', true),
      set_config('app.school_id', ${schoolId ?? ""}, true),
      set_config('app.platform_admin', 'off', true),
      set_config('app.worker', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` in a transaction with the tenant context set (transaction-local).
 * All tenant data access in the app MUST go through this.
 */
export async function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.school_id', ${ctx.schoolId ?? ""}, true),
      set_config('app.platform_admin', ${ctx.isPlatformAdmin ? "on" : "off"}, true),
      set_config('app.worker', 'off', true)`);
    return fn(tx);
  });
}
