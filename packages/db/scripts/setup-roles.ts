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
    update: ["name", "board_id", "medium_id", "timezone", "status", "address", "contact_email", "contact_phone", "short_name", "brand_color", "attendance_edit_days", "weekly_off_days", "attendance_locked_through"],
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
  // Phase 6. Attendance is changed in place (history in attendance_changes), never deleted.
  attendance_records: { select: true, insert: true, update: ["status", "note", "updated_by", "updated_at"] },
  attendance_changes: { select: true, insert: true },
  // Timetable periods are removed by a timestamp, never edited or deleted.
  timetable_slots: { select: true, insert: true, update: ["removed_at"] },
  // Phase 7. Homework is archived, attachments removed by a timestamp; nothing is deleted.
  homework: { select: true, insert: true, update: ["title", "instructions", "due_at", "allow_late", "status", "published_at", "updated_at"] },
  homework_files: { select: true, insert: true, update: ["removed_at"] },
  homework_submissions: { select: true, insert: true, update: ["body", "updated_at"] },
  submission_files: { select: true, insert: true, update: ["removed_at"] },
  submission_feedback: { select: true, insert: true, update: ["feedback", "returned_by", "returned_at"] },
  announcements: { select: true, insert: true, update: ["archived_at"] },
  // Phase 8. The ledger, invoice lines and payments are append-only for the runtime role; online
  // payments change state only through payment_record_provider_event().
  fee_heads: { select: true, insert: true, update: ["name", "tax_bp", "archived_at"] },
  fee_structures: { select: true, insert: true, update: ["name", "late_fee_paise", "late_grace_days", "status", "approved_by", "approved_at"] },
  // Items of a draft structure may be removed (policy: drafts only).
  fee_structure_items: { select: true, insert: true, delete: true },
  fee_concessions: { select: true, insert: true, update: ["status", "decided_by", "decided_at", "revoked_at"] },
  invoices: { select: true, insert: true, update: ["status", "cancelled_at"] },
  invoice_lines: { select: true, insert: true },
  payments: { select: true, insert: true },
  ledger_entries: { select: true, insert: true },
  fee_adjustments: { select: true, insert: true, update: ["status", "decided_by", "decided_at", "ledger_entry_id"] },
  // No direct access: reached only through payment_record_provider_event() / app_next_fee_number().
  payment_events: {},
  fee_counters: {},
  // Phase 9. Questions and versions are never deleted; a version is edited only until locked.
  topics: { select: true, insert: true, update: ["name", "sort_order", "archived_at"] },
  questions: { select: true, insert: true, update: ["topic_id", "status", "current_revision", "published_version_id", "updated_at"] },
  question_versions: { select: true, insert: true, update: ["type", "difficulty", "stem", "options", "answer_key", "explanation", "marks_x100", "negative_marks_x100", "image_file_id", "updated_at", "locked_at"] },
  // Phase 10. Attempt scores are written only by practice_submit(); items of a draft set may be removed.
  practice_sets: { select: true, insert: true, update: ["topic_id", "title", "instructions", "status", "attempt_limit", "feedback", "updated_at", "published_at"] },
  practice_set_items: { select: true, insert: true, delete: true },
  practice_assignments: { select: true, insert: true, update: ["opens_at", "closes_at", "removed_at"] },
  practice_attempts: { select: true, insert: true },
  practice_answers: { select: true, insert: true, update: ["response", "revision", "saved_at"] },
  // Phase 11. Attempts and answers are written only by exam_start / exam_save_answer / exam_set_flag /
  // exam_submit / exam_finalize_due; a published exam changes only by cancellation (trigger exams_guard).
  exams: { select: true, insert: true, update: ["title", "instructions", "status", "opens_at", "closes_at", "duration_minutes", "attempt_limit", "negative_marking", "updated_at", "submitted_by", "published_by", "published_at", "cancelled_by", "cancelled_at", "cancel_reason"] },
  exam_items: { select: true, insert: true, delete: true },
  exam_targets: { select: true, insert: true, delete: true },
  exam_accommodations: { select: true, insert: true, update: ["extra_minutes", "extra_attempts", "reason", "created_by", "updated_at"] },
  exam_attempts: { select: true },
  exam_answers: { select: true },
  // Phase 12. Marks, results and their history are written only by the exam_* / offline_* grading
  // functions; an offline assessment's details change only while it is a draft (policy).
  exam_result_sets: { select: true },
  exam_graders: { select: true, insert: true, delete: true },
  exam_marks: { select: true },
  exam_results: { select: true },
  offline_assessments: { select: true, insert: true, update: ["title", "held_on", "max_marks_x100", "updated_at"] },
  offline_assessment_targets: { select: true, insert: true, delete: true },
  offline_marks: { select: true },
  result_changes: { select: true },
  // Phase 13.1. The reference number is fixed; status changes follow admission_applications_guard.
  admission_applications: { select: true, insert: true, update: ["academic_year_id", "class_id", "applicant_name", "date_of_birth", "guardian_name", "guardian_phone", "guardian_email", "previous_school", "notes", "status", "decision_note", "decided_by", "decided_at", "student_id", "updated_at"] },
  admission_documents: { select: true, insert: true, update: ["required", "status", "file_id", "note", "updated_by", "updated_at"] },
  // The timeline is append-only.
  admission_events: { select: true, insert: true },
  // Phase 13.2. Copies and loans change state but are never deleted; titles are archived.
  library_settings: { select: true, insert: true, update: ["loan_days", "max_renewals", "max_loans_student", "max_loans_staff", "fine_per_day_paise", "updated_at"] },
  library_titles: { select: true, insert: true, update: ["title", "author", "isbn", "publisher", "category", "archived_at"] },
  library_copies: { select: true, insert: true, update: ["shelf", "status", "note", "updated_at"] },
  library_loans: { select: true, insert: true, update: ["due_on", "renewals", "status", "closed_by", "closed_at", "closed_on", "charge_adjustment_id"] },
  // Phase 13.3. Movements and asset events are append-only; stock never below zero (check).
  inventory_locations: { select: true, insert: true, update: ["name", "archived_at"] },
  inventory_items: { select: true, insert: true, update: ["name", "category", "unit", "reorder_level", "archived_at"] },
  inventory_assets: { select: true, insert: true, update: ["serial_no", "location_id", "status", "note", "updated_at"] },
  inventory_allocations: { select: true, insert: true, update: ["returned_by", "returned_at", "return_note"] },
  inventory_stock: { select: true, insert: true, update: ["quantity", "updated_at"] },
  inventory_movements: { select: true, insert: true },
  inventory_asset_events: { select: true, insert: true },
  // Phase 13.4. Capacity is checked by triggers; assignments are only ended, never changed otherwise.
  transport_vehicles: { select: true, insert: true, update: ["capacity", "description", "archived_at"] },
  transport_routes: { select: true, insert: true, update: ["name", "vehicle_id", "driver_staff_id", "attendant_staff_id", "archived_at", "updated_at"] },
  transport_stops: { select: true, insert: true, update: ["name", "sequence", "pickup_minute", "drop_minute"] },
  transport_assignments: { select: true, insert: true, update: ["ended_on", "ended_by"] },
  // Phase 14.1. Employment history is append-only; HR documents are removed by marking.
  hr_departments: { select: true, insert: true, update: ["name", "archived_at"] },
  hr_designations: { select: true, insert: true, update: ["name", "archived_at"] },
  hr_employment: { select: true, insert: true, update: ["employment_type", "department_id", "designation_id", "confirmed_on", "notice_days", "emergency_name", "emergency_phone", "updated_by", "updated_at"] },
  hr_employment_events: { select: true, insert: true },
  hr_payment_details: { select: true, insert: true, update: ["account_holder", "account_no", "ifsc", "pan", "updated_by", "updated_at"] },
  hr_documents: { select: true, insert: true, update: ["removed_at", "removed_by"] },
  // Phase 14.2. Requests change only status and decision (trigger hr_leave_requests_guard); a cleared register mark has status NULL.
  hr_leave_types: { select: true, insert: true, update: ["name", "paid", "quota_halves", "archived_at"] },
  hr_leave_requests: { select: true, insert: true, update: ["status", "decided_by", "decided_at", "decision_note"] },
  hr_staff_attendance: { select: true, insert: true, update: ["status", "leave_request_id", "marked_by", "marked_at"] },
  hr_staff_attendance_changes: { select: true, insert: true },
  // Phase 14.3. Salary versions are insert-only; slips change only while their run is a draft (RLS).
  payroll_components: { select: true, insert: true, update: ["name", "prorate", "cap_paise", "sort_order", "archived_at"] },
  staff_salaries: { select: true, insert: true },
  staff_salary_lines: { select: true, insert: true },
  payroll_runs: { select: true, insert: true, update: ["calculated_at", "calculated_by", "status", "approved_by", "approved_at", "paid_at"] },
  payroll_slips: { select: true, insert: true, update: ["salary_id", "included", "month_working_halves", "working_halves", "lop_halves", "payable_halves", "basic_paise", "earned_basic_paise", "gross_paise", "deductions_paise", "net_paise", "lines", "inputs", "calculated_at"] },
  // Phase 14.4. Payments are voided, never changed; adjustments only change status and the run that pays them (triggers).
  payroll_payments: { select: true, insert: true, update: ["voided_at", "voided_by", "void_reason"] },
  payroll_adjustments: { select: true, insert: true, update: ["status", "decided_by", "decided_at", "decision_note", "applied_run_id"] },
  // Phase 15.1. Written by platform administrators only (policies); subscription history is append-only.
  platform_plans: { select: true, insert: true, update: ["name", "modules", "max_students", "price_paise", "period_months", "archived_at"] },
  school_subscriptions: { select: true, insert: true, update: ["plan_id", "starts_on", "ends_on", "modules_added", "modules_removed", "max_students_override", "updated_by", "updated_at"] },
  subscription_events: { select: true, insert: true },
  platform_invoices: { select: true, insert: true, update: ["status", "paid_on", "payment_reference", "recorded_by", "recorded_at", "cancelled_reason"] },
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
