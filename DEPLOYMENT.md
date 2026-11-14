# Deployment

Status: production deployment is not configured. No hosting provider, domain, CI pipeline, container image or migration automation has been selected. A production administrator bootstrap command exists (`pnpm admin:bootstrap`) but has not been run against a production database. This is a provider-neutral runbook to complete and rehearse, not evidence of an existing deployment.

## Target environments and prerequisites

Separate staging/production databases, roles, storage, credentials and domains. Runtime needs Node-compatible Next.js server hosting and network access to PostgreSQL. Local baseline targets Node 24/PostgreSQL 17; pin verified versions in chosen infrastructure. Plan build-time font access or reviewed local font packaging.

Before production: resolve critical [SECURITY.md](SECURITY.md) gaps, create the first platform administrator with `pnpm admin:bootstrap` from a private terminal holding the owner credential (never the demo seed; the printed one-time code must not end up in stored job logs), set a secret `MFA_ENCRYPTION_KEY` and back it up separately from the database, set `EXAMIO_ENV=production` (the server and worker then refuse to start without clamav scanning, webhook alerts and an explicit `TRUSTED_PROXY_HOPS`), run the worker as its own process or scheduled job, give file storage persistent backed-up space (local disk does not survive on serverless hosts), choose TLS/secret management/region, confirm expected load and pool budget, configure backups/alerts and rehearse restore. Do not expose the current development seed as a production setup mechanism.

## Build and release sequence

1. Select a reviewed source revision and retain its lockfile, build identifier and migration list.
2. Install dependencies with `pnpm install --frozen-lockfile` in a clean build environment.
3. Run `pnpm typecheck`, appropriate tests on disposable data, and `pnpm build`.
4. Test the artifact and planned migrations in staging, including role/RLS verification and critical journeys.
5. Confirm restore point and recovery plan. For compatible schema expansion, run migration from a restricted deployment job; for incompatible changes use an explicit maintenance/backfill plan.
6. Deploy the tested artifact with runtime `DATABASE_URL` only, appropriate pool size and managed secrets. Start with `pnpm --filter @examio/web start` or the hosting adapter's verified equivalent.
7. Verify HTTPS, unauthenticated redirect, login, school isolation, current feature flows, DB role and telemetry. Monitor errors/latency before widening traffic.
8. Record revision, migration results, operator, smoke checks and rollback artifact.

Current `pnpm db:migrate` invokes setup-roles before and after migrations and uses `DATABASE_OWNER_URL` plus `EXAMIO_APP_DB_PASSWORD`. It creates the app role if missing, fails if an existing role is a superuser, has BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION or owns tables, and then replaces the role's privileges with the reviewed per-table manifest. It does not repair role attributes or rotate the password. The web server also refuses to start when `DATABASE_URL` uses a role that can bypass RLS. Review it for target infrastructure before production use. `pnpm db:reset`, `db:reset:test`, `db:seed` and test fixture truncation are not production deployment steps.

## Migrations

Generate and review schema SQL using `pnpm db:generate`; add/review tenant RLS alongside each table. Use expand -> backfill -> switch application -> contract for incompatible changes. Set appropriate lock/statement timeouts in the migration runner when implemented. Test migration duration and concurrent old/new app compatibility. Only one migration runner should execute at a time.

Do not casually reverse data migrations. Keep old columns until the rollback window expires. App startup should not independently run migrations on every instance. Database owner credentials stay in the migration environment, never the web runtime.

## Domain and network

Point DNS at selected ingress, provision/renew certificate, redirect HTTP to HTTPS, and validate secure cookies under the real domain. Configure trusted proxy handling and accepted origins; do not trust arbitrary client-forwarded IP headers. Configure health/readiness probes (not implemented yet) that expose no secrets and distinguish process health from database readiness. Add HSTS only after HTTPS coverage is verified.

## Rollback

If error/security thresholds fail, stop rollout and route to the last known-good artifact if schema remains compatible. Pause unsafe writes/jobs if data integrity is uncertain. Forward-fix schema when possible. Restore a backup only under an approved incident plan: it may discard valid newer data and requires reconciliation, not just restarting the app.

For restore, use a separate database, validate migrations/RLS and counts, reconcile payments/jobs/attempts, then cut over. Preserve evidence and communicate the recovery point. Verify that rollback cannot reintroduce revoked access or replay notifications/payments. See [OPERATIONS.md](OPERATIONS.md).
