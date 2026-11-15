# Security

This is an engineering baseline, not a claim of regulatory certification. Product data includes children's records, guardian contacts, grades and financial information. Data jurisdiction, retention and contractual obligations require decisions before production collection.

## Threat model and trust boundaries

Treat browsers, route IDs, cookies, uploaded files, imported rows and webhook payloads as untrusted. Relevant threats: cross-school record access, role escalation, shared-identity takeover, session theft, answer-key leakage, answer loss/tampering, duplicate financial effects, malicious files and operational data loss.

Server authenticates and authorizes each operation. RLS trusts server-set user/school/platform context: it does not protect against arbitrary SQL execution using the app credential. Owner credentials bypass RLS and must be isolated from runtime. The browser never selects platform privileges.

## Existing controls

- scrypt password hashes, random session tokens stored hashed, secure production HTTP-only SameSite cookies.
- Server-side role guards; tenant transactions and PostgreSQL membership policies.
- Service scope guards: school services reject another school's identifier and malformed identifiers before querying; platform services require a signed-in platform admin.
- Platform access is verified in the database: the transaction flag counts only when the acting user is an active platform administrator. A forged flag grants nothing.
- School roles require an active membership, an active account and a school that is not suspended, checked in the database on every statement.
- Identity writes: no direct self-update; a school admin can change only users who belong to that school alone and are neither school admins nor platform admins. Platform admins cannot be created, promoted or edited through the runtime role.
- Membership grants: a school admin can add only active, non-platform users with no active membership in another school; school, user and role are immutable; memberships are revoked, not deleted.
- Least-privilege runtime role: per-table grants with no DELETE on users, memberships, schools, lookups or audit events; `users.password_hash` is not selectable; helper functions are not executable by PUBLIC. `pnpm db:migrate` verifies the role is not a superuser, BYPASSRLS or table owner, and the web server refuses to start on such a role.
- Sessions are protected by RLS (own rows only); lookup by token hash uses a reviewed SECURITY DEFINER helper.
- School status, board and medium can be changed only by a platform admin (database trigger); school code is immutable for the runtime role.
- Schema/foreign-key constraints; Zod validation for current school and password forms.
- Password changes invalidate other sessions; disabled accounts and suspended school filtering.
- Append-only app audit policies for covered events.
- Frame denial, nosniff and referrer-policy headers; Next.js Server Actions used for mutations.
- Shared rate limits stored in PostgreSQL, enforced inside the sign-in and password-change services: failed attempts are limited per account, per account and address, and per address; only hashed keys are stored; phone formats and letter case share one account key; known and unknown identifiers are limited identically.
- Sign-in input is bounded (identifier 254, password 128 characters) before hashing or lookup. The client address is taken from `X-Forwarded-For` only at the position written by a configured trusted proxy (`TRUSTED_PROXY_HOPS`); client-supplied entries are ignored.
- Capability checks: school services run through `withCapability`, which reads the caller's active roles from the database in the same transaction and denies by default.
- Account activation and recovery by single-use codes: 80 random bits, stored only as hashes, redeemed atomically, cancelled by a newer code, expiring, and ending all sessions on use. Issuing requires a recorded reason. Membership invitations give shared identities a consented link to a second school.
- Session limits: 7 days idle, 30 days absolute; sessions can be revoked by the user or by whoever may recover the account.
- Platform support access: a platform admin routinely sees only schools, lookups, platform admins and school admins. Other school records need a grant for that one school, limited to 4 hours, not extendable, recorded in the school's audit log and visible to its admins.
- Two-step sign-in with an authenticator app: required for platform admins (enforced in the database), optional for school admins; codes accepted once; single-use backup codes; secrets encrypted at rest with a key outside the database.
- Platform administrators are created only by an operator command using the owner credential; it never handles a password and never promotes an existing account.
- Private files: type detected from bytes with matching extension, size limits, safe names, quarantine until a scanner marks them clean, checksum verified on download, forced-download headers with a sandboxing CSP, visibility enforced by RLS, and exports that expire.
- Disposable-database guard on every destructive script and test fixture; browser tests use their own database.
- Redacting structured logs; job errors are redacted before storage; job payloads carry identifiers only.
- Secrets excluded by `.gitignore`; form echoes omit password-named fields.

## Known gaps / release blockers

| Gap | Required treatment |
| --- | --- |
| Unverified identity creation | A school admin can create an account with any unused email/username; require verified invitations (01.2) and separate tenant profiles (Phases 4-5) |
| Teacher reads are school-wide | Introduce assignment-scoped services/policies before exposing rosters and learner data |
| Runtime credential compromise | RLS trusts the server-set context: whoever holds the application database credential can set any user context, including a platform admin with a self-opened grant. Protect the credential; MFA does not mitigate this |
| Capabilities cover roles only | Assignment, ownership and guardian-link scope are enforced by database policies (Phases 4-6: `app_teaches_section`, `app_teaches_student`, `app_is_guardian_of`, `app_can_write_attendance`, `app_can_see_homework`, `app_can_see_submission`); later modules must use them, and every new service must declare a capability |
| Account lockout by an attacker | With no trusted proxy configured only the per-account limit applies, so repeated failures can block a known account for the window; set `TRUSTED_PROXY_HOPS` for the hosting setup and review limit values before pilot |
| MFA key management | `MFA_ENCRYPTION_KEY` has no rotation procedure; losing or changing it forces every enrolled user to recover. School admins are not required to enrol |
| Hand-out codes rely on the school | A code is as safe as the hand-over. Schools need a written verification practice; the audit log records issuer and reason but cannot prove who received the code |
| Runtime role is cluster-wide | `examio_app` is shared by databases on one cluster; separate clusters/credentials per environment and review grants on the target infrastructure |
| No real malware scanner running | ClamAV adapter exists but no daemon is deployed; development uses `dev-allow` (no scanning). Staging/production refuse to start without clamav |
| Worker context is trusted | `app.worker` is server-set context like the other `app.*` settings; a stolen runtime credential can set it |
| No payment infrastructure | Signed/deduplicated webhooks before enabling payments (Phase 8) |
| No production runbooks verified | Restore rehearsal, monitoring, redaction, environment segregation and incident access controls |

These are code-review findings and requirements, not claims that an end-user exploit has been demonstrated.

## Required development controls

Validate all inputs server-side; parameterize SQL; escape rendered content; sanitize rich text through a reviewed allowlist. Never use raw HTML from users without sanitization. Prohibit unsafe object storage paths and unbounded file/body sizes. Check assignment/ownership and record state after authentication. Use same-school FKs as well as RLS. Review SECURITY DEFINER functions for fixed search_path, narrow behavior and execution grants.

Do not send answer keys, unreleased marks, password hashes or full identity records to learner clients. Prevent authenticated response caching across users/tenants. Exports require the same scope checks as screen reads and expiring download access. Neutralize spreadsheet formula injection in exported/import-preview text.

Add CSRF/origin protection to future cookie-authenticated HTTP handlers. Configure CSP after testing actual asset requirements; evaluate HSTS once HTTPS/domain operation is verified. No blanket credentialed CORS. Audit dependencies and lockfile changes using tooling selected for CI; no security scanner is currently configured.

## Secrets, transport and data

Use environment secret management in hosted environments, TLS for browser/database/provider connections, encrypted storage/backups and least-privilege service identities. Never bundle secrets in `NEXT_PUBLIC_*`. Do not log raw tokens, reset links, passwords, database URLs, answer content, complete contacts or payment payloads. Keep synthetic fixtures separate from live data. Rotate exposed secrets and revoke affected sessions.

Collect minimum data necessary. Retention periods and deletion approvals are decision pending; until agreed, do not promise automatic erasure or indefinite retention. Erasure workflows must reconcile academic/financial history requirements and backups without silently corrupting records.

## Security acceptance

Every protected module passes unauthenticated, wrong-role, wrong-school, wrong-assignment/child and invalid-state tests. Include shared users, revoked memberships, suspended schools, forged identifiers, request retries and concurrency. Security-sensitive failures block release. Escalate incidents using [OPERATIONS.md](OPERATIONS.md); never include sensitive evidence in public issue descriptions.
