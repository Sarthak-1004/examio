# Business rules

Unless labeled implemented, rules are planned defaults for implementation and may be changed through an explicit documented product decision.

## Schools and identities

Implemented school statuses: onboarding, active, suspended. Current session loading accepts onboarding/active memberships and excludes suspended schools. Target: onboarding allows setup; student practice/exam starts require an active school. Define handling of existing attempts before suspension; preserve recorded answers and audit the decision.

School codes are unique lowercase alphanumeric, 2-12 characters. Global emails/usernames are unique when present; phones may be shared. Membership is school-specific and can be revoked. Never infer guardianship or merge accounts solely because a phone matches. Platform admin creates schools; schools manage their own profiles and memberships within explicit capabilities.

## Academic MIS

One current academic year per school; start date <= end date. School local dates govern attendance; UTC instants govern scheduled events. Year overlap policy is decision pending; do not silently prohibit legitimate overlapping administrative preparation.

Admission number is unique within school and stable across years. Initial model allows one active enrollment per student/year. Roll number is unique among active enrollments in a section. Promotion creates a new enrollment and closes the prior enrollment as appropriate; it never rewrites previous results. Transfers preserve history and record effective dates. Archive referenced classes/subjects rather than deleting them.

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

Percentage = final total / maximum x 100, rounded half-up to 2 decimal places for display; reject zero maximum at publication. Grade boundaries are configurable, nonoverlapping and evaluated against the unrounded percentage. Passing threshold and subject-specific requirements must be configured; do not assume a universal pass percentage.

Manual marks are between zero and item maximum. Release requires all required grading complete. Students/parents cannot see draft results. Post-release corrections create a new result revision, preserve earlier marks and require reason; notify affected recipients after commit. Rankings are off initially; any future ranking must specify ties and visibility.

Offline (paper) assessments record marks for exams not taken in Examio. Each assessment belongs to one academic year and subject, targets explicit sections and has a positive maximum. Every enrollment in a target section needs exactly one current entry: marks between zero and the maximum, or absent or exempt with no marks. Absent and exempt are distinct from zero. Only an assigned teacher of that subject and section, or a school admin, may enter marks. Entry lifecycle: draft -> submitted -> locked by admin -> released; locking requires a complete register. Changes after lock create a new revision with reason and preserve earlier marks. Percentage, grade and visibility follow the same rules as online results. How absent/exempt entries and assessment weightings affect report-card totals is decision pending.

## Fees

Amounts use integer minor units and explicit currency. Line total = quantity x unit amount - discount + tax; components cannot produce a negative line. Discounts/tax/rounding policy must be approved before issuance. An issued invoice snapshots descriptions and amounts; corrections use credit/debit adjustments, not silent edits.

Outstanding = posted charges + approved debit adjustments - approved credits - settled payments + payment reversals/refunds that restore the obligation. A payment counts only after trusted confirmation or authorized offline posting. Overpayments need explicit credit handling; initially reject allocations beyond invoice balance. Never allocate across currencies. Unique provider event/reference and receipt IDs prevent duplicate credit.

Refund/adjustment requires reason and admin approval; finance executes approved operations with idempotency. Fees are never automatically used to block examination access in the initial product. Tax rules, late charges, discounts, refund policy and billing currency remain decision pending.


