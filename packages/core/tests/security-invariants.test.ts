import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { app, owner } from "./helpers";

/**
 * Phase 15.4: security regression checks over the whole schema, so a future migration that
 * forgets one of the rules fails here rather than in review.
 */
type Row = Record<string, unknown>;
const q = async <T extends Row>(text: ReturnType<typeof sql>) => (await owner.db.execute(text)) as unknown as T[];

describe("security invariants", () => {
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("row level security is on for every table, and every table has at least one policy", async () => {
    const noRls = await q<{ t: string }>(sql`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
    expect(noRls.map((r) => r.t)).toEqual([]);
    const noPolicy = await q<{ t: string }>(sql`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
      order by 1`);
    // Reached only through SECURITY DEFINER functions or the worker; no policy means deny all.
    expect(noPolicy.map((r) => r.t)).toEqual(["account_tokens", "fee_counters", "jobs", "payment_events", "rate_limit_buckets", "user_mfa", "user_mfa_recovery_codes", "worker_heartbeats"]);
  });

  it("the runtime role is restricted: no superuser, no RLS bypass, owns nothing, no migration history", async () => {
    const [role] = await q<{ unsafe: boolean; createrole: boolean; createdb: boolean }>(sql`
      select (rolsuper or rolbypassrls or rolreplication) as unsafe, rolcreaterole as createrole, rolcreatedb as createdb from pg_roles where rolname = 'examio_app'`);
    expect(role).toEqual({ unsafe: false, createrole: false, createdb: false });
    const owned = await q<{ t: string }>(sql`select tablename as t from pg_tables where tableowner = 'examio_app'`);
    expect(owned).toEqual([]);
    const [m] = await q<{ ok: boolean }>(sql`select not has_schema_privilege('examio_app', 'drizzle', 'USAGE') as ok`);
    expect(m?.ok).toBe(true);
  });

  it("the runtime role deletes only from a reviewed list, always under a delete policy, and never truncates", async () => {
    const rows = await q<{ t: string; del: boolean; trunc: boolean; trig: boolean; refs: boolean }>(sql`
      select c.relname as t, has_table_privilege('examio_app', c.oid, 'DELETE') as del, has_table_privilege('examio_app', c.oid, 'TRUNCATE') as trunc,
             has_table_privilege('examio_app', c.oid, 'TRIGGER') as trig, has_table_privilege('examio_app', c.oid, 'REFERENCES') as refs
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`);
    // Sessions, unused setup items and draft composition lines (TABLE_GRANTS). Records, history
    // and ledgers are never deletable: they are archived, voided or reversed instead.
    const deletable = ["academic_years", "attendance_sessions", "calendar_events", "class_subjects", "classes", "exam_graders", "exam_items", "exam_targets", "fee_structure_items", "grading_bands", "grading_schemes", "offline_assessment_targets", "practice_set_items", "sections", "sessions", "subjects"];
    expect(rows.filter((r) => r.del).map((r) => r.t)).toEqual(deletable);
    const unscoped = await q<{ t: string }>(sql`
      select t from unnest(${sql.raw(`array[${deletable.map((t) => `'${t}'`).join(",")}]`)}::text[]) t
      where not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t and p.cmd in ('DELETE', 'ALL'))`);
    expect(unscoped).toEqual([]);
    expect(rows.filter((r) => r.trunc || r.trig || r.refs).map((r) => r.t)).toEqual([]);
  });

  it("no function is executable by PUBLIC, and every SECURITY DEFINER function pins its search path", async () => {
    const publicExec = await q<{ f: string }>(sql`
      select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('public', p.oid, 'EXECUTE')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1`);
    expect(publicExec.map((r) => r.f)).toEqual([]);
    const unpinned = await q<{ f: string }>(sql`
      select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
      order by 1`);
    expect(unpinned.map((r) => r.f)).toEqual([]);
  });

  it("every policy is scoped: none is unconditionally true for writes", async () => {
    const open = await q<{ t: string; p: string }>(sql`
      select tablename as t, policyname as p from pg_policies
      where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        and (coalesce(trim(qual), '') in ('true', '') and coalesce(trim(with_check), '') in ('true', ''))
      order by 1, 2`);
    expect(open).toEqual([]);
  });

  it("with no request context the runtime role sees no tenant data", async () => {
    const tables = await q<{ t: string }>(sql`
      select c.table_name as t from information_schema.columns c join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
      where c.table_schema = 'public' and c.column_name = 'school_id' and tb.table_type = 'BASE TABLE' order by 1`);
    const visible: string[] = [];
    await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', '', true), set_config('app.school_id', '', true), set_config('app.platform_admin', 'off', true)`);
      for (const { t } of tables) {
        const [can] = (await tx.execute(sql`select has_table_privilege(current_user, ${t}, 'SELECT') as ok`)) as unknown as { ok: boolean }[];
        if (!can?.ok) continue; // not readable at all by the runtime role
        const [r] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)}`)) as unknown as { n: number }[];
        if ((r?.n ?? 0) > 0) visible.push(t);
      }
    });
    expect(visible).toEqual([]);
  });
});
