# Release notes

## 1.0.0-rc.1 — pilot release candidate (2026-11-20)

The first complete build of Examio: a school management system with practice and formal online exams, for schools in India (classes 1-12, CBSE-style grading by default, INR). It is a **release candidate for a supervised pilot**, not an authorised production release: production hosting is prepared but not provisioned, and the readiness review in [TASKS.md](TASKS.md) lists what must happen before real student data is used. The free demo at https://examio-teal.vercel.app runs this build with fake data.

### What is included

- **Accounts and security:** school-created accounts with one-time codes (no paid SMS/OTP), sign-in by email, mobile number or school username, authenticator-app two-step sign-in (required for platform administrators), account recovery by codes, rate limits, audit log, support access grants visible to the school, row level security in the database for every table.
- **School setup and records:** academic years, classes, sections, subjects, grading schemes, calendar; staff and students with imports, enrollment history, promotion, parents linked to children.
- **Daily school life:** timetable with clash checks, attendance registers with corrections, homework with submissions and feedback, notices.
- **Fees:** fee structures with second-administrator approval, invoices, concessions, receipts, online payments through Razorpay in test mode, reports.
- **Question bank, practice and exams:** versioned questions (single choice, true/false, descriptive), practice sets with progress, formal exams with approval, accommodations, reliable answer saving and deadlines enforced by the server.
- **Results:** online and paper marks, grading, release, corrections with history, report cards.
- **Admissions, library, inventory, transport,** with dashboards and exports.
- **HR, leave and payroll:** employment records, staff attendance, leave with approval by another administrator, school-defined salary components, monthly payroll with separation of duties, payslips, bank file, staff self-service.
- **Platform:** subscription plans with module entitlements and student limits, manual invoices, grace period then read-only (nothing deleted, running exams finish), usage counts per school.
- **Operations:** background worker with health checks and alerts, backups with restore and migration rehearsals, pre-flight configuration check, CI with tests, migration rehearsal and dependency audit.

### Verified in this candidate

Type checking, 402 integration tests, the production build and 74 browser tests (every role, desktop and phone, with automated accessibility checks) pass; schema-wide security checks pass; 2,000 simultaneous exam takers completed with no errors on the development machine; migration, backup and restore rehearsals passed locally, and a backup of the demo database restored with every check passing. See [TEST_PLAN.md](TEST_PLAN.md), [OPERATIONS.md](OPERATIONS.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

### Known limitations

- Production hosting, domain and on-call alerts are not set up; measurements were taken on a development machine.
- Email and SMS are not sent (sandbox); notifications appear in the app.
- Online payments use Razorpay test mode only.
- Payroll uses components the school defines; Examio does not calculate statutory PF, ESI, professional tax or TDS and files nothing.
- Report-card format, absent/exempt counting and ranking use provisional defaults until the school agrees.
- No public online admission form; the office records applications.
- Data retention and deletion policy is not yet agreed.
- Drivers and attendants do not yet see their route's students; titles, stops and locations cannot be archived from every page.
- A manual screen-reader review by a person has not been done.

### Upgrading

Database migrations 0000-0033 apply in order with `pnpm db:migrate`; all are additive. Schools without a subscription keep full access.
