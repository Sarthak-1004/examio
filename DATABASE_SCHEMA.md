# Database schema

Implemented source: `packages/db/src/schema.ts` and `packages/db/migrations/`. Proposed tables below do not exist yet; migrations must be reviewed before implementation. PostgreSQL is authoritative; caches/files are not substitutes for relational ownership checks.

## Implemented tables

Unless noted, `id` is UUID primary key generated randomly and `created_at` is non-null timestamptz default now. Nullable fields are marked `?`.

| Table | Fields | Constraints/indexes |
| --- | --- | --- |
| `boards` | id, name text, active boolean default true, created_at | Unique name |
| `mediums` | id, name text, active boolean default true, created_at | Unique name |
| `schools` | id, name, code, board_id FK boards, medium_id FK mediums, timezone default Asia/Kolkata, status default onboarding, address?, contact_email?, contact_phone?, created_at | Unique code; code regex `^[a-z0-9]{2,12}$` |
| `users` | id, full_name, email?, phone?, username?, password_hash, is_platform_admin default false, status default active, must_change_password default false, created_at | Unique non-null email and username; phone index but NOT unique; at least one identifier required |
| `sessions` | id text (SHA-256 token hash), user_id FK users, expires_at timestamptz, pending_mfa boolean default false, created_at | PK id; user index; user deletion cascades; RLS own rows only |
| `school_memberships` | id, school_id FK schools, user_id FK users, role, status default active, created_at | Unique (school_id,user_id,role); user index |
| `rate_limit_buckets` | key text (SHA-256 of scope and subject), count integer, reset_at timestamptz | PK key; reset_at index; no `id`/`created_at`; global infrastructure table: RLS enabled with no policy and no runtime grants; reached only through `rate_limit_hit` and `rate_limit_refund` |
| `account_tokens` | id, user_id FK users, purpose (activation/password_reset), token_hash, school_id? FK schools (issuing school), issued_by? FK users, expires_at, consumed_at?, revoked_at?, created_at | Unique token_hash; user and expiry indexes; global identity table: RLS enabled with no policy and no runtime grants; reached only through `auth_issue_account_token`, `auth_check_account_token`, `auth_redeem_account_token`, `auth_revoke_account_tokens` |
| `membership_invitations` | id, school_id FK schools, role, token_hash, recipient_label, invited_by FK users, expires_at, accepted_by? FK users, accepted_at?, revoked_at?, created_at | Tenant table with RLS (school admins of that school); unique token_hash; index (school_id,created_at); role cannot be school_admin; label 1-200 chars; token_hash not selectable; only revoked_at updatable; accepted through `auth_accept_membership_invitation` |
| `support_access_grants` | id, school_id FK schools, platform_user_id FK users, reason, expires_at, ended_at?, created_at | RLS: platform admins and the school's admins read; a platform admin inserts for themself; only ended_at updatable; reason 10-500 chars; expiry within 4 hours of creation; indexes (school_id,created_at) and (platform_user_id,expires_at) |
| `user_mfa` | user_id PK FK users, secret_enc (AES-256-GCM, application key), confirmed_at?, last_used_step bigint default 0, created_at | Global identity table: RLS enabled with no policy and no runtime grants; reached only through `auth_mfa_*` functions |
| `user_mfa_recovery_codes` | id, user_id FK users, code_hash, used_at?, created_at | Unique code_hash; user index; same access model as `user_mfa` |
| `jobs` | id, school_id? FK schools, kind, payload jsonb (≤8 KB, identifiers only), dedupe_key?, status (queued/running/succeeded/dead), attempts, max_attempts (1-25), run_at, locked_by?, locked_until?, last_error? (≤1000, redacted), created_at, updated_at, finished_at? | Unique (kind, dedupe_key); due index (status, run_at); no runtime grants; reached through `job_*` functions |
| `worker_heartbeats` | worker_id PK, seen_at, started_at | No runtime grants; `worker_heartbeat` |
| `notifications` | id, school_id?, recipient_user_id FK users, channel (in_app/email), template, params jsonb (≤4 KB), dedupe_key, status (pending/delivered/sandboxed/failed), provider?, provider_ref?, last_error?, created_at, delivered_at?, read_at? | Unique (dedupe_key, recipient, channel); recipient and school admins read; only read_at updatable; created through `notification_queue*` |
| `idempotency_records` | id, school_id?, actor_user_id FK users, operation, key (8-128), request_hash, response jsonb?, created_at, completed_at?, expires_at | Unique (actor, operation, key); own rows only |
| `files` | id, school_id FK, uploaded_by FK users, purpose, original_name (1-200), content_type, size_bytes (≤50 MB), sha256, storage_key (unique, `<school>/<uuid>`), status (quarantined/clean/rejected/deleted), scan_result?, scanned_at?, expires_at?, deleted_at?, purged_at?, created_at | Visible to uploader (while a member), school admins and support grants; users insert quarantined rows and may only mark deleted; scan results and exports through `file_*` functions |
| `academic_years` | id, school_id, name (1-40), starts_on date, ends_on date, status (planned/current/closed), created_at, updated_at | Unique (school, id) and (school, lower(name)); one current per school (partial unique); start < end <= start + 731 days |
| `classes` | id, school_id, name (1-40), sort_order (-1000..1000), archived_at?, created_at | Unique (school, id) and (school, lower(name)) |
| `sections` | id, school_id, academic_year_id, class_id, name (1-20), capacity? (1-500), archived_at?, created_at | Composite FKs (school, year) and (school, class); unique (school, year, class, lower(name)) |
| `subjects` | id, school_id, name (1-80), code (`^[A-Z0-9][A-Z0-9-]{1,11}$`), archived_at?, created_at | Unique (school, id), (school, code), (school, lower(name)) |
| `class_subjects` | id, school_id, academic_year_id, class_id, subject_id, created_at | Composite FKs to year, class and subject; unique (school, year, class, subject) |
| `grading_schemes` | id, school_id, name (1-60), pass_bp (0-10000), is_default, archived_at?, created_at, updated_at | Unique (school, lower(name)); one active default per school (partial unique) |
| `grading_bands` | id, school_id, scheme_id, label (1-10), min_bp (0-10000), description? | Composite FK to scheme (cascade); unique (scheme, min_bp) and (scheme, lower(label)) |
| `calendar_events` | id, school_id, academic_year_id, title (1-120), kind (holiday/event/exam), starts_on, ends_on, created_at | Composite FK to year; start <= end |
| `attendance_sessions` | id, school_id, name (1-40), sort_order, archived_at?, created_at | Unique (school, lower(name)); "Full day" created for every school by trigger |
| `audit_events` | id, school_id? FK schools, actor_user_id? FK users, action, entity_type?, entity_id? text, data? jsonb, created_at | Index (school_id,created_at); app policies append/read only |

Enums: school_status = onboarding/active/suspended; user_status = active/disabled; membership_role = school_admin/teacher/student/parent/finance; membership_status = active/revoked; account_token_purpose = activation/password_reset. Email/username normalization is currently application behavior, not a database lowercase constraint.

RLS is enabled on all tables above. Policies use transaction context and helper functions: `app_is_platform_admin` (flag plus an active platform-admin account), `app_has_school_role` and `app_is_member_of` (active membership, active account, school not suspended), `app_can_manage_user` and `app_can_grant_membership`. Reviewed SECURITY DEFINER auth helpers: `auth_find_login`, `auth_session_lookup`, `auth_own_password_hash`, `auth_set_own_password`. Further helpers: `app_can_recover_user`, `app_has_support_access`, `app_platform_can_see_user`, `platform_school_member_count` (aggregate only), `auth_revoke_user_sessions`, `auth_purge_expired`. Trigger `schools_guard_update` restricts status/board/medium changes to platform admins. Owner connections bypass RLS and the trigger. See [SECURITY.md](SECURITY.md) for current policy limitations.

Runtime privileges are a reviewed manifest, `TABLE_GRANTS` in `packages/db/scripts/setup-roles.ts`, applied by `pnpm db:migrate`. There is no blanket grant: a new table without a manifest entry fails the script. Current grants for `examio_app`: no DELETE except on sessions; UPDATE limited to listed columns (membership `status` only; never `users.is_platform_admin` or `schools.code`); SELECT on users excludes `password_hash`; audit events are insert/select only. Functions in schema public are not executable by PUBLIC. Drizzle `select()`/`returning()` without a column list fails on `users`; name the columns.

Migrations: `0000_init` (tables), `0001_rls_policies` (initial policies), `0002_identity_hardening` (policies, helpers, sessions RLS, function privileges; no data rewrite). `0003_rate_limits` (counter table and functions; disposable data), `0004_finance_role` (adds the `finance` enum value, which cannot be dropped later). `0005_account_recovery` (account codes, membership invitations, session helpers; changes the result columns of `auth_session_lookup`), `0006_support_access` (support grants; narrows what a platform admin can read and change). `0007_mfa` (authenticator tables, `sessions.pending_mfa`, `auth_mfa_*` and `auth_session_complete_mfa` functions; `app_is_platform_admin` now also requires a confirmed authenticator, so existing platform admins lose platform access until they enrol). `0010_academic_setup` (Phase 3 tables above, `schools.short_name` and `schools.brand_color`, policies: members read, school admins write, year-scoped rows only while the year is open; `app_can_read_school`, `app_can_manage_setup`, `app_year_open`; default attendance session backfill and trigger). `0008_jobs_notifications` (job queue, heartbeats, notifications, idempotency; `app_is_worker`), `0009_files` (private files). `0002` and `0005`-`0009` must be deployed together with the matching application code. Recovery is forward-fix: earlier definitions remain in `0001` and can be restored by a new migration.

## Planned schema conventions

Tenant tables below carry `id`, non-null `school_id`, `created_at`, and where mutable `updated_at` plus integer `version` for optimistic concurrency. Add `UNIQUE(school_id,id)` on referenced tenant entities and composite FKs `(school_id,related_id)` to enforce same-school links. Index referencing FK columns and common scoped filters. Restrict deletes on history-bearing relations; explicit cascade only for disposable children. All tenant tables require RLS and negative tests.

Use date for local school days; timestamptz for instants; `numeric(10,2)` for marks; bigint minor units and ISO currency code for money. APIs serialize unsafe-size integers as decimal strings. Validate timezone names in services. Status transitions are enforced transactionally by services with SQL checks for allowed values.

## Planned identity and MIS (Phases 1-7)

| Table | Principal fields and relationships | Constraints/indexes |
| --- | --- | --- |
| Guardian invitation link (planned) | child reference on `membership_invitations` or a companion table | Guardian invitations must carry a verified child link before a parent gains access (Phase 5) |
| `student_profiles` | user_id, admission_no, display_name, admitted_on, status | Unique school/user and school/admission_no; no global admission uniqueness |
| `staff_profiles` | user_id, employee_no, display_name, status | Unique school/user and school/employee_no |
| `enrollments` | student_id, academic_year_id, section_id, roll_no?, joined_on, left_on?, status | One active enrollment per student/year (initial model); scoped section/status index; unique active roll within section |
| `teacher_assignments` | staff_id, section_id, subject_id, academic_year_id, starts_on, ends_on? | Scoped unique assignment; date and section/year consistency |
| `guardian_links` | guardian_user_id, student_id, relationship, verified_by?, verified_at?, revoked_at? | Unique school/guardian/student; no access until verified and active |
| `attendance_records` | enrollment_id, attendance_date, session_key, status, marked_by, correction_reason? | Unique school/enrollment/date/session; date/status indexes |
| `timetable_slots` | academic_year_id, section_id, subject_id, staff_id, weekday, start_time, end_time, room? | End > start; transactional overlap checks for teacher/section/room |
| `homework` | section_id, subject_id, author_id, title, instructions, due_at, status | Section/due index |
| `homework_submissions` | homework_id, enrollment_id, submitted_at?, feedback?, status | Unique school/homework/enrollment |
| `announcements` | author_id, title, body, status, published_at? | Scoped status/published index |
| `announcement_targets` | announcement_id, section_id?, role? | Explicit validated target; prohibit ambiguous empty scope |
| `files` | storage_key, uploader_id, purpose, mime_type, byte_size, scan_status | Unique storage key; positive size; owner links enforce access separately |
| `homework_files` / `submission_files` | homework_id or submission_id, file_id | Unique parent/file; same-school FK; private download authorization |
| `import_jobs` | creator_id, kind, file_id, status, counts, errors_file_id?, idempotency_key | Unique school/key; scoped status/created index |

Global `users` should hold authentication identity only. School-editable names/contact details must live in tenant profiles or use a verified global update flow. Finance role requires an enum migration and corresponding capability/RLS updates.

## Planned fees (Phase 8)

| Table | Principal fields | Constraints/indexes |
| --- | --- | --- |
| `fee_schedules` | academic_year_id, name, currency, status | Scoped year/name unique |
| `fee_schedule_items` | schedule_id, description, amount_minor, due_on | Nonnegative amount; same currency as schedule |
| `invoices` | student_id, academic_year_id, invoice_no, currency, status, issued_at, due_on | Unique school/invoice_no; student/status index |
| `invoice_lines` | invoice_id, description, quantity, unit_amount_minor, discount_minor, tax_minor | Nonnegative components; snapshot issued description/rules |
| `payments` | invoice_id, provider?, provider_reference?, amount_minor, currency, status, paid_at? | Unique provider/reference when present; positive amount; offline unique receipt reference per school |
| `ledger_entries` | invoice_id, payment_id?, type, signed_amount_minor, currency, reverses_entry_id?, actor_id | Append-only; reversal links and idempotency unique; invoice/time index |
| `finance_adjustments` | invoice_id, reason, requested_by, approved_by?, status, amount_minor, provider_reference? | Explicit approval lifecycle; execution idempotency |

Posted balances derive from immutable ledger entries, not editable UI totals. Never cascade delete posted financial history. Cross-currency allocation is excluded initially.

## Planned questions, practice and exams (Phases 9-12)

| Table | Principal fields | Constraints/indexes |
| --- | --- | --- |
| `topics` | subject_id, parent_id?, name | Same-subject parent; prevent hierarchy cycles |
| `questions` | subject_id, topic_id?, author_id, difficulty, status | Scoped subject/topic/status indexes |
| `question_versions` | question_id, revision, type, content jsonb, answer_key jsonb, explanation?, default_marks | Unique school/question/revision; immutable once referenced by publication; key server-only |
| `practice_sets` | subject_id, title, instructions, status, attempt_limit?, feedback_policy | Positive limit or null unlimited |
| `practice_set_items` | practice_set_id, question_version_id, position | Unique school/set/position |
| `practice_assignments` | practice_set_id, section_id, opens_at?, closes_at? | Unique school/set/section; valid dates |
| `practice_attempts` | practice_set_id, enrollment_id, attempt_no, status, started_at, submitted_at?, score? | Unique school/set/enrollment/attempt_no |
| `practice_answers` | attempt_id, question_version_id, response jsonb, revision, score? | Unique school/attempt/question; conditional revision writes |
| `exams` | title, subject_id, author_id, status | Scoped status/subject index |
| `exam_versions` | exam_id, revision, instructions, duration_seconds, opens_at, closes_at, attempt_limit, scoring_policy jsonb, published_by?, published_at? | Unique school/exam/revision; duration > 0; opens < closes; immutable after publication |
| `exam_items` | exam_version_id, question_version_id, position, marks, negative_marks | Unique version/position; marks >= 0; validated penalty |
| `exam_targets` | exam_version_id, section_id | Unique school/version/section |
| `exam_attempts` | exam_version_id, enrollment_id, attempt_no, status, started_at, deadline_at, submitted_at?, submission_key? | Unique school/version/enrollment/attempt_no; scoped deadline/status index |
| `exam_answers` | attempt_id, exam_item_id, response jsonb, revision, saved_at | Unique school/attempt/item; item must belong to attempt's version |
| `grading_records` | answer_id, marks, grader_id?, reason?, revision | Unique school/answer/revision; within item bounds; immutable revisions |
| `result_batches` | exam_version_id, revision, status, published_by?, published_at? | Unique school/version/revision |
| `results` | result_batch_id, attempt_id, total_marks, maximum_marks, percentage, grade?, passed? | Unique school/batch/attempt; only published batch visible to learners |
| `offline_assessments` | academic_year_id, subject_id, title, assessment_date, maximum_marks, status, locked_by?, locked_at?, published_by?, published_at? | Scoped year/subject/status index; maximum > 0; same-school year/subject |
| `offline_assessment_targets` | offline_assessment_id, section_id | Unique school/assessment/section |
| `offline_marks` | offline_assessment_id, enrollment_id, entry_status, marks?, entered_by, revision, reason? | Unique school/assessment/enrollment/revision; marks within 0..maximum and present only when entry_status is marked; enrollment must belong to a target section; immutable revisions |

Enforce item/attempt/version consistency with composite relationships or equivalent transactional validation backed by tests. Do not return answer keys in learner queries. Eligibility resolves target section plus current enrollment and publication rules.

## Planned infrastructure

Implemented in Phase 2 as `jobs`, `notifications` and `idempotency_records` (see the implemented tables above); provider webhook events remain planned. Original proposal, kept for reference: `outbox_events`: school_id?, event_type, payload reference, status, attempts, next_attempt_at; indexed ready jobs. `notification_deliveries`: school_id, recipient_user_id, channel, provider_reference?, status, event_id; unique event/recipient/channel. `webhook_events`: provider, event_id, payload_hash, received_at, processed_at?, status; unique provider/event_id, trusted processing before tenant association. `idempotency_records`: school_id, actor_id, operation, key, request_hash, response_reference, expires_at; unique scope/operation/key. Global infrastructure tables require explicit restricted access rather than default tenant policies.

Retention/erasure rules must be agreed before collecting production student data. Proposed models are refined through reviewed migrations. Admissions/library/inventory/transport (Phase 13), HR/payroll (Phase 14), and subscriptions (Phase 15) are now scheduled in [TASKS.md](TASKS.md); their detailed tables and constraints must be specified before implementation.

