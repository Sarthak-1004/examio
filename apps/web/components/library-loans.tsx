import type { MyLoanRow } from "@examio/core";
import { Badge, EmptyState } from "./ui";

/** A student's library books: on loan first (overdue marked), then returned or lost ones. */
export function LibraryLoans({ rows, empty }: { rows: MyLoanRow[]; empty: string }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={`${r.accessionNo}-${r.issuedAt.toISOString()}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-slate-900">{r.title}</p>
            <p className="text-slate-600">{[r.author, `Copy ${r.accessionNo}`].filter(Boolean).join(" · ")}</p>
          </div>
          {r.status === "open" ? (
            r.overdue ? <Badge tone="red">{`Overdue, was due ${r.dueOn}`}</Badge> : <Badge tone="blue">{`Due ${r.dueOn}`}</Badge>
          ) : r.status === "lost" ? (
            <Badge tone="amber">Lost</Badge>
          ) : (
            <Badge tone="slate">{`Returned ${r.closedOn ?? ""}`.trim()}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
