# Changelog

Record user-visible behavior, fixes, security changes and migration compatibility here. Do not treat planned tasks as shipped releases. No tagged release history was established during the repository review.

## Unreleased

### Phase 5: students, guardians and academic history — 2026-11-15

- Added: Students for school admins (`/school/students`): admit with a one-time activation code (students sign in with `<school code>.<admission no>`), search and filter by year, class and status, members without student details, CSV export.
- Added: student pages with enrollment, section moves from a date, roll numbers, corrections, leaving and readmission, account codes, private documents and parents.
- Added: parents and guardians: a parent account created for a child, a sibling link, or a code naming the child for a parent who already uses Examio; the parent portal (`/parent`) shows only linked children.
- Added: class list import with column mapping, row errors and duplicate warnings, all rows or none; promotion and graduation per section; class strength report.
- Added: teachers see "My classes" and today's class lists for sections they teach; students see their class on their home page.
- Security: student records are visible only to the school's admins, the student, linked parents and today's teachers, enforced in the database; parents cannot look up or claim a child; parent invitations must name a child.
- Migration: `0012_students` (four new tables, invitation child columns, new access helpers, new invitation acceptance). Must be applied to the demo database before deploying.
- Verification (local): typecheck, 264 integration tests, build and 38 browser tests passed.

### Phase 4: staff management and assignments — 2026-11-15

- Added: Staff for school admins (`/school/staff`): add staff with a one-time activation code, search and filter, staff details for invited members, invitations, CSV export.
- Added: staff pages with details, leaving and return, new activation or reset codes, sign out of all devices; subject assignments and class teachers per section with start and end dates; "Who teaches what" with gaps highlighted.
- Added: bulk staff import from CSV: check first (nothing saved), then all rows or none; the same file cannot create employees twice.
- Added: "My classes today" on the teacher dashboard.
- Security: teachers no longer see students, parents or member counts; they see the school's staff and their own assignments. Staff records are for school admins only. Leaving ends access and assignments at once. Assignments are ended, never deleted, and a closed year's assignments are read-only.
- Migration: `0011_staff` (three new tables, new access helpers, narrower teacher visibility). Must be applied to the demo database before deploying.
- Verification (local): typecheck, 245 integration tests, build and 34 browser tests passed.

### Phase 3: school and academic setup — 2026-11-15

- Added: School setup for school admins (`/school/setup`), with a checklist that is also shown on the dashboard.
- Added: school profile editing (name, short name, address, contact details, time zone, accent colour).
- Added: academic years (planned, current, closed, reopen), classes (Class 1-12 in one step), sections per year, subjects, subjects per class, and copying a year's structure into a new year.
- Added: grading schemes with exact percentage bands, pass marks and a CBSE-style starter; school calendar (holidays, events, exam periods); attendance sessions (every school starts with "Full day").
- Security: setup is isolated per school; only school admins can change it; a closed year's setup is read-only in the database; anything in use can only be archived.
- Fixed: setup forms keep what you typed after an error (React cleared inputs after every form submission).
- Changed: the dashboard shows the current academic year instead of a placeholder "0 upcoming exams".
- Migration: `0010_academic_setup` (new tables, two nullable school columns, a default session for every existing school). Must be applied to the demo database before deploying.
- Verification (local): typecheck, 227 integration tests, build and 30 browser tests passed.

### Free hosted demo preparation — 2026-11-14

- Decision: free hosting during development (Vercel, Neon, Slack webhook); paid hosting later.
- Added: `EXAMIO_ENV=demo` with its own start-up rules (real MFA key, no owner credential, explicit proxy setting, no unscanned files).
- Added: `/internal/worker`, a secret-protected endpoint that runs one round of background work, and the `Worker tick` GitHub workflow that calls it every 10 minutes once configured. `WORKER_STALE_SECONDS` widens the stalled-worker check for scheduled runs.
- Changed: alerts are now queued as jobs, sent at most once per condition per hour across all workers and runs.
- Added: `pnpm hosted:migrate`, `hosted:seed` (demo schools with a private password, no public platform admin), `hosted:admin`, `hosted:alert-test`, using a git-ignored `.env.hosted` (template `.env.hosted.example`).
- CI: passed on GitHub on the first push; action versions updated for the Node 20 deprecation.

### Phase 2: shared UI, test isolation, jobs, files and operations — 2026-11-14

- Added: shared table, pagination, filter, loading and error components; loading, error and not-found pages; a skip-to-content link; a mobile menu that traps focus and closes on Escape; form fields that announce hints and errors to screen readers; 44px buttons. The platform school list now searches, filters by status and paginates.
- Changed: browser tests run against their own database (`examio_e2e`), dropped and recreated each run; they no longer write to the development database. New settings `E2E_DATABASE_URL`, `E2E_DATABASE_OWNER_URL`, `E2E_BROWSER_CHANNEL`.
- Security: every command that truncates or drops data refuses databases that are not local, not named `*_test`/`*_e2e`, or are the development database.
- Added: GitHub Actions workflow (type check, integration tests, build, browser tests) using throwaway databases. Not yet run.
- Added: background job queue with retries, backoff, lease recovery and a dead-letter list; `pnpm worker` (or `--once`). Platform admins can see and retry failed jobs on the new System page.
- Added: notifications. When platform support opens access to a school, its admins get an in-app notice on their dashboard and a sandboxed email (recorded, never sent).
- Added: private file storage: uploads are type-checked from their bytes, held in quarantine until scanned (ClamAV, or `dev-allow` in development only), downloadable only by permitted people through `/files/[id]`; system exports expire within 7 days. No upload screen yet.
- Added: audit log pages for platform admins (`/admin/audit`) and school admins (`/school/audit`); a public `/health` check; redacting structured logs; alerts to the log or a webhook; `EXAMIO_ENV` with production rules checked at start-up.
- Added: `pnpm ops:backup`, `pnpm ops:restore-rehearsal`, `pnpm ops:alert-test`.
- Migrations: `0008_jobs_notifications`, `0009_files` (new tables and functions only). Deploy with the matching application code.
- Verification (local): typecheck, 199 integration tests, build and 26 browser tests passed; backup and restore rehearsal passed.

### Two-step sign-in with an authenticator app (task 01.4; Phase 1 complete) — 2026-11-14

- Decision: MFA uses an authenticator app. Required for platform admins, optional for school admins.
- Added: two-step sign-in. New pages `/mfa` (enter the code after the password) and `/mfa/setup` (turn it on, see ten backup codes once; school admins can turn it off). Each code works once; wrong codes are rate limited.
- Security: a platform admin has no platform access until an authenticator is enrolled, enforced in the database. Existing platform admins must enrol at their next sign-in.
- Changed: redeeming an activation or reset code now also removes the account's authenticator, as the lost-device recovery path.
- Changed: the development seed enrols the demo platform admin with a public demo authenticator key; signing in as that admin now needs a code.
- Configuration: new `MFA_ENCRYPTION_KEY` (required in production mode, including `pnpm test:e2e`) and optional `SEED_SUPERADMIN_TOTP_SECRET`. The web app now loads the root `.env` before reading any setting; previously `TRUSTED_PROXY_HOPS` from `.env` could be missed under `next start`.
- Migration: `0007_mfa` (two new tables, one new session column). Deploy with the matching application code.
- Verification (local): typecheck, 141 integration tests, build and 12 browser tests passed.

### Account recovery, invitations, support access and administrator bootstrap (tasks 01.2, 01.4 except MFA) — 2026-11-13

- Decision: activation and password reset use single-use codes handed out by the school; no email or SMS. MFA was deferred at this point and added on 2026-11-14 (see above).
- Added: one-time activation and reset codes. A school admin issues them for its own users and a platform admin for school admins, each with a recorded reason. New public page `/redeem`; the platform school page can issue a reset code for a school admin. Redeeming a code signs the user out everywhere.
- Added: membership invitations and the page `/join`, so a person who already has an account can be linked to a second school with their consent.
- Changed: sessions now end after 30 days from sign-in regardless of activity (the 7-day idle limit is unchanged). Users and admins can end sessions.
- Security: a platform admin no longer sees every user, membership and audit event. Routine access is limited to schools, platform admins and school admins; other school records need a support access grant (maximum 4 hours, reason required, recorded in the school's audit log, visible to its admins).
- Added: `pnpm admin:bootstrap` creates the first platform administrator with a one-time code instead of a password. Platform administrators still cannot be created through the application.
- Migrations: `0005_account_recovery` and `0006_support_access`. New tables only; no existing data is rewritten. Both must be deployed with the matching application code.
- Verification (local): typecheck, 126 integration tests, build and 12 browser tests passed. The bootstrap command was exercised against the test database and its refusal path against the development database.

### Security: rate limits and capability checks (tasks 01.3, 01.5) — 2026-11-13

- Security: sign-in rate limits are now shared across server instances (stored in PostgreSQL) and enforced inside the sign-in service. Only failed attempts count. Limits per 10 minutes: 8 per account and address, 30 per account, 300 per address. The in-memory limiter was removed.
- Security: phone numbers in any format, and emails/usernames in any letter case, share one rate-limit counter. Oversized sign-in input is rejected before lookup. Password change allows 8 wrong current-password attempts per 10 minutes.
- Security: the client address is no longer taken from a client-supplied `X-Forwarded-For` value. New optional setting `TRUSTED_PROXY_HOPS` (default 0) says how many trusted proxies sit in front of the app; an invalid value stops the server at start.
- Added: capability checks for school services. Teachers can no longer call the member contact list service; students, parents and finance staff can no longer call the member count service. No current screen exposed these to them.
- Added: `finance` membership role. It grants nothing beyond basic membership until the fees module.
- Migrations: `0003_rate_limits` (new table and functions) and `0004_finance_role` (new enum value; cannot be dropped later). No existing data is rewritten.
- Verification (local): typecheck, 73 integration tests, build and 8 browser tests passed.

### Security: identity and tenant boundaries (task 01.1) — 2026-11-13

- Security: a school admin can no longer attach another school's user or a platform admin to their school, edit a user shared with another school, edit a fellow school admin, or change membership roles. Users can no longer update their own account row directly; password change is unchanged for users.
- Security: platform access is verified against the account in the database, not only a request flag. Members of a suspended school and disabled accounts lose database access immediately.
- Security: the runtime database role has per-table least-privilege grants (no deletes on identity, membership, school or audit data; password hashes not readable). Sessions are protected by RLS. Helper functions are no longer executable by PUBLIC.
- Changed: only a platform admin can change a school's status, board or medium; school code is immutable at runtime.
- Changed: school services return "not found" for another school's identifier; status and lookup changes on unknown identifiers return "not found" instead of silently succeeding.
- Added: the web server refuses to start if `DATABASE_URL` uses a role that can bypass Row Level Security; `pnpm db:migrate` fails for an unsafe runtime role or a table without reviewed grants.
- Migration: `0002_identity_hardening` (policies, functions, trigger, sessions RLS; no data rewrite). Deploy with the matching application code. Recovery is forward-fix.
- Verification (local): typecheck, 47 integration tests, build and 8 browser tests passed.

### Scope confirmation — 2026-11-13

- Recorded in TASKS.md that negative marking, self-service password reset and verified recovery, privileged-account MFA, descriptive questions with manual grading, and the full 15-phase scope are confirmed. These supersede the narrower 2026-11-10 defaults.
- Added offline (paper) exam marks entry to Phase 12 as task 12.3 and renumbered the later Phase 12 tasks to 12.4-12.6. Added planned rules, tables, endpoints, pages, flow, permissions and test cases for it to the affected specifications. The roadmap remains 15 phases.
- Listed nine other suggested features in TASKS.md as deferred candidates; none is scheduled.
- Recovery channel and MFA mechanism remain undecided. Documentation-only change: no application code or database changes were made.

### Development roadmap — 2026-11-13

- Replaced the previous delivery numbering with an authoritative 15-phase roadmap in TASKS.md, including dependencies, task checklists, exit criteria and a resume checkpoint.
- Scheduled all proposed modules, including admissions, library, transport, inventory, HR/payroll, platform subscriptions and consolidated reporting.
- Updated contributor instructions and affected specifications to reference the new roadmap. All phases remain planned; no application code or database changes were made.

### Documentation — 2026-11-13

- Established a 20-document baseline for a full school-management system with MIS, practice and formal examinations as connected modules.
- Defined phased scope, acceptance criteria, routes, permissions, proposed data/API contracts and business rules.
- Documented existing implementation separately from planned authentication, security, integrations and operational controls.
- Updated setup/run guidance, test side effects, deployment requirements and contributor instructions.
- Documentation-only change: no application behavior, schema migrations, provider connections or deployments changed.

### Existing foundation inventory

The following was already present when documented; original implementation dates are not asserted:

- pnpm workspace with Next.js web app, core services and Drizzle/PostgreSQL database package.
- Password authentication, hashed sessions, forced password change and role-based portal routing.
- School onboarding/status, board/medium administration and tenant RLS policies.
- Basic school/student portal shells and authentication/isolation/browser test source.

Validation recorded during initial analysis: `pnpm typecheck` passed. Integration/E2E execution and production readiness are not implied.

## Future entry format

For each release record version/date, added/changed/fixed/security items, migration/environment changes, compatibility or rollback constraints, and verification reference. Add a breaking-change section whenever existing users, clients or data require migration.
