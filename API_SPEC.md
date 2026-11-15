# API specification

## Implemented interface: Server Actions, not REST

No `/api/v1` endpoints exist today. Ten route handlers exist: `POST /payments/razorpay/webhook` (Razorpay; `X-Razorpay-Signature` HMAC-SHA256 of the raw body with `RAZORPAY_WEBHOOK_SECRET`, optional `X-Razorpay-Event-Id`; 200 `{ok, outcome}` for every verified event including duplicates, 400 for an invalid signature, 404 unless `PAYMENTS_PROVIDER=razorpay`) and `GET /school/fees/reports/export` (finance staff or school admin; `report=collections&from&to` or `report=defaulters`; audited CSV); `GET /school/attendance/reports/export` (school admin; `section`, `from`, `to`; section attendance CSV) and `GET /school/timetable/load/export` (school admin; `year`; teacher load CSV), both audited and not cached; `GET /school/students/export` (school admin; optional `q`, `year`, `section` (or `none`), `status` (`left`, `any`; default active); student list CSV) and `GET /school/students/reports/export` (school admin; optional `year`; class strength CSV), both audited, `Cache-Control: private, no-store`, 403 otherwise; `GET /school/staff/export` (session cookie, school admin of the selected school; optional `q`, `status`, `role` as on the staff page; returns `text/csv` as an attachment, `Cache-Control: private, no-store`; audited; 403 otherwise), `GET /files/{id}` (session cookie; authorized download with `Content-Disposition: attachment`, `nosniff`, `Cache-Control: private, no-store` and `Content-Security-Policy: default-src 'none'; sandbox`; 401/404/409) `GET|POST /internal/worker` (`Authorization: Bearer <CRON_SECRET>`; runs one round of background work and returns `{claimed, succeeded, retried, dead}`; 401 on a wrong secret, 404 when `CRON_SECRET` is unset) and `GET /health` (public; `{"status":"ok"}` 200 or `{"status":"unavailable"}` 503). First-party mutations use Next.js Server Actions; their generated transport identifiers are not stable public API contracts. Session cookies authenticate requests; each protected action must perform its own authorization.

| Action | Input FormData fields | Success |
| --- | --- | --- |
| `loginAction` | identifier, password | Set session cookie, clear school cookie, redirect `/`; with two-step sign-in the cookie holds a pending session and the redirect is `/mfa` |
| `retryJobAction` | jobId | Platform admin. Put a dead-lettered job back in the queue; already retried counts as success |
| `markNotificationReadAction` | notificationId | Mark one of your own notices read |
| `verifyMfaAction` | code (app code or backup code) | Complete the pending sign-in, redirect `/` |
| `beginMfaAction` | none | Privileged user. Returns the setup key once in form state (`mfaSecret`, `mfaUri`) |
| `confirmMfaAction` | code | Confirms enrolment; returns backup codes once (`recoveryCodes`) |
| `disableMfaAction` | code | School admin turns two-step sign-in off; refused for platform admins |
| `logoutAction` | none | Delete current session/cookies, redirect `/login` |
| `changePasswordAction` | currentPassword, newPassword, confirmPassword | Change password, revoke other sessions, redirect home with `pw=changed` |
| `selectSchoolAction` | schoolId | Set allowed school preference, redirect `/` |
| `createSchoolAction` | name, code, boardId, mediumId, timezone, address, contactEmail, contactPhone, adminName, adminEmail, adminPhone, adminPassword | Create school/admin, redirect detail |
| `setSchoolStatusAction` | schoolId, status | Update status, revalidate pages |
| `addLookupAction` | kind (board/medium), name | Revalidate settings, return success state |
| `toggleLookupAction` | kind, id, active | Update lookup/revalidate |
| `redeemCodeAction` | code, newPassword, confirmPassword | Public. Redeem a one-time code, set password, end all sessions, redirect `/login?reset=1` |
| `acceptInvitationAction` | code | Signed-in user joins the inviting school, school cookie set, redirect `/` |
| `issueResetCodeAction` | userId, reason | Platform admin. Returns the one-time code once in form state (`code`, `codeExpires`) |
| `startSupportAccessAction` | schoolId, reason | Platform admin. Open a 1-hour support grant, revalidate school page |
| `endSupportAccessAction` | grantId, schoolId | Platform admin. End own grant; already-ended is treated as success |

School setup (Phase 3, `apps/web/app/school/setup/actions.ts`; school admin, `school.setup.manage`): `saveProfileAction`, `createYearAction`, `updateYearAction`, `setYearStatusAction`, `deleteYearAction`, `copyYearAction`, `createClassAction`, `addStandardClassesAction`, `updateClassAction`, `createSectionAction`, `archiveItemAction`, `deleteItemAction`, `createSubjectAction`, `renameSubjectAction`, `setClassSubjectsAction`, `createGradingSchemeAction`, `createPresetSchemeAction`, `setDefaultSchemeAction`, `archiveSchemeAction`, `addCalendarEntryAction`, `deleteCalendarEntryAction`, `createSessionAction`, `archiveSessionAction`.

Staff (Phase 4, `apps/web/app/school/staff/actions.ts`; school admin, `school.staff.manage` unless noted): `createStaffAction` (returns the activation code once in `code`), `addProfileForMemberAction`, `updateStaffAction`, `markLeftAction` (reason required), `reactivateAction`, `issueStaffCodeAction` (activation or reset code, once) and `signOutEverywhereAction` (both `school.accounts.recover`), `assignAction`, `classTeacherAction`, `endAssignmentAction`, `inviteAction` and `revokeInvitationAction` (`school.invitations.manage`), `previewImportAction` (nothing saved; returns rows, errors, a fingerprint and an idempotency key) and `commitImportAction` (text, fingerprint, key; all rows or none; a repeat returns the first result without codes). Each action derives the school from the session and re-checks the capability in the service.

Students (Phase 5, `apps/web/app/school/students/actions.ts`; school admin, `school.students.manage` unless noted): `admitStudentAction` (returns the activation code once in `code` and the sign-in name in the message), `addStudentProfileAction`, `updateStudentAction`, `enrollAction`, `changeSectionAction`, `correctEnrollmentAction`, `setRollAction`, `numberRollsAction`, `markStudentLeftAction`, `readmitAction`, `issueStudentCodeAction` and `signOutStudentAction` (`school.accounts.recover`), `createGuardianAction`, `linkGuardianAction`, `guardianCodeAction` and `revokeGuardianAction` (`school.guardians.manage`; the code action also needs `school.invitations.manage`), `uploadDocumentAction` (upload with purpose `student_document`, then attach) and `removeDocumentAction`, `promoteAction` (fromSectionId, toSectionId or `graduate`, studentIds[], keepRollNumbers), `previewStudentImportAction` (file or text, yearId; nothing saved; returns mapping, rows with errors and warnings, fingerprint, idempotency key) and `commitStudentImportAction` (text, yearId, fingerprint, key; all rows or none; a repeat returns the first counts without codes). `createMembershipInvitation` accepts `studentId` and `relationship`, required for parent invitations.

Attendance and timetable (Phase 6): `submitRegisterAction` (`apps/web/app/school/attendance/actions.ts`; school admin or teacher, `school.attendance.mark`; sectionId, sessionId, date, version, enrollment[] with `status-<id>` and `note-<id>`, reason), `attendanceSettingsAction` (school admin, `school.attendance.manage`; editDays, weeklyOff[], lockedThrough), `addSlotAction` and `removeSlotAction` (`apps/web/app/school/timetable/actions.ts`; school admin, `school.timetable.manage`).

Homework and notices (Phase 7): `createHomeworkAction` (sectionIds[], subjectId, title, instructions, dueAt as local `YYYY-MM-DDTHH:MM`, allowLate, files[] uploaded as `homework_attachment`), `updateHomeworkAction`, `archiveHomeworkAction`, `remindHomeworkAction`, `feedbackAction` (`apps/web/app/school/homework/actions.ts`; school admin or teacher, `school.homework.manage`); `publishNoticeAction` and `archiveNoticeAction` (`apps/web/app/school/announcements/actions.ts`; `school.announcements.publish`); `submitHomeworkAction` (`apps/web/app/student/homework/actions.ts`; student, `school.homework.submit`; homeworkId, body, files[] uploaded as `homework_submission`). File uploads go through `lib/uploads.ts`, which is not a server action.

Fees (Phase 8): `apps/web/app/school/fees/actions.ts` (school admin or finance; approvals and invoice cancellation need `school.fees.approve`): `createHeadAction`, `archiveHeadAction`, `createStructureAction`, `addItemAction`, `removeItemAction`, `approveStructureAction`, `archiveStructureAction`, `issueAction` (structureId, dueOn), `recordPaymentAction` (invoiceId, amount in rupees, method, reference, key for idempotency), `requestConcessionAction`, `revokeConcessionAction`, `requestAdjustmentAction`, `decideAction` (type, id, decision), `cancelInvoiceAction`, `lateFeesAction`, `remindersAction`, `reconcileAction`. `apps/web/app/parent/fees/actions.ts` (parent, `school.fees.pay`): `startPaymentAction` (invoiceId; returns the provider order: id, amount, Razorpay key id) and `completeSandboxAction` (sandbox only; paymentId, outcome). Environment: `PAYMENTS_PROVIDER` (sandbox | razorpay), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; production refuses the sandbox.

Question bank (Phase 9, `apps/web/app/school/questions/actions.ts`; school admin or teacher, `school.questions.manage`; publish/send back/archive need `school.questions.publish`): `createQuestionAction` (subjectId, topicId, type, difficulty, stem, option0-option5, correct, modelAnswer, explanation, marks, negativeMarks, image file; `submit=1` to submit; redirects to the question), `updateQuestionAction` (questionId, the same fields, currentImageId, removeImage), `questionStateAction` (questionId, op = submit | publish | sendBack | archive | restore), `createChapterAction`, `createTopicAction`, `renameTopicAction`, `archiveTopicAction`, `previewQuestionImportAction` (file or text, createMissing, submit) and `commitQuestionImportAction` (text, createMissing, submit, fingerprint, key). `ActionForm` now sends the clicked submit button's name and value.

Implemented form response:

```ts
interface FormState {
  ok?: boolean;
  message?: string;
  fields?: Record<string, string>;
  values?: Record<string, string>; // password-named fields excluded
}
```

Expected `AppError` codes: INVALID_CREDENTIALS, AMBIGUOUS_LOGIN, ACCOUNT_DISABLED, FORBIDDEN, NOT_FOUND, CONFLICT, VALIDATION. Form conversion currently returns message/fields, not the code. Unexpected exceptions are rethrown. Status/toggle actions do not yet use the same form-error contract.

Current validation: school code lowercase alphanumeric 2-12; name 3-200; UUID board/medium; admin name 2-200; at least email or phone; password 8-128; lookup name 2-80. Login has no equivalent server password-length bound yet. Timezone currently only requires nonempty text. Strengthening these is planned.

## Planned HTTP conventions

The routes below are proposed contracts for Phases 3-12, not an instruction to replace every Server Action. Implement only where needed, calling the same core services. Base `/api/v1`. JSON request/response, UTF-8; IDs UUID, timestamps ISO-8601 UTC, dates YYYY-MM-DD, marks decimal strings, money minor units decimal strings plus currency. Server obtains identity from session and validates every path school ID against authorization.

Unsafe cookie-authenticated HTTP handlers require same-origin/CSRF protection. Do not enable wildcard credentialed CORS. Public integration auth is a separate future design.

Success: `{ "data": {...}, "meta": { "requestId": "..." } }`. Lists add `nextCursor` (nullable). `limit` defaults 25, max 100; opaque cursor, stable `(created_at,id)` order unless documented otherwise; allowlist filters/sorts.

Errors:

```json
{"error":{"code":"VALIDATION","message":"Check the highlighted fields.","fields":{"name":"Required"},"requestId":"req_..."}}
```

| HTTP | Codes / behavior |
| --- | --- |
| 400 | VALIDATION, malformed JSON/UUID/unknown enum |
| 401 | UNAUTHENTICATED, INVALID_CREDENTIALS |
| 403 | FORBIDDEN, ACCOUNT_DISABLED; avoid disclosing inaccessible object details |
| 404 | NOT_FOUND; use for inaccessible tenant objects where existence is sensitive |
| 409 | CONFLICT, VERSION_CONFLICT, ATTEMPT_CLOSED, IDEMPOTENCY_CONFLICT |
| 413 / 415 | PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE |
| 429 | RATE_LIMITED, Retry-After header |
| 500 / 503 | INTERNAL_ERROR / SERVICE_UNAVAILABLE; safe message, request reference, no stack/SQL |

Create returns 201; read/update 200; background work 202 with job reference; deletion/archive 200 with final state. Planned new codes must be added to shared types when implemented.

## Proposed endpoint catalog

Paths below are relative to `/api/v1`; school-scoped paths start `/schools/{schoolId}`. Permissions follow [ROLES_PERMISSIONS.md](ROLES_PERMISSIONS.md).

| Method/path | Request | Response / checks |
| --- | --- | --- |
| GET/POST `/schools/{schoolId}/academic-years` | POST name, startsOn, endsOn | Year/list; school admin writes; valid dates, scoped unique name |
| GET/POST `/schools/{schoolId}/students` | POST profile + enrollment IDs | Student/list; scoped admission uniqueness; same-school relations |
| GET/PATCH `/schools/{schoolId}/students/{id}` | PATCH editable profile fields, version | Scoped profile; immutable identity privileges excluded |
| POST `/schools/{schoolId}/imports` | kind, authorized fileId, mapping | 202 import job; dry-run first; limits and duplicate detection |
| GET `/schools/{schoolId}/imports/{id}` | none | Counts, status, authorized error report reference |
| POST `/schools/{schoolId}/imports/{id}/commit` | previewVersion, policy | 202 job; reject stale preview; idempotent |
| POST `/schools/{schoolId}/promotions` | fromYearId, toYearId, student/section mapping, previewVersion | Job/report; preserve historical enrollment |
| GET/PUT `/schools/{schoolId}/attendance` | PUT sectionId, date, sessionKey, entries, version | Register; teacher assignment/date lock/unique entries |
| GET/POST `/schools/{schoolId}/homework` | POST sectionId, subjectId, title, instructions, dueAt | Assignment/list; assignment scope |
| POST `/schools/{schoolId}/homework/{id}/submissions` | fileIds, text?, version | Own submission; file ownership/deadline policy |
| POST `/schools/{schoolId}/files/upload-intents` | purpose, mimeType, byteSize, filename | Short-lived upload URL/fileId; quarantine until validated |
| GET `/schools/{schoolId}/files/{id}/download` | none | Short-lived authorized download; scan status required |
| GET/POST `/schools/{schoolId}/invoices` | POST studentId, currency, line snapshots | Invoice/list; finance/admin; idempotency required |
| POST `/schools/{schoolId}/invoices/{id}/payments` | method, amountMinor, currency, reference | Receipt or pending provider payment; no trust in browser paid flag |
| POST `/schools/{schoolId}/invoices/{id}/adjustments` | amountMinor, reason, type | Pending approval; cannot silently rewrite ledger |
| POST `/schools/{schoolId}/adjustments/{id}/approve` | version, reason | Approved adjustment; authorized approver |
| POST `/schools/{schoolId}/adjustments/{id}/execute` | version | Reversal/refund result or pending job; exactly-once business effect |
| GET/POST `/schools/{schoolId}/questions` | POST subject/topic/type/content/key/explanation/difficulty | Authoring representation; keys never in learner response |
| POST `/schools/{schoolId}/questions/{id}/versions` | revised content/key, baseVersion | New immutable revision |
| POST `/schools/{schoolId}/practice-sets/{id}/attempts` | optional clientRequestId | Eligible attempt, learner question DTO without key |
| PUT `/schools/{schoolId}/practice-attempts/{id}/answers/{questionId}` | response, revision | Acknowledged revision; own active attempt |
| POST `/schools/{schoolId}/practice-attempts/{id}/submit` | version | Stable result/feedback per policy |
| GET/POST `/schools/{schoolId}/exams` | POST title, subjectId, targets, items, schedule, durationSeconds, scoringPolicy | Draft/list; assigned teacher/admin |
| POST `/schools/{schoolId}/exams/{id}/publish` | version | Fixed exam version; admin; validate content/targets/schedule |
| POST `/schools/{schoolId}/exams/{id}/attempts` | clientRequestId | Existing/new own attempt, deadlineAt, serverTime, questions |
| GET `/schools/{schoolId}/attempts/{id}` | none | Own acknowledged state or assigned grading representation |
| PUT `/schools/{schoolId}/attempts/{id}/answers/{itemId}` | response, revision | savedRevision, savedAt, deadlineAt; reject stale/late writes |
| POST `/schools/{schoolId}/attempts/{id}/submit` | version | Stable submission receipt; repeats return same outcome |
| PUT `/schools/{schoolId}/answers/{id}/grade` | marks, reason, version | Grading revision; assigned grader, bounds validation |
| POST `/schools/{schoolId}/exams/{id}/results/publish` | batchVersion | Published batch; admin; no unresolved grading |
| GET `/schools/{schoolId}/results/{id}` | none | Released own/child result or authorized staff view |
| GET/POST `/schools/{schoolId}/offline-assessments` | POST title, academicYearId, subjectId, sectionIds, assessmentDate, maximumMarks | Draft/list; admin creates; assigned teacher reads own |
| PUT `/schools/{schoolId}/offline-assessments/{id}/marks` | entries[] of enrollmentId, entryStatus, marks?; version | Saved register revision; assigned teacher/admin; bounds and target-section validation; reject stale version |
| POST `/schools/{schoolId}/offline-assessments/{id}/lock` | version | Locked register; admin; requires an entry for every enrollment |
| POST `/schools/{schoolId}/offline-assessments/{id}/results/publish` | version | Released marks; admin; locked register only |
| POST `/webhooks/payments/{provider}` | Provider-signed raw payload | Acknowledgement after durable event capture; verified signature, deduplicated event |

Academic setup, assignments, timetable and notices may initially remain Server Actions. They must follow the same validation, authorization and domain contracts; no undocumented HTTP endpoints should be introduced.

## Retry and concurrency contracts

Creation of invoices, payments, attempts, imports and submissions uses `Idempotency-Key`; unique per school/actor/operation. Same key + same payload returns original outcome; changed payload returns 409. Retention must exceed provider/client retry windows; payment event deduplication persists with financial history.

For answer saves, `revision` is the client's expected current revision (initial 0). Successful conditional write increments it. Replaying a stale revision returns 409 with current revision; the client must reconcile rather than overwrite blindly. Submission locks/finalizes the attempt transactionally; no answer writes after closure.

Example planned save:

```json
{"response":{"selectedOptionIds":["option-a"]},"revision":3}
```

```json
{"data":{"savedRevision":4,"savedAt":"2026-11-13T10:30:00Z","deadlineAt":"2026-11-13T11:00:00Z"},"meta":{"requestId":"req_example"}}
```

Reset/invitation endpoints are not yet defined as HTTP routes; their planned pages may use Server Actions. They must use generic reset acknowledgements and hashed, single-use, expiring tokens as described in [AUTHENTICATION.md](AUTHENTICATION.md).

