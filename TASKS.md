# Development roadmap: 15 phases

Updated: 2026-11-13. This is the authoritative delivery plan for Examio: a full school-management system with MIS, student practice and formal examinations. The user requested all previously proposed modules, including admissions, library, transport, inventory, HR/payroll and platform subscriptions. They are now scheduled scope rather than an unscheduled backlog.

This roadmap replaces the earlier P0-P8 phase numbering. Existing foundation work is the baseline, not an additional development phase. Phase 1 is **Complete** (2026-11-14); Phase 2 is **In progress** (code complete and CI passing; staging waits for paid hosting); Phases 3-12 are **Complete** (Phase 12 on 2026-11-19; Phase 8 in Razorpay test mode; Phase 11 load benchmark and Phase 12 report-card format pending agreement); Phase 13 is **Complete** (2026-11-19); Phase 14 is **Complete** (2026-11-19); Phase 15 is **In progress** (15.1 subscriptions and 15.2 usage and reports done 2026-11-20). Documentation completion does not mean implementation completion. No schedule or delivery dates are promised.

## Resume here

- Current state: Phases 1 and 3-14 are complete (Phase 14 on 2026-11-19). Phase 2 is complete except a staging environment, which waits for paid hosting. The free demo is at https://examio-teal.vercel.app; see the deployment line below for what it runs.
- Next work: Phase 15, task 15.3 (environment documentation, production provisioning runbook, migration and rollback rehearsal; prepared, not provisioned, per the 2026-11-20 decision). Payroll policy agreed 2026-11-19: school-defined earning and deduction components (no built-in statutory rules or filing), finance prepares and a different administrator approves, office-marked staff attendance, leave approved by an administrator other than the requester. Completed phases are deployed to the demo automatically (migrate Neon, then push).
- Last recorded checks (2026-11-20, local, 15.2): `pnpm typecheck` passed; `pnpm test` 396 tests in 40 files passed; `pnpm build` passed; browser tests 72 passed; development database migrated to 0033. GitHub CI passed on the 13.3 commit (f929a64). The run for cebec6c (a documentation commit) failed only because Ubuntu package mirrors returned 503 while installing the test browser; the next run passed.
- Demo deployment: Phases 1-11 live on https://examio-teal.vercel.app (2026-11-18; demo database migrated to 0021: exam tables, policies, functions, triggers and grants verified; signed in on the live site as teacher, principal, student and parent and opened Exams). Phases 12 and 13.1: Phase 12 live since 2026-11-19 (demo database migrated to 0022: grading tables and functions verified; results pages opened on the live site as principal, teacher, student and parent; CI passed); 13.1 admissions live since 2026-11-19 (demo database migrated to 0023; `/school/admissions` opened on the live site as principal; CI passed on b646224). 13.2 library live since 2026-11-19 (demo database migrated to 0024: four library tables with RLS, 12 policies, the one-open-loan index and grants verified; `/school/library`, the catalogue, `/student/library` and the parent page opened on the live site; CI passed on e63f827). 13.3 inventory live since 2026-11-19 (demo database migrated to 0025: seven inventory tables with RLS, 19 policies, the one-allocation index, the non-negative stock check, the disposal trigger and append-only history grants verified; `/school/inventory` opened as principal, and a teacher is sent back to their dashboard; CI passed on f929a64). 13.4-13.5 live since 2026-11-19 (demo database migrated to 0026: four transport tables with RLS, 12 policies, the one-route-per-student index and the three capacity triggers verified; the School operations card, `/school/transport` with its CSV download, `/student/transport` and the parent page opened on the live site). CI on 7c2f77d failed: a new test (`operations-reports.test.ts`) created three refused calls before awaiting them, leaving one rejection briefly unhandled, which Vitest reports as an error on CI; all 358 tests themselves passed. Fixed in the next commit by starting each call only when it is checked. 14.1 HR records live since 2026-11-19 (demo database migrated to 0027: six HR tables with RLS, 17 policies, append-only history and no support access to payment details verified; `/school/hr` opened as principal, while teacher and finance are sent to their own pages; CI passed on 6aed61a). 14.2 leave live since 2026-11-19 (demo database migrated to 0028: four tables with RLS, 11 policies, the overlap constraint and the decision guard verified; staff leave and register pages opened as principal, My leave as teacher and finance; CI passed on d5d9ef1). 14.3 payroll live since 2026-11-19 (demo database migrated to 0029: five payroll tables with RLS, 13 policies, the finance read policies, one run per month, insert-only salaries and no support access verified; `/school/payroll` opened as principal, salaries as finance, and a teacher is sent to the dashboard; CI passed on bd8d44c). 14.4 live since 2026-11-19 (demo database migrated to 0030: payments and adjustments tables with RLS, 6 policies, three guard triggers and the one-active-payment index verified; adjustments opened as principal and payroll as finance; CI passed on 01a5cd0). 14.5 live since 2026-11-19 (demo database migrated to 0031: the four self policies and helper functions verified, the functions not executable by PUBLIC; My payslips opened as teacher and finance; CI passed on 8c4fab6). 15.1 live since 2026-11-20 (demo database migrated to 0032: four subscription tables with RLS, 11 policies, the read-only guard on 96 school tables with 8 documented exemptions, the student-cap trigger, no subscriptions so every school active; Subscription, Library, Exams, student Results and the parent page opened through the new checks; CI passed on 49e418b). The free demo's scheduled worker stays inactive until `CRON_SECRET` and `WORKER_URL` are set; signed-in pages verified with the sample accounts (password in `.env.hosted` `SEED_DEMO_PASSWORD`).
- Before working: read AGENTS.md, this file, SECURITY.md and the relevant module specifications.
- After each implementation session: update task checkboxes, phase status, actual checks, outstanding issues and this resume section.
- A phase becomes Complete only when its exit criteria and the shared definition of done pass. Record partial progress without skipping unresolved acceptance criteria.

## Existing foundation

Implemented in source: pnpm workspace; Next.js app; core/database separation; password login and hashed sessions; password change; school/admin onboarding; board/medium settings; school statuses; basic role routing; school/student portal shells; RLS and auth/isolation/browser test source.

Known verification: `pnpm typecheck` passed during initial repository analysis. Integration/E2E execution and production readiness were not established by the documentation work. Preserve this foundation and improve it rather than rebuilding unnecessarily.

## Phase overview

| Phase | Deliverable | Principal dependencies | Priority | Status |
| --- | --- | --- | --- | --- |
| 1 | Security, identity and access foundation | Existing foundation | Critical | Complete (2026-11-14) |
| 2 | Shared UI, infrastructure and development quality | 1 | Critical | In progress (02.1-02.4 done; 02.5 needs paid hosting for staging) |
| 3 | School and academic setup | 1-2 | High | Complete (2026-11-15) |
| 4 | Staff management and assignments | 3 | High | Complete (2026-11-15) |
| 5 | Student MIS, guardians and academic history | 3-4 | High | Complete (2026-11-15) |
| 6 | Attendance, calendar and timetable | 4-5 | High | Complete (2026-11-15) |
| 7 | Homework, communication and family portals | 2, 5-6 | High | Complete (2026-11-15) |
| 8 | Fees, payments and finance | 2, 5, finance policy | High | Complete (2026-11-15; Razorpay test mode) |
| 9 | Curriculum and question bank | 3-4, private files from 2 | High | Complete (2026-11-15) |
| 10 | Student practice and learning progress | 5, 9 | High | Complete (2026-11-15) |
| 11 | Formal exams and reliable exam-taking | 2, 5, 9 | Critical | Complete (2026-11-18; load benchmark pending) |
| 12 | Grading, offline marks entry, results and academic reporting | 3-5, 10-11 | High | Complete (2026-11-19; report-card format provisional) |
| 13 | Admissions, library, inventory and transport | 5-8, module specifications | High | Complete (2026-11-19) |
| 14 | HR, leave and payroll | 4, 8, payroll policy | High | Complete (2026-11-19) |
| 15 | Platform subscriptions, consolidated analytics and release readiness | 1-14 | Critical | In progress (15.1-15.2 done 2026-11-20) |

Delivery order is 1 through 15 by default; dependencies identify technical prerequisites if the user later changes priorities. Security, testing, accessibility, monitoring and backups are continuous responsibilities, not work deferred until Phase 15. Phases vary in size; do not interpret them as equal-duration sprints.

## Phase 1 — Security, identity and access

- [x] 01.1 Restrict global identity writes, membership grants, database/function privileges and shared-user access; enforce tenant boundaries on every service/action. Done 2026-11-13: migration `0002_identity_hardening`, least-privilege runtime grants, service scope guards, startup role check and negative tests (`packages/core/tests/identity-boundaries.test.ts`).
- [x] 01.2 Add invitation/activation, password reset and verified recovery, single-use hashed tokens, session revocation/cleanup and a deliberate cookie renewal policy. Done 2026-11-13: one-time activation/reset codes handed out by the school, membership invitations, `/redeem` and `/join`, session revocation, 7-day idle and 30-day absolute session limits, cleanup (migration `0005_account_recovery`); tests in `account-recovery.test.ts` and `invitations.test.ts`.
- [x] 01.3 Add distributed rate limiting, canonical account keys, bounded input and trusted proxy handling. Done 2026-11-13: PostgreSQL-backed limiter (migration `0003_rate_limits`), limits enforced inside `login` and `changeOwnPassword`, `TRUSTED_PROXY_HOPS`, tests in `packages/core/tests/rate-limit.test.ts`.
- [x] 01.4 Implement privileged-account MFA, safe production administrator bootstrap and audited privileged support access. Done 2026-11-14: authenticator-app two-step sign-in, required for platform admins and optional for school admins (migration `0007_mfa`, tests in `mfa.test.ts`); `pnpm admin:bootstrap`; time-limited audited support access (migration `0006_support_access`; tests in `bootstrap-admin.test.ts` and `support-access.test.ts`).
- [x] 01.5 Establish capability checks for school admin, teacher, student, parent and finance; extend roles deliberately when later modules require them. Done 2026-11-13: `withCapability` and the capability map in `packages/core/src/capabilities.ts`, `finance` membership role (migration `0004_finance_role`), tests in `packages/core/tests/capabilities.test.ts`.

Exit: forged tenant/role inputs, shared identities, expired/replayed recovery tokens, revoked memberships and suspended schools pass negative tests. No new workflow can bypass these controls. Resolve recovery channel and MFA choices before enabling the affected flow.

Carried forward from 01.1:

- A school admin cannot attach an identity that already belongs to another school directly. Since 01.2 the school issues a membership invitation and the person accepts it while signed in.
- A school admin can still create a new account with any unused email or username. Codes are handed over in person, so there is no verified email or phone channel; this stays an accepted limitation of the hand-out model.
- A school admin cannot change or recover a fellow school admin's account; a platform admin issues the reset code. This is a provisional rule.
- Teachers still read all users and memberships of their school; assignment-scoped reads are Phase 4 (04.4). Role-level capability checks in services are 01.5.
- Platform administrators cannot be created or promoted through the application; since 01.4 an operator uses `pnpm admin:bootstrap`.

Carried forward from 01.3:

- Limit values are provisional: 8 failed sign-ins per account and address, 30 per account, 300 per address, each per 10 minutes; 8 failed current-password checks per user per 10 minutes. Review them against pilot traffic.
- Address-based limits apply only when `TRUSTED_PROXY_HOPS` is set for the hosting setup. With the default of 0 only the per-account limit applies, so an attacker can lock a known account out of sign-in for the window. Set the value when hosting is chosen.
- Expired counters are removed opportunistically; a scheduled cleanup belongs to the job runner in Phase 2 (02.4).
- Code redemption and invitation acceptance use the same limiter (done in 01.2).

Carried forward from 01.2:

- Only the platform admin has a screen for issuing reset codes (for school admins). School admins can issue activation and reset codes and create invitations through the services, but their screens arrive with the people pages in Phases 4-5 (04.1, 05.3).
- Code lifetimes are provisional: 48 hours for activation and invitations, 24 hours for password reset.
- The school is responsible for checking who it hands a code to; the issuer and the stated reason are in the audit log. There is no self-service reset.
- Guardian invitations still need a verified child link (05.3); the invitation table has no child reference yet.
- Expired sessions, codes and invitations are purged opportunistically at sign-in until the job runner exists (02.4).

Carried forward from 01.4:

- MFA has no QR code: the setup key is typed into the authenticator app (or opened through a link on the same phone). A QR code needs an image-generation dependency and is left for Phase 2 UI work.
- A lost authenticator is recovered with a backup code or an account reset code, which removes the authenticator. For a platform admin that means the operator command `pnpm admin:bootstrap --recover`.
- `MFA_ENCRYPTION_KEY` must be kept safe and unchanged; replacing it makes every enrolled authenticator unreadable. Key rotation is not implemented.
- School admins can turn two-step sign-in on and off themselves; a school cannot yet require it for its own admins.
- Support access has one screen (open, end, recent history on the platform school page). School admins can read their school's support history through the service; their screen comes with the audit viewer (02.5).
- `pnpm admin:bootstrap` was tested against the test database and its refusal path against the development database. It has not been run on a production database, because none exists.

Carried forward from 01.5:

- The capability map covers only the three school operations that exist today. Every new service must add its capability and call `withCapability`; do not test role names in services.
- The finance role exists and can be assigned, but it has no portal and no finance capabilities until Phase 8. Finance-only and parent-only users still land on the no-access page.
- Assignment scope (teacher), ownership (student) and child links (parent) are not capabilities; they are added with the modules that need them (Phases 4-5).

## Phase 2 — Shared UI, infrastructure and development quality

- [x] 02.1 Standardize responsive shells, forms, tables, pagination, filters and loading/error/empty states; fix keyboard/focus behavior. Done 2026-11-14: `DataTable`, `Pagination`, `FilterBar`, `PageLoading`, `ErrorView`, loading/error/not-found pages, accessible `Field`, skip link and focus-trapped mobile drawer; school list searchable and paginated; tests in `paging.test.ts` and `e2e/accessibility.spec.ts`.
- [x] 02.2 Establish isolated test environments and CI typecheck/build/relevant test gates; prevent fixture operations against live/dev data. Done 2026-11-14: disposable-database guard on every destructive script and fixture, browser tests on their own recreated `examio_e2e` database, `.github/workflows/ci.yml` passing on GitHub.
- [x] 02.3 Build private file storage with upload validation/quarantine/scanning, authorized downloads and export expiry. Done 2026-11-14: `files` table and policies (migration `0009_files`), local-disk storage, ClamAV and dev-allow scanners, type detection from bytes, `/files/[id]` download route, expiring exports, purge; tests in `files.test.ts`.
- [x] 02.4 Add durable job/outbox processing, idempotency, retries, dead-letter inspection and provider adapters. Done 2026-11-14: job queue with leases, backoff and dead letters, `pnpm worker`, notifications with in-app and sandbox email delivery, `withIdempotency`, dead-letter retry on `/admin/system` (migration `0008_jobs_notifications`); tests in `jobs.test.ts`, `notifications.test.ts`, `idempotency-logging.test.ts`.
- [ ] 02.5 Add audit viewer, redacted logging, monitoring, staging, backups, restore rehearsal and configuration validation. Done locally 2026-11-14: `/admin/audit` and `/school/audit`, redacting JSON logger and request-error logging, health checks on `/admin/system` and `/health`, worker alerts (log/webhook), `EXAMIO_ENV` configuration validation, `pnpm ops:backup` and `pnpm ops:restore-rehearsal` (passed), `pnpm ops:alert-test`; tests in `ops.test.ts`, `e2e/operations.spec.ts`. **Open: no staging environment and no alert channel to a person** (need hosting and channel choices).

Exit: a synthetic upload, queued job, notification sandbox and export complete with tested failure/retry paths; no unauthorized file access; accessible core shell; isolated checks and restore/alert rehearsal pass. Provider selection is required only for the adapters being enabled.

Exit status (2026-11-14): met except staging. CI passed on GitHub on the first push (run 43563660579). The user chose free hosting during development (Vercel + Neon + Slack webhook) and paid hosting later; the free demo is not staging (scheduled worker, no scanner, no persistent disk), so 02.5 stays open until the paid server exists. A real alert rehearsal to Slack happens when the demo is set up (DEPLOYMENT.md, Free hosted demo).

Carried forward from Phase 2:

- Only the local-disk storage driver exists. It does not survive on serverless hosting (for example Vercel); an object-storage driver is needed before files are used on a hosted demo.
- No ClamAV daemon runs on this machine. Development and CI use `FILE_SCANNER=dev-allow`, which marks uploads clean without scanning and is refused in staging/production.
- There is no upload screen yet: modules that need uploads (homework, profile documents, imports) add their own purpose, policy and UI. The download route `/files/[id]` exists.
- Email has only the sandbox adapter: email notifications are recorded, never sent. In-app notices work.
- `withIdempotency` is built and tested but no current action uses it; finance and assessment submissions (Phases 8 and 11) must.
- The worker runs as a separate long-lived process (`pnpm worker`) or from a scheduler (`pnpm worker --once`). How it runs on the chosen host is a deployment decision.
- Server Actions accept bodies up to Next.js's default limit; uploads larger than that need a route handler or a raised limit when the first upload screen is built.
- Health thresholds and job retention (succeeded 14 days, dead 90 days) are provisional.
- On this Windows machine the Vitest worker process occasionally crashes with exit code 0xC0000409 (2 of 4 full runs on 2026-11-14, in `notifications.test.ts`); no assertion fails, the file passes when re-run, and it has not happened on Linux CI. The browser-test runner crashed the same way once. Investigate if it becomes frequent (Node 24.15 on Windows).
- Free demo: Neon database set up 2026-11-14 (project dry-unit-42676649, branch production, Singapore): `pnpm hosted:migrate` and `pnpm hosted:seed` succeeded, 10 migrations applied, restricted role verified (cannot bypass RLS, sees no rows without context). Vercel website live 2026-11-15 at https://examio-teal.vercel.app (health OK, worker endpoint verified). Still to do: platform admin (`pnpm hosted:admin`), Slack webhook, GitHub `WORKER_URL` variable and `CRON_SECRET` secret for the Worker tick schedule. Neon skill and MCP server (OAuth, project-pinned) installed for Claude Code in this repo.
- Backups are a local scripted baseline (`pnpm ops:backup`, `pnpm ops:restore-rehearsal`); hosted environments still need encrypted, off-site, scheduled backups with point-in-time recovery.

## Phase 3 — School and academic setup

- [x] 03.1 School profile, timezone, contact details, branding and configuration. Done 2026-11-15: `/school/setup/profile` (name, short name, address, contact, validated time zone, accent colour); board, medium, status and code stay platform-controlled.
- [x] 03.2 Academic years, classes, sections, subjects and class-subject mappings. Done 2026-11-15: year lifecycle planned/current/closed with one current year, Class 1-12 in one step, sections per year, subjects with fixed codes, per-class subject assignment, copy structure into a new year (migration `0010_academic_setup`).
- [x] 03.3 Grading schemes, pass rules, school calendar/holidays and configurable attendance sessions. Done 2026-11-15: exact basis-point grading with one band from 0%, CBSE-style preset, default scheme; holidays/events/exam periods inside the year; per-school attendance sessions with a default "Full day".
- [x] 03.4 Setup completeness checks, archival rules and school-admin dashboard. Done 2026-11-15: setup checklist on `/school/setup` and the dashboard; archive instead of delete for anything in use (RESTRICT keys); closed years read-only in the database.

Exit: admin can prepare a new school/year without database scripts; duplicate/invalid setup is rejected, school data is isolated and referenced historical setup cannot be silently deleted. Curriculum, language and grading assumptions are documented.

Exit status (2026-11-15): met. The browser journey `e2e/setup.spec.ts` prepares a year from the screens alone; integration tests cover duplicates, invalid values, closed years, archive-not-delete, composite same-school keys and cross-school isolation; assumptions are in BUSINESS_RULES.md (Academic setup).

Carried forward from Phase 3:

- Branding is a short name and an accent colour. A school logo is deferred: it needs a file purpose visible to all members and persistent storage, which the free demo lacks (local disk on Vercel). The accent colour is stored but not yet applied to the interface.
- Platform support access can read a school's setup but not change it.
- Overlapping academic years are allowed with a warning; the overlap policy is still a product decision.
- Grading schemes are defined but not yet used: results and report cards (Phase 12) will apply them. A scheme used by published results must become immutable then (versioning is Phase 12 work).
- Attendance sessions and holidays are stored for Phase 6; nothing reads them yet.
- Subject codes cannot be changed after creation; there is no bulk import of classes or subjects (imports come with Phases 4-5).
- Forms built on `ActionForm` keep typed values after an error. The older forms (login, change password, redeem, join, MFA, school creation) still use React's automatic reset and restore values from state; move them to `ActionForm` when they are next touched.
- When a row action removes its own button (make current, delete), its confirmation disappears with it; the change itself is visible on the page.

## Phase 4 — Staff management and assignments

- [x] 04.1 Tenant staff profiles, employee identifiers, teacher invitations and account lifecycle. Done 2026-11-15: `/school/staff`; staff profiles with per-school employee numbers; new staff get a one-time activation code; existing Examio users are invited and then given staff details; leave and return; new activation/reset codes and sign out of all devices from the staff page (migration `0011_staff`).
- [x] 04.2 Subject/section/year assignments, effective dates and class-teacher responsibility. Done 2026-11-15: assignments only for subjects the class studies that year, co-teaching allowed, start/end dates inside the year, ended never deleted; one class teacher per section, replaced from a date; closed years read-only in the database; "Who teaches what" with gaps.
- [x] 04.3 Staff search, filters, validated bulk import and scoped exports. Done 2026-11-15: search by name, number, email or phone with status/role filters; CSV import with preview, all-or-nothing commit, fingerprint and idempotency key; audited CSV export with formula cells neutralised.
- [x] 04.4 Teacher dashboard and assignment-based access enforced in services and database policies where applicable. Done 2026-11-15: "My classes today"; teachers read only staff users/memberships, their own profile and assignments (no students, parents or member counts); `app_teaches_section` / `app_teaches_subject` decide by date and active profile, ready for Phase 5 records.

Exit: teachers see only assigned educational records; assignment changes/revocation take effect; shared users retain other schools' identities and access. Retry imports cannot duplicate employees.

Exit status (2026-11-15): met for the records that exist so far. Integration tests cover access by date, after ending and after leaving; teachers not seeing students; isolation between schools; a member of two schools keeping the other school's identity and access; repeated and concurrent imports creating no duplicates. Browser journey `e2e/staff.spec.ts` adds and assigns a teacher who then sees the class, and imports a file once. Educational records (students, attendance, marks) arrive from Phase 5 and must use the Phase 4 helpers.

Carried forward from Phase 4:

- Teacher access to students, attendance, homework and marks is not built yet; each later module must scope teachers with `app_teaches_section` / `app_teaches_subject` and test unassigned access.
- "My classes today" lists assignments in force today, not periods; the timetable is Phase 6.
- Additional school administrators are added by platform support. Marking an administrator as left revokes their access; bringing them back restores only teacher or finance roles.
- Bringing back a staff member does not restore their earlier assignments.
- Imports run in the request (at most 300 rows), not through the job queue. Activation codes are handed over by the school; nothing is emailed. An email that already has an Examio account is refused in imports: invite that person instead.
- HR details (contracts, documents, salary, leave) are Phase 14.

## Phase 5 — Student MIS, guardians and academic history

- [x] 05.1 Student profiles, admission numbers, school-specific details, enrollment and section/roll allocation. Done 2026-11-15: `/school/students`; school-created student accounts with sign-in name `<school code>.<admission no>` and activation code; per-school admission numbers (case-insensitive, fixed); one open enrollment per student per year; roll numbers unique per section, numbered alphabetically on request (migration `0012_students`).
- [x] 05.2 Roster import mapping/preview/commit, row-level errors and duplicate detection. Done 2026-11-15: `/school/students/import`; header spellings mapped and shown; row errors (formats, duplicates in file and school, unknown section, roll clashes) and possible-duplicate warnings; all-or-nothing commit with fingerprint and idempotency key.
- [x] 05.3 Verified guardian links, invitations, multiple-child/school switching and parent portal entry. Done 2026-11-15: guardian links created only by the school (new parent account, sibling link, or a code naming the child accepted at `/join`); `/parent` with one page per child; school switching through `/select-school`.
- [x] 05.4 Promotion, transfer, withdrawal/archive and academic-year history with explicit effective dates. Done 2026-11-15: section moves from a date, corrections kept in history, promotion and graduation per section (retry-safe), leaving with reason and date, readmission.
- [x] 05.5 Student search, authorized profile documents and enrollment reports. Done 2026-11-15: search and filters by year, class, status; admin-only private documents; class strength report; audited CSV exports.

Exit: a student can be created/imported, enrolled, linked to a verified guardian and promoted without rewriting prior history. No arbitrary child lookup, duplicate school admission number or cross-school enrollment is possible.

Exit status (2026-11-15): met. Integration tests (`students.test.ts`) cover admission and sign-in, duplicates in any case, other schools' sections refused, enrollment history across moves and promotion, retry-safe promotion and import, leaving and readmission, and who sees which student (teacher by today's assignment, student self, parent by active link only, no direct link insertion, other school nothing). Browser journey `e2e/students.spec.ts`: admit, add a parent, student and parent each sign in and see only their own; import once.

Carried forward from Phase 5:

- The admission number cannot be corrected after creation (the sign-in name is built from it); a typo needs a new record.
- Moving section must be dated after the current enrollment started; a same-day mistake is undone as a "correction" that stays in the history for one day.
- Imports run in the request (at most 300 rows; import class by class), not through the job queue; there is no downloadable error file, errors are shown on screen.
- Student documents use local file storage, which the free demo (Vercel) does not keep between requests; documents need object storage before real use.
- Parents see class history only; attendance, homework, notices, results and fees arrive with later phases. Teachers see a class list (name, admission number, roll) and no guardian contacts.
- Parent invitations created before Phase 5 without a child give no access to any child (the new check is NOT VALID for those rows).
- Students sign in with the sign-in name only; adding a student's own email or mobile number is not offered yet.

## Phase 6 — Attendance, calendar and timetable

- [x] 06.1 Daily/session attendance, present/absent/late/excused statuses and missing-entry detection. Done 2026-11-15: registers per section, date and attendance session at `/school/attendance`; every student marked; school days from weekly days off and calendar holidays; registers taken/incomplete/not taken per day; not-recorded counted in reports (migrations `0013_attendance_timetable`, `0014_attendance_roster`).
- [x] 06.2 Date locks, corrections with reason, summaries and student/guardian views. Done 2026-11-15: teacher edit window and lock date (school settings, enforced in the database); reasons for later changes and locked dates; append-only change history; safe resubmission and stale-register refusal; student and parent attendance views.
- [x] 06.3 Class/teacher/room timetable, school calendar integration and conflict detection. Done 2026-11-15: weekly periods at `/school/timetable`; section, teacher and room clashes refused by exclusion constraints with explained messages; teacher must be assigned; teacher week and day view with holidays; student and parent timetables.
- [x] 06.4 Attendance and schedule reports, scoped exports and dashboard widgets. Done 2026-11-15: section attendance report with policy percentages and incomplete dates; teacher load report; audited CSV exports; "Attendance today" on the dashboard.

Exit: assigned teacher records a valid roster once per date/session; duplicate submissions are safe; locked corrections are controlled; teacher/class/room conflicts are blocked; percentages follow the documented policy and school timezone.

Exit status (2026-11-15): met. Integration tests (`attendance.test.ts`) cover one register per date and session, safe double submission, stale-register refusal, complete-roster and school-day checks, teacher scope, edit window and lock (also as direct database writes), reasons for corrections, closed years, cross-school isolation, the percentage policy (N/A), missing entries, student/parent/teacher views, and section/teacher/room clashes. Browser journey `e2e/timetable-attendance.spec.ts`: settings, a register taken and confirmed, a report, a period added and a clash refused.

Carried forward from Phase 6:

- One attendance policy only (the documented percentage); versioned school-specific policies are not built.
- Registers are whole-section and per session; there is no period-wise (per timetable period) attendance and no bulk "mark all absent" shortcut beyond the default of present.
- Timetable periods have no effective dates: a change applies to the whole year from then on (removed periods keep their rows). There is no substitution/cover planning and no printable timetable.
- Students and parents see subjects and rooms in the timetable but not teacher names (staff records are not visible to them).
- Attendance notifications to parents (absent alerts) are not sent; notifications come with Phase 7.
- Dates are handled in the school's time zone; the weekday shown for a date is computed from the calendar date.

## Phase 7 — Homework, communication and family portals

- [x] 07.1 Teacher assignments/homework with instructions, attachments, deadlines and target sections. Done 2026-11-15: `/school/homework`; one or more sections a teacher teaches, subject the class studies, due time in school time, private attachments readable by the homework's audience (migrations `0015_homework_announcements`, `0016_homework_files_per_homework`).
- [x] 07.2 Student submissions, late policy, feedback and completion tracking. Done 2026-11-15: private submissions (text and files), changeable until feedback, late rule per homework, feedback with one-time notification, submitted/late/missing per student, reminders once a day.
- [x] 07.3 School/class announcements, targeted messages, reminders and delivery status. Done 2026-11-15: `/school/announcements`; administrators any audience, teachers their classes; notifications queued once per recipient; delivery and read counts for administrators and authors.
- [x] 07.4 Complete student/parent daily views for timetable, attendance, homework and notices; expose future modules only when delivered. Done 2026-11-15: student "Today" page (periods, homework to do, attendance, notices), homework and notices pages; parent child page with homework, attendance and timetable, parent notices; results and progress stay marked "soon".

Exit: teacher publishes to an assigned class, student submits privately, feedback reaches authorized recipients, and retries cannot send duplicate business notifications. Revoked guardian links immediately lose access.

Exit status (2026-11-15): met. Integration tests (`communication.test.ts`) cover section-scoped publishing, notification recipients exactly the section's students and linked parents (not other sections or schools), retry creating no duplicate notification, private submissions, lock after feedback (also as a direct database write), the late rule, file visibility for attachments and submissions, reminders only to non-submitters once a day, notice audiences and teacher limits, delivery counts, and immediate loss of access after a guardian link is revoked. Browser journey `e2e/teaching-homework.spec.ts`: homework and a class notice reach a new student, who submits and later reads the feedback.

Carried forward from Phase 7:

- In-app notifications and emails are delivered by the background worker. On the free demo the scheduled worker is not active until the GitHub secret `CRON_SECRET` and variable `WORKER_URL` are set, so notifications stay pending there (homework and notices themselves are visible without it).
- Uploaded files stay "virus check pending" until the worker scans them, and the demo has no persistent file storage; attachments need object storage and the worker before real use.
- No scheduled (future-dated) notices or homework, no drafts in the interface (the `draft` status exists), no per-student grading or marks on homework (marks belong to Phase 12), no comment threads.
- Reminders are sent by the teacher on demand; there is no automatic reminder before the due time.
- Teachers who no longer teach a section still see homework they wrote, but not its current students' list.

## Phase 8 — Fees, payments and finance

- [x] 08.1 Finance capabilities, approved fee structures, discounts/tax/late-charge policy and due schedules. Done 2026-11-15: finance role area (`/school/fees`); fee heads with tax % (default 0); structures per class and year with items and due dates, approved by a school admin and then fixed; concessions (percent or amount) approved by another admin; flat late fee after grace days (migrations `0017_fees`, `0018_finance_reads`).
- [x] 08.2 Invoice issuance, immutable financial ledger, offline receipts and outstanding statements. Done 2026-11-15: invoices per instalment, once per student; append-only ledger with reversals; numbered offline receipts, retry-safe, never above the outstanding balance; student accounts.
- [x] 08.3 Online payment adapter, verified webhooks, pending/failure states and reconciliation. Done 2026-11-15: Razorpay Orders and webhook adapter (test mode) plus a sandbox provider through the same webhook path; HMAC-verified events applied exactly once; wrong amounts never credited; finance reconciliation asks the provider.
- [x] 08.4 Approved adjustments/refunds, reversal history, overdue reminders and finance reports. Done 2026-11-15: waivers, extra charges, refunds and receipt reversals approved by an admin other than the requester; invoice cancellation by reversal; overdue reminders once a day; collections, outstanding, defaulters, reconciliation check, audited CSV.
- [x] 08.5 Parent fee statements/payment journey and scoped receipt downloads. Done 2026-11-15: `/parent/fees` statements and online payment; printable receipts for finance staff and linked parents.

Exit: balances reconcile; duplicate/out-of-order payment events cannot double-credit; currency/rounding and reversal rules pass tests; browser redirects cannot mark invoices paid. Resolve currency, provider and financial policy before real transactions.

Exit status (2026-11-15): met for test mode. Integration tests (`fees.test.ts`) cover paise parsing and Indian formatting, half-up rounding and tax after discount, approval by someone else, fixed approved structures (also as a direct database write), retry-safe invoicing and receipts, an invalid webhook signature, exactly-once capture with duplicate and repeated events, a wrong amount, a failure after capture, a capture after a failure, a forged browser "captured" payment refused, an append-only ledger, late fees once, approved waivers/reversals/refunds, invoice cancellation by reversal, parent and school isolation, and an empty reconciliation check. Browser journey `e2e/students-fees.spec.ts`: setup, approval, invoices, a cash receipt, the parent's online test payment and the receipt. Decisions: INR, Razorpay test mode (user, 2026-11-15); tax 0% by default, flat late fee, approval by another admin (defaults chosen, configurable). Real transactions are not enabled.

Carried forward from Phase 8:

- Razorpay is integrated in test mode only. Going live needs Razorpay live keys, the webhook configured in the Razorpay dashboard, and an explicit decision; the demo uses the sandbox provider unless RAZORPAY_* variables are set on Vercel.
- Refunds are recorded in Examio and paid back outside it (cash or bank); refunds through the Razorpay API are not implemented.
- No GST tax invoices (GSTIN, HSN/SAC codes, tax-invoice format); tax is a simple rate per fee head.
- No payment plans, instalment rescheduling, sibling-discount rules or automatic concessions; concessions are per student.
- Late fees and overdue reminders run when finance clicks them; there is no scheduled job yet.
- Reconciliation asks the provider only about pending payments older than five minutes; settlements and bank statements are not imported.
- A school with a single school admin needs a finance user (or a second admin) to raise requests, because nobody approves their own request.

## Phase 9 — Curriculum and question bank

- [x] 09.1 Subject/chapter/topic hierarchy and difficulty classification. Done 2026-11-15: `/school/questions/curriculum`; chapters and topics per subject (two levels, same-subject keys, no cycles), archive instead of delete; difficulty easy/medium/hard (migration `0019_question_bank`).
- [x] 09.2 Question editor, images, answer keys, explanations, marks and validation. Done 2026-11-15: editor with marks in hundredths, optional negative marks, explanation, one private image; validation per type.
- [x] 09.3 Single-choice/true-false questions plus descriptive authoring; additional types require explicit scoring rules. Done 2026-11-15: the three types; nothing else accepted.
- [x] 09.4 Version history, draft/review/archive, search, filters and validated bulk import. Done 2026-11-15: numbered versions locked on publication (edits create a new version); draft → in review → published, archive/restore; search by text with subject, chapter/topic, type, difficulty and status filters; CSV import with per-row errors, optional creation of chapters, all-or-nothing and retry-safe.
- [x] 09.5 Preview and teacher subject permissions; prevent answer-key exposure to learner clients. Done 2026-11-15: student-view preview; teachers limited to subjects they currently teach; students and parents have no database access to the bank; `learnerView` strips keys and explanations.

Exit: teachers can build and find reusable questions, edits create appropriate versions, and published assessment references remain immutable. Import errors are actionable; media access stays scoped.

Exit status (2026-11-15): met. Integration tests (`questions.test.ts`) cover the content rules per type and marks, the learner view without keys, chapter/topic permissions and same-subject keys, admin-only publishing (also as a direct database write), locked published versions with new versions on edit, no access for students, parents, other subjects' teachers, teachers whose assignment ended or other schools, search filters, archive/restore, image visibility and the import (actionable errors, chapter creation, retry and changed-file refusal). Browser journey `e2e/teaching-questions.spec.ts`: chapter and topic, a question written and published, an edit creating version 2, and a one-row import.

Carried forward from Phase 9:

- Plain text only: no rich text, formulas (LaTeX) or tables in questions; one image per question; images stay "virus check pending" on the demo (no scanner).
- No multiple-correct, numeric, matching or fill-in-the-blank types (each needs explicit scoring rules first).
- No "lock on use" yet: practice sets and exams (Phases 10-11) will reference published versions only, which are already locked.
- Review is one step by a school administrator; there is no reviewer role, comments or side-by-side diff (versions are listed with their full content).
- Duplicate questions are not detected.

## Phase 10 — Student practice and learning progress

- [x] 10.1 Topic-wise practice, teacher-assigned sets, configurable availability and attempt limits. Done 2026-11-15: `/school/practice`; sets of one subject built from published (locked) question versions, picked or added by chapter/topic, fixed on publication; assigned to sections (teachers: sections they teach) with optional opening/closing times; attempt limit 1-50 or unlimited (migration `0020_practice`).
- [x] 10.2 Saved answers, reconnect recovery, repeat attempts and submission feedback. Done 2026-11-15: `/student/practice`; one attempt in progress at a time (starting again resumes it); each answer saved at once with a revision, so a stale window cannot overwrite a newer answer; reopening the page restores saved answers; submission scored in the database; feedback right after submitting or after the assignment closes.
- [x] 10.3 Explanations, weak-topic indicators, attempt history and learning progress. Done 2026-11-15: correct answers and explanations per the feedback rule; `/student/progress` with accuracy per chapter/topic, sample size, "needs practice" below 60% from 5 answers, recent attempts.
- [x] 10.4 Teacher participation summaries and guardian visibility into permitted child feedback. Done 2026-11-15: per section every current student's attempts, best score and last submission, per question the share correct; parents see the child's practice, attempts and progress, with results only once released.

Exit: eligible student starts, saves, resumes, submits and retries according to policy. Practice results never change formal grades; explanations follow release rules and progress includes sufficient context/sample size.

Exit status (2026-11-15): met. Integration tests (`practice.test.ts`) cover building by subject authors only, published versions only, items fixed after publication (also as direct database writes, including returning a published set to draft), teacher section scope, the assignment window and attempt limit (also as a direct insert), resume instead of a second attempt, answer validation and stale-revision conflicts, no learner read of items, question versions or keys, scoring only by `practice_submit` (negative marks, zero floor, descriptive not scored), after-close feedback withheld (also through the database function), submission after the window closed, progress sample size, parents read-only and limited to their children, participation counts, unassign/archive keeping attempts, and school isolation. Browser journey `e2e/teaching-practice.spec.ts`: a question published, a set built, published and assigned, a student answering (changed answer saved), submitting, seeing the score and the correct answer, and progress. Practice tables are separate from anything formal results will use.

Carried forward from Phase 10:

- Descriptive answers are saved but not scored or reviewed in practice; there is no teacher comment on practice answers.
- Questions appear in set order; no shuffling of questions or options, no per-attempt timer.
- The "needs practice" rule (60%, 5 answers) is fixed, not configurable per school.
- Before release, the score is hidden by the application, while the database returns answer keys only after release; the per-question correctness columns are readable by the student's own session (they reveal no keys).
- Progress uses each question's current chapter/topic; moving a question to another topic moves its history.
- No notifications when practice is assigned or closes.

## Phase 11 — Formal examinations and reliable exam-taking

- [x] 11.1 Draft exams, select/version questions, target classes, schedule, duration, marks, penalties and attempts. Done 2026-11-18: `/school/exams`; exams of one subject for the current year with published question versions in the chosen order, target sections (teachers: their sections), an opening window in school time, duration, 1-5 attempts and whether negative marks apply (migration `0021_exams`).
- [x] 11.2 Preview, admin approval/publication, eligibility, cancellation and documented accommodation/retake controls. Done 2026-11-18: questions shown as students see them; draft → waiting for approval (frozen) → published by a school administrator, or sent back; publication freezes everything (trigger `exams_guard`); eligibility by current enrollment in a target section; cancellation with a reason ends attempts in progress; accommodations (extra minutes, extra attempts) per student with a reason.
- [x] 11.3 Instructions, server timer, question navigation, mark for review and unanswered summary. Done 2026-11-18: `/student/exams`; instructions, a timer from the server's clock, a question navigator showing answered and marked questions, one question at a time, mark for review, a review page listing unanswered and marked questions.
- [x] 11.4 Autosave acknowledgements, refresh/reconnect recovery, stale-write handling and multi-tab conflicts. Done 2026-11-18: every answer saved at once and shown as saved only when acknowledged; failed saves retried and on reconnect; a warning before leaving with unsaved answers; reload restores acknowledged answers; revision checks refuse writes from a stale window or second tab.
- [x] 11.5 Idempotent start/submit, submission receipt, deadline finalization worker and operational monitoring. Done 2026-11-18: start under a database lock (repeat or concurrent starts give one attempt); repeat-safe submission with a receipt code; the worker submits overdue attempts on every tick (and opening an overdue attempt does too); an `exam_deadlines` health check and per-student monitoring for staff.

Exit: concurrent starts respect limits; acknowledged answers survive interruption; late/stale writes fail safely; duplicate submission returns the original receipt; deadline works without an open browser. Benchmark agreed concurrent exam workload before live exams.

Exit status (2026-11-18): met, except the load benchmark. Integration tests (`exams.test.ts`) cover six concurrent starts producing one attempt, the attempt limit and an administrator's retake, saves refused after the deadline and after submission, stale revisions refused, reload returning acknowledged answers, the original receipt on repeat submission, worker finalisation with the saved answers and without a browser, administrator-only publication and cancellation also as direct database writes, and no learner access to questions or keys outside an active attempt. Browser journey `e2e/teaching-exams.spec.ts`: two questions written, an exam built and published, a student answering, marking for review, reloading (answer kept), reviewing the unanswered question and submitting for a receipt, and staff seeing the submission.

Carried forward from Phase 11:

- No load benchmark yet: the agreed concurrent exam workload must be measured (start, save, submit) before live exams, especially on the free demo database.
- Scores and results are Phase 12; no scoring happens at submission.
- No question or option shuffling, sections within an exam, or per-question time limits.
- No proctoring (full screen, tab-switch detection); no offline mode beyond retrying saves while the page stays open.
- On the demo, the scheduled worker is inactive until `CRON_SECRET` and `WORKER_URL` are set, so overdue attempts are submitted when they are next opened (staff see them as "time up" meanwhile).
- An accommodation cannot be removed, only changed (at least one extra is required).
- Found and fixed while building: the mobile menu's account links could fall off-screen when the menu grew, and a wide table could widen a page's grid on phones (cards now contain wide tables).

## Phase 12 — Grading, offline marks entry, results and academic reporting

- [x] 12.1 Deterministic objective scoring, negative marking and boundary/rounding tests. Done 2026-11-19: scored in the database at the start of grading (correct: marks; wrong: minus the penalty when the exam applies negative marking; blank: 0; total floored at 0); percentages rounded half-up, grades and pass on the exact fraction (migration `0022_results`).
- [x] 12.2 Assigned descriptive graders, bounded marks, review and completion checks. Done 2026-11-19: `/school/results`; graders assigned per exam besides administrators and the subject's teachers; marks 0..maximum with comments; names hidden outside a grader's sections; release refused until every counted written answer is marked.
- [x] 12.3 Offline (paper) exam marks entry. Done 2026-11-19: administrators define paper exams (year, subject, sections, maximum); the subject's teacher of each section or an administrator enters marks, AB or EX per student (one entry per student; students outside the sections refused); CSV import all-or-none; draft → submitted → locked (complete register) → released.
- [x] 12.4 Controlled result publication, student/guardian views and downloads. Done 2026-11-19: administrators release online results and paper marks; students see each question with marks, comments and keys (`/student/results`); parents see the child's report card; CSV downloads for staff; printable report cards.
- [x] 12.5 Audited post-release corrections, result revisions and notifications. Done 2026-11-19: corrections by administrators with a reason; earlier values kept in `result_changes`; revisions shown; students and parents notified on release and correction; retake designation recorded.
- [x] 12.6 Report cards, analysis and longitudinal reports. Done 2026-11-19 with a provisional format: report cards per year combining online and paper results (absent counts as zero, exempt left out, equal weight by marks, no ranking, practice excluded); exam summaries (average, highest, lowest, passed, grade distribution); class overview per section; report cards for every year a student was enrolled.

Exit: no unreleased result leakage; incomplete grading or incomplete offline marks entry blocks publication; scoring matches policy; revisions retain original marks. Offline marks cannot exceed the maximum, be entered by an unassigned teacher or be recorded for a student outside the target sections; repeated saves cannot create duplicate entries. Report-card format and optional ranking policy must be agreed before enabling them.

Exit status (2026-11-19): met, with the report card in a provisional format pending the school's agreement (ranking stays off). Integration tests (`results.test.ts`) cover the scoring and rounding boundaries, release blocked while grading or the register is incomplete, nothing visible to students or parents before release (also directly in the database), bounded marks, offline entry refused for a teacher of another section, for a student outside the target sections and above the maximum, one entry per student on repeated saves, corrections keeping the earlier values with raised revisions, and school isolation. Browser journey `e2e/teaching-results.spec.ts`: a paper exam defined, marked, locked and released, and the student's report card.

Decisions needed (provisional defaults in use):
- Report-card format: which assessments appear and how they are weighted (now: every released assessment, equal weight by marks).
- How absent and exempt count in totals (now: absent as zero out of the maximum, exempt left out).
- Whether rankings are wanted, and their tie and visibility rules (now: none).

Carried forward from Phase 12:
- No PDF generation on the server: report cards are printed or saved as PDF from the browser.
- No co-scholastic areas, attendance or remarks on the report card; no term or weighting configuration.
- Corrections change one question (online) or one entry (paper) at a time; no bulk re-marking.
- Notifications go out when results are released or corrected; delivery needs the worker (inactive on the demo until configured).

## Phase 13 — Admissions, library, inventory and transport

Before implementation, expand PRD, PAGES, USER_FLOWS, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS and BUSINESS_RULES for each submodule. Deliver these as separate submilestones so a large phase does not hide incomplete work.

- [x] 13.1 Admissions: enquiry/application, document checklist, review/approval, status tracking and conversion to enrollment without duplicate identity/admission records. Done 2026-11-19: `/school/admissions` (school administrators); reference numbers, default document checklist with private files and reasoned waivers, status steps enforced in the database (trigger), approval gated on the date of birth and required documents, duplicate applications and students refused unless confirmed, conversion creating one student exactly once (concurrent requests included), timeline (migration `0023_admissions`). Product documents expanded (PRD ADM-01, USER_FLOWS, PAGES, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS, BUSINESS_RULES). Assumption: the office records applications; a public online form is not built. Found while testing: the activation code would have disappeared when the page refreshed after conversion; the page now keeps it visible until reloaded.
- [x] 13.2 Library: catalogue and copy identifiers, issue/return/renewal, due dates, overdue tracking and approved loss/fine handling. Done 2026-11-19: `/school/library` (desk: issue and return by accession number, books on loan with renew and mark lost, lending rules), `/school/library/catalogue` and title pages (copies, withdraw or restore, history), `/student/library`, and a Library card on the parent's child page. Borrowers are active students (admission number) and staff (employee number); per-school loan period, renewals, limits and late fine; one open loan per copy enforced by a unique index (two simultaneous issues give one loan); overdue borrowers cannot borrow or renew. Late and lost-book charges for students become pending Phase 8 fee adjustments that another administrator must approve (migration `0024_library`). Product documents expanded (PRD LIB-01, USER_FLOWS, PAGES, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS, BUSINESS_RULES). Assumptions: school administrators run the library (no librarian role); staff are never charged; titles cannot be archived from the pages yet.
- [x] 13.3 Inventory: assets/stock, locations, allocation/return, movements, adjustments and audit history. Done 2026-11-19: `/school/inventory` (items with on-hand counts and low stock, assets with staff, locations) and item pages (assets by tag: add, allocate to staff by employee number, take back, move, repair, dispose with a reason; consumables: receive, issue to staff or for a purpose, transfer, correct after a count with a reason; history). Balances can never go below zero (row lock plus check constraint; two simultaneous issues cannot overdraw); one open allocation per asset (unique index); disposal final (trigger); movements and asset events append-only with the balance after each change (migration `0025_inventory`). Product documents expanded (PRD INV-01, USER_FLOWS, PAGES, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS, BUSINESS_RULES). Assumptions: school administrators run it (no store-keeper role); no approval step for count adjustments, which need a reason and are kept in the ledger; staff do not yet see items allocated to them. Found while testing: rows written in one transaction (both halves of a transfer) came back in random order; history timestamps now use `clock_timestamp()`.
- [x] 13.4 Transport: routes/stops, vehicles, staff allocation, capacity, student assignments and authorized guardian visibility. Live GPS is not assumed. Done 2026-11-19: `/school/transport` (routes with occupancy, vehicles with seats, find a student's route) and route pages (students by stop, stops with pickup and drop times, assign by admission number, end, vehicle and crew); `/student/transport` and a Transport card on the parent's child page. One active route per student (unique index; reassigning ends the old assignment the same day, history kept); a stop must belong to its route (composite key); occupancy never exceeds the vehicle's seats, enforced by database triggers on assignment, vehicle change, capacity change and archiving, with the route row locked so simultaneous assignments of the last seat give one (migration `0026_transport`). Product documents expanded (PRD TRN-01, USER_FLOWS, PAGES, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS, BUSINESS_RULES). Assumptions: one vehicle per route, a vehicle may serve several routes (separate trips); drivers and attendants do not yet see their route's students; stops are not deleted.
- [x] 13.5 Dedicated capabilities, dashboards, reports and scoped exports for each submodule. Done 2026-11-19: capabilities `school.admissions.manage`, `school.library.manage`/`.view`, `school.inventory.manage`, `school.transport.manage`/`.view`; a School operations card on the administrator dashboard (open and approved applications, books on loan and overdue, low stock and assets with staff, students, seats and full routes, each linking to its page); audited CSV downloads for applications, loans (or overdue), the asset register, stock and route lists, under each submodule's capability and through one shared download helper (`apps/web/lib/csv-response.ts`).

Exit status (2026-11-19): met. Conversion is idempotent (`admissions.test.ts`, two simultaneous conversions give one student); two simultaneous issues of one copy give one loan (`library.test.ts`); stock never goes below zero, with no override, and two simultaneous issues cannot overdraw (`inventory.test.ts`); route capacity and one-route-per-student checks pass, including simultaneous assignments and capacity changes (`transport.test.ts`); library fines and replacement charges go through Phase 8 adjustment approval by a second administrator.

Exit: application-to-enrollment conversion is idempotent; a library copy cannot be issued concurrently twice; stock cannot become negative without an explicit approved policy; transport capacity/conflicting assignment checks pass. Fees/fines reuse Phase 8 finance controls.

## Phase 14 — HR, leave and payroll

- [x] 14.1 Employment details, departments/designations, restricted HR documents and employment history. Done 2026-11-19: `/school/hr` (staff with designation, department and type; departments and designations) and HR record pages (employment terms with an effective date, dated append-only history including leaving and rejoining, payment details for payroll, private HR documents). Payment details are readable by administrators and finance only and never written to the audit log (migration `0027_hr_records`). Decisions recorded 2026-11-19 (the user): school-defined payroll components, finance prepares and another administrator approves payroll, office-marked staff attendance, leave approved by an administrator other than the requester.
- [x] 14.2 Staff attendance, leave types/balances, requests, approvals and corrections. Done 2026-11-19: `/school/hr/leave` (pending requests with balances, decisions, leave types, requests on behalf), `/school/hr/attendance` (daily staff register) and `/school/my-leave` for every staff member (balances, requests, own register). Leave counts working half days (weekly off days and school holidays excluded) per academic year; paid types have a quota; overlapping open requests are refused by an exclusion constraint; a database trigger allows only valid status changes and refuses decisions by the staff member or the requester; approval writes leave marks into the register and cancelling clears them, with corrections kept (migration `0028_staff_leave`). Found while testing: a staff member cancelling their own approved leave saw "not found" because the row lock applied the update policy; the service now reads before locking and says to ask an administrator.
- [x] 14.3 Salary structures, payroll periods, earnings/deductions, draft calculation and review. Done 2026-11-19: `/school/payroll` (runs, components), salary pages (versions from a date) and run pages (totals, payslips with line details, staff not included, recalculation). School-defined components (fixed, % of basic, % of gross for deductions, caps, proration), insert-only salary versions, one run per month (unique index), loss of pay from the staff register and unpaid leave, integer-paise arithmetic rounding half up in a pure function, and a stored copy of every input on each slip (migration `0029_payroll`). Found while testing: finance could not read the staff list, register or leave requests that payroll needs, nor administrators' names; read-only policies now let finance read the first three, and names fall back to a label.
- [x] 14.4 Approval/locking, payslips, payment tracking/export and audited corrections/reversals. Done 2026-11-19: run approval by an administrator other than the preparer and calculator (database trigger), locking after approval, payments per payslip or for all with voiding, the bank CSV (audited), printable payslips, and post-approval corrections as adjustments decided by someone else and paid by the next draft run (migration `0030_payroll_approval`).
- [x] 14.5 HR/payroll capabilities and staff self-service without access to colleagues' salary records. Done 2026-11-19: `/school/my-payslips` for every staff member (own payslips from approved runs, printable, and own employment record); database policies limit a staff member to their own released payslips, the runs they belong to, their payments and their own payment details (migration `0031_payroll_self_service`); the six HR and payroll capabilities are documented in ROLES_PERMISSIONS.

Exit status (2026-11-19): met. Staff request leave and see balances (`hr-leave.test.ts`, `staff-leave.spec.ts`) and see only their own payslips (`hr-self-service.test.ts`, `staff-payroll-approval.spec.ts`); each payslip stores every input and recomputing them gives the stored result (`payroll.test.ts`); a month has one run and an approved run is locked by the database (`payroll-approval.test.ts`); approved runs, payments and adjustments are never rewritten (voids and adjustments instead). Payroll rules are the school's own components (decision 2026-11-19); no statutory calculation or filing is claimed.

Exit: authorized staff can request leave and view own payslip; payroll calculates deterministically from versioned inputs, cannot be posted twice, and preserves approved history. Resolve jurisdiction-specific payroll/statutory rules and authorized approvers before production payroll; no statutory filing integration is assumed.

## Phase 15 — Platform subscriptions, analytics and production readiness

- [x] 15.1 School subscription plans, module entitlements, usage limits, renewal/status management and platform billing with audited overrides. Done 2026-11-20: platform plans (modules, student cap, price), per-school subscriptions with overrides and history, manual invoices with idempotent payment recording that renews (`/admin/plans`, the school's admin page); module entitlements in `withCapability` for every school service and plan-aware navigation; access states (due, grace, read-only) with banners; read-only enforced by a database trigger on every school table (exams already started can finish); the student cap enforced by a trigger; `/school/subscription` for school administrators (migration `0032_subscriptions`). Decisions 2026-11-20 (the user): manual invoices, 14-day notice and 15-day grace then read-only, modules plus student cap, production prepared but not provisioned. Found while testing: locking a paid invoice hid it (the update policy), so payment recording reads first; platform administrators could not count students (no access to records), so a count-only function was added.
- [x] 15.2 Platform usage, safe support tooling and consolidated school dashboards/reports across delivered modules. Done 2026-11-20: `/admin/usage` (per-school counts from a database function that returns counts only to platform administrators, totals, failed jobs, unpaid invoices; records still need a support access grant) and `/school/reports` (figures across the plan's modules linking to each module, and every download) (migration `0033_platform_usage`). Support tooling is the Phase 1 support access grants and the Phase 2 System page, linked from Usage.
- [ ] 15.3 Complete integration/environment documentation, production provisioning, domain/TLS, migrations and rollback rehearsal.
- [ ] 15.4 End-to-end role acceptance, accessibility/mobile review, representative load tests and security regression review across all modules.
- [ ] 15.5 Restore rehearsal, alert routing, incident procedures, pilot onboarding, release notes and recorded readiness decision.

Exit: entitlements are enforced server-side, renewal callbacks are idempotent and access transitions preserve school data; all critical module journeys pass; release/rollback/restore are measured and documented. Subscription expiry must not silently destroy data or interrupt an active exam; grace policy is a product decision. Release authorization and provider/account commitments remain separate from planning.

## Delivery milestones

- After Phase 5: academic MIS foundation ready for controlled evaluation.
- After Phase 7: daily school-management pilot candidate.
- After Phase 8: finance module candidate.
- After Phase 12: complete MIS, practice and examinations candidate.
- After Phase 15: full planned suite release candidate, including extended school operations.

Every candidate requires release gates for its delivered scope; these milestones do not automatically authorize deployment or imply production readiness.

## Shared definition of done

Each module includes relevant role journeys, responsive loading/error/empty/success states, server validation/authorization, same-school constraints/RLS, audit history, concurrency/idempotency where needed, migrations and meaningful tests. Update all affected specifications and CHANGELOG. Record commands/results and unrun checks. No phase completes with an unresolved critical security or data-loss issue.

Before a new module begins, resolve its material business rules and detailed schema/routes/contracts; the roadmap is not a substitute for those specifications. Preserve provisional choices as explicit decisions, not undocumented assumptions.

## Confirmed scope decisions

Confirmed by the user on 2026-11-13. These supersede the narrower defaults agreed on 2026-11-10 and must not be removed or reduced without a new explicit decision. All of them remain planned work, not implemented behavior.

- Negative marking stays in scope (11.1, 12.1) as an optional penalty configured per exam item. An item with no configured penalty scores a wrong answer as zero, as defined in [BUSINESS_RULES.md](BUSINESS_RULES.md).
- Password reset and verified recovery stay in scope (01.2) and are delivered through school-issued codes; see the channel decision below.
- MFA for privileged accounts stays in scope (01.4); see the MFA decision below.
- Descriptive questions stay in scope: authoring in 09.3 and assigned manual grading in 12.2, alongside single-choice and true/false.
- Recovery and activation channel (decided 2026-11-13): the school hands out a single-use, expiring code. A school admin issues it for that school's users; a platform admin issues it for school admins. No email or SMS provider is used. Email self-service may be added later.
- MFA (decided 2026-11-14): authenticator app (time-based codes) with single-use backup codes. Required for platform admins; optional for school admins; not offered to other roles.
- The full 15-phase scope stays, including Phases 13-15. Their open product decisions are resolved when each phase is specified, not by cutting the modules.
- Offline (paper) exam marks entry is added to Phase 12 as task 12.3, so report cards can include exams that were not taken online. The roadmap remains 15 phases.

## Deferred feature candidates

Suggested on 2026-11-13 and deliberately postponed by the user. They are not scheduled in any phase and must not be built or presented as planned scope until the user assigns them to one.

- Certificates and ID documents: transfer, bonafide and character certificates, student ID cards, hall tickets and seating plans.
- Question and option shuffling per student.
- Printable question papers generated from the question bank by blueprint.
- Bilingual questions.
- Installable phone app (PWA) with an offline warning during exams.
- Parent-teacher meeting scheduling and a complaints/requests inbox.
- Teacher substitution for absent staff.
- Syllabus coverage and lesson plans.
- Student health and emergency record.

## Decisions to resolve when needed

Product: pilot school count, curricula/languages, grading/report cards, guardian verification, attendance sessions, fees/refunds/taxes, library rules, transport capacity policy, payroll jurisdiction, subscription/grace policy and retention. Engineering/operations: hosting region, concurrency targets, recovery budget, providers, secrets and alert ownership. Do not block independent local work on unrelated future decisions.

## Previous phase mapping

Earlier P1 work is now Phases 1-2; P2 is Phases 3-5; P3 is Phases 6-7; P4 is Phase 8; P5 is Phases 9-10; P6 is Phases 11-12; P7 readiness runs throughout with final verification in Phase 15; P8's formerly deferred modules are scheduled in Phases 13-15. The current 15-phase roadmap takes precedence over the superseded numbering.
