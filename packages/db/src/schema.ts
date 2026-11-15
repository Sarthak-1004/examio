import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ */
/* Platform-wide lookup tables (not tenant-owned)                      */
/* ------------------------------------------------------------------ */

export const boards = pgTable("boards", {
  id: id(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const mediums = pgTable("mediums", {
  id: id(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/* Tenants                                                             */
/* ------------------------------------------------------------------ */

export const schoolStatus = pgEnum("school_status", ["onboarding", "active", "suspended"]);

export const schools = pgTable("schools", {
  id: id(),
  name: text("name").notNull(),
  /** Short unique code, lowercase letters/digits. Prefix for student usernames. */
  code: text("code").notNull().unique(),
  boardId: uuid("board_id").notNull().references(() => boards.id),
  mediumId: uuid("medium_id").notNull().references(() => mediums.id),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  status: schoolStatus("status").notNull().default("onboarding"),
  address: text("address"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  /** Short name for headers and printouts, e.g. "GVPS". */
  shortName: text("short_name"),
  /** Accent colour for the school's pages, #rrggbb. */
  brandColor: text("brand_color"),
  /** Attendance (Phase 6): days after a date during which teachers may still mark or change it. */
  attendanceEditDays: integer("attendance_edit_days").notNull().default(3),
  /** ISO weekdays with no school (1 = Monday … 7 = Sunday). */
  weeklyOffDays: integer("weekly_off_days").array().notNull().default(sql`'{7}'::integer[]`),
  /** Attendance on or before this date is locked; only administrators correct it, with a reason. */
  attendanceLockedThrough: date("attendance_locked_through"),
  createdAt: createdAt(),
}, (t) => [
  check("schools_code_format", sql`${t.code} ~ '^[a-z0-9]{2,12}$'`),
  check("schools_short_name_length", sql`${t.shortName} is null or char_length(${t.shortName}) between 1 and 30`),
  check("schools_brand_color_format", sql`${t.brandColor} is null or ${t.brandColor} ~ '^#[0-9a-f]{6}$'`),
  check("schools_attendance_edit_days", sql`${t.attendanceEditDays} between 0 and 31`),
  check("schools_weekly_off_days", sql`${t.weeklyOffDays} <@ array[1,2,3,4,5,6,7] and cardinality(${t.weeklyOffDays}) <= 6`),
]);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const users = pgTable("users", {
  id: id(),
  fullName: text("full_name").notNull(),
  /** Lowercased. Unique when present. */
  email: text("email"),
  /** Digits only (e.g. 9876543210). NOT unique: siblings may share a parent's phone. */
  phone: text("phone"),
  /** Lowercased. Unique when present. Students get school code + admission no. */
  username: text("username"),
  passwordHash: text("password_hash").notNull(),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  status: userStatus("status").notNull().default("active"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("users_email_unique").on(t.email),
  uniqueIndex("users_username_unique").on(t.username),
  index("users_phone_idx").on(t.phone),
  check("users_has_identifier", sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL OR ${t.username} IS NOT NULL`),
]);

/** Session tokens are stored only as SHA-256 hashes. Not RLS-protected (no personal data). */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token) hex
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** True between a correct password and a correct second factor; such a session grants nothing. */
  pendingMfa: boolean("pending_mfa").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const membershipRole = pgEnum("membership_role", ["school_admin", "teacher", "student", "parent", "finance"]);
export const membershipStatus = pgEnum("membership_status", ["active", "revoked"]);

export const schoolMemberships = pgTable("school_memberships", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: membershipRole("role").notNull(),
  status: membershipStatus("status").notNull().default("active"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("memberships_school_user_role_unique").on(t.schoolId, t.userId, t.role),
  index("memberships_user_idx").on(t.userId),
]);

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export const auditEvents = pgTable("audit_events", {
  id: id(),
  /** NULL for platform-level events. */
  schoolId: uuid("school_id").references(() => schools.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  data: jsonb("data"),
  createdAt: createdAt(),
}, (t) => [index("audit_school_created_idx").on(t.schoolId, t.createdAt)]);

/* ------------------------------------------------------------------ */
/* Infrastructure (not tenant-owned)                                   */
/* ------------------------------------------------------------------ */

/**
 * Fixed-window rate-limit counters shared by every server instance.
 * `key` is a SHA-256 hash, so identifiers and addresses are never stored.
 * The runtime role has no privileges on this table: it is reached only through the
 * rate_limit_hit() / rate_limit_refund() database functions.
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
}, (t) => [index("rate_limit_reset_idx").on(t.resetAt)]);

/* ------------------------------------------------------------------ */
/* Account recovery and invitations                                    */
/* ------------------------------------------------------------------ */

export const accountTokenPurpose = pgEnum("account_token_purpose", ["activation", "password_reset"]);

/**
 * Single-use codes that let a user set their own password (first activation or reset).
 * Only the SHA-256 hash of the code is stored. Global identity table: the runtime role has
 * no privileges on it and reaches it only through the auth_* database functions.
 */
export const accountTokens = pgTable("account_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  purpose: accountTokenPurpose("purpose").notNull(),
  tokenHash: text("token_hash").notNull(),
  /** School whose administrator issued the code; NULL when issued at platform level. */
  schoolId: uuid("school_id").references(() => schools.id),
  /** NULL only for the operator-run administrator bootstrap. */
  issuedBy: uuid("issued_by").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("account_tokens_hash_unique").on(t.tokenHash),
  index("account_tokens_user_idx").on(t.userId),
  index("account_tokens_expires_idx").on(t.expiresAt),
]);

/**
 * A school's offer of membership to someone who already has an account (for example a
 * teacher or parent known to another school). The recipient accepts while signed in, which
 * is their consent. School-admin membership is never offered this way.
 */
export const membershipInvitations = pgTable("membership_invitations", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  role: membershipRole("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  /** Who the code was handed to, in the school's own words. Not used for authorization. */
  recipientLabel: text("recipient_label").notNull(),
  invitedBy: uuid("invited_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** Parent invitations may name the child; accepting creates the guardian link (Phase 5). */
  studentId: uuid("student_id"),
  relationship: text("relationship"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("membership_invitations_hash_unique").on(t.tokenHash),
  index("membership_invitations_school_idx").on(t.schoolId, t.createdAt),
  check("membership_invitations_not_admin", sql`${t.role} <> 'school_admin'`),
  check("membership_invitations_label_length", sql`char_length(${t.recipientLabel}) between 1 and 200`),
  check("membership_invitations_child_only_for_parent", sql`${t.studentId} is null or ${t.role} = 'parent'`),
  check("membership_invitations_relationship", sql`(${t.studentId} is null) = (${t.relationship} is null) and (${t.relationship} is null or ${t.relationship} in ('mother', 'father', 'guardian', 'other'))`),
]);

/* ------------------------------------------------------------------ */
/* Platform support access                                             */
/* ------------------------------------------------------------------ */

/**
 * A platform administrator has no routine access to the people and records of a school.
 * To help a school they open a short, reasoned grant for that one school; the grant and its
 * reason are visible to the administrators of that school and recorded in its audit log.
 * A grant cannot be extended: a new one must be opened.
 */
export const supportAccessGrants = pgTable("support_access_grants", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  platformUserId: uuid("platform_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("support_access_school_idx").on(t.schoolId, t.createdAt),
  index("support_access_user_idx").on(t.platformUserId, t.expiresAt),
  check("support_access_reason_length", sql`char_length(${t.reason}) between 10 and 500`),
  check("support_access_duration", sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '4 hours'`),
]);

/* ------------------------------------------------------------------ */
/* Two-step sign-in (authenticator app)                                */
/* ------------------------------------------------------------------ */

/**
 * One authenticator-app secret per user. The secret is encrypted by the application before it
 * is stored. Global identity table: no runtime privileges; reached only through auth_mfa_*.
 */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  secretEnc: text("secret_enc").notNull(),
  /** NULL while enrolment is pending; the second factor is enforced only once confirmed. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  /** Highest 30-second time step already accepted; a code is never accepted twice. */
  lastUsedStep: bigint("last_used_step", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
});

/** Single-use backup codes for a lost authenticator; stored as SHA-256 hashes. */
export const userMfaRecoveryCodes = pgTable("user_mfa_recovery_codes", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("user_mfa_recovery_hash_unique").on(t.codeHash),
  index("user_mfa_recovery_user_idx").on(t.userId),
]);

/* ------------------------------------------------------------------ */
/* Background jobs (outbox)                                            */
/* ------------------------------------------------------------------ */

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "dead"]);

/**
 * Durable work queue. A job is written in the same transaction as the business change that
 * needs it (outbox pattern) and run later by the worker, with retries and a dead-letter state.
 * Payloads carry identifiers only, never personal data. No runtime table privileges: reached
 * only through the job_* database functions.
 */
export const jobs = pgTable("jobs", {
  id: id(),
  schoolId: uuid("school_id").references(() => schools.id),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  /** Enqueuing the same kind + key again returns the existing job instead of a duplicate. */
  dedupeKey: text("dedupe_key"),
  status: jobStatus("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  lockedBy: text("locked_by"),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("jobs_kind_dedupe_unique").on(t.kind, t.dedupeKey),
  index("jobs_due_idx").on(t.status, t.runAt),
  index("jobs_school_idx").on(t.schoolId),
  check("jobs_kind_format", sql`${t.kind} ~ '^[a-z][a-z0-9_.]{2,63}$'`),
  check("jobs_attempts_range", sql`${t.maxAttempts} between 1 and 25 and ${t.attempts} >= 0`),
  check("jobs_payload_size", sql`octet_length(${t.payload}::text) <= 8192`),
]);

/** Last time each worker process reported in; used for monitoring. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export const notificationChannel = pgEnum("notification_channel", ["in_app", "email"]);
export const notificationStatus = pgEnum("notification_status", ["pending", "delivered", "sandboxed", "failed"]);

/**
 * One message to one person on one channel. Created with a delivery job in the same
 * transaction; the worker delivers it through the configured provider adapter. In sandbox
 * mode email is recorded here and never sent.
 */
export const notifications = pgTable("notifications", {
  id: id(),
  schoolId: uuid("school_id").references(() => schools.id),
  recipientUserId: uuid("recipient_user_id").notNull().references(() => users.id),
  channel: notificationChannel("channel").notNull(),
  template: text("template").notNull(),
  params: jsonb("params").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: notificationStatus("status").notNull().default("pending"),
  provider: text("provider"),
  providerRef: text("provider_ref"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("notifications_dedupe_unique").on(t.dedupeKey, t.recipientUserId, t.channel),
  index("notifications_recipient_idx").on(t.recipientUserId, t.createdAt),
  index("notifications_school_idx").on(t.schoolId, t.createdAt),
  check("notifications_params_size", sql`octet_length(${t.params}::text) <= 4096`),
]);

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

/**
 * Remembers the outcome of a retriable operation so a repeated request with the same key
 * returns the first result instead of acting twice. Scoped to the acting user.
 */
export const idempotencyRecords = pgTable("idempotency_records", {
  id: id(),
  schoolId: uuid("school_id").references(() => schools.id),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("idempotency_scope_unique").on(t.actorUserId, t.operation, t.key),
  index("idempotency_expires_idx").on(t.expiresAt),
  check("idempotency_key_format", sql`char_length(${t.key}) between 8 and 128`),
]);

/* ------------------------------------------------------------------ */
/* Private files                                                       */
/* ------------------------------------------------------------------ */

export const fileStatus = pgEnum("file_status", ["quarantined", "clean", "rejected", "deleted"]);

/**
 * A stored file belonging to one school. The bytes live in the storage adapter under a random
 * key; this row records ownership, the detected type and the scan result. Uploads start
 * quarantined and can be downloaded only once a scan marks them clean. Exports (files the
 * system generates) carry an expiry after which they cannot be downloaded and are purged.
 */
export const files = pgTable("files", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
  purpose: text("purpose").notNull(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  status: fileStatus("status").notNull().default("quarantined"),
  scanResult: text("scan_result"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /** When the stored bytes were removed (rejected, deleted or expired files). */
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("files_storage_key_unique").on(t.storageKey),
  uniqueIndex("files_school_id_unique").on(t.schoolId, t.id),
  index("files_school_idx").on(t.schoolId, t.createdAt),
  index("files_uploader_idx").on(t.uploadedBy),
  check("files_purpose_format", sql`${t.purpose} ~ '^[a-z][a-z0-9_]{2,40}$'`),
  check("files_name_length", sql`char_length(${t.originalName}) between 1 and 200`),
  check("files_size_range", sql`${t.sizeBytes} between 1 and 52428800`),
  check("files_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("files_storage_key_format", sql`${t.storageKey} ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'`),
]);

/* ------------------------------------------------------------------ */
/* Academic setup (Phase 3)                                            */
/* ------------------------------------------------------------------ */
/*
 * Every table carries school_id. Rows that point at other setup rows do so with composite
 * foreign keys (school_id, id), so a section can never belong to another school's year or
 * class. Referenced rows cannot be deleted (RESTRICT); they are archived instead.
 */

export const academicYearStatus = pgEnum("academic_year_status", ["planned", "current", "closed"]);

export const academicYears = pgTable("academic_years", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  status: academicYearStatus("status").notNull().default("planned"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("academic_years_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("academic_years_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  uniqueIndex("academic_years_one_current").on(t.schoolId).where(sql`${t.status} = 'current'`),
  check("academic_years_name_length", sql`char_length(${t.name}) between 1 and 40`),
  check("academic_years_dates", sql`${t.startsOn} < ${t.endsOn} and ${t.endsOn} <= ${t.startsOn} + 731`),
]);

export const classes = pgTable("classes", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("classes_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("classes_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  check("classes_name_length", sql`char_length(${t.name}) between 1 and 40`),
  check("classes_sort_order_range", sql`${t.sortOrder} between -1000 and 1000`),
]);

export const sections = pgTable("sections", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  classId: uuid("class_id").notNull(),
  name: text("name").notNull(),
  capacity: integer("capacity"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "sections_year_fk", columns: [t.schoolId, t.academicYearId], foreignColumns: [academicYears.schoolId, academicYears.id] }),
  foreignKey({ name: "sections_class_fk", columns: [t.schoolId, t.classId], foreignColumns: [classes.schoolId, classes.id] }),
  uniqueIndex("sections_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("sections_school_year_id_unique").on(t.schoolId, t.academicYearId, t.id),
  uniqueIndex("sections_year_class_name_unique").on(t.schoolId, t.academicYearId, t.classId, sql`lower(${t.name})`),
  index("sections_year_idx").on(t.schoolId, t.academicYearId),
  check("sections_name_length", sql`char_length(${t.name}) between 1 and 20`),
  check("sections_capacity_range", sql`${t.capacity} is null or ${t.capacity} between 1 and 500`),
]);

export const subjects = pgTable("subjects", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  code: text("code").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("subjects_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("subjects_school_code_unique").on(t.schoolId, t.code),
  uniqueIndex("subjects_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  check("subjects_name_length", sql`char_length(${t.name}) between 1 and 80`),
  check("subjects_code_format", sql`${t.code} ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'`),
]);

export const classSubjects = pgTable("class_subjects", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  classId: uuid("class_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "class_subjects_year_fk", columns: [t.schoolId, t.academicYearId], foreignColumns: [academicYears.schoolId, academicYears.id] }),
  foreignKey({ name: "class_subjects_class_fk", columns: [t.schoolId, t.classId], foreignColumns: [classes.schoolId, classes.id] }),
  foreignKey({ name: "class_subjects_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  uniqueIndex("class_subjects_unique").on(t.schoolId, t.academicYearId, t.classId, t.subjectId),
  index("class_subjects_subject_idx").on(t.schoolId, t.subjectId),
]);

/**
 * A grading scheme turns a percentage into a grade. Percentages are stored in basis points
 * (hundredths of a percent, 0-10000) so comparisons are exact. Bands are defined by their lower
 * bound: a band applies from its minimum up to the next band's minimum; the highest band
 * includes 100%. Every scheme has a band starting at 0, so every percentage gets a grade.
 */
export const gradingSchemes = pgTable("grading_schemes", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  passBp: integer("pass_bp").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("grading_schemes_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("grading_schemes_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  uniqueIndex("grading_schemes_one_default").on(t.schoolId).where(sql`${t.isDefault} and ${t.archivedAt} is null`),
  check("grading_schemes_name_length", sql`char_length(${t.name}) between 1 and 60`),
  check("grading_schemes_pass_range", sql`${t.passBp} between 0 and 10000`),
]);

export const gradingBands = pgTable("grading_bands", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  schemeId: uuid("scheme_id").notNull(),
  label: text("label").notNull(),
  minBp: integer("min_bp").notNull(),
  description: text("description"),
}, (t) => [
  foreignKey({ name: "grading_bands_scheme_fk", columns: [t.schoolId, t.schemeId], foreignColumns: [gradingSchemes.schoolId, gradingSchemes.id] }).onDelete("cascade"),
  uniqueIndex("grading_bands_scheme_min_unique").on(t.schemeId, t.minBp),
  uniqueIndex("grading_bands_scheme_label_unique").on(t.schemeId, sql`lower(${t.label})`),
  check("grading_bands_label_length", sql`char_length(${t.label}) between 1 and 10`),
  check("grading_bands_min_range", sql`${t.minBp} between 0 and 10000`),
  check("grading_bands_description_length", sql`${t.description} is null or char_length(${t.description}) <= 100`),
]);

export const calendarEventKind = pgEnum("calendar_event_kind", ["holiday", "event", "exam"]);

/** School calendar: holidays, events and exam periods, as local dates within an academic year. */
export const calendarEvents = pgTable("calendar_events", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  title: text("title").notNull(),
  kind: calendarEventKind("kind").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "calendar_events_year_fk", columns: [t.schoolId, t.academicYearId], foreignColumns: [academicYears.schoolId, academicYears.id] }),
  index("calendar_events_year_idx").on(t.schoolId, t.academicYearId, t.startsOn),
  check("calendar_events_title_length", sql`char_length(${t.title}) between 1 and 120`),
  check("calendar_events_dates", sql`${t.startsOn} <= ${t.endsOn}`),
]);

/** Attendance sessions a school takes each day, e.g. "Full day", or "Morning" and "Afternoon". */
export const attendanceSessions = pgTable("attendance_sessions", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("attendance_sessions_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("attendance_sessions_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  check("attendance_sessions_name_length", sql`char_length(${t.name}) between 1 and 40`),
]);

/* ------------------------------------------------------------------ */
/* Staff and assignments (Phase 4)                                     */
/* ------------------------------------------------------------------ */

export const staffStatus = pgEnum("staff_status", ["active", "left"]);

/**
 * A person's employment record at one school. Access comes from their school membership; this
 * row holds the school's own details (employee number, display name, job title, dates). One
 * profile per user per school; a user may have profiles at several schools.
 */
export const staffProfiles = pgTable("staff_profiles", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  employeeNo: text("employee_no").notNull(),
  displayName: text("display_name").notNull(),
  jobTitle: text("job_title"),
  status: staffStatus("status").notNull().default("active"),
  joinedOn: date("joined_on"),
  leftOn: date("left_on"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("staff_profiles_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("staff_profiles_school_user_unique").on(t.schoolId, t.userId),
  uniqueIndex("staff_profiles_school_employee_no_unique").on(t.schoolId, sql`lower(${t.employeeNo})`),
  index("staff_profiles_user_idx").on(t.userId),
  check("staff_profiles_employee_no_format", sql`${t.employeeNo} ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$'`),
  check("staff_profiles_display_name_length", sql`char_length(${t.displayName}) between 2 and 120`),
  check("staff_profiles_job_title_length", sql`${t.jobTitle} is null or char_length(${t.jobTitle}) between 1 and 80`),
  check("staff_profiles_left_after_joined", sql`${t.leftOn} is null or ${t.joinedOn} is null or ${t.leftOn} >= ${t.joinedOn}`),
  check("staff_profiles_left_has_date", sql`(${t.status} = 'left') = (${t.leftOn} is not null)`),
]);

/**
 * Who teaches which subject to which section, from when to when. Never deleted: an assignment is
 * ended by setting ends_on, so history (who taught 7A maths in March) survives.
 */
export const teacherAssignments = pgTable("teacher_assignments", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  staffId: uuid("staff_id").notNull(),
  academicYearId: uuid("academic_year_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "teacher_assignments_staff_fk", columns: [t.schoolId, t.staffId], foreignColumns: [staffProfiles.schoolId, staffProfiles.id] }),
  foreignKey({ name: "teacher_assignments_section_fk", columns: [t.schoolId, t.academicYearId, t.sectionId], foreignColumns: [sections.schoolId, sections.academicYearId, sections.id] }),
  foreignKey({ name: "teacher_assignments_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  uniqueIndex("teacher_assignments_one_open").on(t.schoolId, t.staffId, t.sectionId, t.subjectId).where(sql`${t.endsOn} is null`),
  index("teacher_assignments_staff_idx").on(t.schoolId, t.staffId),
  index("teacher_assignments_section_idx").on(t.schoolId, t.sectionId),
  check("teacher_assignments_dates", sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
]);

/** The class teacher of a section, from when to when. At most one open class teacher per section. */
export const classTeachers = pgTable("class_teachers", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  staffId: uuid("staff_id").notNull(),
  academicYearId: uuid("academic_year_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "class_teachers_staff_fk", columns: [t.schoolId, t.staffId], foreignColumns: [staffProfiles.schoolId, staffProfiles.id] }),
  foreignKey({ name: "class_teachers_section_fk", columns: [t.schoolId, t.academicYearId, t.sectionId], foreignColumns: [sections.schoolId, sections.academicYearId, sections.id] }),
  uniqueIndex("class_teachers_one_open").on(t.schoolId, t.sectionId).where(sql`${t.endsOn} is null`),
  index("class_teachers_staff_idx").on(t.schoolId, t.staffId),
  check("class_teachers_dates", sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
]);

/* ------------------------------------------------------------------ */
/* Students, enrollments and guardians (Phase 5)                       */
/* ------------------------------------------------------------------ */

export const studentStatus = pgEnum("student_status", ["active", "left"]);
export const studentLeaveReason = pgEnum("student_leave_reason", ["withdrawn", "transferred", "graduated", "other"]);

/**
 * A student's record at one school, linked to their own account (students sign in with a
 * username). The admission number is unique within the school and never reused for another
 * student; it is not unique across schools.
 */
export const studentProfiles = pgTable("student_profiles", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  admissionNo: text("admission_no").notNull(),
  displayName: text("display_name").notNull(),
  dateOfBirth: date("date_of_birth"),
  admittedOn: date("admitted_on").notNull(),
  status: studentStatus("status").notNull().default("active"),
  leftOn: date("left_on"),
  leaveReason: studentLeaveReason("leave_reason"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("student_profiles_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("student_profiles_school_user_unique").on(t.schoolId, t.userId),
  uniqueIndex("student_profiles_school_admission_unique").on(t.schoolId, sql`lower(${t.admissionNo})`),
  index("student_profiles_user_idx").on(t.userId),
  index("student_profiles_school_name_idx").on(t.schoolId, sql`lower(${t.displayName})`),
  check("student_profiles_admission_format", sql`${t.admissionNo} ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$'`),
  check("student_profiles_display_name_length", sql`char_length(${t.displayName}) between 2 and 120`),
  check("student_profiles_left_consistent", sql`(${t.status} = 'left') = (${t.leftOn} is not null and ${t.leaveReason} is not null)`),
  check("student_profiles_left_after_admitted", sql`${t.leftOn} is null or ${t.leftOn} >= ${t.admittedOn}`),
  check("student_profiles_birth_before_admission", sql`${t.dateOfBirth} is null or ${t.dateOfBirth} < ${t.admittedOn}`),
]);

export const enrollmentEndReason = pgEnum("enrollment_end_reason", ["promoted", "section_changed", "left", "corrected"]);

/**
 * A student in a section for a span of dates within one academic year. Moving section or
 * promotion ends one enrollment and starts another; rows are never deleted, so the history of
 * where a student was on any date survives. At most one open enrollment per student per year.
 */
export const enrollments = pgTable("enrollments", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  academicYearId: uuid("academic_year_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  rollNo: integer("roll_no"),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  endReason: enrollmentEndReason("end_reason"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("enrollments_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("enrollments_school_id_student_section_unique").on(t.schoolId, t.id, t.studentId, t.sectionId),
  foreignKey({ name: "enrollments_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "enrollments_section_fk", columns: [t.schoolId, t.academicYearId, t.sectionId], foreignColumns: [sections.schoolId, sections.academicYearId, sections.id] }),
  uniqueIndex("enrollments_one_open_per_year").on(t.schoolId, t.studentId, t.academicYearId).where(sql`${t.endsOn} is null`),
  uniqueIndex("enrollments_roll_unique_open").on(t.schoolId, t.sectionId, t.rollNo).where(sql`${t.endsOn} is null and ${t.rollNo} is not null`),
  index("enrollments_section_idx").on(t.schoolId, t.sectionId),
  index("enrollments_student_idx").on(t.schoolId, t.studentId),
  check("enrollments_dates", sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
  check("enrollments_end_reason", sql`(${t.endsOn} is null) = (${t.endReason} is null)`),
  check("enrollments_roll_range", sql`${t.rollNo} is null or ${t.rollNo} between 1 and 9999`),
]);

export const guardianRelationship = pgEnum("guardian_relationship", ["mother", "father", "guardian", "other"]);

/**
 * A parent or guardian's verified link to one student. A parent sees a child only through an
 * active link (not revoked). Links are created by the school: directly for an account it creates
 * or already knows as a parent, or when the parent accepts a code the school issued for that
 * child. Revoked links stay as history.
 */
export const guardianLinks = pgTable("guardian_links", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  guardianUserId: uuid("guardian_user_id").notNull().references(() => users.id),
  studentId: uuid("student_id").notNull(),
  relationship: guardianRelationship("relationship").notNull(),
  verifiedBy: uuid("verified_by").notNull().references(() => users.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "guardian_links_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  uniqueIndex("guardian_links_one_active").on(t.schoolId, t.guardianUserId, t.studentId).where(sql`${t.revokedAt} is null`),
  index("guardian_links_guardian_idx").on(t.guardianUserId),
  index("guardian_links_student_idx").on(t.schoolId, t.studentId),
]);

/**
 * Private documents on a student's record (birth certificate, transfer certificate, ...).
 * The bytes are a private file (purpose "student_document"); only the school's administrators
 * can list or download them. Removing a document hides it; the row stays as history.
 */
export const studentDocuments = pgTable("student_documents", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  fileId: uuid("file_id").notNull(),
  title: text("title").notNull(),
  addedBy: uuid("added_by").notNull().references(() => users.id),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "student_documents_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "student_documents_file_fk", columns: [t.schoolId, t.fileId], foreignColumns: [files.schoolId, files.id] }),
  uniqueIndex("student_documents_file_unique").on(t.fileId),
  index("student_documents_student_idx").on(t.schoolId, t.studentId),
  check("student_documents_title_length", sql`char_length(${t.title}) between 1 and 120`),
]);

/* ------------------------------------------------------------------ */
/* Attendance and timetable (Phase 6)                                  */
/* ------------------------------------------------------------------ */

export const attendanceStatus = pgEnum("attendance_status", ["present", "absent", "late", "excused"]);

/**
 * One student's attendance for one local school date and attendance session. A missing row
 * means "not recorded", which is different from absent. The enrollment fixes the student and
 * section (composite key), so a record can never point at another school's or another section's
 * student. Changes after the first marking are kept in attendance_changes.
 */
export const attendanceRecords = pgTable("attendance_records", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  enrollmentId: uuid("enrollment_id").notNull(),
  studentId: uuid("student_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  attendanceDate: date("attendance_date").notNull(),
  status: attendanceStatus("status").notNull(),
  note: text("note"),
  markedBy: uuid("marked_by").notNull().references(() => users.id),
  markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("attendance_records_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "attendance_records_enrollment_fk", columns: [t.schoolId, t.enrollmentId, t.studentId, t.sectionId], foreignColumns: [enrollments.schoolId, enrollments.id, enrollments.studentId, enrollments.sectionId] }),
  foreignKey({ name: "attendance_records_session_fk", columns: [t.schoolId, t.sessionId], foreignColumns: [attendanceSessions.schoolId, attendanceSessions.id] }),
  uniqueIndex("attendance_records_one_per_session").on(t.schoolId, t.enrollmentId, t.attendanceDate, t.sessionId),
  index("attendance_records_section_date_idx").on(t.schoolId, t.sectionId, t.attendanceDate),
  index("attendance_records_student_date_idx").on(t.schoolId, t.studentId, t.attendanceDate),
  check("attendance_records_note_length", sql`${t.note} is null or char_length(${t.note}) between 1 and 200`),
]);

/** Every change to an attendance record after it was first marked: who, when, from what, why. Append-only. */
export const attendanceChanges = pgTable("attendance_changes", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  recordId: uuid("record_id").notNull(),
  oldStatus: attendanceStatus("old_status").notNull(),
  newStatus: attendanceStatus("new_status").notNull(),
  reason: text("reason"),
  changedBy: uuid("changed_by").notNull().references(() => users.id),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "attendance_changes_record_fk", columns: [t.schoolId, t.recordId], foreignColumns: [attendanceRecords.schoolId, attendanceRecords.id] }),
  index("attendance_changes_record_idx").on(t.schoolId, t.recordId),
  check("attendance_changes_reason_length", sql`${t.reason} is null or char_length(${t.reason}) between 3 and 200`),
]);

/**
 * A weekly timetable period: a subject for a section on a weekday from one time to another,
 * optionally with a teacher and a room. Times are minutes after midnight in the school's time
 * zone. Clashes (same section, teacher or room at overlapping times on the same weekday in the
 * same year) are refused by exclusion constraints. Removed periods keep their row.
 */
export const timetableSlots = pgTable("timetable_slots", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  staffId: uuid("staff_id"),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  room: text("room"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  foreignKey({ name: "timetable_slots_section_fk", columns: [t.schoolId, t.academicYearId, t.sectionId], foreignColumns: [sections.schoolId, sections.academicYearId, sections.id] }),
  foreignKey({ name: "timetable_slots_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  foreignKey({ name: "timetable_slots_staff_fk", columns: [t.schoolId, t.staffId], foreignColumns: [staffProfiles.schoolId, staffProfiles.id] }),
  index("timetable_slots_section_idx").on(t.schoolId, t.sectionId, t.weekday),
  index("timetable_slots_staff_idx").on(t.schoolId, t.staffId, t.weekday),
  check("timetable_slots_weekday", sql`${t.weekday} between 1 and 7`),
  check("timetable_slots_times", sql`${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.endMinute} > ${t.startMinute}`),
  check("timetable_slots_room_length", sql`${t.room} is null or char_length(${t.room}) between 1 and 40`),
]);

/* ------------------------------------------------------------------ */
/* Homework and announcements (Phase 7)                                */
/* ------------------------------------------------------------------ */

export const homeworkStatus = pgEnum("homework_status", ["draft", "published", "archived"]);

/**
 * Homework set for one section and subject in one academic year. Students and their parents see
 * it once published, while the student is enrolled in the section; the due time is an instant
 * (shown in the school's time zone). Archived homework is hidden from families, never deleted.
 */
export const homework = pgTable("homework", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  instructions: text("instructions"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  allowLate: boolean("allow_late").notNull().default(false),
  status: homeworkStatus("status").notNull().default("published"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("homework_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "homework_section_fk", columns: [t.schoolId, t.academicYearId, t.sectionId], foreignColumns: [sections.schoolId, sections.academicYearId, sections.id] }),
  foreignKey({ name: "homework_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  index("homework_section_due_idx").on(t.schoolId, t.sectionId, t.dueAt),
  index("homework_author_idx").on(t.schoolId, t.authorUserId),
  check("homework_title_length", sql`char_length(${t.title}) between 1 and 150`),
  check("homework_instructions_length", sql`${t.instructions} is null or char_length(${t.instructions}) between 1 and 5000`),
  check("homework_published_at", sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`),
]);

/** A private file attached to homework (purpose "homework_attachment"). */
export const homeworkFiles = pgTable("homework_files", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  homeworkId: uuid("homework_id").notNull(),
  fileId: uuid("file_id").notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "homework_files_homework_fk", columns: [t.schoolId, t.homeworkId], foreignColumns: [homework.schoolId, homework.id] }),
  foreignKey({ name: "homework_files_file_fk", columns: [t.schoolId, t.fileId], foreignColumns: [files.schoolId, files.id] }),
  uniqueIndex("homework_files_homework_file_unique").on(t.homeworkId, t.fileId),
  index("homework_files_homework_idx").on(t.schoolId, t.homeworkId),
]);

/**
 * A student's submission: written answer and/or files. One per student per homework; the
 * student may change it until feedback is returned. `late` is fixed when first submitted after
 * the due time.
 */
export const homeworkSubmissions = pgTable("homework_submissions", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  homeworkId: uuid("homework_id").notNull(),
  studentId: uuid("student_id").notNull(),
  body: text("body"),
  late: boolean("late").notNull().default(false),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("homework_submissions_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "homework_submissions_homework_fk", columns: [t.schoolId, t.homeworkId], foreignColumns: [homework.schoolId, homework.id] }),
  foreignKey({ name: "homework_submissions_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  uniqueIndex("homework_submissions_one_per_student").on(t.schoolId, t.homeworkId, t.studentId),
  index("homework_submissions_student_idx").on(t.schoolId, t.studentId),
  check("homework_submissions_body_length", sql`${t.body} is null or char_length(${t.body}) between 1 and 5000`),
]);

/** A private file attached to a submission (purpose "homework_submission"). */
export const submissionFiles = pgTable("submission_files", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  submissionId: uuid("submission_id").notNull(),
  fileId: uuid("file_id").notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "submission_files_submission_fk", columns: [t.schoolId, t.submissionId], foreignColumns: [homeworkSubmissions.schoolId, homeworkSubmissions.id] }),
  foreignKey({ name: "submission_files_file_fk", columns: [t.schoolId, t.fileId], foreignColumns: [files.schoolId, files.id] }),
  uniqueIndex("submission_files_file_unique").on(t.fileId),
  index("submission_files_submission_idx").on(t.schoolId, t.submissionId),
]);

/** Feedback on a submission from a teacher of the section or an administrator. Returning it locks the submission. */
export const submissionFeedback = pgTable("submission_feedback", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  submissionId: uuid("submission_id").notNull(),
  feedback: text("feedback").notNull(),
  returnedBy: uuid("returned_by").notNull().references(() => users.id),
  returnedAt: timestamp("returned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "submission_feedback_submission_fk", columns: [t.schoolId, t.submissionId], foreignColumns: [homeworkSubmissions.schoolId, homeworkSubmissions.id] }),
  uniqueIndex("submission_feedback_one_per_submission").on(t.submissionId),
  check("submission_feedback_length", sql`char_length(${t.feedback}) between 1 and 2000`),
]);

export const announcementAudience = pgEnum("announcement_audience", ["everyone", "staff", "students", "parents", "section"]);

/**
 * A notice from the school (administrators: any audience) or a teacher (a section they teach).
 * "section" reaches the section's current students and their parents. Published at once;
 * archived notices are hidden from recipients, never deleted.
 */
export const announcements = pgTable("announcements", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  audience: announcementAudience("audience").notNull(),
  sectionId: uuid("section_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "announcements_section_fk", columns: [t.schoolId, t.sectionId], foreignColumns: [sections.schoolId, sections.id] }),
  index("announcements_school_published_idx").on(t.schoolId, t.publishedAt),
  index("announcements_section_idx").on(t.schoolId, t.sectionId),
  check("announcements_title_length", sql`char_length(${t.title}) between 1 and 150`),
  check("announcements_body_length", sql`char_length(${t.body}) between 1 and 5000`),
  check("announcements_section_audience", sql`(${t.audience} = 'section') = (${t.sectionId} is not null)`),
]);

/* ------------------------------------------------------------------ */
/* Fees, payments and finance (Phase 8)                                */
/* ------------------------------------------------------------------ */
// Money is integer paise in INR. The ledger is append-only; balances are sums of ledger entries.

/** A kind of fee (tuition, transport, …) with its tax rate in basis points (0 by default). */
export const feeHeads = pgTable("fee_heads", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  name: text("name").notNull(),
  taxBp: integer("tax_bp").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("fee_heads_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("fee_heads_school_name_unique").on(t.schoolId, sql`lower(${t.name})`),
  check("fee_heads_name_length", sql`char_length(${t.name}) between 1 and 80`),
  check("fee_heads_tax_bp", sql`${t.taxBp} between 0 and 10000`),
]);

export const feeStructureStatus = pgEnum("fee_structure_status", ["draft", "approved", "archived"]);

/**
 * Fees for one class in one academic year: items (head, amount, due date). Drafted by finance or
 * administrators, approved by a school administrator; an approved structure's items never change.
 * Late fee: a flat amount added once to an invoice unpaid `late_grace_days` after its due date.
 */
export const feeStructures = pgTable("fee_structures", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  academicYearId: uuid("academic_year_id").notNull(),
  classId: uuid("class_id").notNull(),
  name: text("name").notNull(),
  status: feeStructureStatus("status").notNull().default("draft"),
  lateFeePaise: integer("late_fee_paise").notNull().default(0),
  lateGraceDays: integer("late_grace_days").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("fee_structures_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "fee_structures_year_fk", columns: [t.schoolId, t.academicYearId], foreignColumns: [academicYears.schoolId, academicYears.id] }),
  foreignKey({ name: "fee_structures_class_fk", columns: [t.schoolId, t.classId], foreignColumns: [classes.schoolId, classes.id] }),
  uniqueIndex("fee_structures_school_year_class_name_unique").on(t.schoolId, t.academicYearId, t.classId, sql`lower(${t.name})`),
  check("fee_structures_name_length", sql`char_length(${t.name}) between 1 and 80`),
  check("fee_structures_late_fee", sql`${t.lateFeePaise} between 0 and 100000000 and ${t.lateGraceDays} between 0 and 365`),
  check("fee_structures_approval", sql`(${t.status} = 'draft') = (${t.approvedAt} is null) and (${t.approvedAt} is null) = (${t.approvedBy} is null)`),
]);

export const feeStructureItems = pgTable("fee_structure_items", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  structureId: uuid("structure_id").notNull(),
  feeHeadId: uuid("fee_head_id").notNull(),
  label: text("label").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  dueOn: date("due_on").notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "fee_structure_items_structure_fk", columns: [t.schoolId, t.structureId], foreignColumns: [feeStructures.schoolId, feeStructures.id] }),
  foreignKey({ name: "fee_structure_items_head_fk", columns: [t.schoolId, t.feeHeadId], foreignColumns: [feeHeads.schoolId, feeHeads.id] }),
  index("fee_structure_items_structure_idx").on(t.schoolId, t.structureId, t.dueOn),
  check("fee_structure_items_label_length", sql`char_length(${t.label}) between 1 and 80`),
  check("fee_structure_items_amount", sql`${t.amountPaise} between 1 and 100000000`),
]);

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const concessionKind = pgEnum("concession_kind", ["percent", "amount"]);

/**
 * A student's concession on a fee head (or on every head when fee_head_id is null): a percentage
 * in basis points, or a fixed amount per invoice line. Applies to invoices issued after approval.
 */
export const feeConcessions = pgTable("fee_concessions", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  feeHeadId: uuid("fee_head_id"),
  kind: concessionKind("kind").notNull(),
  value: integer("value").notNull(),
  reason: text("reason").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "fee_concessions_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "fee_concessions_head_fk", columns: [t.schoolId, t.feeHeadId], foreignColumns: [feeHeads.schoolId, feeHeads.id] }),
  index("fee_concessions_student_idx").on(t.schoolId, t.studentId),
  check("fee_concessions_value", sql`(${t.kind} = 'percent' and ${t.value} between 1 and 10000) or (${t.kind} = 'amount' and ${t.value} between 1 and 100000000)`),
  check("fee_concessions_reason_length", sql`char_length(${t.reason}) between 3 and 200`),
  check("fee_concessions_decision", sql`(${t.status} = 'pending') = (${t.decidedAt} is null) and (${t.decidedAt} is null) = (${t.decidedBy} is null) and (${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy})`),
]);

export const invoiceStatus = pgEnum("invoice_status", ["open", "cancelled"]);

/**
 * One student's bill for one instalment of a fee structure (the items sharing a due date).
 * Issuing posts a charge to the ledger; paid/outstanding comes from the ledger. Unique per
 * structure, student and due date, so issuing a batch twice bills nobody twice. Cancelling
 * reverses its ledger entries.
 */
export const invoices = pgTable("invoices", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  structureId: uuid("structure_id").notNull(),
  number: text("number").notNull(),
  dueOn: date("due_on").notNull(),
  totalPaise: integer("total_paise").notNull(),
  status: invoiceStatus("status").notNull().default("open"),
  issuedBy: uuid("issued_by").notNull().references(() => users.id),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("invoices_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("invoices_school_id_student_unique").on(t.schoolId, t.id, t.studentId),
  foreignKey({ name: "invoices_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "invoices_structure_fk", columns: [t.schoolId, t.structureId], foreignColumns: [feeStructures.schoolId, feeStructures.id] }),
  uniqueIndex("invoices_school_number_unique").on(t.schoolId, t.number),
  uniqueIndex("invoices_one_per_instalment").on(t.schoolId, t.structureId, t.studentId, t.dueOn),
  index("invoices_student_idx").on(t.schoolId, t.studentId),
  index("invoices_due_idx").on(t.schoolId, t.dueOn),
  check("invoices_total", sql`${t.totalPaise} >= 0`),
  check("invoices_cancelled", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  invoiceId: uuid("invoice_id").notNull(),
  feeHeadId: uuid("fee_head_id").notNull(),
  description: text("description").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  discountPaise: integer("discount_paise").notNull().default(0),
  taxPaise: integer("tax_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
}, (t) => [
  foreignKey({ name: "invoice_lines_invoice_fk", columns: [t.schoolId, t.invoiceId], foreignColumns: [invoices.schoolId, invoices.id] }),
  foreignKey({ name: "invoice_lines_head_fk", columns: [t.schoolId, t.feeHeadId], foreignColumns: [feeHeads.schoolId, feeHeads.id] }),
  index("invoice_lines_invoice_idx").on(t.schoolId, t.invoiceId),
  check("invoice_lines_amounts", sql`${t.amountPaise} >= 0 and ${t.discountPaise} between 0 and ${t.amountPaise} and ${t.taxPaise} >= 0 and ${t.totalPaise} = ${t.amountPaise} - ${t.discountPaise} + ${t.taxPaise}`),
]);

export const paymentMethod = pgEnum("payment_method", ["cash", "cheque", "bank_transfer", "upi", "online"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "captured", "failed"]);

/**
 * Money received for an invoice. Offline payments (cash, cheque, …) are recorded as captured by
 * finance staff with a receipt number. Online payments start pending with a provider order and
 * become captured only through a verified provider event (never a browser redirect); the
 * provider's payment id is unique, so a repeated event cannot credit twice.
 */
export const payments = pgTable("payments", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),
  method: paymentMethod("method").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  status: paymentStatus("status").notNull(),
  provider: text("provider"),
  providerOrderId: text("provider_order_id"),
  providerPaymentId: text("provider_payment_id"),
  reference: text("reference"),
  receiptNo: text("receipt_no"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
}, (t) => [
  uniqueIndex("payments_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "payments_invoice_fk", columns: [t.schoolId, t.invoiceId, t.studentId], foreignColumns: [invoices.schoolId, invoices.id, invoices.studentId] }),
  uniqueIndex("payments_provider_order_unique").on(t.provider, t.providerOrderId),
  uniqueIndex("payments_provider_payment_unique").on(t.provider, t.providerPaymentId),
  uniqueIndex("payments_school_receipt_unique").on(t.schoolId, t.receiptNo),
  index("payments_student_idx").on(t.schoolId, t.studentId),
  index("payments_captured_idx").on(t.schoolId, t.capturedAt),
  check("payments_amount", sql`${t.amountPaise} between 1 and 100000000`),
  check("payments_online", sql`(${t.method} = 'online') = (${t.provider} is not null and ${t.providerOrderId} is not null)`),
  check("payments_captured", sql`(${t.status} = 'captured') = (${t.capturedAt} is not null and ${t.receiptNo} is not null)`),
  check("payments_reference_length", sql`${t.reference} is null or char_length(${t.reference}) between 1 and 100`),
]);

export const ledgerKind = pgEnum("ledger_kind", ["charge", "late_fee", "payment", "adjustment", "refund", "reversal"]);

/**
 * The student account: positive amounts are owed by the student, negative amounts are credits.
 * Append-only (no update or delete grants); a mistake is corrected by a reversal entry pointing at
 * the entry it reverses (each entry at most once). One payment credit per payment, one late fee
 * per invoice.
 */
export const ledgerEntries = pgTable("ledger_entries", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  invoiceId: uuid("invoice_id"),
  paymentId: uuid("payment_id"),
  kind: ledgerKind("kind").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  reversesEntryId: uuid("reverses_entry_id"),
  memo: text("memo"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("ledger_entries_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "ledger_entries_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "ledger_entries_invoice_fk", columns: [t.schoolId, t.invoiceId], foreignColumns: [invoices.schoolId, invoices.id] }),
  foreignKey({ name: "ledger_entries_payment_fk", columns: [t.schoolId, t.paymentId], foreignColumns: [payments.schoolId, payments.id] }),
  foreignKey({ name: "ledger_entries_reverses_fk", columns: [t.schoolId, t.reversesEntryId], foreignColumns: [t.schoolId, t.id] }),
  uniqueIndex("ledger_entries_one_reversal").on(t.reversesEntryId),
  uniqueIndex("ledger_entries_one_payment_credit").on(t.paymentId).where(sql`${t.kind} = 'payment'`),
  uniqueIndex("ledger_entries_one_late_fee").on(t.invoiceId).where(sql`${t.kind} = 'late_fee'`),
  index("ledger_entries_student_idx").on(t.schoolId, t.studentId, t.createdAt),
  index("ledger_entries_invoice_idx").on(t.schoolId, t.invoiceId),
  check("ledger_entries_nonzero", sql`${t.amountPaise} <> 0`),
  check("ledger_entries_sign", sql`(${t.kind} in ('charge', 'late_fee', 'refund') and ${t.amountPaise} > 0) or (${t.kind} = 'payment' and ${t.amountPaise} < 0) or ${t.kind} in ('adjustment', 'reversal')`),
  check("ledger_entries_reversal", sql`(${t.kind} = 'reversal') = (${t.reversesEntryId} is not null)`),
  check("ledger_entries_memo_length", sql`${t.memo} is null or char_length(${t.memo}) between 1 and 200`),
]);

export const adjustmentKind = pgEnum("adjustment_kind", ["waiver", "extra_charge", "refund", "receipt_reversal"]);

/**
 * A requested change to a student's account: a waiver (credit), an extra charge, a refund of a
 * captured payment, or reversing a receipt recorded in error. Takes effect only when approved by
 * a school administrator other than the requester; the approval posts the ledger entry.
 */
export const feeAdjustments = pgTable("fee_adjustments", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  studentId: uuid("student_id").notNull(),
  invoiceId: uuid("invoice_id"),
  paymentId: uuid("payment_id"),
  kind: adjustmentKind("kind").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  reason: text("reason").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ledgerEntryId: uuid("ledger_entry_id"),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ name: "fee_adjustments_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "fee_adjustments_invoice_fk", columns: [t.schoolId, t.invoiceId], foreignColumns: [invoices.schoolId, invoices.id] }),
  foreignKey({ name: "fee_adjustments_payment_fk", columns: [t.schoolId, t.paymentId], foreignColumns: [payments.schoolId, payments.id] }),
  foreignKey({ name: "fee_adjustments_ledger_fk", columns: [t.schoolId, t.ledgerEntryId], foreignColumns: [ledgerEntries.schoolId, ledgerEntries.id] }),
  index("fee_adjustments_status_idx").on(t.schoolId, t.status),
  uniqueIndex("fee_adjustments_one_open_payment_reversal").on(t.paymentId).where(sql`${t.kind} in ('refund', 'receipt_reversal') and ${t.status} <> 'rejected'`),
  check("fee_adjustments_amount", sql`${t.amountPaise} between 1 and 100000000`),
  check("fee_adjustments_reason_length", sql`char_length(${t.reason}) between 3 and 200`),
  check("fee_adjustments_payment", sql`(${t.kind} in ('refund', 'receipt_reversal')) = (${t.paymentId} is not null)`),
  check("fee_adjustments_decision", sql`(${t.status} = 'pending') = (${t.decidedAt} is null) and (${t.decidedAt} is null) = (${t.decidedBy} is null) and (${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}) and ((${t.status} = 'approved') = (${t.ledgerEntryId} is not null))`),
]);

/** Provider webhook events already processed (dedupe), with a summary only (no raw body). */
export const paymentEvents = pgTable("payment_events", {
  id: id(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  paymentId: uuid("payment_id"),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("payment_events_provider_event_unique").on(t.provider, t.eventId),
]);

/** Per-school counters for invoice and receipt numbers. */
export const feeCounters = pgTable("fee_counters", {
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  kind: text("kind").notNull(),
  value: integer("value").notNull().default(0),
}, (t) => [
  primaryKey({ name: "fee_counters_pk", columns: [t.schoolId, t.kind] }),
  check("fee_counters_kind", sql`${t.kind} in ('invoice', 'receipt')`),
]);

/* ------------------------------------------------------------------ */
/* Curriculum and question bank (Phase 9)                              */
/* ------------------------------------------------------------------ */

export const topicLevel = pgEnum("topic_level", ["chapter", "topic"]);

/**
 * A subject's chapters and their topics. Two levels only: a chapter has no parent; a topic's
 * parent is a chapter of the same subject (composite key), so cycles are impossible. Archived
 * entries stay for questions that use them.
 */
export const topics = pgTable("topics", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  subjectId: uuid("subject_id").notNull(),
  level: topicLevel("level").notNull(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("topics_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("topics_school_subject_id_unique").on(t.schoolId, t.subjectId, t.id),
  foreignKey({ name: "topics_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  foreignKey({ name: "topics_parent_fk", columns: [t.schoolId, t.subjectId, t.parentId], foreignColumns: [t.schoolId, t.subjectId, t.id] }),
  uniqueIndex("topics_unique_name").on(t.schoolId, t.subjectId, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  index("topics_subject_idx").on(t.schoolId, t.subjectId),
  check("topics_name_length", sql`char_length(${t.name}) between 1 and 120`),
  check("topics_level_parent", sql`(${t.level} = 'chapter') = (${t.parentId} is null)`),
  check("topics_sort_order", sql`${t.sortOrder} between -1000 and 1000`),
]);

export const questionStatus = pgEnum("question_status", ["draft", "in_review", "published", "archived"]);
export const questionType = pgEnum("question_type", ["single_choice", "true_false", "descriptive"]);
export const questionDifficulty = pgEnum("question_difficulty", ["easy", "medium", "hard"]);

/**
 * A reusable question of one subject. Its content lives in numbered versions. `published_version_id`
 * is the version practice and exams use; editing after publication creates a new draft version and
 * leaves the published one untouched. Never deleted; archived instead.
 */
export const questions = pgTable("questions", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  subjectId: uuid("subject_id").notNull(),
  topicId: uuid("topic_id"),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  status: questionStatus("status").notNull().default("draft"),
  currentRevision: integer("current_revision").notNull().default(1),
  publishedVersionId: uuid("published_version_id"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("questions_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "questions_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  foreignKey({ name: "questions_topic_fk", columns: [t.schoolId, t.subjectId, t.topicId], foreignColumns: [topics.schoolId, topics.subjectId, topics.id] }),
  index("questions_subject_status_idx").on(t.schoolId, t.subjectId, t.status),
  index("questions_topic_idx").on(t.schoolId, t.topicId),
  check("questions_revision", sql`${t.currentRevision} >= 1`),
  check("questions_published", sql`${t.status} <> 'published' or ${t.publishedVersionId} is not null`),
]);

/**
 * One revision of a question's content. Single choice: 2-6 options and the correct option id in
 * the answer key; true/false: the correct value; descriptive: an optional model answer (graded by
 * hand). Marks in hundredths (½ mark = 50); negative marks optional, never more than the marks.
 * A version is editable only until it is locked (published or used); then edits create a new one.
 */
export const questionVersions = pgTable("question_versions", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  questionId: uuid("question_id").notNull(),
  revision: integer("revision").notNull(),
  type: questionType("type").notNull(),
  difficulty: questionDifficulty("difficulty").notNull().default("medium"),
  stem: text("stem").notNull(),
  options: jsonb("options"),
  answerKey: jsonb("answer_key").notNull(),
  explanation: text("explanation"),
  marksX100: integer("marks_x100").notNull().default(100),
  negativeMarksX100: integer("negative_marks_x100").notNull().default(0),
  imageFileId: uuid("image_file_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("question_versions_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "question_versions_question_fk", columns: [t.schoolId, t.questionId], foreignColumns: [questions.schoolId, questions.id] }),
  foreignKey({ name: "question_versions_image_fk", columns: [t.schoolId, t.imageFileId], foreignColumns: [files.schoolId, files.id] }),
  uniqueIndex("question_versions_revision_unique").on(t.schoolId, t.questionId, t.revision),
  index("question_versions_question_idx").on(t.schoolId, t.questionId),
  check("question_versions_stem_length", sql`char_length(${t.stem}) between 1 and 5000`),
  check("question_versions_explanation_length", sql`${t.explanation} is null or char_length(${t.explanation}) between 1 and 5000`),
  check("question_versions_marks", sql`${t.marksX100} between 1 and 10000 and ${t.negativeMarksX100} between 0 and ${t.marksX100}`),
  check("question_versions_options", sql`(${t.type} = 'single_choice') = (${t.options} is not null)`),
  check("question_versions_descriptive_no_penalty", sql`${t.type} <> 'descriptive' or ${t.negativeMarksX100} = 0`),
]);

/* ------------------------------------------------------------------ */
/* Practice (Phase 10)                                                 */
/* ------------------------------------------------------------------ */

export const practiceSetStatus = pgEnum("practice_set_status", ["draft", "published", "archived"]);
export const practiceFeedback = pgEnum("practice_feedback", ["immediate", "after_close"]);

/**
 * A practice set of one subject: an ordered list of published (locked) question versions,
 * fixed once the set is published. Unlimited attempts unless a limit is set; feedback (correct
 * answers and explanations) right after submission, or only after the assignment closes.
 * Practice never affects formal results.
 */
export const practiceSets = pgTable("practice_sets", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  subjectId: uuid("subject_id").notNull(),
  topicId: uuid("topic_id"),
  title: text("title").notNull(),
  instructions: text("instructions"),
  status: practiceSetStatus("status").notNull().default("draft"),
  attemptLimit: integer("attempt_limit"),
  feedback: practiceFeedback("feedback").notNull().default("immediate"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("practice_sets_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "practice_sets_subject_fk", columns: [t.schoolId, t.subjectId], foreignColumns: [subjects.schoolId, subjects.id] }),
  foreignKey({ name: "practice_sets_topic_fk", columns: [t.schoolId, t.subjectId, t.topicId], foreignColumns: [topics.schoolId, topics.subjectId, topics.id] }),
  index("practice_sets_subject_idx").on(t.schoolId, t.subjectId, t.status),
  check("practice_sets_title_length", sql`char_length(${t.title}) between 1 and 150`),
  check("practice_sets_instructions_length", sql`${t.instructions} is null or char_length(${t.instructions}) between 1 and 2000`),
  check("practice_sets_attempt_limit", sql`${t.attemptLimit} is null or ${t.attemptLimit} between 1 and 50`),
  check("practice_sets_published", sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`),
]);

export const practiceSetItems = pgTable("practice_set_items", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  setId: uuid("set_id").notNull(),
  questionVersionId: uuid("question_version_id").notNull(),
  position: integer("position").notNull(),
}, (t) => [
  uniqueIndex("practice_set_items_school_id_unique").on(t.schoolId, t.id),
  uniqueIndex("practice_set_items_school_id_set_unique").on(t.schoolId, t.id, t.setId),
  foreignKey({ name: "practice_set_items_set_fk", columns: [t.schoolId, t.setId], foreignColumns: [practiceSets.schoolId, practiceSets.id] }),
  foreignKey({ name: "practice_set_items_version_fk", columns: [t.schoolId, t.questionVersionId], foreignColumns: [questionVersions.schoolId, questionVersions.id] }),
  uniqueIndex("practice_set_items_position_unique").on(t.schoolId, t.setId, t.position),
  uniqueIndex("practice_set_items_version_unique").on(t.schoolId, t.setId, t.questionVersionId),
  check("practice_set_items_position", sql`${t.position} between 1 and 200`),
]);

/** A published set made available to a section, optionally between two instants. */
export const practiceAssignments = pgTable("practice_assignments", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  setId: uuid("set_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  opensAt: timestamp("opens_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("practice_assignments_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "practice_assignments_set_fk", columns: [t.schoolId, t.setId], foreignColumns: [practiceSets.schoolId, practiceSets.id] }),
  foreignKey({ name: "practice_assignments_section_fk", columns: [t.schoolId, t.sectionId], foreignColumns: [sections.schoolId, sections.id] }),
  uniqueIndex("practice_assignments_one_active").on(t.schoolId, t.setId, t.sectionId).where(sql`${t.removedAt} is null`),
  index("practice_assignments_section_idx").on(t.schoolId, t.sectionId),
  check("practice_assignments_window", sql`${t.opensAt} is null or ${t.closesAt} is null or ${t.closesAt} > ${t.opensAt}`),
]);

export const practiceAttemptStatus = pgEnum("practice_attempt_status", ["in_progress", "submitted"]);

/**
 * One try at a practice set by one student. At most one attempt in progress per student and set;
 * attempt numbers are unique, so a double "start" cannot create two. Scores are written only by
 * practice_submit() (from the answer keys, inside the database).
 */
export const practiceAttempts = pgTable("practice_attempts", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  setId: uuid("set_id").notNull(),
  studentId: uuid("student_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  status: practiceAttemptStatus("status").notNull().default("in_progress"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  scoreX100: integer("score_x100"),
  maxX100: integer("max_x100"),
  correctCount: integer("correct_count"),
  scoredCount: integer("scored_count"),
}, (t) => [
  uniqueIndex("practice_attempts_school_id_unique").on(t.schoolId, t.id),
  foreignKey({ name: "practice_attempts_set_fk", columns: [t.schoolId, t.setId], foreignColumns: [practiceSets.schoolId, practiceSets.id] }),
  foreignKey({ name: "practice_attempts_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [studentProfiles.schoolId, studentProfiles.id] }),
  foreignKey({ name: "practice_attempts_assignment_fk", columns: [t.schoolId, t.assignmentId], foreignColumns: [practiceAssignments.schoolId, practiceAssignments.id] }),
  uniqueIndex("practice_attempts_number_unique").on(t.schoolId, t.setId, t.studentId, t.attemptNo),
  uniqueIndex("practice_attempts_one_open").on(t.schoolId, t.setId, t.studentId).where(sql`${t.status} = 'in_progress'`),
  index("practice_attempts_student_idx").on(t.schoolId, t.studentId),
  check("practice_attempts_number", sql`${t.attemptNo} between 1 and 50`),
  check("practice_attempts_submitted", sql`(${t.status} = 'submitted') = (${t.submittedAt} is not null and ${t.maxX100} is not null)`),
]);

/** A saved answer. `revision` increases with every save, so a stale tab cannot overwrite a newer answer. */
export const practiceAnswers = pgTable("practice_answers", {
  id: id(),
  schoolId: uuid("school_id").notNull().references(() => schools.id),
  attemptId: uuid("attempt_id").notNull(),
  itemId: uuid("item_id").notNull(),
  response: jsonb("response").notNull(),
  revision: integer("revision").notNull().default(1),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  scoreX100: integer("score_x100"),
  isCorrect: boolean("is_correct"),
}, (t) => [
  foreignKey({ name: "practice_answers_attempt_fk", columns: [t.schoolId, t.attemptId], foreignColumns: [practiceAttempts.schoolId, practiceAttempts.id] }),
  foreignKey({ name: "practice_answers_item_fk", columns: [t.schoolId, t.itemId], foreignColumns: [practiceSetItems.schoolId, practiceSetItems.id] }),
  uniqueIndex("practice_answers_one_per_item").on(t.schoolId, t.attemptId, t.itemId),
  check("practice_answers_revision", sql`${t.revision} >= 1`),
]);
