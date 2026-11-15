# User flows

Implemented flows are explicitly labeled; all others are planned. Authorization requirements are in [ROLES_PERMISSIONS.md](ROLES_PERMISSIONS.md), routes in [PAGES.md](PAGES.md).

## Shared sign-in (implemented)

1. User supplies email, username or phone and password.
2. Rate limiter checks account/IP; authentication verifies password and account status.
3. App creates session and routes to password change when required.
4. If multiple schools require selection, user chooses a membership-backed school.
5. User enters school, student or platform portal according to roles; unsupported/no active membership leads to no-access.

Unknown login/wrong password share a generic error. Multiple matching accounts sharing a phone require username. Disabled accounts are rejected; suspended school memberships are omitted. Parent-only accounts currently have no parent portal and reach no-access. Sign-out removes current session and cookies.

## Platform admin onboarding (implemented)

1. Sign in, open school list, choose Add school.
2. Enter school details, board/medium and first admin credentials.
3. Submit; validation/duplicate errors preserve non-password fields.
4. Transaction creates school, user, membership and audit event.
5. Review school detail; activate when ready. New admin changes initial password.

Lookup creation/activation and school suspension are implemented. Subscription and usage management are scheduled in Phase 15. Production account bootstrap is not yet implemented.

## School administrator: academic MIS (implemented, Phases 3-5)

1. Configure academic year and dates, classes, sections and subjects (Phase 3).
2. Add teachers and assign subjects/sections for that year (Phase 4).
3. Admit students one by one, or import a class list: choose the year, check the file (column mapping, row errors and warnings), fix it, import all rows; hand over the sign-in names and activation codes shown once.
4. Enroll students in sections and number the rolls; move a student between sections from a date; undo a mistaken enrollment as a correction.
5. Link parents from the student's page: create a parent account (code), link a parent who already has a child here, or give a parent with an Examio account a code for this child.
6. At year end promote each section into the next year's section (untick repeaters; graduate the final class); students who leave are marked left with a reason. Earlier enrollments are never rewritten.

Failed imports must be retriable without duplicates. No silent merging of unrelated identities. Existing students retain admission number and history.

## Teacher: daily operations (implemented, Phases 6-7)

1. Open Attendance (or the dashboard's "Attendance today"): the registers of sections taught that day (implemented).
2. Mark each student (everyone starts as present), save and see the confirmation (implemented).
3. Change entries within the school's edit window, giving a reason for earlier dates; locked or older dates need the administrator (implemented).
4. Review "My timetable" (week and today, with holidays shown).
5. Set homework for their sections (with attachments and a due time), review submissions, return feedback, remind those who have not submitted, and publish class notices.

Unassigned sections are inaccessible even through copied URLs. Conflicting schedules and duplicate attendance submissions produce actionable errors.

## Student: practice (planned Phase 10)

1. Choose an available subject/topic or assigned practice set.
2. Review rules and start an eligible attempt.
3. Answer and save; recover latest acknowledged state after reconnect.
4. Submit and receive feedback according to practice policy.
5. Review explanations/topic progress and retry if allowed.

Practice never changes formal exam results. Exhausted/archived sets explain why another attempt is unavailable.

## Teacher/admin: formal assessment (planned Phases 11-12)

1. Teacher drafts questions and exam for assigned sections.
2. Configure marks, duration, schedule, allowed attempts and result policy.
3. Preview; school admin reviews and publishes a fixed content/rules version.
4. Monitor operational status without revealing other students' answers to students.
5. Auto-score objective answers; assigned graders mark descriptive answers.
6. Admin verifies completion and releases results; later corrections require reason and revision history.

Published content cannot be edited in place. Cancellation/rescheduling must address active attempts explicitly; never silently shorten an active student's deadline.

## School admin: prepare a school year (implemented, Phase 3)

1. Open School setup from the menu or the dashboard card; the checklist shows what is left.
2. Complete the profile (address, contact, time zone).
3. Create the academic year and make it current (a later year: copy sections and subjects from the previous one).
4. Add classes (Class 1-12 in one step, or by name) and the year's sections.
5. Add subjects and tick each class's subjects for the year.
6. Choose a grading scheme (the CBSE-style starter, or your own) and confirm attendance sessions; add holidays.
7. At year end, make the next year current; the old year closes and becomes read-only, and can be reopened if needed.

Anything already in use is archived rather than deleted; refusals are explained next to the button.

## School admin: staff and teaching assignments (implemented, Phase 4)

1. Open Staff. Add a staff member (name, employee number, email or mobile, teacher or finance) and hand over the one-time activation code shown; or import many from CSV: check the file, fix rows marked in red, import, then hand over the codes listed once.
2. For someone who already uses Examio at another school, send an invitation; after they join, add their employee number under "Members without staff details".
3. Open a teacher and assign subjects to sections for the year; appoint class teachers. "Who teaches what" shows sections without a class teacher and class subjects without a teacher.
4. When a teacher changes, end their assignment (or appoint the new class teacher from a date); when someone leaves, mark them as left: access ends at once and their assignments end.
5. A lost activation code or forgotten password: issue a new code from their page; "Sign out of all devices" ends their sessions.

The teacher, after setting a password at `/redeem`, sees "My classes today" on the dashboard. Staff pages are for school admins only.

## Teacher/admin: offline exam marks (planned Phase 12)

1. Admin creates an offline assessment for an academic year, subject and sections, with date and maximum marks.
2. Assigned teacher opens the register and enters marks, or absent/exempt, for each enrolled student.
3. Teacher saves a draft and submits when the register is complete.
4. Admin reviews, locks and releases the marks; later corrections require reason and revision history.
5. Released marks appear with online results for the student and linked guardians, and feed report cards.

Marks above the maximum, entries for students outside the target sections and saves against a stale register are rejected with row-level errors.

## Student: formal exam (planned Phase 11)

1. Open eligible scheduled exam and read instructions.
2. Start within the allowed window; server creates/reuses the allowed attempt and deadline.
3. Navigate questions, answer, mark for review and observe save state.
4. Refresh/reconnect loads acknowledged answers and remaining server time.
5. Review unanswered count and submit; retry returns same submission receipt.
6. Deadline finalizes the latest acknowledged answers even without an open browser.
7. View results only after release.

Late/unauthorized writes are rejected. Connection loss does not extend time automatically. A save conflict reloads the server revision instead of overwriting it.

## Parent (Phase 5 implemented; later modules planned)

1. Set a password with the code from the school (new account), or, with an existing Examio account, enter the school's code for the child at `/join` (implemented).
2. See linked children at `/parent` and open each child's class history, homework (with the child's submission and feedback), attendance and timetable; read notices; switch school when linked at more than one (implemented).
3. View attendance, timetable, notices, homework, fee statements and released results as modules become available.
4. Pay an eligible invoice when online payments are enabled; wait for verified payment confirmation.

No child is discoverable by arbitrary admission number or phone lookup. Revoked links immediately remove access.

## Finance staff (planned Phase 8)

1. Open school fee dashboard and assigned finance functions.
2. Issue invoices from approved fee schedules; record offline receipts with reference.
3. Reconcile provider-confirmed payments and unmatched entries.
4. Request adjustment/refund; school admin approves; authorized execution records reversal and audit.
5. Export scoped statements and reconciliation reports.

Duplicate payment callbacks do not credit twice; pending or failed payments never show as paid.

## Recovery, activation and joining a second school (implemented, Phase 1)

Forgotten password: the user asks their school office -> a school admin (or, for a school admin, the platform admin) confirms who is asking, issues a one-time reset code with a reason and hands it over -> the user opens `/redeem`, enters the code and a new password -> the code is consumed, all sessions end -> the user signs in again.

New account: the school creates the account and hands over an activation code instead of choosing a password for the person -> same `/redeem` step.

Existing account joining another school: the second school creates a membership invitation and hands over its code -> the person signs in to their own account and enters it at `/join` -> they gain that membership and can switch schools.

First platform administrator: an operator runs `pnpm admin:bootstrap` and passes the printed one-time code to the administrator, who redeems it at `/redeem`.

Platform support: the platform admin opens support access on the school's page with a reason -> works within that school for up to the granted time -> ends access; the school's admins can see the grant and reason.

A wrong, expired, used or cancelled code always gives the same message. Earlier email-based design, kept for a possible later channel:

Request reset -> generic acknowledgement -> verified channel receives short-lived link -> user submits valid new password -> consume token and revoke sessions -> sign in again. Missing access to the channel requires a documented school/platform identity-verification process, not security questions or disclosure of the old password.


