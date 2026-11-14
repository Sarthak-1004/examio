# Authentication

## Implemented behavior

There is no public self-registration. A platform admin creates a school and its first school administrator. Development seeding creates the initial platform admin and fake school accounts; a production bootstrap flow is not implemented.

Login accepts normalized email, username or phone. Phone numbers are not unique because family members may share them. If more than one matching account has the supplied password, login asks for a username. Unknown identifiers and wrong passwords return the same credentials error; unknown users perform a dummy password verification. Disabled users cannot sign in.

Sign-in is rate limited inside the `login` service using counters shared through PostgreSQL. Only failed attempts count: a successful sign-in gives its own attempt back and never clears earlier failures. Limits per 10 minutes (provisional): 8 failures per account and client address, 30 per account, 300 per client address. The account key is canonical: every format of a phone number, and any letter case or Unicode width of an email or username, share one counter. The client address is used only when `TRUSTED_PROXY_HOPS` identifies it; otherwise address limits are skipped. Identifiers longer than 254 characters and passwords longer than 128 are rejected as invalid credentials before any lookup. Changing a password allows 8 failed current-password checks per user per 10 minutes.

Passwords use Node scrypt with random 16-byte salt, N=32768, r=8, p=1, 32-byte derived key, and 64MB max memory. Passwords are NFKC-normalized before hashing. Hash format embeds algorithm/parameters/salt/key. Password creation/change validation accepts 8-128 characters; login enforces the same upper bound. Do not change normalization or hash format without backward compatibility.

Sessions use a random 32-byte base64url token. Only its SHA-256 hash is stored in PostgreSQL. The sessions table is protected by RLS: a row is visible and writable only in its own user's context. Lookup by token hash, which happens before the user is known, goes through the SECURITY DEFINER helper `auth_session_lookup`. Session TTL is 7 days; validation renews database expiry when fewer than 3.5 days remain. The session cookie `examio_session` is HTTP-only, SameSite=Lax, path `/`, Secure in production, and has a fixed 30-day maxAge. The cookie is not refreshed during validation, so its lifetime can end an otherwise renewed DB session. This discrepancy must be resolved deliberately before documenting indefinite sliding login.

`examio_school` is an HTTP-only school preference cookie with the same options. It is validated against memberships; it is never proof of permission. User status and active memberships are loaded on validation; suspended schools are omitted. User roles select `/admin`, `/school`, `/student`, `/select-school`, or `/no-access`. Parent-only users currently reach no-access.

New school admins must change their password. `requireSession` routes such users to the change-password page. Changing password requires the existing password and revokes all other sessions; current session remains. The runtime database role cannot select `password_hash` or update its own user row: the signed-in user's hash is read and replaced only through `auth_own_password_hash` and `auth_set_own_password`, and login uses `auth_find_login`.

Identity management rules enforced in the database: a school admin can create users and add them to their own school, and can change the profile, credentials or status only of users who belong to that school alone and are not school or platform admins. A user shared with another school can be revoked from a school but not edited by either school. Platform admins cannot be created or promoted through the application.

Logout deletes the current session and both cookies.

## Two-step sign-in (implemented)

Decision 2026-11-14: authenticator app. Required for platform administrators, optional for school administrators, not available to other roles.

Codes are standard time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), implemented with Node's crypto module and no added dependency. The previous and next step are accepted to tolerate clock drift. Each step is accepted once: the database refuses a step that is not newer than the last accepted one, so a code cannot be replayed, even concurrently. Wrong codes are limited to 5 per user per 10 minutes.

Enrolment at `/mfa/setup`: the server creates a 160-bit secret, shows it once as a setup key (and an `otpauth://` link), and enforces nothing until the first correct code confirms it. Confirmation returns ten single-use backup codes, shown once and stored as hashes. Secrets are encrypted with AES-256-GCM under `MFA_ENCRYPTION_KEY` before storage in `user_mfa`, which the runtime role cannot read directly.

Sign-in: after a correct password, an enrolled account gets only a pending session (10 minutes) that authenticates nothing. `/mfa` asks for the app code or a backup code and turns the pending session into a real one.

Platform administrators: the database function `app_is_platform_admin` is false until the account has a confirmed authenticator, so an un-enrolled platform admin has no platform access anywhere; the web app sends them to `/mfa/setup`. They cannot turn it off. School administrators can turn it off with a current code.

Lost device: use a backup code. Without one, an account reset code removes the authenticator along with the password: a platform admin issues it for a school admin; for a platform admin an operator runs `pnpm admin:bootstrap --recover`.

## Activation, recovery and invitations (implemented)

Decision 2026-11-13: no email or SMS. Codes are handed over by the school.

**One-time account codes.** A code lets a user choose their own password, either for a new account (activation, valid 48 hours) or after forgetting it (reset, valid 24 hours). A school admin issues codes for users their school alone manages; a platform admin issues them for school admins, and for other users only under open support access. The issuer must give a reason, which is written to the audit log with the issuer. Issuing a code cancels any earlier outstanding code for that user and changes nothing else until it is redeemed.

A code is 16 characters (80 random bits), shown once to the issuer and stored only as a SHA-256 hash in `account_tokens`, which the runtime role cannot read. It is redeemed at the public page `/redeem` together with a new password. Redemption is a single database statement that claims the code, so replayed or concurrent attempts cannot both succeed; it sets the password, clears `must_change_password`, ends every session of the user and cancels their other codes. Unknown, used, expired and cancelled codes fail with the same message. Typing is forgiving: case, spaces and hyphens are ignored and O/I/L are read as 0/1/1.

**Membership invitations.** To link someone who already has an account (for example a teacher or parent at another school), a school admin creates an invitation for a role other than school admin and hands over its code (valid 48 hours). The person signs in and enters it at `/join`; that is their consent, and they gain exactly that membership. Platform admins cannot accept invitations. Open invitations can be revoked; accepted ones are history.

**Session revocation.** A user can end all of their own sessions; whoever may recover an account can end that user's sessions. Redeeming a code always does.

**Session lifetime (deliberate policy).** Idle limit 7 days: a validation with less than half of that remaining renews the session. Absolute limit 30 days from sign-in, however active. The cookie is issued once for 30 days and never renewed, so cookie and server session end together; the idle limit is enforced on the server.

**Cleanup.** Sessions expired for more than a day, and codes and unaccepted invitations expired for more than 30 days, are deleted by `auth_purge_expired`, run occasionally at sign-in until a scheduled job exists.

**First platform administrator.** Platform admins cannot be created through the application. An operator holding the owner database credential runs `pnpm admin:bootstrap --email <email> --name "<name>"`. It refuses if one already exists (`--additional` adds another, `--recover` issues a new code for an existing one), never promotes an existing account, never accepts or prints a password, and prints a one-time code (valid 24 hours) that the new admin redeems at `/redeem`.

## Planned lifecycle (remaining)

The numbered steps and the reset paragraph below describe the original email-based design. They are superseded by the school hand-out model above and are kept only as the basis for an optional email channel later.

1. School admin creates school-scoped profile and invitation, avoiding duplicate global identities.
2. Invitation token is random, hashed at rest, scoped to recipient/school/role, expires after a proposed 48 hours, and is consumed once.
3. Recipient proves control of the intended channel, chooses password, and receives only the invited membership.
4. Guardian invitations require a verified child link; a shared phone is not sufficient authorization.
5. School administrators can revoke their memberships and trigger recovery invitations, but cannot read passwords or edit another identity's global privileges.

Reset: generic acknowledgement whether account exists or not; rate-limit requests and delivery; short-lived random hashed token (proposed 30 minutes), single-use transactional consumption; set validated password; revoke all sessions and outstanding reset tokens; notify the verified channel without exposing credentials. Reset pages must not leak tokens to third-party analytics/referrers. No security questions or temporary plaintext password emails.

If the verified channel is lost, use documented identity verification by the school, with platform escalation for platform admins or cross-school disputes. Record actor, reason and evidence reference, not unnecessary identity documents. In the implemented model the school verifies the person before issuing a code and records the reason; platform admins handle school admins. A written verification policy for schools remains decision pending.

## Required hardening

Scheduled (not opportunistic) expiry cleanup; credential/session rotation for incidents. Not yet implemented: QR code for enrolment, rotation of `MFA_ENCRYPTION_KEY`, and a school-level setting that requires two-step sign-in for its admins. The 7-day idle and 30-day absolute session limits and the code lifetimes are provisional values. Changes must preserve existing login compatibility and include migration tests.
