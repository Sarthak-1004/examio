# Design system

## Existing baseline

Tokens: `apps/web/app/globals.css`. Components: `apps/web/components/ui.tsx` (Button, Input, Select, Field, Card, Badge, Alert, EmptyState, Skeleton), `submit-button.tsx`, `app-shell.tsx`, `data-table.tsx`, `pagination.tsx`, `filter-bar.tsx`, `page-loading.tsx`, `error-view.tsx`, `audit-table.tsx`, `action-form.tsx`. Update this document and code together when changing the visual system.

| Token | Value / use |
| --- | --- |
| brand-50 | `#eef4ff`, light emphasis |
| brand-100 | `#dbe6fe`, secondary sidebar text |
| brand-500 | `#3b6cf6`, accent |
| brand-600 | `#2953e0`, primary action |
| brand-700 | `#1f41b5`, hover/emphasis |
| brand-900 | `#172a63`, navigation |
| Neutral | slate-50 page, white cards, slate-900 primary text, slate-500 secondary, slate-200 borders |
| Semantic | Emerald success, amber pending/warning, red error/destructive, slate neutral |

Typography: Inter via `next/font/google`, system sans-serif fallback. Page title 24px bold, card title 16px semibold, body 14-16px, metadata 12px. Inputs use 16px on mobile. Use tabular numerals for counts, marks and money. Additional language fonts require representative text testing.

## Layout

Use a 4px spacing rhythm: 4/8/12/16/20/24/32/40/48px. Cards: 20px content padding, rounded-xl, subtle shadow/ring. Buttons: rounded-lg. Existing main width is `max-w-6xl`, sidebar 256px, page gutters 16/24/32px.

Mobile first: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px. Sidebar becomes a drawer below `lg`. Tables may scroll inside their container; avoid horizontal page scrolling. Prioritize key columns and link to details. Exam screens must retain accessible navigation and visible save status on small screens.

## Components and states

| Component | Rules |
| --- | --- |
| Button / ButtonLink | Primary/secondary/danger/ghost; verb labels; pending state prevents duplicate submission |
| Field / Input / Select / Textarea | Persistent label; adjacent field errors; connect hints/errors with `aria-describedby`; never echo passwords |
| Card / PageHeader | One page h1; meaningful hierarchy; obvious primary action |
| Badge / Alert | Convey status in words, not color alone; errors use alert semantics |
| EmptyState | Explain absence; distinguish empty data from filtered-out data; show authorized next action |
| DataTable / Pagination / FilterBar | Implemented. Caption and column headers for screen readers; scrolls inside its own focusable region on small screens; `secondary` columns hide below `md`; filters and pages live in the URL (plain GET forms and links, work without JavaScript); filtered-empty and empty states differ. Bulk actions remain planned |
| ActionForm | Implemented. Wraps a server action returning FormState: pending state on its SubmitButton, error message as an alert, success as a status. Submits through `onSubmit` so a validation error never clears what the person typed (React clears inputs after `action`-prop submissions); clears only after success unless `keepValues`. Use it for new forms and row actions |
| Loading / error / not-found | Implemented as route files: skeleton with polite status text; error view with retry, a link home and the support reference only (never the message); not-found that does not reveal whether a record exists |
| Dialog (planned pattern) | Explain consequence, trap focus, support Escape, restore trigger focus |

Loading: stable skeleton/progress text, never false zero counts. Error: clear recovery/retry and safe diagnostic reference. Success: preserve useful context. Offline/unsaved: explicitly distinguish local edits from server acknowledgements.

Target: keyboard operation, visible focus, adequate contrast, accessible names/landmarks, 44px touch targets for new controls, reduced-motion support and polite save announcements. Implemented: skip-to-content link; mobile drawer with focus trap, Escape, close button and focus return; 44px buttons and nav links; `Field` links hints/errors with `aria-describedby` and sets `aria-invalid`; skeletons respect reduced motion. Not yet done: an automated contrast/axe audit. This is a target, not a compliance certification.

Show school timezone beside schedules, unambiguous dates and explicit currencies. Keep internal errors, storage keys and implementation details out of normal user flows.
