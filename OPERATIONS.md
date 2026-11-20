# Operations

Status: required operational design; monitoring, jobs and backup automation are not implemented. Assign service owner, incident lead, database recovery owner and escalation contacts before production. Do not place personal phone numbers or secrets in this repository.

## Proposed service targets

Targets require approval against hosting cost and pilot workload: 99.5% monthly application availability; database RPO <=15 minutes and RTO <=4 hours; exam answer-save p95 <2 seconds at agreed peak load. RPO is acceptable recovery-point loss, not permission to drop acknowledged answers during normal operation. Higher-stakes exams may require stricter recovery objectives before scheduling them.

## Implemented tooling (Phase 2)

- **Scheduled worker**: on hosting without an always-on process, `POST /internal/worker` with `Authorization: Bearer <CRON_SECRET>` runs one round (up to about 20 seconds). The `Worker tick` GitHub workflow calls it every 10 minutes once `WORKER_URL` and `CRON_SECRET` are configured.
- **Worker**: `pnpm worker` runs due jobs (notification delivery, file scans, hourly housekeeping), reports a heartbeat every 30 seconds and checks health every 5 minutes. `pnpm worker --once` runs what is due and exits, for a scheduler. It uses the restricted runtime role.
- **Health**: `/health` (public) answers 200 when the server reaches its database, 503 otherwise, with no details. `/admin/system` (platform admins) shows the checks below and the failed-job list with Retry.
- **Alerts**: the worker alerts on each check that is not OK, on every dead-lettered job kind and on a worker crash, at most once per condition per hour (alerts are queued as `alert.send` jobs with an hourly dedupe key, so this holds across processes and scheduled runs). `ALERT_SINK=log` writes an error log line; `ALERT_SINK=webhook` posts to `ALERT_WEBHOOK_URL`. `pnpm ops:alert-test` rehearses delivery. Only the log sink has been rehearsed (2026-11-14).
- **Logs**: one JSON object per line on stdout/stderr, with sensitive keys and embedded credentials redacted. Unexpected request errors are logged with the same `digest` users see as their support reference.
- **Backups**: `pnpm ops:backup` writes a `pg_dump` custom-format dump, a copy of the file storage folder and a manifest of row counts. `pnpm ops:restore-rehearsal` restores the newest backup into `examio_restore_check`, verifies migrations, row counts, RLS on every table, runtime-role attributes, tenant isolation without context and stored file bytes, records the timing in `rehearsal.json` and drops the database. Rehearsed locally 2026-11-14: passed, restore under 1 second on development data.
- **Retention**: succeeded jobs are deleted after 14 days, dead jobs after 90 days; expired sessions, codes, invitations, idempotency records and rate-limit counters are purged hourly; bytes of rejected, deleted and expired files are removed.

Health checks (provisional thresholds): worker silent for more than 5 minutes: critical; oldest due job waiting more than 10 minutes: warning, more than 30: critical; any dead-lettered job: warning; a file in quarantine more than 30 minutes: warning; an exam attempt more than 5 minutes past its deadline and not yet submitted: warning, more than 30 minutes: critical.

- **Release rehearsals (Phase 15.3)**: `pnpm ops:migration-rehearsal [--back n] [--keep]` builds a throwaway local database at an earlier release, adds data, upgrades it and verifies rows, RLS and the runtime role, writing a report to `.data/rehearsals/`; `pnpm ops:preflight` checks a deployment's settings. Measured results are in [DEPLOYMENT.md](DEPLOYMENT.md).

- **Exam load test (Phase 15.4)**: `pnpm load:exam [--students n] [--questions n] [--pool n]` empties the disposable test database, then every student of one school takes a published exam at once (start, load questions, save each answer, submit) through the same services and RLS as the website with one web instance's pool; it reports p50/p95/p99 per step, throughput and errors to `.data/load/`. It excludes HTTP, rendering and sign-in.

Measured 2026-11-20 on the development machine (Windows laptop, PostgreSQL 17 on the same machine, pool 20, 20 questions, every student pressing on with no pause, a saturation pattern):

| Students | Run | Throughput | Errors | Save p50 / p95 / p99 | Start p95 | Submit p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 1 s | 466 ops/s | 0 | 29 / 39 / 46 ms | 281 ms | 33 ms |
| 200 (pool 10) | 6.1 s | 760 ops/s | 0 | 240 / 270 / 407 ms | 527 ms | 238 ms |
| 2,000 | 64.7 s | 711 ops/s | 0 | 2.5 / 3.5 / 5.1 s | 4.0 s | 2.9 s |

All 2,000 attempts were submitted with all 40,000 answers stored. Above about 700 operations a second requests queue for connections, which is what the 2,000-student latencies show. A real exam is far gentler: 2,000 students answering a question roughly every 30 seconds is about 70 saves a second, a tenth of this capacity, where latency stays near the 20-student figures. Repeat on the production server (with HTTP in front) before the first live exam; the free demo database is not sized for it.

## Logging and metrics

Structured events should include timestamp, environment, release, request ID, operation, safe actor/tenant identifiers, outcome and duration. Keep access restricted; avoid full names, contacts, tokens, connection URLs, file content, answer text and provider payloads. Audit events record domain changes, actor, target, reason and minimal before/after metadata where appropriate; operational logs do not replace audit records.

Monitor request failures/latency, login/reset rate limits, DB connections/locks/storage, worker queue depth/age, provider delivery failures, payment reconciliation mismatches, answer-save conflicts/failures, overdue attempt finalization, backup age and certificate expiry.

## Initial alert policy (proposed)

| Signal | Trigger | Response |
| --- | --- | --- |
| Availability/errors | Sustained health failure or >5% server errors over 5 minutes | On-call investigates release/DB; rollback if appropriate |
| Exam saves | >1% failed saves or p95 >2s for 5 minutes during active exams | Immediate assessment incident; inspect DB/load; communicate status |
| Deadline finalization | Active attempt more than 5 minutes past its deadline (`exam_deadlines` health check; the worker finalises on every tick) | Start or fix the worker; finalisation is idempotent (`exam_finalize_due`) and also happens when the attempt is opened |
| DB saturation | >80% connection budget or sustained lock queue | Reduce pressure; inspect queries/pool; protect active transactions |
| Backups | Recovery logs stale >15 minutes or scheduled backup failed | Restore RPO protection; escalate before more live data accumulates |
| Financial mismatch | Any unexplained duplicate credit or unreconciled discrepancy | Freeze affected processing and reconcile |
| Security | Suspected cross-tenant disclosure/privilege escalation | Contain immediately, preserve restricted evidence |

Tune thresholds using actual workload. Alert channels must be tested; a configured dashboard alone is not incident response.

## Backups and recovery

Proposed baseline: encrypted daily database backups with continuous recovery logs for the RPO target; retain 30 days pending approved retention policy. Back up private object storage separately and preserve referential consistency. Restrict backup identities and test decrypt/restore permissions. Backup policy for personal data must match the approved retention/erasure policy.

Monthly restore rehearsal and pre-major-migration rehearsal: restore to isolated environment; verify schema/migration version, RLS role attributes, representative tenant isolation, counts/invariants and file references; test login with synthetic recovery access; record measured recovery point/time. Never send restored queued notifications or replay payments during rehearsal.

Incident restore: preserve damaged state for investigation; restore into a separate database; validate; reconcile provider events, financial entries and acknowledged assessment records; cut over under incident lead approval; verify live workflows; record any unrecoverable interval honestly.

## Routine maintenance

Implemented jobs: expired session/code/invitation cleanup, notification delivery, file scanning and purge, finished-job cleanup. Planned: deadline finalization, import/export processing, provider reconciliation, backup verification. Jobs require leases, idempotency, bounded retries and dead-letter visibility. Retention deletion requires reviewed policy and references checks; no arbitrary truncation of audits/academic/financial history.

Review privileged memberships, staff/guardian revocations, dependency updates, provider quotas, DB growth and slow queries. Rotate secrets according to risk and incidents; test dual-key transition where supported. Reconcile payment records with provider statements on a scheduled basis.

## Incident procedure

1. Declare scope/severity and assign lead; record timeline and request/release references.
2. Contain affected writes/access and protect unaffected schools; preserve redacted evidence.
3. Determine whether rollback, forward fix or restore is safest.
4. Communicate verified impact and next update time through authorized channels; do not speculate about lost answers or exposure.
5. Recover and verify tenant access, data invariants and worker/provider reconciliation.
6. Document cause, actual impact, corrective tasks and detection improvements.

Notification obligations and retention depend on operating jurisdictions/contracts and remain to be reviewed before production; this document does not prescribe a legal compliance conclusion.

## Alert routing (Phase 15.5)

What raises an alert today. Each check runs on every worker tick; the same condition is sent at most once per hour (dedupe key `alert:<key>:<hour>`), so a condition that stays bad repeats hourly until fixed. The same checks are shown on `/admin/system`.

| Alert key | Raised when | Severity | First response (playbook) |
| --- | --- | --- | --- |
| `health:worker` | Worker has never reported, or silent more than 5 minutes | critical | Worker stalled (B) |
| `health:queue` | Oldest due job waiting more than 10 minutes (warning) or 30 minutes (critical) | warning / critical | Worker stalled (B) |
| `health:dead_jobs` | Any job failed permanently | warning | Read the job's error on `/admin/system`; fix the cause; retry |
| `dead:<job kind>` | A job just failed permanently (sent once per kind per hour) | warning | As above |
| `health:quarantine` | An uploaded file waiting for virus scanning more than 30 minutes | warning | Check ClamAV (`systemctl status clamav-daemon`) and the worker |
| `health:exam_deadlines` | Exam attempts past their deadline not submitted after 5 minutes (warning) or 30 minutes (critical) | warning / critical | Exam outage (C) |

Where alerts go: `ALERT_SINK=log` writes them to the worker's log only; `ALERT_SINK=webhook` posts `{"text": …}` to `ALERT_WEBHOOK_URL` (a Slack or Teams incoming webhook, https only). Pre-flight refuses production settings without the webhook. `pnpm ops:alert-test` sends a test alert through the configured sink; it ran on 2026-11-20 through the log sink (no webhook exists yet). Before a pilot: create the channel, set the webhook, run the alert test, and name an on-call person and a deputy for school hours (IST 07:30-17:00 on school days).

Not yet alerted automatically (watch by hand or with the hosting provider's monitoring): website down or server errors, database connections and storage, backup failure (the backup timer's exit status), TLS certificate expiry, failed exam saves. The uptime check on `/health` from an external monitor (for example a free uptime service) covers the first.

## Incident severity

| Level | Meaning | Examples | Response |
| --- | --- | --- | --- |
| S1 | Students or schools harmed now, or data exposed | Outage during an exam; suspected cross-school data exposure; wrong money taken | Immediately, any hour; incident lead named; school told within the hour |
| S2 | A main function down, no exam running | Website down outside exams; worker stopped; payments not confirming | Within 1 hour in school hours |
| S3 | Degraded or one feature broken, workaround exists | One report wrong; file scanning slow; one failed job | Next working day |

## Playbooks

Record a timeline for every S1 and S2 (what was seen, when, what was done). Never paste student details, passwords, tokens or connection strings into chat or tickets.

**A. Database unreachable.** Symptoms: `/health` fails, every page errors. 1) Check the provider status page and `systemctl status postgresql` (self-hosted). 2) Check disk space and connection count. 3) If the database is lost or corrupt, follow *Incident restore* below; do not run migrations or resets against a damaged database. 4) After recovery, confirm sign-in, one exam attempt read and `/admin/system` green.

**B. Worker stalled.** Symptoms: `health:worker` or `health:queue`. 1) `systemctl status examio-worker` and `journalctl -u examio-worker -n 200`. 2) Restart it; jobs are idempotent and leased, so a restart is safe. 3) If one job keeps failing, it goes dead after its retries; read its error. 4) While the worker is down, exam attempts are still submitted when the student or teacher opens them, but notifications and scanning wait.

**C. Outage during an exam (S1).** 1) Tell the school's exam lead at once: students must not close the exam; answers saved before the outage are kept on the server, and answers not yet sent are retried every few seconds and when the connection returns, as long as the exam page stays open (they are not stored if the browser is closed). 2) Restore service (A or B, or roll back the last release per DEPLOYMENT.md). 3) If students lost time, the school extends the exam or gives individual extra time (accommodations) after service returns; attempts already past their deadline are submitted with what was saved and cannot be reopened in place. 4) Afterwards, compare attempts in progress and submitted with the number of students who sat the exam, and record any student who could not finish.

**D. Suspected cross-school data exposure (S1).** 1) Contain: take the affected page or feature offline (roll back the release, or block the route at Caddy); revoke support access grants involved. 2) Preserve evidence: keep logs and audit entries; copy only identifiers, not student details, into the incident record. 3) Determine scope from the audit log and the database (which school's data, which users saw it, when). 4) Fix and add a test that fails without the fix (row level security test or e2e). 5) Tell affected schools what was exposed, to whom and what was done; legal notification duties must be reviewed with an adviser, this document does not decide them.

**E. Payment or financial mismatch (S1 if money taken wrongly, else S2).** 1) Stop: pause online payments by removing the payment keys from the settings and restarting (offline receipts continue). 2) Compare Razorpay's dashboard with Examio's payments and receipts for the period; webhook events are stored and processing is idempotent, so replaying a missed event is safe. 3) Correct with reversals, never by editing or deleting ledger rows. 4) Payroll: an approved run cannot change; correct with an adjustment in the next run, or void a payment and record it again.

**F. School wrongly read-only (S2).** The subscription end date passed or a payment was not recorded. 1) Platform admin → the school → record the payment with its reference, or extend the period with a reason (audited). 2) Access returns at once; nothing was deleted, and exams that were running finished normally.

**G. Lost account access.** School users: the school administrator issues a reset code. School administrators: the platform admin issues it after confirming identity by a known phone number. Platform admins with a lost authenticator: another platform admin, or the operator with `pnpm admin:bootstrap` rules; never disable two-step sign-in.

## Restore rehearsal from the demo (Phase 15.5)

Done 2026-11-20 and **passed**. The demo's Neon server runs PostgreSQL 18, so PostgreSQL 17 client tools refuse to dump it; PostgreSQL 18.7 tools (EDB binaries zip, unpacked to `D:\tools\postgresql-18`, no Windows service) were used through `PG_BIN_DIR`.

1. Backup: `pnpm ops:backup` against the demo (settings from `.env.hosted`, `BACKUP_DIR` outside the repository's tracked files): 34 migrations, 82 s over the network.
2. Restore: the disposable-database guard allows restores only on this machine, and a PostgreSQL 18 dump needs a PostgreSQL 18 server, so a throwaway local 18.7 server was started on port 5433 (`initdb`, `pg_ctl`), with `examio_app` created as a login role without superuser or bypass of row level security, and Neon's own roles (`neondb_owner`, `neon_auth`, `neon_superuser`) created as no-login placeholders because the dump grants to them. Then `pnpm ops:restore-rehearsal` with that server's settings.
3. Result: every check passed: 34 of 34 migrations, row counts equal for every counted table, row level security enabled on every table, the runtime role cannot bypass it, no rows visible without a request context. Restore 2.4 s (total 3 s).
4. The throwaway server, its data and the backup copy were deleted afterwards (the demo holds fake data only, but backups contain password hashes).

For production: keep client tools on the server's major version, and when restoring a managed-database dump elsewhere, create the provider's roles first (or restore with `--no-acl` and re-run `setup-roles`).
