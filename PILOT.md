# Pilot onboarding

Status (2026-11-20): a checklist for bringing one pilot school onto Examio, prepared in Phase 15.5. No real school has been onboarded. Use it only on a production environment set up with the runbook in [DEPLOYMENT.md](DEPLOYMENT.md) and only after the readiness blockers in [TASKS.md](TASKS.md) (Phase 15, readiness review) are cleared. The free demo holds fake data only and must never receive real student records.

## Before the school starts (Examio team)

1. **Agreement.** Written agreement with the school on: the plan (modules, student limit, period, price), who may be contacted at the school, how data is handled and kept (retention and deletion policy, still to be agreed: see [SECURITY.md](SECURITY.md)), and how to raise problems.
2. **School record.** Platform admin → Add school: name, code (becomes the prefix of student sign-in names, cannot change), board, medium, time zone. Status stays *onboarding* until step 8.
3. **Plan.** On the school's page assign the plan with start and end dates; raise the first invoice (manual; payment recorded with its reference renews the period).
4. **First school administrator.** Created with the school; hand over the one-time code in person or by a verified phone call (the code is as safe as the hand-over). The administrator sets a password at `/redeem`; ask them to turn on the authenticator app (optional for school administrators, recommended).
5. **Support access.** Explain that the Examio team can look inside the school only through a support access grant with a reason and an end time, which the school's administrators see.

## Setting up the school (school administrator, with the Examio team)

Follow the setup checklist on the school's dashboard. In order:

1. **School profile and academic year.** Profile, the current academic year with dates, weekly off days, holidays in the calendar.
2. **Classes, sections and subjects.** Classes 1-12 as needed, sections with capacity, subjects, subjects per class, grading scheme (CBSE-style default available).
3. **Staff.** Add or import staff (CSV: name, employee number, email or mobile, role). Each receives a one-time code. Assign teachers to sections and subjects; set class teachers.
4. **Students.** Import the class lists (CSV: name, admission number, class, section, roll number, date of birth). Check the import preview and its row errors before confirming; a re-import of the same file is recognised. Hand student codes to class teachers for distribution.
5. **Parents.** Add parents on each student's page (or give parents the child-specific code to join with an existing account).
6. **Timetable and attendance sessions.** Periods per section (clashes are refused); attendance sessions (full day, or morning and afternoon).
7. **Modules in the plan.** As purchased: fee heads and structures (approved by a second administrator), library catalogue, inventory, transport routes, HR records, leave types, payroll components and salaries.
8. **Go live.** Platform admin marks the school *active*.

## First two weeks

- Day 1: administrators and teachers sign in; teachers take attendance; a notice to all classes.
- Week 1: homework and practice in a few classes; parents check they see their children.
- Before the first formal exam: a dry run with one class (start, save, submit, results released), on the production server, during school hours; confirm the load test was repeated on that server ([OPERATIONS.md](OPERATIONS.md)).
- Weekly 30-minute check-in with the school's administrator; record issues in the project tracker.

## Support during the pilot

- Report problems to the agreed contact with the page, the time and a screenshot without student details.
- Examio's on-call person watches the alert channel and `/admin/system`; incidents follow the playbooks in [OPERATIONS.md](OPERATIONS.md).
- Account recovery: the school administrator issues reset codes for their users; the platform admin does it for school administrators.

## Pilot success criteria (to agree with the school)

- Attendance taken daily in every section for two weeks.
- At least one formal exam completed with every attempt submitted and results released.
- No cross-school data exposure and no lost exam answers.
- Fees, library or other purchased modules used for their first real cycle.
- The school administrator can do routine tasks without the Examio team.
