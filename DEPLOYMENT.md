# Deployment

Status (2026-11-20): production is **prepared, not provisioned** (decision 2026-11-20: nothing is bought or deployed until the school/user decides on hosting). The free demo runs on Vercel + Neon (below); CI runs on every push. For production this document gives a single-server runbook with ready configuration files in [`deploy/`](deploy/), a pre-flight check (`pnpm ops:preflight`), and rehearsed migration, backup and restore procedures with measured times. `pnpm admin:bootstrap` has not been run against a production database. Nothing here is evidence of an existing production deployment.

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

Point DNS at selected ingress, provision/renew certificate, redirect HTTP to HTTPS, and validate secure cookies under the real domain. Configure trusted proxy handling and accepted origins; do not trust arbitrary client-forwarded IP headers. Use `/health` for uptime monitors and load balancers: it answers 200 when the server reaches its database and 503 otherwise, with no details (detailed checks are on `/admin/system`). Add HSTS only after HTTPS coverage is verified.

## Rollback

If error/security thresholds fail, stop rollout and route to the last known-good artifact if schema remains compatible. Pause unsafe writes/jobs if data integrity is uncertain. Forward-fix schema when possible. Restore a backup only under an approved incident plan: it may discard valid newer data and requires reconciliation, not just restarting the app.

For restore, use a separate database, validate migrations/RLS and counts, reconcile payments/jobs/attempts, then cut over. Preserve evidence and communicate the recovery point. Verify that rollback cannot reintroduce revoked access or replay notifications/payments. See [OPERATIONS.md](OPERATIONS.md).

## Production server runbook (prepared, not provisioned)

One server runs the website, the worker, ClamAV and (optionally) PostgreSQL; Caddy in front provides TLS. A managed PostgreSQL 17 or newer (for example Neon on a paid plan; the demo runs 18) may replace the local database. Sizing for the pilot (5 schools, about 1,000 students each, up to 2,000 at once in exams): 4 vCPU, 8 GB RAM, 80 GB disk to start; confirm with the Phase 15.4 load test before the first real exam. Region: India (Mumbai) or Singapore, close to the schools.

1. **Server.** Ubuntu 24.04 LTS. Create a non-login user `examio`; enable automatic security updates; firewall (ufw): allow 22 (SSH, keys only), 80 and 443; deny the rest. PostgreSQL and ClamAV listen on 127.0.0.1 only.
2. **Software.** Node 24 (NodeSource or nvm for the `examio` user), `corepack enable` (pnpm version from package.json), PostgreSQL 17 client tools (`pg_dump`/`pg_restore` matching the server major version), ClamAV daemon (`clamav-daemon`, with freshclam updating signatures), Caddy.
3. **Database.** Create the database and an owner role (`examio_owner`, not a superuser) that owns the schema. Never give the owner credential to the website.
4. **Settings.** Copy [`deploy/migrate.env.example`](deploy/migrate.env.example) to `/etc/examio/migrate.env` (root only, chmod 600) and [`deploy/web.env.example`](deploy/web.env.example) to `/etc/examio/web.env` (root and `examio`, chmod 640). Generate secrets on the server: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` for `MFA_ENCRYPTION_KEY` (store a copy in the password manager, separately from backups; never change it) and a long random `EXAMIO_APP_DB_PASSWORD`. Create `/var/lib/examio/files` and `/var/backups/examio`, owned by `examio`.
5. **Release.** Check out the reviewed revision into `/opt/examio/releases/<revision>`, `pnpm install --frozen-lockfile`, `pnpm build`, and point the symlink `/opt/examio/current` at it.
6. **Pre-flight.** `pnpm ops:preflight --settings /etc/examio/web.env --as production --connect` must end with `Result: ready.` (it names settings, never values). With the migration settings it also reports pending migrations: `pnpm ops:preflight --settings /etc/examio/migrate.env --connect`.
7. **Migrate.** Load the migration settings into a root shell (`set -a; . /etc/examio/migrate.env; set +a`), then `pnpm db:migrate` (creates the restricted `examio_app` role if missing, applies migrations, re-applies the reviewed grants). Run from one place only.
8. **Services.** Install [`deploy/examio-web.service`](deploy/examio-web.service), [`deploy/examio-worker.service`](deploy/examio-worker.service), [`deploy/examio-backup.service`](deploy/examio-backup.service) and [`deploy/examio-backup.timer`](deploy/examio-backup.timer) into `/etc/systemd/system/`; `systemctl daemon-reload`; `systemctl enable --now examio-web examio-worker examio-backup.timer`. The website refuses to start if the settings break production rules or its database role could bypass row level security.
9. **Domain and TLS.** Point the domain's A/AAAA records at the server; install [`deploy/Caddyfile.example`](deploy/Caddyfile.example) as `/etc/caddy/Caddyfile` with the real domain; `systemctl reload caddy`. Caddy obtains and renews the certificate and redirects HTTP to HTTPS. Check `https://<domain>/health` returns 200, sign-in cookies are `Secure`, and HSTS is present.
10. **First administrator.** From a private terminal with the migration settings: `pnpm admin:bootstrap --email <email> --name "<name>"`; redeem the printed code at `/redeem`; set up the authenticator app. Do not store the code anywhere.
11. **Alerts and checks.** `pnpm ops:alert-test` must reach the webhook. Watch `/admin/system` (worker heartbeat, queue, dead jobs, exam deadlines). Run `pnpm ops:restore-rehearsal` against the first backup and keep its report.

## Release, migration and rollback procedure

Each release: (1) back up (`pnpm ops:backup`, or let the nightly timer's backup be recent); (2) pre-flight; (3) rehearse the migration on a copy when it changes data or adds constraints (`pnpm ops:migration-rehearsal --back <n>` locally, where n is the number of new migrations); (4) migrate; (5) switch `/opt/examio/current` to the new release and `systemctl restart examio-web examio-worker`; (6) smoke-check `/health`, sign-in and one page per role; (7) record the revision, migrations and checks in the release notes.

Rollback: if the new release misbehaves and its migrations only added things (the norm: every migration so far is additive and forward-fixed), switch `/opt/examio/current` back to the previous release and restart; the older code ignores the new tables and columns. If data integrity is in doubt, stop the website and worker, restore the last good backup into a new database with `pg_restore` (the procedure `pnpm ops:restore-rehearsal` exercises), verify it, then point `DATABASE_URL`/`DATABASE_OWNER_URL` at it. A restore loses changes made after the backup; reconcile payments, exam attempts and notifications before reopening.

Measured on 2026-11-20 (development machine, local PostgreSQL 17, Windows; production timings will differ and must be measured again on the real server):

| Rehearsal | Command | Result |
| --- | --- | --- |
| Upgrade from the previous release with data | `pnpm ops:migration-rehearsal` (5 migrations back, 0028 → 0033) | Passed: previous release built in 2.1 s; upgrade 0.4 s; grants 0.4 s; 34 of 34 migrations; all rows kept; RLS on every table; runtime role cannot bypass it; no rows without a request context |
| Backup | `pnpm ops:backup` | 0.8 s; 34 migrations; manifest of row counts and files |
| Restore into a scratch database | `pnpm ops:restore-rehearsal` | Passed in 2.7 s (3.1 s total): migrations, row counts, RLS, runtime role, tenant isolation and file bytes all verified |
| Pre-flight of the development settings as production | `pnpm ops:preflight --as production` | Not ready, as expected: owner URL present, no clamav scanner, no explicit proxy hops, alerts not to a webhook, sandbox payments |

## Free hosted demo (Vercel + Neon)

Decision 2026-11-14: during development the shareable copy runs on free services; paid hosting (one small server) follows later for real staging. The demo holds **fake data only**. It is not staging: there is no always-on worker (a schedule runs it every 10 minutes), no virus scanner (uploads stay quarantined) and no persistent disk.

What runs where: website on Vercel (Hobby, free); database on Neon (free); background work through `/internal/worker`, called every 10 minutes by the `Worker tick` GitHub workflow; alerts to a free Slack incoming webhook.

Steps (not yet carried out; nothing here has been deployed):

1. **Neon.** Sign up at neon.tech, create a project (the demo project runs PostgreSQL 18; choose the newest offered, and install client tools of the same major version for backups; region Asia Pacific, Singapore). From *Connect*, copy the **direct** connection string for `neondb_owner`, and note the **pooled** host (it contains `-pooler`).
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

Status 2026-11-15: the demo is live at https://examio-teal.vercel.app (first build 36 s; `/health` OK, so demo-mode start-up checks passed and the database is reachable; `/internal/worker` refuses requests without the secret and ran housekeeping with it). Steps 6-8 (platform admin, Slack, GitHub `WORKER_URL`/`CRON_SECRET`) are still open. Step 5 was done through the Vercel CLI (project `examio` in scope `sarthak-singhs-projects-6adc1370`, root `apps/web`, Next.js, Node 24, the seven production variables added from `.env.hosted` with secrets stored as sensitive, GitHub repository connected so pushes to `main` deploy). Status 2026-11-14: steps 1-3 done (Neon project `dry-unit-42676649`, branch `production`; `.env.hosted` written from the Neon CLI; migrations and seed applied; Neon accepted `CREATE ROLE` from `neondb_owner`). Untested assumptions still to watch: Vercel building with pnpm 12 through Corepack, and Vercel's `X-Forwarded-For` holding the client address as its last entry (`TRUSTED_PROXY_HOPS=1`).

Moving to paid hosting later: one VPS (for example Hetzner, or DigitalOcean/Lightsail in India) running the website, `pnpm worker`, ClamAV and PostgreSQL or Neon, with `EXAMIO_ENV=staging` / `production` rules.
