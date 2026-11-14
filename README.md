# Examio

Examio is a full multi-school school-management system. Its scope includes MIS, academic administration, attendance, communication, fees, student practice and formal examinations. Schools share the application while their records are isolated by tenant.

## Current status

Implemented: authentication, school onboarding, board/medium settings, school status management, role-based portal entry and PostgreSQL row-level security. School dashboards and the student exam page are basic shells. Academic MIS, practice, exams, attendance, fees and parent workflows are planned, not working modules yet.

Documentation baseline: **2026-11-13**. **Implemented** means present in source; **Planned** means a target requirement; **Decision pending** means unresolved. Code presence does not imply production verification. See [TASKS.md](TASKS.md).

## Development roadmap

The complete feature scope is scheduled in the [15-phase development plan](TASKS.md), including admissions, library, inventory, transport, HR/payroll and platform subscriptions. TASKS.md is the authoritative progress tracker and contains the next task to resume. All 15 phases are currently planned; implementation begins with security and identity hardening. Read [PRD.md](PRD.md) for product requirements.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js App Router UI, Server Actions, session guards |
| `packages/core` | Business services, authentication, validation, integration tests |
| `packages/db` | Drizzle schema/client, SQL migrations, RLS and database scripts |

## Local setup: Windows PowerShell

Prerequisites: Node.js 24, the package manager declared in `package.json` (`pnpm@12.18.0`), and PostgreSQL 17 on localhost:5432. These are intended development versions; verify installation compatibility before changing them.

```powershell
Copy-Item .env.example .env
# Edit .env for your local PostgreSQL credentials before continuing.
pnpm install --frozen-lockfile
```

For a **new, disposable local database only**, this drops/recreates the configured development database, migrates and seeds fake data:

```powershell
pnpm db:reset
pnpm dev
```

Visit http://localhost:3000. For an existing database, preserve its data and use `pnpm db:migrate` instead of reset. The migration connection is privileged; runtime must use restricted `DATABASE_URL`. See [ENVIRONMENT.md](ENVIRONMENT.md).

## Commands

| Command | Effect |
| --- | --- |
| `pnpm dev` | Start development server |
| `pnpm build` | Build web app |
| `pnpm --filter @examio/web start` | Start already-built application |
| `pnpm typecheck` | Type-check all three packages |
| `pnpm test` | Vitest; migrates test DB and truncates fixture tables |
| `pnpm test:e2e` | Build, recreate and seed the disposable `examio_e2e` database, run desktop/mobile Playwright (installed Microsoft Edge by default) |
| `pnpm worker` | Background worker: notifications, file scans, housekeeping, health alerts (`--once` runs what is due and exits) |
| `pnpm ops:backup` / `pnpm ops:restore-rehearsal` | Back up the dev database and file storage to `.data/backups`; restore the newest backup into a throwaway database and verify it |
| `pnpm ops:alert-test` | Send a test alert through the configured alert sink |
| `pnpm hosted:migrate` / `hosted:seed` / `hosted:admin` / `hosted:alert-test` | Set up the free hosted demo database from `.env.hosted` (see DEPLOYMENT.md, Free hosted demo) |
| `pnpm db:generate` | Generate Drizzle migrations from schema |
| `pnpm db:migrate` | Configure role, migrate dev DB, refresh grants |
| `pnpm db:migrate:test` | Same process for test DB |
| `pnpm db:seed` | Seed fake demonstration data; development only |
| `pnpm admin:bootstrap --email <email> --name "<name>"` | Create the first platform administrator using the owner connection; prints a one-time code, never a password. `--additional` adds another, `--recover` issues a new code |
| `pnpm db:reset:test` | Drop/recreate local test DB and migrate |

Tests require disposable databases. No lint command or CI pipeline is currently configured. Build uses `next/font/google` for Inter and may need provider access. Before database tests, confirm test connections differ from development and production.

## Local demo accounts

These credentials are public fixtures, never production credentials, and are not used on the hosted demo (it is seeded with a private password and a privately bootstrapped platform admin). The seeded platform admin uses two-step sign-in: add the public demo key `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to an authenticator app (account name of your choice, time-based) to get its codes. `pnpm test:e2e` needs `MFA_ENCRYPTION_KEY` in `.env` (see `.env.example`).

| Role | Login | Password |
| --- | --- | --- |
| Platform admin | `admin@examio.local` | `ChangeMe!2026` |
| Green Valley school admin | `principal@gvps.demo` or `9000000001` | `Demo@1234` |
| Sunrise school admin | `principal@srv.demo` or `9000000002` | `Demo@1234` |

Platform seed credentials can be overridden in the local environment. New school admins created through the application must change their initial password. Demo admins bypass that step in the development seed. Production bootstrap remains planned.

## Documentation

| Document | Purpose |
| --- | --- |
| [PRD.md](PRD.md) | Goals, users, scope, acceptance criteria |
| [AGENTS.md](AGENTS.md) | Contributor and AI instructions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Structure and technical decisions |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | UI tokens and interaction rules |
| [USER_FLOWS.md](USER_FLOWS.md) | Role journeys and exceptions |
| [PAGES.md](PAGES.md) | Routes and loading/error/empty states |
| [ROLES_PERMISSIONS.md](ROLES_PERMISSIONS.md) | Authorization matrix |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Existing schema and planned model |
| [API_SPEC.md](API_SPEC.md) | Current actions and proposed HTTP contracts |
| [AUTHENTICATION.md](AUTHENTICATION.md) | Identity, sessions and recovery |
| [SECURITY.md](SECURITY.md) | Controls, requirements and known gaps |
| [BUSINESS_RULES.md](BUSINESS_RULES.md) | Domain rules and calculations |
| [INTEGRATIONS.md](INTEGRATIONS.md) | Services, webhooks and failures |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Environment configuration |
| [TASKS.md](TASKS.md) | Phases, priorities and dependencies |
| [TEST_PLAN.md](TEST_PLAN.md) | Tests and release gates |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Release, migration and rollback |
| [OPERATIONS.md](OPERATIONS.md) | Monitoring, backups and incidents |
| [CHANGELOG.md](CHANGELOG.md) | History and compatibility notes |

Read the product requirements and implementation plan before starting a module. Keep code, permissions, schema, tests and documentation aligned as features are delivered.

