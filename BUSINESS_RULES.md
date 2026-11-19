# Business rules

Unless labeled implemented, rules are planned defaults for implementation and may be changed through an explicit documented product decision.

## Schools and identities

Implemented school statuses: onboarding, active, suspended. Current session loading accepts onboarding/active memberships and excludes suspended schools. Target: onboarding allows setup; student practice/exam starts require an active school. Define handling of existing attempts before suspension; preserve recorded answers and audit the decision.

School codes are unique lowercase alphanumeric, 2-12 characters. Global emails/usernames are unique when present; phones may be shared. Membership is school-specific and can be revoked. Never infer guardianship or merge accounts solely because a phone matches. Platform admin creates schools; schools manage their own profiles and memberships within explicit capabilities.

## Academic MIS

### Academic setup (implemented, Phase 3)

- **Academic years** run planned → current → closed; a closed year can be reopened (back to planned). At most one year is current per school, enforced in the database; making a year current closes the previous current year. A year ends after it starts and lasts at most two years. Overlapping years are allowed with a warning, because preparing next year while this one runs is normal; the overlap policy remains a product decision. A closed year is read-only: its sections, subject assignments and calendar cannot change, enforced in the database.
- **Classes** belong to the school across years, ordered by a sort number; names are unique ignoring case. "Add Class 1 to Class 12" creates any that are missing; pre-primary classes (Nursery, LKG, UKG) are added by name.
- **Sections** belong to one class in one year; names are unique per class and year ignoring case; capacity is optional, 1-500.
- **Subjects** have a name and a code (2-12 capital letters, digits or hyphens), both unique per school; the code cannot change after creation because other records refer to it.
- **Subject assignment**: per year, each class has a set of active subjects; saving replaces the set.
- **Copying a year** copies active sections and subject assignments into an empty, open year.
- **Archive, not delete**: classes, sections and subjects in use cannot be deleted (database RESTRICT keys) and are archived instead; archived items are hidden from new setup, kept for history, and can be restored. Unused items can be deleted.
- **Calendar**: holidays, events and exam periods are local school dates inside their academic year.
- **Attendance sessions** are per school; every school starts with "Full day" and always keeps at least one active session.
- **School profile**: administrators edit name, short name, address, contact email/phone, time zone (any valid IANA zone) and accent colour; board, medium, status and code are platform decisions.

### Staff and teaching assignments (implemented, Phase 4)

- **Staff record**: every staff member of a school has one staff profile there, linked to their own account: employee number (up to 30 letters, digits, `/`, `_` or `-`; unique in the school ignoring case; not unique across schools), display name, optional job title and joining date. A person working at two schools has a separate profile, employee number and roles in each; one school's changes never affect the other.
- **Adding staff**: a school admin creates the account (email or mobile number required) with the teacher or finance role and hands over a one-time activation code, valid 48 hours; the person chooses their own password at `/redeem`. Someone who already has an Examio account (for example at another school) is invited instead and gets staff details after joining. Additional school administrators are added by platform support.
- **Leaving**: marking someone as left records the leaving date (not before the joining date), revokes their staff roles in this school at once (signed-in sessions lose access on their next request), and ends their open subject and class-teacher assignments in open years on that date. Nothing is deleted. An admin cannot mark themself as left. Bringing someone back restores their teacher and finance roles; assignments are not restored automatically.
- **Subject assignments**: a teacher (active, with the teacher role) is assigned a subject for a section in one academic year, from a start date inside that year (default today, or the year's start if it has not begun). The class must study the subject that year. Several teachers may share a subject in a section (co-teaching); the same teacher cannot hold the same open assignment twice.
- **Class teacher**: at most one current class teacher per section. Appointing a new one from a date ends the previous one the day before; the new start must be after the previous one's start.
- **Ending**: assignments are ended, never deleted, so history stays visible; the end date is within the year and not before the start. A closed year's assignments are read-only.
- **Teacher access** follows assignments: a teacher "teaches" a section on a date when a subject or class-teacher assignment covers that date and their staff profile is active. Teachers see the school's staff, their own profile and assignments, but no students or parents; Phase 5 grants access to students of the sections they teach.
- **Bulk import**: CSV with a header row (name, employee_no, email, phone, role, job_title, joined_on), at most 300 rows and 256 KB. The preview checks every row (formats, duplicates within the file and against existing staff and accounts) and saves nothing; the import re-checks the same file and adds all rows or none. A changed file is refused, and repeating an import never creates an employee twice. Activation codes are shown only in the first response.
- **Export**: the staff list as CSV with the page's filters, for school admins only; each export is audited, and cells that a spreadsheet would treat as formulas are neutralised.

### Students, enrollments and guardians (implemented, Phase 5)

- **Student record**: one per student per school, linked to the student's own account. Admission number: up to 30 letters, digits, `/`, `_` or `-`; unique in the school ignoring case; not unique across schools; cannot be changed after creation. Optional date of birth (before the admission date); admission date (default today).
- **Sign-in**: the school creates the account; the student signs in with a sign-in name made of the school code and the admission number (`gvps.2026-014`; characters other than letters and digits become `-`), using a one-time activation code to set a password. Two admission numbers that give the same sign-in name (`A/1`, `A-1`) cannot both be used. A student who already has an Examio account joins by invitation and is then given student details.
- **Enrollment**: a student is in one section per academic year at a time (one open enrollment per student per year); roll numbers 1-9999, unique among a section's current students, optional. Start date inside the year and not before admission (default today, or the year's start if it has not begun). Moving section ends the current enrollment the day before the move. A mistaken enrollment is ended as a correction on its first day. Enrollments are never deleted; a closed year's enrollments are read-only. An enrollment still open when its year closes counts as ending with the year.
- **Promotion**: chosen students of a section move to a section of a later year, starting on that year's first day; their old enrollment ends on the old year's last day while that year is still open. Students not chosen stay (for example to repeat). A final class is marked graduated: the students leave on the year's last day (or today, if earlier). Running the same promotion again skips students already in the target year.
- **Leaving**: withdrawn, transferred, graduated or other, with a date not before admission. Access ends at once (student membership revoked) and open enrollments in open years end on that date. Guardian links remain, so parents still see the record. Readmission restores access; enrollments are made again.
- **Guardians**: a parent sees a child only through an active guardian link (relationship mother, father, guardian or other), created by the school: a new parent account for that child (activation code), an existing parent of the school linked to a sibling, or a code naming the child that a parent with an existing account accepts at `/join` (not usable by the child, not valid once the child has left). Parent invitations must name a child. Unlinking a parent's last child also revokes their parent membership. A parent never searches for or claims a child.
- **Import**: CSV with a header row; common column spellings are recognised (name, admission number, admission date, date of birth, class, section, roll number) and the mapping is shown. At most 300 rows and 256 KB per file. Class and section are looked up in the chosen open year. Errors (format, duplicate admission number or roll in the file or the school, unknown section) block the import; warnings (same name and date of birth as an existing student) do not. All rows or none; a changed file or year is refused; repeating an import never creates students twice; sign-in names and codes are shown only in the first response.
- **Documents**: private files (PDF or image, up to 10 MB) on the student's record, visible to the school's administrators only; downloads only after the virus check; removing hides the document and keeps the history.
- **Reports**: class strength per section (current students, capacity, students without roll number) and the student list, both as audited CSV with formula cells neutralised.

Curriculum and language assumptions: no national curriculum or board syllabus is built in; classes and subjects are whatever the school defines, and the board/medium chosen at onboarding are labels only. Interface text is English; subject and class names may be in any language and script.

School local dates govern attendance; UTC instants govern scheduled events.

Promotion never rewrites previous results. Archive referenced classes/subjects rather than deleting them.

Imports default to validation preview followed by atomic commit of the approved batch. No partial import unless explicitly selected and reported. Changed source/mapping invalidates the preview. Retries reuse job/idempotency identity. Teachers may only access assigned classes/subjects within assignment dates.

## Attendance, timetable and homework

### Attendance and timetable (implemented, Phase 6)

- **Registers**: one per section, local school date and attendance session (sessions are set up per school; every school has "Full day"). The register lists the students enrolled in the section on that date (enrollments undone as corrections are left out). Every student is marked present, absent, late or excused, with an optional note; a student without a record is "not recorded", never absent.
- **School days**: inside the section's academic year, not a weekly day off (school setting, default Sunday) and not a holiday on the school calendar. No register is taken on other days or for future dates.
- **Who writes**: a teacher who teaches the section on that date (subject or class teacher), within the school's edit window (default 3 days after the date) and after the lock date; administrators write any date. Enforced in the database too.
- **Changes**: changing an entry after its date needs a reason; an administrator writing a locked date or a date outside the teachers' window needs a reason even for a first marking. Every status change is kept (who, when, from what, why) and visible to administrators. A closed year's attendance is read-only.
- **Safe submission**: submitting the same register twice changes nothing; if someone else saved the register after it was opened, the submission is refused with a request to reload (unless it asks for exactly what is stored).
- **Lock**: administrators lock attendance up to a past date; the lock date cannot be in the future.
- **Timetable**: weekly periods per section and academic year (weekday, start and end time in the school's time zone, subject the class studies, optionally a teacher assigned to that subject in that section, and a room). The same section, the same teacher and the same room (ignoring case) cannot have overlapping periods on the same weekday of a year; back-to-back periods are allowed. Removed periods keep their history. Holidays and weekly days off are shown instead of periods on the teacher's day view.

Initial attendance statuses: present, absent, late, excused; not recorded is distinct from absent. Attendance session configuration is per school. Unique record per enrollment/local date/session. Only eligible enrolled students belong on the register. Admin controls lock/correction window; corrections require actor/time/reason.

Default attendance percentage = (present + late) / (present + late + absent) x 100; excused and not-recorded entries are excluded. Zero denominator displays N/A, not 0%. Implemented in Phase 6 with integer basis points and shown to one decimal; reports also count not-recorded sessions and list dates with incomplete registers. A different school policy (versioned) is not implemented.

Timetable slots cannot overlap for a section, teacher or assigned room on the same applicable day. Homework due time uses school timezone; late submission is flagged and allowed only if the published assignment policy permits it. Files remain unavailable until validation/scan succeeds.

### Homework and notices (implemented, Phase 7)

- **Homework** is set by a teacher for sections they teach that day (administrators: any section) and a subject the class studies; set for several sections, each gets its own copy. Due time is entered in school time and stored as an instant. It is visible to the section's current students and their linked parents once published; archived homework is hidden from families and kept.
- **Submissions** are private: the student writes an answer and/or attaches files (PDF, image or text, up to 10 MB each). The student may change it until feedback is returned; then it is final. After the due time a first submission is accepted only when late submissions are allowed, and is marked late (the mark never changes).
- **Feedback** comes from the author, a teacher of the section or an administrator; it can be updated. The student and their parents are notified the first time.
- **Reminders** go to students who have not submitted and their parents, at most once per homework per day.
- **Notices**: administrators publish to everyone, staff, students, parents or one class; teachers only to a class they teach. A class notice reaches its current students, their parents and its teachers. Archived notices disappear for recipients; nothing is deleted. Administrators and the author see delivery and read counts.
- **Notifications** (in-app and email when an address exists) are queued once per recipient and item: retrying never notifies twice. Delivery needs the background worker.
- **Guardian access** follows the link: revoking a parent's link removes their access to that child's homework, submissions and class notices at once.

## Question bank (implemented, Phase 9)

- **Curriculum**: each subject has chapters, and chapters have topics (two levels). Names are unique within their parent, ignoring case. Archiving a chapter archives its topics; archived ones stay for existing questions but cannot take new ones.
- **Question types**: single choice (2 to 6 options, exactly one correct, options unique ignoring case), true/false, and descriptive (graded by hand; optional model answer shown to graders only). Other types need explicit scoring rules before they are added.
- **Marks**: 0.01 to 100 in hundredths; optional negative marks from 0 up to the question's marks (not for descriptive questions). Difficulty easy, medium or hard. Text is plain with line breaks; one optional image (PNG, JPEG or WebP, up to 2 MB).
- **Versions**: the latest version is edited in place until published. Publishing locks it; editing a published question creates a new draft version, and the published version stays in use unchanged until the new one is published. Versions are never deleted; the type of a published question does not change.
- **Review**: teachers write questions for the subjects they currently teach and submit them; school administrators publish, send back to draft, archive and restore (a restored question returns to published if it had a published version).
- **Learners** never read the bank. Practice and exams (later phases) receive only the learner view of a published version: question, options, marks and image, without the answer key or explanation.
- **Import**: CSV checked row by row with the editor's rules; subjects by code or name; missing chapters and topics are an error unless "create missing" is chosen; up to 300 questions and 512 KB; all rows or none; a repeat of the same file adds nothing.

## Practice (implemented, Phase 10)

Practice is separate from formal grading: it never changes results, report cards or exam marks.

- **Sets**: administrators and teachers of the subject build a set from published questions of that subject (picked one by one, or a number from a chapter or topic). Each item is the question's published, locked version, so later edits to a question never change a set. Up to 100 questions. Questions are added and removed only while the set is a draft; publishing fixes them. Published sets are archived, never deleted; drafts can simply stay unpublished.
- **Settings**: attempts unlimited by default, or a limit from 1 to 50 (at most 50 in any case). Feedback (correct answers, explanations, per-question results and the score) right after submitting (default), or only after the assignment closes. Changing the settings of a published set applies from then on.
- **Assignment**: a published set is assigned to sections of the current year whose class studies the subject: administrators any section, teachers sections they teach today. Optional opening and closing times in the school's time zone; the closing time must be in the future and after the opening time. One active assignment per set and section; removing it hides the set from that section and keeps attempts.
- **Who practises**: students currently enrolled in an assigned section, while the set is published and the assignment active. Starting is allowed only inside the window (server time) and within the limit; starting again returns the attempt already in progress (one at a time).
- **Answers** are saved one question at a time with the revision the screen last saw; a save from a stale window is refused, and the screen asks to reload. Saving needs the window to be open. An attempt in progress when the window closes can still be submitted (what was saved is scored); a new one cannot be started.
- **Scoring** happens inside the database at submission: single choice and true/false earn their marks when correct and lose the negative marks when wrong; blank answers score nothing; descriptive answers are not scored in practice (and are left out of the maximum). The total never goes below zero. Submitting twice changes nothing.
- **Feedback** is withheld until the rule allows: before that the student sees only that the attempt was submitted, and the database returns no answer keys. Staff see results at once.
- **Progress** per chapter/topic: accuracy over scored questions of released, submitted attempts (unanswered counts as not correct). A topic "needs practice" below 60% once at least 5 questions have been answered; below 5 answers it shows "not enough practice yet" rather than a judgement. Recent attempts list scores only once released.
- **Parents** see their linked children's assigned practice, attempts (answers and, once released, results) and progress, read-only.
- **Teachers** see, per assigned section, every current student's attempts, best score and last submission, and per question the share answered correctly.

## Formal examinations (implemented, Phase 11)

As implemented:
- **Drafting**: administrators and teachers of the subject draft an exam for the current academic year with published questions (each fixed to its published version, in the order chosen), sections (teachers: sections they teach today; the class must study the subject), an opening and closing time in the school's time zone, a duration of 5-600 minutes, 1-5 attempts (default 1) and whether the questions' negative marks apply.
- **Approval**: a teacher submits the draft for approval, which freezes it; a school administrator publishes it or sends it back to draft (the author may also withdraw it). An administrator may publish their own draft directly. Publishing needs questions, sections, a closing time in the future and a duration that fits between opening and closing. Publication freezes questions, sections and timing.
- **Cancellation**: an administrator cancels a published exam with a reason. Attempts in progress end at once (kept, marked cancelled); nothing new can start. Cancelled is final.
- **Accommodations**: an administrator records extra minutes (up to 240) and/or extra attempts (up to 3) for one student of a target section, with a reason. They apply to attempts started afterwards.
- **Starting**: a student currently enrolled in a target section may start while the exam is open (server time in [opens, closes)) and attempts remain. Starting again, from any tab or device, returns the attempt in progress. Concurrent starts are serialised in the database and never exceed the limit.
- **Deadline**: min(start + duration, closing time), each plus the student's accommodation minutes, fixed at start. No extension for disconnection.
- **Answers**: one question at a time; each save carries the revision the screen last saw and is refused if another window saved since (the student reloads). Saves are accepted only for the student's own active attempt before its deadline and only for questions of that exam. "Saved" is shown only after the server acknowledged it; failed saves are retried, including when the connection returns. Marking a question for review does not change its answer.
- **Submission**: the student reviews unanswered and marked questions, then submits. A repeated submission returns the original receipt (a 10-character code). After the deadline the attempt is submitted with the answers saved by then: by the worker within a couple of minutes, or at once when the student or the screen opens it, and the student's screen submits automatically at zero.
- **Visibility**: students see questions only during their own active attempt and never answer keys; after submission they see the receipt only. Parents see the schedule, attempts and receipts of their children, not questions or answers. Staff of the subject see each student's state (not started, in progress, time up, submitted) and number answered. Scores and results come in Phase 12.

Planned rules (some decisions still pending):

Lifecycle: draft -> published -> closed -> grading -> results released; cancellation is an explicit audited alternative. Publication freezes content, marks, targets and timing. New content requires a new version; active attempts retain their original version. Admin publishes by default; teacher drafts/grades only assigned subjects.

Start requires active school/account/membership, eligible enrollment, published target and server time within `[opens_at, closes_at)`. Default one attempt; retakes require explicit configured limit/authorization. Allocate attempts transactionally to prevent concurrent starts exceeding limits.

Deadline = minimum(started_at + duration, closes_at), except an explicit per-student accommodation approved before start. No automatic extension for disconnects. Server time is authoritative. Accept answer writes only for active attempts before deadline; validate question belongs to that exam version. Duplicate submission returns the original receipt. Deadline worker finalizes acknowledged answers; unsent browser edits cannot be represented as saved.

Cancellation, disruption and accommodations need an admin workflow with reason and affected attempts. Product decisions on retake grading policy and accommodations remain pending; initial default result uses the first authorized attempt, with any replacement explicitly designated and audited.

## Scoring and results (implemented, Phase 12)

As implemented:
- **Grading starts** after an exam closes (by its managers); attempts whose deadline has passed are submitted first, and grading waits while a student with extra time is still writing. For each student now in a target section, and anyone who attempted the exam, the first submitted attempt counts; an administrator may count another submitted attempt instead, with a reason (recorded).
- **Objective questions** are scored at once: correct earns the question's marks; wrong loses the penalty if the exam applies negative marking, otherwise zero; blank earns zero. Single-choice and true/false marks are not edited during grading.
- **Written answers** are marked by administrators, the subject's teachers and assigned graders: 0 to the question's marks in hundredths, with an optional comment. A grader who does not teach a student's section marks the answer without seeing the name.
- **Release** (administrators) is refused while any counted written answer is unmarked or when the school has no default grading scheme. The total is the sum of the question marks floored at zero; the maximum is the sum of all question marks. A student without an attempt is absent. Students and parents are notified.
- **After release**, administrators correct a question's marks with a reason; the earlier marks are kept (`result_changes`), the result's revision rises, and the student and parents are notified. Students see each question, their answer, the marks, the grader's comment and the correct answer with its explanation; parents see the totals.
- **Paper exams**: as described below, with a register per section, CSV import (admission number and marks, AB or EX; all rows or none), draft → submitted → locked → released, and corrections after locking with a reason.
- **Report card (provisional format)**: per academic year and subject, every released online exam and paper exam with marks, percentage and grade; subject and overall totals count assessments by their marks with equal weight; absent counts as zero out of the maximum and exempt is left out; grades and pass compare the exact fraction with the school's current default scheme; no ranking; practice is excluded. Students, parents (for linked children) and administrators see it and can print it. The format and weighting remain open decisions for the school (see TASKS.md).

Planned rules (decisions still pending where marked):

Initial objective types: single choice and true/false; descriptive manual grading follows in Phase 12. Multi-select partial credit requires a separate explicit scoring policy before enabling it. Correct objective answer earns item marks; wrong answer earns negative penalty if configured, otherwise zero; unanswered earns zero. Penalty is nonnegative and no greater than item marks. Default total is floored at zero after summation; maximum = sum of positive item marks.

Grading schemes (implemented, Phase 3): each has a pass mark and grade bands defined by their minimum percentage; a band covers its minimum up to the next band's minimum and the top band includes 100%. One band must start at 0%, so every percentage gets exactly one grade; minimums and grade names are unique within a scheme. Values are stored as basis points (hundredths of a percent), so comparisons are exact. One active scheme is the school's default (the first one created); the default cannot be archived. A CBSE-style preset (A1 91%, A2 81%, B1 71%, B2 61%, C1 51%, C2 41%, D 33%, E 0%; pass 33%) is offered as an editable starting point; no universal scale is assumed.

Percentage = final total / maximum x 100, rounded half-up to 2 decimal places for display; reject zero maximum at publication. Grade boundaries are configurable, nonoverlapping and evaluated against the unrounded percentage. Passing threshold and subject-specific requirements must be configured; do not assume a universal pass percentage.

Manual marks are between zero and item maximum. Release requires all required grading complete. Students/parents cannot see draft results. Post-release corrections create a new result revision, preserve earlier marks and require reason; notify affected recipients after commit. Rankings are off initially; any future ranking must specify ties and visibility.

Offline (paper) assessments record marks for exams not taken in Examio. Each assessment belongs to one academic year and subject, targets explicit sections and has a positive maximum. Every enrollment in a target section needs exactly one current entry: marks between zero and the maximum, or absent or exempt with no marks. Absent and exempt are distinct from zero. Only an assigned teacher of that subject and section, or a school admin, may enter marks. Entry lifecycle: draft -> submitted -> locked by admin -> released; locking requires a complete register. Changes after lock create a new revision with reason and preserve earlier marks. Percentage, grade and visibility follow the same rules as online results. How absent/exempt entries and assessment weightings affect report-card totals is decision pending.

## Admissions (implemented, Phase 13.1)

- Recorded by the school office (school administrators) for an academic year that is not closed and an active class. A guardian mobile number or email is required. No public online form yet.
- Reference numbers are per school and year of the academic year's start: A26-0001, A26-0002, …
- Duplicates: an open application for the same year with the same applicant name (ignoring case) and the same date of birth or guardian mobile is refused unless the office confirms it is a different child; a student already on record with the same name and date of birth is shown and must be confirmed at conversion.
- Status steps: enquiry → applied → under review → approved or rejected; withdrawn from any open step (with a reason); approved can go back to review; rejected and withdrawn can be reopened for review. Rejection needs a reason. Details can change only before a decision.
- Documents: birth certificate, photograph and address proof are required by default; previous report and transfer certificate optional; "other" can be added. Approval needs the date of birth and every required document verified or waived; waiving a required document needs a reason. Files are private to the school's administrators.
- Conversion (approved only) creates the student's account, record and optional enrollment in a section of the class and year applied for, with the admission number given (unique in the school); exactly once: converting again returns the same student and creates nothing. The activation code is shown once. Enrolled is final.

## Library (implemented, Phase 13.2)

- Run by school administrators (no separate librarian role yet). The catalogue has titles (title, author, ISBN, publisher, category) and copies with an accession number unique in the school, a shelf and a status: available, issued, lost or withdrawn.
- Borrowers are active students and active staff of the school. Settings per school: loan period (default 14 days), renewals per loan (default 2), books at a time for students (3) and staff (10), and a late fine per day (default none).
- Issue: only an available copy; never to a borrower at their limit or with an overdue book. A copy has at most one open loan, enforced in the database, so two desks issuing the same copy at once cannot both succeed. The due date is today plus the loan period (school time).
- Renew: an open loan that is not overdue, within the renewal limit; the new due date is today plus the loan period.
- Return: closes the loan and makes the copy available. A late return by a student with a late fine configured raises a fee charge request (days late × fine per day), which takes effect only when another administrator approves it in Fees (Phase 8 controls).
- Lost: the loan is closed as lost and the copy marked lost. For a student, an optional replacement charge is requested the same way. Staff losses are recorded only.
- Withdrawing a copy (damaged, discarded) is possible only when it is not on loan; a lost copy can be found again (back to available).
- Students see their own loans and due dates; parents see their linked children's. Overdue books are listed for administrators.
- A borrower number that matches both a student's admission number and a staff employee number is refused until the office makes them distinct. Charges for staff are not handled by the library. Titles cannot yet be archived from the pages.

## Inventory (implemented, Phase 13.3)

- Run by school administrators (no separate store-keeper role yet). Locations (store room, labs, classrooms) have names unique in the school.
- Items are either **assets**, tracked one by one with a tag unique in the school (projector, laptop, microscope), or **consumables**, counted per location in a unit (chalk boxes, paper reams), with an optional reorder level.
- Asset states: in store, allocated, under repair, disposed. An asset is always at a location. Allocation is to one active staff member at a time (enforced in the database), optionally with a return date; returning puts it back in store at a chosen location. Moving changes the location of an asset that is not allocated. Disposal needs a reason and is final.
- Stock: receive (adds), issue (to a staff member or for a stated purpose), transfer between locations, and adjust after a physical count (reason required). A balance can never go below zero, enforced in the database; issuing or transferring more than is there is refused with the quantity available. Quantities are whole units, at most 100,000 per entry.
- Every stock change is recorded as an append-only movement with the balance after it, and every asset change as an append-only asset event, each with who and when. Nothing is deleted; items can be archived when no stock or active assets remain.
- Low stock: consumables whose total across locations is at or below the reorder level are listed for administrators.
- Stock can still be issued from, transferred out of or counted at an archived location; receipts, transfers in, new assets and returns need an active location. Locations cannot be renamed or archived from the pages yet. Staff do not see items allocated to them yet.

## Transport (implemented, Phase 13.4)

- Run by school administrators. Vehicles have a registration number unique in the school (letters, digits, spaces and hyphens, up to 20) and a seat capacity (1-100). Routes have a name unique in the school, an optional vehicle, and an optional driver and attendant from the school's active staff (two different people).
- Stops belong to one route, with a position (1-99, unique on the route), a name unique on the route and optional pickup and drop times (school time).
- A student is assigned to one route and one of its stops at a time (enforced in the database). Assigning a student who already has a route ends the old assignment the same day and starts the new one, so history is kept. Assignments start on the school's current day and end on a day; nothing is deleted. Only active students can be assigned.
- Capacity: the number of students currently on a route can never exceed its vehicle's capacity, and a route without a vehicle takes no students. This is enforced in the database when assigning, when changing a route's vehicle and when lowering a vehicle's capacity.
- Students see their own route, stop, times and vehicle; parents see the same for their linked children only. Driver and attendant names are shown to administrators. No live vehicle tracking.
- Stops cannot be removed once added (they may be part of history); rename or renumber them instead. Drivers and attendants do not yet see their route's students. Transport fees are set up in Fees like any other fee head.

## Operations reports (implemented, Phase 13.5)

- Each submodule has its own capability: `school.admissions.manage`, `school.library.manage`, `school.inventory.manage`, `school.transport.manage` (school administrators), and `school.library.view` and `school.transport.view` for students' own records; parents use their linked-child access.
- The administrator dashboard shows open, under-review and approved-but-not-enrolled applications; books on loan and overdue; low-stock items, assets with staff (overdue) and in repair; students, seats and full routes. Each figure links to its page.
- CSV downloads, for school administrators only and recorded in the audit log: applications (all, or the status and year being viewed, with guardian contacts), books on loan (or overdue only), the asset register, consumable stock by location, and students on routes (all routes or one). Cells that could run as spreadsheet formulas are neutralised. Files are not cached.

## HR records (implemented, Phase 14.1)

- Run by school administrators. Departments and designations are per school, with names unique in the school; they can be archived, not deleted.
- Each staff member has one employment record: employment type (permanent, probation, contract, part-time, temporary), department, designation, confirmation date (permanent staff), notice period in days and an emergency contact. The joining and leaving dates stay on the staff profile (Phase 4).
- Every change to type, department, designation or confirmation is kept as a dated employment-history entry (effective date, what changed, from and to, who recorded it, an optional note); history is never edited or deleted. Leaving and rejoining (Phase 4) also appear in the history.
- Payment details (account holder, bank account number, IFSC, PAN) are kept apart and readable only by school administrators and finance staff (finance prepares payroll in Phase 14.3). Account numbers are 6-18 digits; IFSC is four letters, 0, then six letters or digits; PAN is five letters, four digits, a letter. Lists show only the last four digits of an account number.
- HR documents (appointment letter, ID proof, qualification, experience letter, address proof, other) are private files visible only to school administrators.
- Only an active staff member's employment can change. An archived department or designation stays on records that have it but cannot be newly chosen. The effective date cannot be before the joining date. Only permanent staff have a confirmation date. A staff member can read their own employment terms and history (shown to them in Phase 14.5); finance can read employment terms for payroll. The audit log records that payment details changed, never the numbers.

## Staff attendance and leave (implemented, Phase 14.2)

- Working days are the school's days: not a weekly off day and not inside a holiday on the school calendar. Leave counts working days only, in half days.
- Leave types are per school: a name, paid or unpaid, and for paid types a yearly quota in days (halves allowed) per academic year. Unpaid leave has no quota. Types are archived, not deleted. No carry-forward.
- A request covers whole working days from one date to another, or half of one day, within one academic year, with a reason. Staff request for themselves; an administrator can request for any active staff member. One staff member's pending and approved requests cannot overlap (enforced in the database). A request that covers no working day is refused.
- A pending request is approved or rejected (rejection needs a reason) by a school administrator who is not the staff member and did not make the request. Approving paid leave needs enough balance: quota minus approved leave of that type in the year. The staff member can cancel their own pending request; an administrator can cancel a pending or approved one with a reason.
- Approval marks each working day in the staff register as leave (or half leave), replacing any earlier mark, with the change kept in history; cancelling approved leave clears those marks, also kept in history.
- The staff register is marked by administrators for one day at a time: present, absent or half day (absent for half the day). Leave marks come only from approved leave and cannot be overwritten by hand. Changing an existing mark needs a reason and is kept as a correction. Days in the future cannot be marked.
- Balances show quota, approved, pending and remaining days per paid type for the academic year. A new paid request must also fit after other pending requests of that type.
- A leave type keeps its name and pay; only the quota changes, or it is archived (no new requests). A cleared register mark (from cancelled leave) is "not marked" and can be marked again without a reason; the change is still recorded. Platform support with an active grant can read leave and the register; payment details stay hidden from support.

## Fees

### Fees and payments (implemented, Phase 8)

- **Money**: Indian rupees only, stored as integer paise; percentages in basis points; rounding half-up to the paisa. Amounts per item up to ₹10,00,000.
- **Fee heads** carry a tax rate (default 0%; school tuition is generally GST-exempt, schools set rates with their accountant). Tax is charged on the amount after concessions.
- **Fee structures** are per class and academic year: items (head, label, amount, due date inside the year), an optional flat late fee and grace days. Drafted by finance staff or administrators; billable only after a school administrator approves; approved items never change (archive and create a new structure instead).
- **Invoices** are issued per instalment (items sharing a due date) to the students currently enrolled in the class that year, numbered `INV-000001` per school. One invoice per structure, student and due date: issuing again bills nobody twice. Approved, unrevoked concessions apply (percentages and fixed amounts per line, never more than the line). An unpaid invoice can be cancelled by an administrator with a reason; its charges are reversed.
- **Ledger**: every charge, late fee, payment, adjustment, refund and reversal is an entry; nothing is edited or deleted; a mistake is reversed by a new entry (each entry at most once). Balances are sums of entries.
- **Offline payments** (cash, cheque with number, bank transfer, UPI) are recorded by finance staff with a receipt number `RCT-000001`, never more than the invoice's outstanding balance; a retried submission records nothing twice.
- **Online payments** (Razorpay, test mode until live payments are approved): the parent pays the outstanding amount of a linked child's invoice. Only the provider's signed webhook (or finance reconciliation asking the provider) marks a payment received: never the browser. Each provider event is applied once; a payment is credited once; an event for a different amount is not credited and raises an alert; a failure after a capture is ignored; a capture after a failure is accepted.
- **Late fees**: added once per invoice, when it is still unpaid more than the grace days after its due date (run by finance from the Fees page).
- **Approvals**: concessions and adjustments (waiver, extra charge, refund of a received payment, reversal of a receipt entered in error) take effect only when approved by a school administrator who is not the requester. Refunds are paid back outside Examio (cash or bank); Examio records them.
- **Reminders**: parents of students with overdue invoices are reminded at most once per invoice per day.
- **Reports**: collections by method and day, outstanding by class, defaulters, and a reconciliation check (invoice totals against charges, payments against credits); CSV exports are audited.


Amounts use integer minor units and explicit currency. Line total = quantity x unit amount - discount + tax; components cannot produce a negative line. Discounts/tax/rounding policy must be approved before issuance. An issued invoice snapshots descriptions and amounts; corrections use credit/debit adjustments, not silent edits.

Outstanding = posted charges + approved debit adjustments - approved credits - settled payments + payment reversals/refunds that restore the obligation. A payment counts only after trusted confirmation or authorized offline posting. Overpayments need explicit credit handling; initially reject allocations beyond invoice balance. Never allocate across currencies. Unique provider event/reference and receipt IDs prevent duplicate credit.

Refund/adjustment requires reason and admin approval; finance executes approved operations with idempotency. Fees are never automatically used to block examination access in the initial product. Tax rules, late charges, discounts, refund policy and billing currency remain decision pending.


