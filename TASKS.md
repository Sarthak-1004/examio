# Development roadmap: 15 phases

Updated: 2026-11-13. This is the authoritative delivery plan for Examio: a full school-management system with MIS, student practice and formal examinations. The user requested all previously proposed modules, including admissions, library, transport, inventory, HR/payroll and platform subscriptions. They are now scheduled scope rather than an unscheduled backlog.

This roadmap replaces the earlier P0-P8 phase numbering. Existing foundation work is the baseline, not an additional development phase. Phase 1 is **Complete** (2026-11-14); Phase 2 is **In progress** (code complete and CI passing; staging waits for paid hosting); Phase 3 is **Complete** (2026-11-15); Phases 4-15 are **Planned**. Documentation completion does not mean implementation completion. No schedule or delivery dates are promised.

## Resume here

- Current state: Phases 1, 3, 4 and 5 are complete (Phase 5 on 2026-11-15). Phase 2 is complete except a staging environment, which waits for paid hosting. The free demo is at https://examio-teal.vercel.app; see the deployment line below for what it runs.
- Next work: Phase 6, task 06.1 (attendance). Completed phases are deployed to the demo automatically (migrate Neon, then push).
- Last recorded checks (2026-11-15, local): `pnpm typecheck` passed; `pnpm test` 264 tests in 21 files passed; `pnpm build` passed; browser tests 38 passed; development database migrated to 0012. Demo after deployment: health check 200, new routes answer (signed-out requests redirect to login, staff export 403); signed-in pages on the demo not checked yet. GitHub CI result for this push not yet checked.
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
| 6 | Attendance, calendar and timetable | 4-5 | High | Planned |
| 7 | Homework, communication and family portals | 2, 5-6 | High | Planned |
| 8 | Fees, payments and finance | 2, 5, finance policy | High | Planned |
| 9 | Curriculum and question bank | 3-4, private files from 2 | High | Planned |
| 10 | Student practice and learning progress | 5, 9 | High | Planned |
| 11 | Formal exams and reliable exam-taking | 2, 5, 9 | Critical | Planned |
| 12 | Grading, offline marks entry, results and academic reporting | 3-5, 10-11 | High | Planned |
| 13 | Admissions, library, inventory and transport | 5-8, module specifications | High | Planned |
| 14 | HR, leave and payroll | 4, 8, payroll policy | High | Planned |
| 15 | Platform subscriptions, consolidated analytics and release readiness | 1-14 | Critical | Planned |

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

- [ ] 06.1 Daily/session attendance, present/absent/late/excused statuses and missing-entry detection.
- [ ] 06.2 Date locks, corrections with reason, summaries and student/guardian views.
- [ ] 06.3 Class/teacher/room timetable, school calendar integration and conflict detection.
- [ ] 06.4 Attendance and schedule reports, scoped exports and dashboard widgets.

Exit: assigned teacher records a valid roster once per date/session; duplicate submissions are safe; locked corrections are controlled; teacher/class/room conflicts are blocked; percentages follow the documented policy and school timezone.

## Phase 7 — Homework, communication and family portals

- [ ] 07.1 Teacher assignments/homework with instructions, attachments, deadlines and target sections.
- [ ] 07.2 Student submissions, late policy, feedback and completion tracking.
- [ ] 07.3 School/class announcements, targeted messages, reminders and delivery status.
- [ ] 07.4 Complete student/parent daily views for timetable, attendance, homework and notices; expose future modules only when delivered.

Exit: teacher publishes to an assigned class, student submits privately, feedback reaches authorized recipients, and retries cannot send duplicate business notifications. Revoked guardian links immediately lose access.

## Phase 8 — Fees, payments and finance

- [ ] 08.1 Finance capabilities, approved fee structures, discounts/tax/late-charge policy and due schedules.
- [ ] 08.2 Invoice issuance, immutable financial ledger, offline receipts and outstanding statements.
- [ ] 08.3 Online payment adapter, verified webhooks, pending/failure states and reconciliation.
- [ ] 08.4 Approved adjustments/refunds, reversal history, overdue reminders and finance reports.
- [ ] 08.5 Parent fee statements/payment journey and scoped receipt downloads.

Exit: balances reconcile; duplicate/out-of-order payment events cannot double-credit; currency/rounding and reversal rules pass tests; browser redirects cannot mark invoices paid. Resolve currency, provider and financial policy before real transactions.

## Phase 9 — Curriculum and question bank

- [ ] 09.1 Subject/chapter/topic hierarchy and difficulty classification.
- [ ] 09.2 Question editor, images, answer keys, explanations, marks and validation.
- [ ] 09.3 Single-choice/true-false questions plus descriptive authoring; additional types require explicit scoring rules.
- [ ] 09.4 Version history, draft/review/archive, search, filters and validated bulk import.
- [ ] 09.5 Preview and teacher subject permissions; prevent answer-key exposure to learner clients.

Exit: teachers can build and find reusable questions, edits create appropriate versions, and published assessment references remain immutable. Import errors are actionable; media access stays scoped.

## Phase 10 — Student practice and learning progress

- [ ] 10.1 Topic-wise practice, teacher-assigned sets, configurable availability and attempt limits.
- [ ] 10.2 Saved answers, reconnect recovery, repeat attempts and submission feedback.
- [ ] 10.3 Explanations, weak-topic indicators, attempt history and learning progress.
- [ ] 10.4 Teacher participation summaries and guardian visibility into permitted child feedback.

Exit: eligible student starts, saves, resumes, submits and retries according to policy. Practice results never change formal grades; explanations follow release rules and progress includes sufficient context/sample size.

## Phase 11 — Formal examinations and reliable exam-taking

- [ ] 11.1 Draft exams, select/version questions, target classes, schedule, duration, marks, penalties and attempts.
- [ ] 11.2 Preview, admin approval/publication, eligibility, cancellation and documented accommodation/retake controls.
- [ ] 11.3 Instructions, server timer, question navigation, mark for review and unanswered summary.
- [ ] 11.4 Autosave acknowledgements, refresh/reconnect recovery, stale-write handling and multi-tab conflicts.
- [ ] 11.5 Idempotent start/submit, submission receipt, deadline finalization worker and operational monitoring.

Exit: concurrent starts respect limits; acknowledged answers survive interruption; late/stale writes fail safely; duplicate submission returns the original receipt; deadline works without an open browser. Benchmark agreed concurrent exam workload before live exams.

## Phase 12 — Grading, offline marks entry, results and academic reporting

- [ ] 12.1 Deterministic objective scoring, negative marking and boundary/rounding tests.
- [ ] 12.2 Assigned descriptive graders, bounded marks, review and completion checks.
- [ ] 12.3 Offline (paper) exam marks entry: admin defines offline assessments per academic year, subject and section with maximum marks; assigned teachers enter bounded marks or an absent/exempt status for each enrolled student; draft, submit and admin lock; optional validated bulk import.
- [ ] 12.4 Controlled result publication for online exams and offline assessments, student/guardian views and downloads.
- [ ] 12.5 Audited post-release corrections, result revisions and notifications.
- [ ] 12.6 Report cards combining online and offline marks, class/subject/student analysis and longitudinal academic reports; keep practice and formal metrics distinct.

Exit: no unreleased result leakage; incomplete grading or incomplete offline marks entry blocks publication; scoring matches policy; revisions retain original marks. Offline marks cannot exceed the maximum, be entered by an unassigned teacher or be recorded for a student outside the target sections; repeated saves cannot create duplicate entries. Report-card format and optional ranking policy must be agreed before enabling them.

## Phase 13 — Admissions, library, inventory and transport

Before implementation, expand PRD, PAGES, USER_FLOWS, DATABASE_SCHEMA, API_SPEC, ROLES_PERMISSIONS and BUSINESS_RULES for each submodule. Deliver these as separate submilestones so a large phase does not hide incomplete work.

- [ ] 13.1 Admissions: enquiry/application, document checklist, review/approval, status tracking and conversion to enrollment without duplicate identity/admission records.
- [ ] 13.2 Library: catalogue and copy identifiers, issue/return/renewal, due dates, overdue tracking and approved loss/fine handling.
- [ ] 13.3 Inventory: assets/stock, locations, allocation/return, movements, adjustments and audit history.
- [ ] 13.4 Transport: routes/stops, vehicles, staff allocation, capacity, student assignments and authorized guardian visibility. Live GPS is not assumed.
- [ ] 13.5 Dedicated capabilities, dashboards, reports and scoped exports for each submodule.

Exit: application-to-enrollment conversion is idempotent; a library copy cannot be issued concurrently twice; stock cannot become negative without an explicit approved policy; transport capacity/conflicting assignment checks pass. Fees/fines reuse Phase 8 finance controls.

## Phase 14 — HR, leave and payroll

- [ ] 14.1 Employment details, departments/designations, restricted HR documents and employment history.
- [ ] 14.2 Staff attendance, leave types/balances, requests, approvals and corrections.
- [ ] 14.3 Salary structures, payroll periods, earnings/deductions, draft calculation and review.
- [ ] 14.4 Approval/locking, payslips, payment tracking/export and audited corrections/reversals.
- [ ] 14.5 HR/payroll capabilities and staff self-service without access to colleagues' salary records.

Exit: authorized staff can request leave and view own payslip; payroll calculates deterministically from versioned inputs, cannot be posted twice, and preserves approved history. Resolve jurisdiction-specific payroll/statutory rules and authorized approvers before production payroll; no statutory filing integration is assumed.

## Phase 15 — Platform subscriptions, analytics and production readiness

- [ ] 15.1 School subscription plans, module entitlements, usage limits, renewal/status management and platform billing with audited overrides.
- [ ] 15.2 Platform usage, safe support tooling and consolidated school dashboards/reports across delivered modules.
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
