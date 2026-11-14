import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
  createdAt: createdAt(),
}, (t) => [check("schools_code_format", sql`${t.code} ~ '^[a-z0-9]{2,12}$'`)]);

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
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("membership_invitations_hash_unique").on(t.tokenHash),
  index("membership_invitations_school_idx").on(t.schoolId, t.createdAt),
  check("membership_invitations_not_admin", sql`${t.role} <> 'school_admin'`),
  check("membership_invitations_label_length", sql`char_length(${t.recipientLabel}) between 1 and 200`),
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
  index("files_school_idx").on(t.schoolId, t.createdAt),
  index("files_uploader_idx").on(t.uploadedBy),
  check("files_purpose_format", sql`${t.purpose} ~ '^[a-z][a-z0-9_]{2,40}$'`),
  check("files_name_length", sql`char_length(${t.originalName}) between 1 and 200`),
  check("files_size_range", sql`${t.sizeBytes} between 1 and 52428800`),
  check("files_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("files_storage_key_format", sql`${t.storageKey} ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'`),
]);
