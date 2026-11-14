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

## Free hosted demo (Vercel + Neon)

Decision 2026-11-14: during development the shareable copy runs on free services; paid hosting (one small server) follows later for real staging. The demo holds **fake data only**. It is not staging: there is no always-on worker (a schedule runs it every 10 minutes), no virus scanner (uploads stay quarantined) and no persistent disk.

What runs where: website on Vercel (Hobby, free); database on Neon (free); background work through `/internal/worker`, called every 10 minutes by the `Worker tick` GitHub workflow; alerts to a free Slack incoming webhook.

Steps (not yet carried out; nothing here has been deployed):

1. **Neon.** Sign up at neon.tech, create a project (PostgreSQL 17, region Asia Pacific, Singapore). From *Connect*, copy the **direct** connection string for `neondb_owner`, and note the **pooled** host (it contains `-pooler`).
2. **Settings file.** Copy `.env.hosted.example` to `.env.hosted` (git-ignored) and fill in: owner URL (direct), a long random `EXAMIO_APP_DB_PASSWORD`, `DATABASE_URL` for user `examio_app` with that password, and `SEED_DEMO_PASSWORD` (at least 10 characters, not `Demo@1234`).
3. **Database.** Run `pnpm hosted:migrate` (creates the restricted role, applies migrations and grants), then `pnpm hosted:seed` (lookups and the two demo schools; no platform admin).
4. **Secrets.** Generate two values locally: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` for `MFA_ENCRYPTION_KEY`, and `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for `CRON_SECRET`. Keep both private; never change the MFA key afterwards.
5. **Vercel.** Sign up with GitHub, *Add New → Project*, import `Sarthak-1004/examio`, set **Root Directory** to `apps/web`, and add environment variables:
   - `DATABASE_URL`: the **pooled** Neon URL for `examio_app`
   - `MFA_ENCRYPTION_KEY`, `CRON_SECRET`: from step 4
   - `EXAMIO_ENV=demo`, `TRUSTED_PROXY_HOPS=1`, `WORKER_STALE_SECONDS=1800`
   - `ENABLE_EXPERIMENTAL_COREPACK=1` (so Vercel uses the pnpm version in package.json)
   - later, after step 7: `ALERT_SINK=webhook`, `ALERT_WEBHOOK_URL`
   Never add `DATABASE_OWNER_URL` to Vercel: the app refuses to start with it in demo mode. Deploy. Functions run in Singapore (`apps/web/vercel.json`), next to the database.
6. **Platform admin.** Run `pnpm hosted:admin --email <your email> --name "<your name>"`. Open `https://<your-app>.vercel.app/redeem`, enter the printed code, choose a password, sign in and set up the authenticator app when asked.
7. **Alerts.** Create a free Slack workspace and an incoming webhook to `#alerts` (api.slack.com/apps → Create App → Incoming Webhooks). Put the URL in Vercel (`ALERT_WEBHOOK_URL`, plus `ALERT_SINK=webhook`) and in `.env.hosted`, redeploy, and run `pnpm hosted:alert-test`.
8. **Scheduled worker.** In GitHub: *Settings → Secrets and variables → Actions*: add secret `CRON_SECRET` (same value as Vercel) and variable `WORKER_URL` = `https://<your-app>.vercel.app/internal/worker`. Then *Actions → Worker tick → Run workflow* once to check it answers.
9. **Share.** Friends sign in at the Vercel URL as `principal@gvps.demo` or `principal@srv.demo` with `SEED_DEMO_PASSWORD`. Do not share the platform admin account.

Status 2026-11-15: step 5 done through the Vercel CLI (project `examio` in scope `sarthak-singhs-projects-6adc1370`, root `apps/web`, Next.js, Node 24, the seven production variables added from `.env.hosted` with secrets stored as sensitive, GitHub repository connected so pushes to `main` deploy). Status 2026-11-14: steps 1-3 done (Neon project `dry-unit-42676649`, branch `production`; `.env.hosted` written from the Neon CLI; migrations and seed applied; Neon accepted `CREATE ROLE` from `neondb_owner`). Untested assumptions still to watch: Vercel building with pnpm 12 through Corepack, and Vercel's `X-Forwarded-For` holding the client address as its last entry (`TRUSTED_PROXY_HOPS=1`).

Moving to paid hosting later: one VPS (for example Hetzner, or DigitalOcean/Lightsail in India) running the website, `pnpm worker`, ClamAV and PostgreSQL or Neon, with `EXAMIO_ENV=staging` / `production` rules.
