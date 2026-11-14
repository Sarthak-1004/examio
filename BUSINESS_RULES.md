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

Initial attendance statuses: present, absent, late, excused; not recorded is distinct from absent. Attendance session configuration is per school. Unique record per enrollment/local date/session. Only eligible enrolled students belong on the register. Admin controls lock/correction window; corrections require actor/time/reason.

Default attendance percentage = (present + late) / (present + late + absent) x 100; excused and not-recorded entries are excluded. Zero denominator displays N/A, not 0%. Schools may adopt a different versioned policy; reports identify policy and missing records.

Timetable slots cannot overlap for a section, teacher or assigned room on the same applicable day. Homework due time uses school timezone; late submission is flagged and allowed only if the published assignment policy permits it. Files remain unavailable until validation/scan succeeds.

## Practice

Practice is separate from formal grading. Default is unlimited attempts, immediate feedback after submission, and access only to assigned/published sets. School may set a finite positive limit and delayed feedback. Preserve question versions and attempt history. Topic progress reports must show sample size; no mastery claim from insufficient data.

## Formal examinations

Lifecycle: draft -> published -> closed -> grading -> results released; cancellation is an explicit audited alternative. Publication freezes content, marks, targets and timing. New content requires a new version; active attempts retain their original version. Admin publishes by default; teacher drafts/grades only assigned subjects.

Start requires active school/account/membership, eligible enrollment, published target and server time within `[opens_at, closes_at)`. Default one attempt; retakes require explicit configured limit/authorization. Allocate attempts transactionally to prevent concurrent starts exceeding limits.

Deadline = minimum(started_at + duration, closes_at), except an explicit per-student accommodation approved before start. No automatic extension for disconnects. Server time is authoritative. Accept answer writes only for active attempts before deadline; validate question belongs to that exam version. Duplicate submission returns the original receipt. Deadline worker finalizes acknowledged answers; unsent browser edits cannot be represented as saved.

Cancellation, disruption and accommodations need an admin workflow with reason and affected attempts. Product decisions on retake grading policy and accommodations remain pending; initial default result uses the first authorized attempt, with any replacement explicitly designated and audited.

## Scoring and results

Initial objective types: single choice and true/false; descriptive manual grading follows in Phase 12. Multi-select partial credit requires a separate explicit scoring policy before enabling it. Correct objective answer earns item marks; wrong answer earns negative penalty if configured, otherwise zero; unanswered earns zero. Penalty is nonnegative and no greater than item marks. Default total is floored at zero after summation; maximum = sum of positive item marks.

Grading schemes (implemented, Phase 3): each has a pass mark and grade bands defined by their minimum percentage; a band covers its minimum up to the next band's minimum and the top band includes 100%. One band must start at 0%, so every percentage gets exactly one grade; minimums and grade names are unique within a scheme. Values are stored as basis points (hundredths of a percent), so comparisons are exact. One active scheme is the school's default (the first one created); the default cannot be archived. A CBSE-style preset (A1 91%, A2 81%, B1 71%, B2 61%, C1 51%, C2 41%, D 33%, E 0%; pass 33%) is offered as an editable starting point; no universal scale is assumed.

Percentage = final total / maximum x 100, rounded half-up to 2 decimal places for display; reject zero maximum at publication. Grade boundaries are configurable, nonoverlapping and evaluated against the unrounded percentage. Passing threshold and subject-specific requirements must be configured; do not assume a universal pass percentage.

Manual marks are between zero and item maximum. Release requires all required grading complete. Students/parents cannot see draft results. Post-release corrections create a new result revision, preserve earlier marks and require reason; notify affected recipients after commit. Rankings are off initially; any future ranking must specify ties and visibility.

Offline (paper) assessments record marks for exams not taken in Examio. Each assessment belongs to one academic year and subject, targets explicit sections and has a positive maximum. Every enrollment in a target section needs exactly one current entry: marks between zero and the maximum, or absent or exempt with no marks. Absent and exempt are distinct from zero. Only an assigned teacher of that subject and section, or a school admin, may enter marks. Entry lifecycle: draft -> submitted -> locked by admin -> released; locking requires a complete register. Changes after lock create a new revision with reason and preserve earlier marks. Percentage, grade and visibility follow the same rules as online results. How absent/exempt entries and assessment weightings affect report-card totals is decision pending.

## Fees

Amounts use integer minor units and explicit currency. Line total = quantity x unit amount - discount + tax; components cannot produce a negative line. Discounts/tax/rounding policy must be approved before issuance. An issued invoice snapshots descriptions and amounts; corrections use credit/debit adjustments, not silent edits.

Outstanding = posted charges + approved debit adjustments - approved credits - settled payments + payment reversals/refunds that restore the obligation. A payment counts only after trusted confirmation or authorized offline posting. Overpayments need explicit credit handling; initially reject allocations beyond invoice balance. Never allocate across currencies. Unique provider event/reference and receipt IDs prevent duplicate credit.

Refund/adjustment requires reason and admin approval; finance executes approved operations with idempotency. Fees are never automatically used to block examination access in the initial product. Tax rules, late charges, discounts, refund policy and billing currency remain decision pending.


