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
| `/school` | School admin/teacher counts and personal notices | View dashboard; mark notice read | I; Dashboard; setup checklist and exam count are placeholders |
| `/school/audit` (implemented) | School admins: the school's audit log | Search action, date range, paginate | I; List; read-only |
| `/student` | Student exam landing | Current empty exam shell | I; future exam list; no exam service yet |

## Planned initial-product routes

| Route | Role/content | Actions | States/phase |
| --- | --- | --- | --- |
| `/forgot-password` | Public reset request | Request link | Form; generic acknowledgement; Phases 1-2 |
| `/reset-password` | Reset-token form | Set password | Form; expired/used token; Phases 1-2 |
| `/accept-invitation` | Invited account activation | Accept/set password | Form; expired/revoked invitation; Phases 1-2/Phases 3-5 |
| `/school/setup` | Admin profile, years, classes, sections, subjects, grading | Create/edit/archive setup through tabs/dialogs | List/Form; Phases 3-5 |
| `/school/students` | Admin/assigned teacher roster | Filter/open; admin create/import | List; Phases 3-5 |
| `/school/students/new` | Admin enrollment form | Create student/enrollment | Form; Phases 3-5 |
| `/school/students/import` | Admin file mapping/preview/errors | Validate/commit/download errors | Form/List; job progress/failure; Phases 3-5 |
| `/school/students/[id]` | Scoped student profile, history, guardians | Admin edit/archive/link; teacher permitted reads | Detail/Form; Phases 3-5 |
| `/school/teachers` | Admin staff list | Create/invite/open | List/Form; Phases 3-5 |
| `/school/teachers/[id]` | Admin teacher profile/assignments | Edit/assign/revoke | Detail/Form; Phases 3-5 |
| `/school/promotions` | Admin year rollover | Preview/confirm/report exceptions | List/Form; Phases 3-5 |
| `/school/attendance` | Admin/assigned teacher register | Mark/correct/export | List/Form; locked date; Phases 6-7 |
| `/school/timetable` | Admin/teacher weekly schedule | Admin create/edit slots | List/Form; collision errors; Phases 6-7 |
| `/school/homework` | Admin/teacher assignments | Create/filter/open | List/Form; Phases 6-7 |
| `/school/homework/[id]` | Assignment/submissions | Edit before lock, grade/return feedback | Detail/Form; Phases 6-7 |
| `/school/announcements` | Admin/teacher targeted notices | Draft/publish/archive | List/Form; Phases 6-7 |
| `/school/fees` | Admin/finance overview, fee schedules | Configure schedules/issue invoices | Dashboard/Form; Phase 8 |
| `/school/fees/invoices` | Admin/finance invoices | Filter/issue/open | List/Form; Phase 8 |
| `/school/fees/invoices/[id]` | Invoice, payments, adjustments | Receipt/reconcile/request reversal | Detail/Form; Phase 8 |
| `/school/fees/reconciliation` | Admin/finance unmatched events | Match/retry/review | List/Form; Phase 8 |
| `/school/questions` | Admin/assigned teacher bank | Filter/create/import/archive | List/Form; Phases 9-10 |
| `/school/questions/[id]` | Question versions | Edit draft/create revision/preview | Detail/Form; Phases 9-10 |
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
| `/student/timetable` | Own schedule | View week | List; Phases 6-7 |
| `/student/attendance` | Own attendance | View dates | Dashboard; Phases 6-7 |
| `/student/homework` | Own assignments | Open assignment | List; Phases 6-7 |
| `/student/homework/[id]` | Assignment and own submission | Upload/submit | Detail/Form; Phases 6-7 |
| `/student/announcements` | Targeted notices | Read | List/Detail; Phases 6-7 |
| `/student/practice` | Available practice | Filter/start | List; Phases 9-10 |
| `/student/practice/[id]` | Practice instructions/history | Start/retry | Detail/Form; Phases 9-10 |
| `/student/practice/attempts/[id]` | Own practice attempt/feedback | Save/submit/review | Attempt; Phases 9-10 |
| `/student/exams/[id]` | Exam instructions/eligibility | Start/resume | Detail/Form; not-open/closed/ineligible; Phases 11-12 |
| `/student/attempts/[id]` | Own formal attempt | Answer/save/review/submit | Attempt; Phases 11-12 |
| `/student/results` | Own released results | Filter/open | List; unreleased records excluded; Phases 11-12 |
| `/student/results/[id]` | Released result | Review/download | Detail; Phases 11-12 |
| `/student/progress` | Own topic trends | Filter | Dashboard; insufficient-data state; Phases 9-10/Phases 11-12 |
| `/parent` | Linked children summary | Select child/school | Dashboard; no verified link; Phases 3-5 |
| `/parent/children/[id]` | Child summary tabs: timetable, attendance, homework, notices, released results, fees | View scoped records; pay eligible invoice | Detail/Form; module unavailable/link revoked/payment pending; Phases 6-12 |

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

