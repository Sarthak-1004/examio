# Contributor and AI instructions

Applies repository-wide. Read [README.md](README.md), [TASKS.md](TASKS.md), and relevant domain documents before changing code. Follow higher-priority session instructions. Planned requirements must never be represented as implemented behavior.

## Working rules

- The authoritative development roadmap is the 15-phase plan in [TASKS.md](TASKS.md). Read its Resume here section before implementation; update phase/task status, validation evidence and the next unfinished task after each implementation session. The old P0-P8 numbering is superseded. Do not silently omit scheduled modules or mark planned work as delivered.
- Implement the requested scope with minimal coherent changes. Preserve unrelated work; do not reset, clean or overwrite user edits to simplify a task.
- Synchronize documentation with behavior. Mark tasks done only after acceptance checks pass; report unrun or blocked checks honestly.
- Explain new dependencies, services, roles and public APIs; update their specifications.
- Do not deploy, send real notifications, charge accounts or run destructive database operations unless authorized by the task. Use disposable test data.
- Do not inspect or print actual secrets for routine analysis. Use `.env.example` for configuration documentation. Never log passwords, tokens, connection credentials or student records.

## Architecture and conventions

- Use strict TypeScript; avoid `any`, unsafe casts and unexplained non-null assertions.
- UI/routes/actions belong in `apps/web`; validated business services in `packages/core`; schema, migrations, RLS and database plumbing in `packages/db`.
- Prefer Server Components; use Client Components for browser interaction only. Keep privileged modules and secrets out of client bundles.
- Validate untrusted input with Zod on the server. Use `AppError` for expected domain failures; do not swallow unexpected exceptions.
- Authenticate and authorize each protected action independently. Hidden buttons and layout guards are insufficient.
- Derive identity and tenant context from sessions. Validate school selection. Tenant access uses `withContext`; reviewed identity/session helpers are explicit exceptions.
- Every new tenant table needs `school_id`, same-school relational constraints, RLS, useful indexes and negative isolation tests. Runtime must not use the owner connection.
- Parameterize SQL. Allowlist and correctly quote dynamic identifiers; never interpolate user input into SQL.
- Store money in integer minor units plus currency; use decimal-safe marks calculations. Store instants as timezone-aware timestamps and local attendance dates as dates.
- Commit related records and audits atomically. Protect retriable financial and assessment operations with idempotency and concurrency controls.
- Preserve academic history, published exam versions and financial ledgers; use archival or explicit reversal instead of destructive deletion.
- Reuse [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); include accessible labels, keyboard behavior and loading/error/empty states.

## Commands and verification

From the root: `pnpm dev`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm admin:bootstrap` (operator-only; uses the owner connection to create a platform administrator), `pnpm worker`, `pnpm ops:backup`, `pnpm ops:restore-rehearsal`, `pnpm ops:alert-test`.

`pnpm test` migrates and truncates the configured test database. E2E tests drop, recreate and seed the disposable `E2E_DATABASE_URL` database (local, `*_e2e`) and use Microsoft Edge unless `E2E_BROWSER_CHANNEL=chromium`. Destructive scripts and fixtures refuse databases that fail the disposable-database guard; do not weaken it. Inspect configuration before running these against unfamiliar environments. `db:reset` and `db:reset:test` drop databases; their localhost guard does not establish that data is disposable.

Run type checking and relevant tests for code changes. Auth, RLS, grading and financial changes require unauthorized/failure cases. For documentation-only changes, verify links, source accuracy and consistency; database mutation is unnecessary.

## Schema and release discipline

Add forward migrations; do not silently rewrite applied migrations. Review generated SQL and custom RLS together. Plan backfills and compatible rollout before adding incompatible constraints. Document recovery for migrations.

There is no lint script or production provisioning. A CI workflow exists (`.github/workflows/ci.yml`) but has not run yet. Background work goes through the job queue (`enqueueJob` in the business transaction, payloads with identifiers only, idempotent handlers); new UI reuses the shared components in `apps/web/components`. Every new table needs an entry in `TABLE_GRANTS` (`packages/db/scripts/setup-roles.ts`) and every new school service needs a capability (`packages/core/src/capabilities.ts`). Do not invent commands or claim checks passed. Report what changed, validation and remaining limitations.
