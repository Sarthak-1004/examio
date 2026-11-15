# Page inventory

Status: **I** implemented route; **P** planned route. Dynamic identifiers must be authorized server-side. Detailed inventory currently covers the core suite through Phase 12. Extended modules are scheduled in Phases 13-15 of [TASKS.md](TASKS.md); expand their subroutes and states before implementation.

## State conventions

**List**: loading skeleton; fetch error with retry; empty records with authorized create action; no matches with clear-filters action. **Detail**: loading skeleton; unavailable/unauthorized uses non-disclosing response; valid record with no related data shows contextual empty sections. **Form**: pending submit; field/server errors preserving safe inputs; success confirmation/redirect; missing prerequisites link to setup. **Dashboard**: skeleton; per-panel recoverable errors; genuine no-data state. **Attempt**: loading saved state; offline/conflict/deadline errors; unanswered questions; acknowledged save and final receipt.

These are required target states, not a claim all current pages implement them. Dedicated loading/error boundaries and accessibility review remain Phases 1-2 work.

## Existing routes

| Route | Role/content | Actions | States/status |
| --- | --- | --- | --- |
| `/` | Session router | Redirect by role/school/password state | I; no standalone content |
| `/login` | Public sign-in form | Sign in; link to `/redeem` | I; Form; rate-limit/ambiguous login errors; confirmation after a password is set |
| `/mfa` | Second sign-in step for accounts with an authenticator | Enter app code or backup code; cancel | I; Form; wrong/used code, rate limit; no pending sign-in redirects to `/login` |
| `/mfa/setup` | Two-step sign-in for platform and school admins | Start setup, confirm with first code, view backup codes once; school admin can turn it off | I; Form; not available to other roles; platform admins are sent here until enrolled |
| `/redeem` | Public form for a one-time activation or reset code | Set own password | I; Form; invalid/expired/used code, weak or mismatched password; code may be prefilled from `?code=` |
| `/join` | Signed-in user enters a membership invitation code | Join the inviting school | I; Form; invalid code, rate limit; platform admins see an explanation instead |
| `/change-password` | Authenticated password form | Change password | I; Form; current-password/mismatch errors |
| `/select-school` | User school memberships | Select school | I; List; no access routes to `/no-access` |
| `/no-access` | Authenticated access explanation | Sign out | I; unavailable membership state |
| `/admin` | Platform school list | Add/open school; search by name/code; filter by status; paginate | I; List; filtered-empty and empty states |
| `/admin/system` | Health checks, failed jobs | Retry a failed job | I; Dashboard/List |
| `/admin/audit` | Platform-level audit events | Search action, date range, paginate | I; List; read-only |
| `/files/[id]` | Route handler: authorized file download | Download | I; 401 signed out, 404 not visible/expired, 409 quarantined/blocked |
| `/health` | Route handler: public liveness | — | I; 200/503 JSON, no details |
| `/admin/schools/new` | School/admin setup form | Create school | I; Form |
| `/admin/schools/[id]` | School profile, admins and support access | Change school status; issue a reset code for a school admin (reason required, code shown once); open/end support access; recent access history | I; Detail/Form; invalid ID/not found; empty support history |
| `/admin/settings` | Boards and mediums | Add/activate/deactivate | I; List/Form |
| `/school` | Everyone: today's registers still to take (school-wide for admins, own sections for teachers); school admins: member counts, current year and setup checklist; teachers: "My classes today" (subjects and class-teacher sections in force today); everyone: personal notices | View dashboard; mark notice read | I; Dashboard; teacher with no assignments sees an explanation |
| `/school/staff` | School admins: staff list; members without staff details; invitations | Search name/number/email/phone; filter status and role; add a staff member (activation code shown once); add details for an invited member; invite an existing user; revoke an invitation; export CSV | I; List/Form; filtered-empty and empty states; field errors keep typed values |
| `/school/staff/[id]` | School admins: one staff member | Edit details; mark left / bring back; issue activation or reset code (shown once); sign out of all devices; assign subject to a section; set class teacher; end an assignment | I; Detail/Form; not found for another school; closed years read-only; history of ended assignments |
| `/school/staff/teaching` | School admins: who teaches what in the selected year | Year picker; open a teacher | I; List; sections without a class teacher and class subjects without a teacher highlighted |
| `/school/staff/import` | School admins: bulk import from CSV | Upload or paste, check (nothing saved), import all rows or none; activation codes shown once | I; Form/List; row and file errors; repeat of the same file creates nothing |
| `/school/staff/export` | Route handler: staff CSV for school admins | Download with the list's filters | I; 403 for others; audited; formula cells neutralised; not cached |
| `/school/audit` (implemented) | School admins: the school's audit log | Search action, date range, paginate | I; List; read-only |
| `/school/students` | School admins: student list for a year; members without student details | Search name/admission number/sign-in name; filter class (or not enrolled), status, year; admit a student (code shown once); export CSV | I; List/Form; filtered-empty and empty states |
| `/school/students/[id]` | School admins: one student | Edit details; enroll, move section, set roll, undo a mistaken enrollment; parents (new account with code, link an existing parent, code for a parent with an account, unlink); documents (upload, remove); reset/activation code; sign out of all devices; mark left / readmit | I; Detail/Form; not found for another school; closed years read-only; history of enrollments and earlier parents |
| `/school/students/import` | School admins: class list import | Choose year; upload or paste; check (column mapping, row errors and warnings; nothing saved); import all or none; sign-in names and codes shown once | I; Form/List; repeat of the same file creates nothing |
| `/school/students/promote` | School admins: promotion or graduation of a section | Choose from/to sections; untick repeaters; keep roll numbers; confirm | I; Form/List; students already in the target year shown and skipped |
| `/school/students/reports` | School admins: class strength per section for a year | Year picker; open a section; export CSV | I; List; over-capacity highlighted; count of active students without a section |
| `/school/students/sections/[id]` | School admins: a section's current students | Number roll numbers alphabetically | I; List; empty state |
| `/school/students/export`, `/school/students/reports/export` | Route handlers: student list and class strength CSV | Download | I; school admins only (403 otherwise); audited; formula cells neutralised; not cached |
| `/school/classes` | Teachers: sections taught today | Open a class list | I; List; no assignments explained |
| `/school/attendance` | Admins: every register of a date; teachers: their sections' registers | Pick a date; open a register; admins: settings (teacher edit window, weekly days off, lock date) | I; List/Form; not a school day, future date, no registers |
| `/school/attendance/register` | One register (`?section&session&date`) | Mark each student present/absent/late/excused with a note; reason when changing earlier entries or writing a locked date; admins see the change history | I; Form; not a school day, locked/out-of-window (read-only), someone else saved meanwhile |
| `/school/attendance/reports` | Section attendance over a period (admins: any section; teachers: sections taught today) | Pick section and dates; admins export CSV | I; List; incomplete registers listed; N/A when nothing counts |
| `/school/attendance/reports/export` | Route handler: section attendance CSV | Download | I; admins only; audited; not cached |
| `/school/timetable` | Admins: a section's weekly periods; teachers: own week and today's periods with calendar notices | Admins add (day, times, subject, assigned teacher, room) and remove periods | I; List/Form; clash explained (section, teacher or room); closed year read-only |
| `/school/timetable/load`, `/school/timetable/load/export` | Admins: periods and hours per teacher per week; CSV | Year picker; download | I; List; audited export |
| `/school/homework` | Admins: all homework; teachers: homework of sections they teach or wrote | Set homework for one or more sections (subject, title, instructions, due time in school time, late allowed, attachments); current/archived views | I; List/Form; past-due badge; empty states |
| `/school/homework/[id]` | Homework with every student's submission | Return/update feedback; remind students who have not submitted (once a day); edit; archive | I; Detail/Form; not found for others |
| `/school/announcements` | Notices (admins: all; teachers: own and addressed to them) | Publish (admins: everyone/staff/students/parents/one class; teachers: a class they teach); archive; delivery and read counts | I; List/Form; archived view |
| `/student` | Student's day: today's periods (holidays shown), homework to do, attendance %, latest notices | Open homework | I; Dashboard; not enrolled and empty states |
| `/student/homework`, `/student/homework/[id]` | Student: class homework and own submission | Submit or update answer and files until feedback; read feedback | I; List/Form; closed (past due, archived, feedback returned) explained |
| `/student/notices`, `/parent/notices` | Notices addressed to the reader | — | I; List; empty state |
| `/parent/children/[id]/practice/[attemptId]` | Parent: one of the child's practice attempts, read-only; results once released | — | I; Detail; any other child or attempt is not found |
| `/parent/children/[id]/homework/[hwId]` | Parent: one homework item and the child's submission and feedback | — | I; Detail; any other child or homework is not found |
| `/school/fees` | Finance staff and admins: collections today/this month, outstanding and overdue, outstanding by class, student search | Apply late fees; send overdue reminders; reconcile pending online payments | I; Dashboard; reconciliation problems flagged |
| `/school/fees/setup` | Fee heads (with tax %) and fee structures | Add/archive heads; create draft structures | I; List/Form |
| `/school/fees/structures/[id]` | One structure: items, approval, billing | Add/remove items (draft); approve or archive (admins); issue an instalment's invoices (retry-safe) | I; Detail/Form; approved items fixed |
| `/school/fees/students/[id]` | A student's account: invoices with lines and balances, payments, ledger, concessions, adjustments | Record an offline payment; cancel an unpaid invoice (admins); request a concession or adjustment; revoke a concession | I; Detail/Form |
| `/school/fees/approvals` | Pending concessions and adjustments | Approve/reject (school admins; never their own request) | I; List |
| `/school/fees/reports`, `/school/fees/reports/export` | Collections by method and day, defaulters, reconciliation check; CSV | Date range; export collections or defaulters | I; List; audited export |
| `/receipts/[id]` | Printable fee receipt | Print / save as PDF | I; finance staff, admins and the child's linked parents; reversed receipts marked |
| `/parent/fees` | Parent: each child's statement, open invoices, receipts | Pay an invoice online (Razorpay checkout; sandbox: complete/decline test payment) | I; "processing" after checkout until the provider confirms |
| `/payments/razorpay/webhook` | Route handler (POST): Razorpay events | — | Signature-verified; 400 invalid signature; 404 unless Razorpay is configured |
| `/school/questions` | Admins: all subjects; teachers: subjects they teach | Search question text; filter subject, chapter/topic, type, difficulty, status; new question; import | I; List; no-subject and empty states |
| `/school/questions/new` | Question editor (type chosen by tabs) | Subject, chapter/topic, difficulty, question, options and correct answer / true-false / model answer, marks, negative marks, explanation, image; save draft or submit | I; Form; field errors keep typed values |
| `/school/questions/[id]` | Preview as a student sees it, answer key, edit, version history | Save (new version if published); submit; admins publish, send back, archive, restore | I; Detail/Form; published versions fixed |
| `/school/questions/curriculum` | Chapters and topics of a subject | Add chapter/topic; archive/restore | I; List/Form |
| `/school/practice` | Admins: all subjects; teachers: subjects they teach | Search titles; filter subject, status; create a set (subject, title, feedback rule, attempt limit) | I; List/Form; no-subject and empty states |
| `/school/practice/[id]` | One practice set: questions with per-question accuracy, sections with each student's attempts and best score | Draft: add published questions (search, or a number from a chapter/topic), remove, edit settings, publish; published: assign to a section with optional opening/closing times, remove an assignment, archive | I; Detail/Form; other subjects' sets are not found |
| `/school/questions/import` | Question CSV import | Check (errors per row, chapters to create), import all or none; create missing chapters; submit for review | I; Form/List; repeat of the same file adds nothing |
| `/student/practice` | Student: practice assigned to their class, open first, with attempts used, best released score | Start, continue or try again (within the window and limit) | I; List; empty, not open yet, closed and all-attempts-used states |
| `/student/practice/attempts/[id]` | One attempt: questions without answers while in progress, saved state per question; after submission the answers, and the score, correct answers and explanations once released | Answer (saved at once; written answers after a pause), submit with a confirmation of unanswered questions; submit after the window closed | I; Form/Detail; stale-window conflict, closed and feedback-later states |
| `/student/progress` | Student: accuracy per chapter/topic with sample size, recent attempts | — | I; empty and "not enough practice yet" states |
| `/student/attendance`, `/student/timetable` | Student: own attendance (last 30 days) and class timetable | — | I; not enrolled / no timetable states |
| `/school/classes/[id]` | Teachers: today's students of a section they teach | — | I; List; any other section is not found |
| `/parent` | Parent: linked children in the selected school | Open a child; switch school | I; Dashboard; "no child linked yet" state |
| `/parent/children/[id]` | Parent: one linked child's class history, details, homework with submission state, practice and progress, attendance (last 30 days) and timetable | — | I; Detail; any other student is not found |

## Planned initial-product routes

| Route | Role/content | Actions | States/phase |
| --- | --- | --- | --- |
| `/forgot-password` | Public reset request | Request link | Form; generic acknowledgement; Phases 1-2 |
| `/reset-password` | Reset-token form | Set password | Form; expired/used token; Phases 1-2 |
| `/accept-invitation` | Invited account activation | Accept/set password | Form; expired/revoked invitation; Phases 1-2/Phases 3-5 |
| `/school/setup` (implemented) | School admins: setup checklist with links | Open each step | I; checklist with required/optional steps, ready badge |
| `/school/setup/profile` | School profile; platform-set values read-only | Save profile | I; Form; field errors keep typed values |
| `/school/setup/years` | Academic years | Create, edit, make current, close, reopen, delete unused, copy structure | I; List/Form; overlap warning; closed years read-only |
| `/school/setup/classes` | Classes and the selected year's sections | Add Class 1-12, add/rename/reorder classes, add sections, archive/restore/delete | I; List/Form; year picker; archived toggle; in-use refusal |
| `/school/setup/subjects` | Subjects; subjects per class for the selected year | Add, rename, archive/restore/delete; tick subjects per class | I; List/Form; classes without sections explained |
| `/school/setup/grading` | Grading schemes and bands | CBSE-style preset, new scheme, make default, archive/restore | I; List/Form |
| `/school/setup/calendar` | Calendar for the selected year; attendance sessions | Add/remove entries; add/archive/restore sessions | I; List/Form; last session protected |
| `/school/fees` | Admin/finance overview, fee schedules | Configure schedules/issue invoices | Dashboard/Form; Phase 8 |
| `/school/fees/invoices` | Admin/finance invoices | Filter/issue/open | List/Form; Phase 8 |
| `/school/fees/invoices/[id]` | Invoice, payments, adjustments | Receipt/reconcile/request reversal | Detail/Form; Phase 8 |
| `/school/fees/reconciliation` | Admin/finance unmatched events | Match/retry/review | List/Form; Phase 8 |
| `/school/practice` | Admin/teacher sets | Create/configure/assign/archive | List/Form; Phases 9-10 |
| `/school/practice/[id]` | Set content/participation | Edit/version/assign/review | Detail/Form; Phases 9-10 |
| `/school/exams` | Admin/assigned teacher exams | Draft/filter/open | List/Form; Phases 11-12 |
| `/school/exams/[id]` | Exam editor/schedule/publication | Preview; admin publish/cancel | Detail/Form; Phases 11-12 |
| `/school/exams/[id]/monitor` | Admin/assigned teacher attempt status | Inspect operational status | Dashboard; stale-status warning; Phases 11-12 |
| `/school/exams/[id]/grading` | Admin/assigned grader answers | Save marks/review | List/Form; version conflicts; Phases 11-12 |
| `/school/marks` | Admin/assigned teacher offline assessments | Admin create/lock; filter/open | List/Form; Phase 12 |
| `/school/marks/[id]` | Offline marks register for target sections | Enter marks or absent/exempt; save draft/submit; admin lock | List/Form; out-of-range, incomplete register and version conflicts; Phase 12 |
| `/school/results` | Admin/teacher result batches | Review; admin release/export | List/Form; incomplete grading; Phases 11-12 |
| `/school/reports` | Role-scoped reports | Filter/export | Dashboard; export progress; Phases 6-12 |
| `/school/audit` | Admin audit trail | Filter/export authorized events | List; read-only; Phases 1-2 |
| `/student/practice` | Available practice | Filter/start | List; Phases 9-10 |
| `/student/practice/[id]` | Practice instructions/history | Start/retry | Detail/Form; Phases 9-10 |
| `/student/practice/attempts/[id]` | Own practice attempt/feedback | Save/submit/review | Attempt; Phases 9-10 |
| `/student/exams/[id]` | Exam instructions/eligibility | Start/resume | Detail/Form; not-open/closed/ineligible; Phases 11-12 |
| `/student/attempts/[id]` | Own formal attempt | Answer/save/review/submit | Attempt; Phases 11-12 |
| `/student/results` | Own released results | Filter/open | List; unreleased records excluded; Phases 11-12 |
| `/student/results/[id]` | Released result | Review/download | Detail; Phases 11-12 |
| `/student/progress` | Own topic trends | Filter | Dashboard; insufficient-data state; Phases 9-10/Phases 11-12 |
| `/parent/children/[id]` (extended later) | Child summary tabs: timetable, attendance, homework, notices, released results, fees | View scoped records; pay eligible invoice | Detail/Form; module unavailable/link revoked/payment pending; Phases 6-12 |

## Scheduled extended-module entry pages

| Proposed route | Content/actions | Target states | Phase |
| --- | --- | --- | --- |
| `/school/admissions` | Enquiries/applications, review, approval, enrollment conversion | List/Form; duplicate applicant, missing document, approval conflict | 13 |
| `/school/library` | Catalogue/copies, issue/return/renewal, overdue records | List/Form; unavailable copy, overdue, concurrent issue | 13 |
| `/school/inventory` | Assets/stock, locations, allocation and adjustments | List/Form; insufficient stock, assigned asset, approval required | 13 |
| `/school/transport` | Routes/stops/vehicles and student assignments | List/Form; capacity exceeded, conflicting allocation | 13 |
| `/school/hr` | Employment, leave, staff attendance and approvals | List/Form; insufficient leave, restricted document, pending approval | 14 |
| `/school/payroll` | Salary structures, payroll periods, review/posting and payslips | List/Form; invalid configuration, locked period, duplicate posting | 14 |
| `/admin/subscriptions` | Plans, entitlements, renewals and audited overrides | List/Form; pending payment, expired/grace status, conflicting update | 15 |
| `/admin/usage` | Tenant usage, limits and safe operational summaries | Dashboard; delayed metrics, no usage, unavailable source | 15 |

All are planned, not working routes. Expand detail/self-service routes and role capabilities before implementation. Do not add dead links implying these modules work.

