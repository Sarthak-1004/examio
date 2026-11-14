# Roles and permissions

## Implemented model and gaps

`users.isPlatformAdmin` controls platform administration. Membership roles are `school_admin`, `teacher`, `student`, `parent`, `finance`; status is active/revoked. Multiple roles/memberships are possible. Parent and finance portals are not implemented; the finance role holds no finance capabilities until Phase 8.

Implemented capability layer (`packages/core/src/capabilities.ts`): school services call `withCapability`, which reads the caller's active roles from the database in the same transaction and denies by default. Current capabilities: `school.view` (all five roles), `school.member_counts.view` (school admin, teacher), `school.setup.view` (all five roles), `school.setup.manage` (school admin), `school.files.upload` (school admin, teacher), and for school admins only `school.members.view`, `school.accounts.recover`, `school.invitations.manage`, `school.support_access.view` and `school.audit.view`. Platform admins hold an explicit list: `school.view` and `school.members.view`.

A platform admin has platform access only after enrolling an authenticator app (two-step sign-in); this is enforced in the database. Platform admin scope: routine access covers schools, lookups, platform admins and school admins (onboarding and recovery). Any other school record requires an open support access grant for that school: at most 4 hours, with a reason, not extendable, written to the school's audit log and visible to its admins. The platform school list shows member totals as an aggregate only. A non-member or another school's identifier gets not-found; a member without the capability gets forbidden. Add a capability for every new service; do not test role names in services.

Current services support platform school/lookup management and self-service authentication. Services reject another school's identifier, and platform services require a signed-in platform admin that the database also recognises. Identity and membership writes are restricted in the database (task 01.1): no direct self-update, school admins manage only users exclusive to their school, cannot attach users of another school or platform admins, and cannot change membership roles or delete memberships. Current RLS still lets school admins/teachers read school users and memberships more broadly than future assignment-scoped requirements, and capabilities do not yet express assignment, ownership or guardian-link scope. Do not expose new CRUD based on RLS alone.

## Target authorization rules

Deny by default. Authenticate, verify active account, unsuspended school, membership, capability, assignment/ownership and record state on every server operation. Permissions from active roles may combine within the selected school; another school's roles never apply. A global platform role is not an automatic routine entitlement to student records: audited support access must be designed before production broad support tooling.

Scope keys: **school** = selected tenant; **assigned** = current authorized class/subject assignment; **own** = authenticated user's records; **child** = verified active guardian link. State restrictions apply even when a capability is granted.

## Target capability matrix

| Resource/action | Platform admin | School admin | Teacher | Student | Parent | Finance (planned) |
| --- | --- | --- | --- | --- | --- | --- |
| Schools create/status | Manage | View own school | View school context | View context | View linked context | View context |
| Global boards/mediums | Manage | Read | Read | No direct management | No | No |
| Academic setup | No routine edit | Create/edit/archive school | Read assigned | Read own schedule | Read child schedule | Minimum billing references |
| Student profiles/enrollment | Audited support only | Create/edit/archive school | Read assigned minimum fields | Read own | Read child permitted fields | Read billing minimum fields |
| Teacher records/assignments | Audited support only | Create/edit/revoke | Read own assignments | No staff records | No staff records | No |
| Global identity/privileges | Controlled platform process | Invite/link; no global privilege changes | Own verified profile only | Own permitted profile | Own verified profile | Own verified profile |
| Attendance | Audited support only | Read/write/lock/correct school | Read/write assigned within window | Read own | Read child | No |
| Homework/notices | No routine access | Manage school | Create/edit assigned | Read/submit own | Read child | Read targeted notices |
| Question bank/practice sets | No routine access | Manage school | Author assigned subjects | Released learner content only | Released child feedback only | No |
| Formal exams | No routine access | Draft/publish/cancel school | Draft assigned; no publish by default | Start eligible own | No taking attempts | No |
| Answers/grading | Audited support only | Review/grade school | Assigned grader only | Own permitted review | Released child result only | No |
| Offline marks entry | Audited support only | Create assessments; enter/lock/correct school | Enter assigned subject/section until lock | Read own released | Read child released | No |
| Result publication | No routine access | Release/correct with reason | Review assigned | Read own released | Read child released | No |
| Fee schedules/invoices | No routine access | Configure/approve school | No | No initial finance portal | Read/pay child invoice | Issue/read/reconcile school |
| Refund/adjustment | No routine access | Approve | No | No | Request through support | Request/execute approved |
| Audit/export | Platform events/support audit | School events and scoped exports | Assigned educational exports | Own released downloads | Child permitted downloads | Finance exports |

## Deletion and sensitive transitions

Draft records may be deleted only if unused and specifically authorized. Archive people/setup/questions instead of deleting referenced history. No hard deletion of attempts, released results, posted receipts or audits through ordinary UI. Revoke memberships/guardian links rather than erasing evidence. Personal-data erasure is a separate reviewed retention workflow.

Publication, promotion, suspension, fee reversal and post-release marks changes require server-side state validation and audit. Finance adjustments require distinct requester/approver identities when staffing permits; exceptions must be explicitly recorded and reviewed. Never allow users to promote themselves by editing membership roles, identity fields or tenant cookies.

