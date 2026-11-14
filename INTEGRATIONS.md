# Integrations

## Current dependencies

PostgreSQL is the only external runtime data service in use. Provider adapters exist with these drivers: email `sandbox` (records, never sends); file storage `local` (disk); malware scanning `clamav` (TCP to a ClamAV daemon; tested against a stand-in server only) and `dev-allow` (development only); alerts `log` and `webhook`. No real email, SMS, object storage, payment, Redis, analytics or error-monitoring provider is configured. Inter fonts are fetched through `next/font/google` at build time. Microsoft Edge (or Playwright's Chromium) is a test dependency.

## Planned boundaries

| Service | Purpose | Configuration requirements | Failure behavior |
| --- | --- | --- | --- |
| Transactional email | Invitations, recovery, notices | Provider credentials, verified sender/domain, environment recipient controls | Outbox retries/backoff; generic recovery UI; delivery status without exposing account existence |
| SMS (optional) | Verified recovery/reminders | Provider credentials, sender/templates, approved use and rate limits | Queue/retry; no password/token logging; alternate verified channel only if configured |
| Private object storage | Homework, attachments, imports, exports | Private bucket/container, region, service identity, signing expiry | Quarantine, size/type checks, scan; retry uploads; no public fallback |
| Shared rate-limit store | Consistent limits across instances | Implemented in PostgreSQL (`rate_limit_buckets`); no separate service or credentials | Sign-in fails with an error, not silently unlimited, when the database is unavailable |
| Payment provider | Fee collection/refunds | Merchant credentials, supported currency, webhook signing secret | Pending until verified; durable deduplication and reconciliation; never infer payment from redirect |
| Monitoring/error service | Errors, metrics, alert routing | Environment/release IDs, restricted ingestion credentials | Buffer bounded telemetry; app must not fail solely because telemetry fails |
| Worker/scheduler | Notifications, imports, exam deadlines, exports | Service identity, job storage, schedule/lease settings | Lease/retry/dead-letter state; alerts for overdue finalizations |

Provider selection and exact environment names are decision pending. Add adapters behind core interfaces; do not place provider calls in UI or transactions. Use test/sandbox accounts outside production and prevent staging from contacting real families.

## Webhook contract

Verify signature using raw payload and provider-specific timestamp tolerance; reject invalid payloads before acting. Persist provider event ID and payload hash durably; uniqueness prevents replay effects. Acknowledge only after durable capture, then process asynchronously. Resolve tenant through trusted merchant/invoice mapping, never an unverified payload school ID alone. Handle out-of-order events using an explicit payment state machine and provider reconciliation.

Retries use bounded exponential backoff with jitter. Classify validation failures as permanent and network/rate-limit failures as transient. Do not retry financial creation without a provider idempotency key. Dead-letter jobs need an authorized replay flow and audit. Store minimal redacted provider evidence; retention is a production decision.

## Enabling an integration

Document provider, purpose, data fields sent, region, secret ownership/rotation, sandbox setup, limits, webhook setup, cost exposure and fallback. Test outage, duplicate callback, timeout-after-success and invalid signature scenarios before enabling real traffic. No provider or subscription is authorized merely by this document.
