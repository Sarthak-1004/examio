# Test plan

## Current suites and commands

| Check | Command | Coverage / side effects |
| --- | --- | --- |
| TypeScript | `pnpm typecheck` | All packages; passed 2026-11-13 |
| Core Vitest | `pnpm test` | Passwords, login, sessions, onboarding, RLS, identity/privilege boundaries, rate limits, capabilities, account codes, invitations, support access, administrator bootstrap and two-step sign-in; automatically migrates test DB, truncates fixture tables; 141 tests passed 2026-11-14 |
| Browser Playwright | `pnpm test:e2e` | Builds app; drops, recreates and seeds the disposable `examio_e2e` database; runs desktop/mobile on port 3100 (Edge, or bundled Chromium with `E2E_BROWSER_CHANNEL=chromium`); 28 passed 2026-11-14 |
| CI | `.github/workflows/ci.yml` | All of the above on GitHub Actions with throwaway PostgreSQL 17 and bundled Chromium; passed on the first push 2026-11-14 |
| Build | `pnpm build` | Production compilation; font fetch may require network |

Current test files: `packages/core/tests/` (auth, tenant-isolation, identity-boundaries, rate-limit, capabilities, account-recovery, invitations, support-access, bootstrap-admin, mfa, safety, paging, jobs, notifications, idempotency-logging, files, ops, worker-tick); `apps/web/e2e/` (foundation, accessibility, operations, screenshots). Last local run 2026-11-14: 205 integration tests and 28 browser tests passed. Known: an intermittent Vitest worker crash on Windows (exit 0xC0000409), not an assertion failure; see TASKS.md.

Never run fixtures against live data. Every destructive script and fixture calls `assertDisposableDatabase`: the database must be local, named `*_test` or `*_e2e`, and not the one in `DATABASE_URL`/`DATABASE_OWNER_URL`. The browser-test server receives the e2e database URL through `e2e/start-server.mjs`, so the preparation step still sees the real development URL and the guard can compare. Screenshots alone are not visual regression assertions.

## Required test matrix

| Area | Critical cases |
| --- | --- |
| Identity | Correct/wrong/unknown credentials; phone formatting/shared siblings; disabled account; oversized input; forged cookie; reset/invite expiry/replay; concurrent token consumption; other-session revocation |
| Isolation | Wrong school in path/body/cookie; no context; spoofed school; wrong role; revoked membership; shared global user; self-escalation; privileged account attachment; teacher assignments; revoked guardian link; suspension races |
| Academic MIS | Duplicate admission/roll; cross-school section/subject FK; invalid dates; historical enrollment; promotion twice; transfer; concurrent roster edits; import stale preview/retry/row errors |
| Attendance/timetable | Unique date/session entries; late/excused/missing denominators; correction locks; local midnight/timezone boundaries; teacher/section/room overlap |
| Homework/files | Assignment scope; invalid file MIME/size; malicious name; unscanned/private file; late submission policy; unauthorized download/export |
| Fees | Minor-unit arithmetic; discounts/tax boundaries; zero/negative amount; overpayment; wrong currency; duplicate/out-of-order callback; invalid signature; timeout-after-success; approval separation; immutable reversal |
| Questions/practice | Published version immutability; answer-key omission; subject assignment; practice attempt limits; feedback timing; practice excluded from formal results |
| Exams | Start exactly at open/close; duplicate/concurrent starts; deadline cap; server clock; refresh/reconnect; stale revisions; autosave out of order; final save vs submit race; duplicate submit; worker retry; cancellation/accommodation |
| Results | Correct/incorrect/unanswered scoring; negative marking/floor; rounding/grade boundaries; manual mark bounds; incomplete grading blocks release; own/child visibility; correction revisions; offline marks bounds, absent/exempt versus zero, unassigned-teacher and out-of-section rejection, incomplete register blocks lock, stale-save conflict, cross-school isolation |
| Shared UI | Skip link first; drawer focus trap/Escape/return focus; URL-driven search/filter/pagination; safe fallback for malformed page parameters; not-found without disclosure |
| Jobs/files | Outbox atomicity; dedupe; retry/backoff; dead letter and admin retry; lease recovery; no double claim across workers; quarantine until scanned; infected rejection and purge; scanner outage retry; type/extension/size/name validation; uploader/admin/support-grant visibility; checksum mismatch; export expiry |
| Operations | Provider outages; DB connection exhaustion; backup restore; secrets redaction; failed migration; rollback compatibility; alerts and dead-letter replay |

## Test levels

Unit tests cover deterministic validation/calculations/state transitions. Integration tests exercise real PostgreSQL constraints, transactions, RLS and concurrency using the restricted app role; owner role only arranges fixtures/asserts ground truth. API/action tests cover parsing, authentication, error contracts and idempotency. E2E tests cover critical role journeys and server-side negative cases, not just hidden UI controls.

Use controlled clocks for deadline/expiry tests. Include school-local dates crossing UTC boundaries. Test multi-tab edits and network drop after the server commits but before the client receives acknowledgement. Property-based checks may help arithmetic/state invariants where valuable, without duplicating implementation line-for-line.

## Accessibility, performance and release acceptance

Keyboard-only desktop/mobile navigation; visible focus; labeled fields/errors; drawer/dialog focus/Escape; sensible screen-reader announcements; layout at narrow widths; no answer loss on navigation. Validate contrast and language fonts on actual content.

Agree school count, peak simultaneous attempts, answer size/save interval, worker throughput and DB pool budget before load testing. Proposed p95 answer-save target is under 2 seconds at agreed load; report error rates and no-loss/idempotency invariants as well as latency. Do not claim capacity without measured workload/results.

Release gates: relevant typecheck/build/tests pass; migrations tested on representative disposable copy; all new tenant tables have negative isolation coverage; no unresolved critical authorization/data-loss issue; no real secrets/demo credentials in release; role journeys pass; backup restore/alerts rehearsed; rollback plan reviewed; documentation and task statuses match behavior. Earlier pilot releases apply these gates to their delivered scope.
