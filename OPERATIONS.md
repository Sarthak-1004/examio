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
