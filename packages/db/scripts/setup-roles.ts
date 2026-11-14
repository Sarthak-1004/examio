import postgres from "postgres";
import { requireEnv } from "./env";
import { targetFromArgs, targetUrls } from "./target";

/**
 * Creates the restricted application role `examio_app` (subject to RLS, not a table owner)
 * and applies its least-privilege grants. Idempotent; run before and after migrations
 * (`pnpm db:migrate` does both).
 * Usage: tsx scripts/setup-roles.ts [--test | --e2e]
 *
 * Every table in schema `public` must have an entry in TABLE_GRANTS. A new table without
 * one fails this script, so runtime access is always a reviewed decision.
 */
interface TableGrant {
  /** `true` grants SELECT on every column; a list restricts it to those columns. Omit for no SELECT. */
  select?: true | readonly string[];
  insert?: boolean;
  /** Columns the runtime role may UPDATE. Omit for no UPDATE. */
  update?: readonly string[];
  delete?: boolean;
}

const TABLE_GRANTS: Readonly<Record<string, TableGrant>> = {
  // Lookups are archived through `active`, never deleted.
  boards: { select: true, insert: true, update: ["name", "active"] },
  mediums: { select: true, insert: true, update: ["name", "active"] },
  // `code` is immutable (it prefixes usernames); schools are suspended, never deleted.
  schools: {
    select: true,
    insert: true,
    update: ["name", "board_id", "medium_id", "timezone", "status", "address", "contact_email", "contact_phone", "short_name", "brand_color"],
  },
  // password_hash is not selectable and is_platform_admin is not updatable by the runtime role.
  users: {
    select: ["id", "full_name", "email", "phone", "username", "is_platform_admin", "status", "must_change_password", "created_at"],
    insert: true,
    update: ["full_name", "email", "phone", "username", "password_hash", "status", "must_change_password"],
  },
  sessions: { select: true, insert: true, update: ["expires_at"], delete: true },
  // Memberships are revoked, never deleted; school, user and role are immutable.
  school_memberships: { select: true, insert: true, update: ["status"] },
  // Append-only.
  audit_events: { select: true, insert: true },
  // No direct access: reached only through rate_limit_hit() / rate_limit_refund().
  rate_limit_buckets: {},
  // No direct access: reached only through the auth_* account-code functions.
  account_tokens: {},
  // token_hash is not selectable; an open invitation can only be revoked.
  membership_invitations: {
    select: ["id", "school_id", "role", "recipient_label", "invited_by", "expires_at", "accepted_by", "accepted_at", "revoked_at", "student_id", "relationship", "created_at"],
    insert: true,
    update: ["revoked_at"],
  },
  // A grant can be opened and ended, never extended, reassigned or deleted.
  support_access_grants: { select: true, insert: true, update: ["ended_at"] },
  // No direct access: reached only through the auth_mfa_* functions.
  user_mfa: {},
  user_mfa_recovery_codes: {},
  // No direct access: reached only through the job_* / worker_* functions.
  jobs: {},
  worker_heartbeats: {},
  // Recipients (and their school's admins) read; only read_at is changed directly.
  notifications: { select: true, update: ["read_at"] },
  // Own rows only (RLS); the stored response is written once the operation completes.
  idempotency_records: { select: true, insert: true, update: ["response", "completed_at"] },
  // Visible per RLS; users create quarantined uploads and may only mark a file deleted.
  files: { select: true, insert: true, update: ["status", "deleted_at"] },
  // Academic setup (Phase 3): admins edit; delete only succeeds for unreferenced rows (RESTRICT FKs).
  academic_years: { select: true, insert: true, update: ["name", "starts_on", "ends_on", "status", "updated_at"], delete: true },
  classes: { select: true, insert: true, update: ["name", "sort_order", "archived_at"], delete: true },
  sections: { select: true, insert: true, update: ["name", "capacity", "archived_at"], delete: true },
  subjects: { select: true, insert: true, update: ["name", "archived_at"], delete: true },
  class_subjects: { select: true, insert: true, delete: true },
  grading_schemes: { select: true, insert: true, update: ["name", "pass_bp", "is_default", "archived_at", "updated_at"], delete: true },
  grading_bands: { select: true, insert: true, delete: true },
  calendar_events: { select: true, insert: true, update: ["title", "kind", "starts_on", "ends_on"], delete: true },
  attendance_sessions: { select: true, insert: true, update: ["name", "sort_order", "archived_at"], delete: true },
  // Staff (Phase 4): never deleted; people leave (status), assignments end (ends_on).
  staff_profiles: { select: true, insert: true, update: ["employee_no", "display_name", "job_title", "status", "joined_on", "left_on", "updated_at"] },
  teacher_assignments: { select: true, insert: true, update: ["ends_on"] },
  class_teachers: { select: true, insert: true, update: ["ends_on"] },
  // Phase 5. The admission number is fixed once created (the student's username is built from it).
  student_profiles: { select: true, insert: true, update: ["display_name", "date_of_birth", "admitted_on", "status", "left_on", "leave_reason", "updated_at"] },
  // Enrollments are ended, never deleted or moved; the roll number may be corrected.
  enrollments: { select: true, insert: true, update: ["roll_no", "ends_on", "end_reason"] },
  guardian_links: { select: true, insert: true, update: ["revoked_at"] },
  student_documents: { select: true, insert: true, update: ["removed_at"] },
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}
const cols = (names: readonly string[]) => names.map(ident).join(", ");

const url = targetUrls(targetFromArgs(), "set up roles on").ownerUrl;
const appPassword = requireEnv("EXAMIO_APP_DB_PASSWORD");
const sql = postgres(url, { max: 1 });

try {
  const exists = await sql`select 1 from pg_roles where rolname = 'examio_app'`;
  if (exists.length === 0) {
    await sql.unsafe(
      `create role examio_app login password '${appPassword.replace(/'/g, "''")}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
    );
    console.log("Created role examio_app");
  }

  // A pre-existing role is verified rather than trusted.
  const [attrs] = await sql<{ unsafe: boolean }[]>`
    select (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) as unsafe
    from pg_roles where rolname = 'examio_app'`;
  if (!attrs || attrs.unsafe) {
    throw new Error(
      "Role examio_app has SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Remove these attributes before continuing.",
    );
  }
  const owned = await sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and pg_has_role('examio_app', tableowner, 'USAGE')`;
  if (owned.length > 0) {
    throw new Error(
      `Role examio_app owns or inherits ownership of: ${owned.map((t) => t.tablename).join(", ")}. The runtime role must not own tables.`,
    );
  }

  const [row] = await sql<{ db: string }[]>`select current_database() as db`;
  const db = row!.db;
  const tables = (await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`).map(
    (t) => t.tablename,
  );
  const unlisted = tables.filter((t) => !(t in TABLE_GRANTS));
  if (unlisted.length > 0) {
    throw new Error(
      `No runtime grants are defined for table(s): ${unlisted.join(", ")}. Add them to TABLE_GRANTS in packages/db/scripts/setup-roles.ts.`,
    );
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(`grant connect on database "${db.replace(/"/g, '""')}" to examio_app`);
    await tx.unsafe(`grant usage on schema public to examio_app`);

    // Tables: start from nothing, then apply the manifest. No blanket default for future tables.
    await tx.unsafe(`alter default privileges in schema public revoke all on tables from examio_app`);
    await tx.unsafe(`revoke all on all tables in schema public from examio_app`);
    // This script runs before and after migrations; before, a column the manifest names may not
    // exist yet. Grant only existing columns: the run after the migration grants the rest.
    const existing = new Map<string, Set<string>>();
    for (const r of await tx<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`) {
      if (!existing.has(r.table_name)) existing.set(r.table_name, new Set());
      existing.get(r.table_name)!.add(r.column_name);
    }
    const present = (table: string, names: readonly string[]) => names.filter((c) => existing.get(table)?.has(c));

    for (const table of tables) {
      const g = TABLE_GRANTS[table]!;
      const t = ident(table);
      const selectCols = g.select === true || !g.select ? [] : present(table, g.select);
      const updateCols = present(table, g.update ?? []);
      if (g.select === true) await tx.unsafe(`grant select on ${t} to examio_app`);
      else if (selectCols.length > 0) await tx.unsafe(`grant select (${cols(selectCols)}) on ${t} to examio_app`);
      if (g.insert) await tx.unsafe(`grant insert on ${t} to examio_app`);
      if (updateCols.length > 0) await tx.unsafe(`grant update (${cols(updateCols)}) on ${t} to examio_app`);
      if (g.delete) await tx.unsafe(`grant delete on ${t} to examio_app`);
    }

    await tx.unsafe(`grant usage, select on all sequences in schema public to examio_app`);
    await tx.unsafe(`alter default privileges in schema public grant usage, select on sequences to examio_app`);

    // Functions: nothing for PUBLIC (present and future); the runtime role may execute them.
    await tx.unsafe(`alter default privileges revoke execute on functions from public`);
    await tx.unsafe(`revoke all on all functions in schema public from public`);
    await tx.unsafe(`alter default privileges in schema public grant execute on functions to examio_app`);
    await tx.unsafe(`grant execute on all functions in schema public to examio_app`);
  });
  console.log(`Role grants applied on ${db}.`);
} finally {
  await sql.end();
}
