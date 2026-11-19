# Environment configuration

Root `.env.example` documents local variables. Never commit real `.env` files. Next.js configuration and the lazy DB client load the repository root environment; database/core scripts load root `.env` via dotenv. Hosted deployments should inject environment secrets rather than copy a developer file.

## Current variables

| Variable | Consumer | Required / meaning |
| --- | --- | --- |
| `DATABASE_URL` | Web/core runtime | Required; restricted app role connection, subject to RLS |
| `DATABASE_OWNER_URL` | Migrations, role setup, seed/reset | Required for those commands only; owner bypasses RLS; exclude from runtime deployment |
| `EXAMIO_APP_DB_PASSWORD` | Role setup | Required by setup script; only used when creating missing `examio_app`; does not rotate an existing role password |
| `TEST_DATABASE_URL` | Core integration tests | Required for tests; restricted role in dedicated disposable test DB |
| `TEST_DATABASE_OWNER_URL` | Test migration/fixtures | Required for tests; fixture truncation and migration privileges |
| `SEED_SUPERADMIN_EMAIL` | Development seed | Optional; default public demo email from `.env.example` |
| `SEED_SUPERADMIN_PASSWORD` | Development seed | Optional with public demo fallback; never use seed for production bootstrap |
| `DATABASE_POOL_MAX` | Web DB client | Optional; numeric pool maximum, default 10; currently lacks explicit positive-number validation |
| `TRUSTED_PROXY_HOPS` | Web sign-in rate limits | Optional; whole number 0-5, default 0. Number of reverse proxies you operate in front of the app. The client address is read from `X-Forwarded-For` at that position from the right; 0 ignores the header and disables address-based limits. An invalid value stops the server at start |
| `MFA_ENCRYPTION_KEY` | Web two-step sign-in, development seed | 32 random bytes as base64; encrypts authenticator secrets at rest. Required whenever the server runs in production mode, including `pnpm test:e2e`; the server refuses to start without it. Outside production mode a public development key is used when unset. Changing it makes enrolled authenticators unreadable |
| `SEED_SUPERADMIN_TOTP_SECRET` | Development seed | Optional; public demo authenticator key for the seeded platform admin |
| `EXAMIO_ENV` | Web, worker | development (default), test, demo (free hosted demo, fake data), staging or production. Staging/production require clamav scanning, webhook alerts, an explicit `TRUSTED_PROXY_HOPS`, a real MFA key, and no owner URL in the runtime. `next start` sets NODE_ENV=production on any machine, so EXAMIO_ENV (not NODE_ENV) decides which rules apply |
| `CRON_SECRET` | Web | At least 32 characters. Enables `/internal/worker` (scheduled background work); without it the endpoint answers 404. Same value as the GitHub secret used by the `Worker tick` workflow |
| `WORKER_STALE_SECONDS` | Web, worker | How long the worker may be silent before health reports it stopped; default 300, use 1800 for a 10-minute schedule |
| `SEED_DEMO_PASSWORD` | `pnpm hosted:seed` | Password for the hosted demo school admins; at least 10 characters, never `Demo@1234` |
| `E2E_DATABASE_URL`, `E2E_DATABASE_OWNER_URL` | Browser tests | Disposable local `*_e2e` database, dropped and recreated each run |
| `E2E_BROWSER_CHANNEL` | Browser tests | `msedge` (default) or `chromium` |
| `PAYMENTS_PROVIDER` | Web, worker (fees) | `sandbox` (default; simulated) or `razorpay`. Production refuses `sandbox`; live keys only after live payments are approved |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Web (fees) | Required with `PAYMENTS_PROVIDER=razorpay`; test keys until live payments are approved; never committed |
| `EMAIL_PROVIDER` | Worker | `sandbox` only (records, never sends) |
| `FILE_STORAGE`, `FILE_STORAGE_DIR` | Web, worker | `local` only; folder defaults to `<repo>/.data/files` (git-ignored). Must be persistent and backed up with the database |
| `FILE_SCANNER`, `CLAMAV_HOST`, `CLAMAV_PORT` | Worker | `none` (uploads stay quarantined), `dev-allow` (no scanning; refused in staging/production) or `clamav` |
| `ALERT_SINK`, `ALERT_WEBHOOK_URL` | Worker, alert test | `log` (default) or `webhook` (https URL receiving `{"text": ...}`) |
| `LOG_LEVEL` | Web, worker | debug, info (default), warn, error |
| `BACKUP_DIR`, `PG_BIN_DIR` | Backup scripts | Backup folder (default `<repo>/.data/backups`); PostgreSQL tools folder if not found automatically |
| `NODE_ENV` | Next.js/cookie options | Framework-controlled development/test/production; production enables Secure cookies |

No session-signing secret is used: sessions are opaque DB-backed tokens. No provider credentials or `NEXT_PUBLIC_*` variables are currently required. Do not add invented secrets for nonexistent integrations.

## Environment separation

| Environment | Data and credentials | Expectations |
| --- | --- | --- |
| Local | Fake data, localhost dev and test DBs | Demo seed permitted; test DB must differ from dev |
| CI (planned) | Fresh disposable DB/server and isolated roles | No production secrets; no real messages/payments |
| Staging (planned) | Synthetic or approved sanitized data; provider sandboxes | Separate DB/storage/secrets/domain; restore and release rehearsal |
| Production (planned) | Live records, dedicated least-privilege identities | TLS, managed secrets, no demo seed/reset commands; restricted migration job |

Current setup uses the same PostgreSQL role name `examio_app`; roles are cluster-wide. Separate production from test/dev clusters and credentials. Merely changing database names is not full environment isolation.

## Configuration checks

At server start the app validates `TRUSTED_PROXY_HOPS` and `MFA_ENCRYPTION_KEY` and refuses a `DATABASE_URL` role that can bypass RLS. The web server and the worker both run `validateRuntimeConfig` at start: it checks the environment name, pool size, proxy hops, MFA key, email provider, scanner and alert sink, and applies the stricter staging/production rules. Database TLS is not yet checked. Before tests assert test DB is disposable and differs from live/dev. These comprehensive startup/test guards are planned, not currently enforced by all scripts. Current reset only checks hostname localhost/127.0.0.1.

Keep a redacted variable-name inventory, not secret values, in release records. Future integrations must add concrete documented variables and validation when a provider is selected. Rotate secrets through provider/database operations and update deployments; editing `.env` alone does not rotate remote credentials.

## Pre-flight check

`pnpm ops:preflight [--settings <file>] [--as staging|production] [--connect]` applies the same rules as the server and worker at start-up to a settings file and prints pass/fail lines naming settings, never values. `--connect` also checks that the runtime role cannot bypass row level security and, when the file holds `DATABASE_OWNER_URL`, how many migrations are pending. Production templates: [`deploy/web.env.example`](deploy/web.env.example) (runtime) and [`deploy/migrate.env.example`](deploy/migrate.env.example) (migrations and backups). See the runbook in [DEPLOYMENT.md](DEPLOYMENT.md).
