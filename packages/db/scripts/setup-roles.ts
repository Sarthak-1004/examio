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
    update: ["name", "board_id", "medium_id", "timezone", "status", "address", "contact_email", "contact_phone"],
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
    select: ["id", "school_id", "role", "recipient_label", "invited_by", "expires_at", "accepted_by", "accepted_at", "revoked_at", "created_at"],
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
    for (const table of tables) {
      const g = TABLE_GRANTS[table]!;
      const t = ident(table);
      if (g.select === true) await tx.unsafe(`grant select on ${t} to examio_app`);
      else if (g.select && g.select.length > 0) await tx.unsafe(`grant select (${cols(g.select)}) on ${t} to examio_app`);
      if (g.insert) await tx.unsafe(`grant insert on ${t} to examio_app`);
      if (g.update && g.update.length > 0) await tx.unsafe(`grant update (${cols(g.update)}) on ${t} to examio_app`);
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
