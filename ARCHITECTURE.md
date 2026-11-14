# Architecture

## Implemented structure

Modular monolith in a pnpm workspace. Manifests declare Next.js 16.4.5, React 19.3.1, TypeScript 5.9.3, Tailwind CSS 4.3.5, Drizzle ORM 0.45.4, postgres.js 4.1.0 and Zod 4.6.7. The lockfile determines exact resolutions. Development targets Node 24 and PostgreSQL 17.

```text
Browser -> Next.js pages / Server Actions (apps/web)
        -> session + action authorization
        -> validated business services (packages/core)
        -> withContext transaction (packages/db)
        -> examio_app PostgreSQL role + RLS
```

Server Components read data; Client Components handle forms/navigation. Server Actions accept FormData and call core services. No public REST API, queue, worker, shared cache or object store exists yet. Database pool is lazy and process-reused, defaults to 10 connections, and disables prepared statements.

## Identity and tenant boundary

Users are global identities; memberships associate school and role. Platform administration is a flag, not a school role. The selected-school cookie is a preference validated against the session. `withContext` sets user, school and platform flags transaction-locally.

RLS protects against incorrect tenant queries but trusts server context. A compromised database credential or arbitrary SQL execution can set that context. Pre-auth login and session lookup use reviewed SECURITY DEFINER functions; sessions are protected by RLS. The platform flag is verified against the acting user's account in the database. Shared identities cannot be edited by a single school; see [SECURITY.md](SECURITY.md).

## Technical decisions

| Decision | Reason/consequence |
| --- | --- |
| Modular monolith | Shared transactions and one deployment simplify delivery; keep domain services separable |
| PostgreSQL/Drizzle | Relational constraints suit enrollments and ledgers; review migrations and RLS together |
| Server Actions first | Reuse session security for first-party forms; add HTTP handlers for autosave, webhooks or external clients |
| Global identity, tenant profiles | Users may belong to several schools; schools must not modify global privileges or unrelated school records |
| Academic-year enrollments (planned) | Promotion preserves past classes/results |
| Versioned questions/exams (planned) | Bank edits cannot change published assessment content or scoring |
| Separate practice/formal attempts (planned) | Feedback/retry rules differ; practice does not alter formal grades |
| Transactional outbox (planned) | Provider outages do not roll back business records; delivery retries are safe |

## Planned modules and scaling

Modules: identity/access; school setup; academic MIS; attendance/timetable; homework/communications; fees/ledger; question bank/practice; exams/results; reporting/audit. Shared services: authorization, private files, notifications, idempotency and jobs.

Rate limits and the job queue are already shared through PostgreSQL, so several web servers and workers can run side by side. Background work is written to the queue in the same transaction as the business change (outbox) and run by `pnpm worker`, a separate process using the runtime role with `app.worker` context; handlers must be idempotent. File bytes live behind a storage adapter (local disk today) with metadata and access rules in the `files` table. Budget database connections across instances/workers. Benchmark concurrent exam saves. Server deadlines and conditional answer writes must work without an open browser. Avoid network calls within database transactions.

External providers and production hosting remain unselected. See [INTEGRATIONS.md](INTEGRATIONS.md), [DEPLOYMENT.md](DEPLOYMENT.md) and [SECURITY.md](SECURITY.md).
