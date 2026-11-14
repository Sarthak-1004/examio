# Product requirements

Baseline: 2026-11-13. **Implemented** means present in source, **Planned** means a target requirement, and **Decision pending** means unresolved. Source presence does not imply production verification. Delivery status lives in [TASKS.md](TASKS.md).

## Vision and goals

Examio is a full multi-school school-management system. MIS, student practice, and formal examinations are distinct, connected modules. Its goals are authoritative school records, simpler daily administration, preserved academic history, reliable assessments, useful learning feedback, controlled access, and recoverable operations.

## Target users

| User | Needs |
| --- | --- |
| Platform admin | Onboard schools, manage tenant lifecycle and platform configuration |
| School admin/principal | Academic setup, student/staff records, approvals, reports and school settings |
| Teacher | Assigned rosters, attendance, homework, questions, practice, exams and grading |
| Student | Timetable, homework, attendance, practice, exams and published results |
| Parent/guardian | Linked children's attendance, notices, published results and fee statements |
| Finance staff (planned role) | Invoices, receipts, reconciliation and approved adjustments |

Initial assumptions: schools organize students into academic years, classes and sections; subjects and grading schemes are configurable. Default timezone is Asia/Kolkata. Curriculum, language and currency are school settings rather than universal hard-coded rules.

## Scope and acceptance criteria

| ID | Capability | Acceptance criteria | Phase |
| --- | --- | --- | --- |
| FND-01 | School onboarding | Authorized platform admin creates school and first admin atomically; duplicate code/email returns actionable errors; failures leave no partial tenant | Existing foundation |
| SEC-01 | Isolation | Cross-school IDs cannot disclose/mutate data; teachers are limited to assignments; parents to verified child links; negative tests cover every new tenant table | Phases 1-2 and every phase |
| MIS-01 | Academic setup | Admin configures years, classes, sections and subjects; invalid date ranges and duplicate entries are rejected | Phase 3 |
| MIS-02 | Student/staff records | Imports provide preview and row errors; admission numbers are unique within school; promotion preserves prior enrollments | Phases 4-5 |
| MIS-03 | Attendance/timetable | Assigned teacher records one attendance entry per enrollment/date/session; corrections are audited; schedule conflicts are blocked | Phase 6 |
| MIS-04 | Homework/notices | Teachers target assigned sections; students submit authorized files; only intended recipients can read notices | Phase 7 |
| FIN-01 | Fees | Finance staff issue invoices/receipts; duplicate payment events cannot double-credit; reversals preserve original ledger entries | Phase 8 |
| QBN-01 | Question bank | Authors organize versioned questions by subject/topic/difficulty; published assessments retain fixed question versions | Phase 9 |
| PRC-01 | Practice | Eligible students save attempts and receive configured feedback/topic progress; practice remains separate from formal grades | Phase 10 |
| EXM-01 | Formal exams | Teacher drafts, school admin publishes; server enforces eligibility, schedule, duration and attempt limits | Phase 11 |
| EXM-02 | Reliable attempts | Saved answers survive refresh/reconnect; retries cannot duplicate submissions; stale writes cannot overwrite newer answers; deadline finalizes saved answers | Phase 11 |
| RES-01 | Results | Objective scoring is deterministic; manual marks stay within bounds; only released results are visible to students/parents; corrections are audited | Phase 12 |
| RES-02 | Offline marks entry | Admin defines a paper assessment with maximum marks for chosen sections; assigned teacher records marks or absent/exempt for every enrolled student; out-of-range marks and unassigned entry are rejected; marks are visible to students/parents only after release and feed report cards | Phase 12 |
| OPS-01 | Operations | Environment isolation, restore rehearsal, alert delivery and agreed load tests pass before production | Phase 2, every release, and Phase 15 |

## Delivery boundaries

First school-management pilot: Phases 1-7, covering hardened accounts, academic MIS, attendance, timetable, homework and announcements. Initial complete product: fees, practice, examinations and parent access through Phase 12. Deliver usable modules without presenting placeholder pages as completed features.

The full approved planning scope now spans the 15 phases in [TASKS.md](TASKS.md). Report cards are scheduled in Phase 12; admissions, library, inventory and transport in Phase 13; HR/payroll in Phase 14; subscriptions, consolidated analytics and final release readiness in Phase 15. These modules require detailed specifications before their implementation, but are no longer an unscheduled backlog. Native apps, biometric attendance, live vehicle GPS, video proctoring and AI grading are not committed deliverables.

### Extended-module acceptance criteria

| ID | Capability | Acceptance criteria | Phase |
| --- | --- | --- | --- |
| ADM-01 | Admissions | Application review/approval converts to enrollment once; documents remain private and duplicates are prevented | 13 |
| LIB-01 | Library | Catalogue/copy records support issue, return, renewal and overdue tracking; the same copy cannot be issued twice concurrently | 13 |
| INV-01 | Inventory | Asset allocation and stock movements retain audit history; unauthorized or invalid stock adjustments are rejected | 13 |
| TRN-01 | Transport | Routes, stops, vehicles and student allocations enforce capacity/conflict rules and guardian visibility is child-scoped | 13 |
| HR-01 | HR and leave | Employment history and leave balances/approvals are accurate; sensitive staff records require explicit capabilities | 14 |
| PAY-01 | Payroll | Versioned calculations, approvals, payslips and corrections are reproducible; periods cannot be posted twice; staff see only own payslips | 14 |
| PLT-01 | Subscriptions | Plans, entitlements, usage limits, renewals and overrides are enforced server-side; billing retries are safe; expiry preserves records and handles active exams explicitly | 15 |
| RPT-01 | Reporting | Academic report cards and consolidated operational reports respect role/school scope and expose defined calculation periods/policies | 12/15 |

## Quality and success measures

Proposed targets: accessible keyboard/mobile workflows; no loss of server-acknowledged answers; no duplicate receipts or submissions on retry; no cross-tenant access in isolation tests. Benchmark target: p95 answer-save acknowledgement under 2 seconds at a load agreed before pilot. Network failures must be visible. Recovery targets are in [OPERATIONS.md](OPERATIONS.md).

Measure onboarding completion, attendance completion, import errors, exam completion, save failures, practice participation and support incidents. Establish pilot baselines before setting adoption targets.

## Decisions pending

Pilot school count/concurrent seats; curricula/report cards; languages; guardian verification; attendance sessions; fee currency/tax/refund rules; communication providers; retention; hosting region; commercial plans. Do not imply regulatory or contractual approval before these are resolved.


