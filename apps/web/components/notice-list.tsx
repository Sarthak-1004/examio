import type { Notice } from "@examio/core";
import { Badge, EmptyState } from "./ui";
import { formatDateTime } from "@/lib/format";

/** Notices addressed to the reader, newest first. */
export function NoticeList({ notices, limit, timeZone }: { notices: Notice[]; limit?: number; timeZone: string }) {
  const shown = limit ? notices.slice(0, limit) : notices;
  if (shown.length === 0) return <EmptyState title="No notices">Notices from the school appear here.</EmptyState>;
  return (
    <ul className="divide-y divide-slate-100">
      {shown.map((n) => (
        <li key={n.id} className="space-y-1 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-900">{n.title}</span>
            {n.sectionLabel && <Badge tone="blue">{n.sectionLabel}</Badge>}
          </div>
          <p className="whitespace-pre-wrap text-slate-700">{n.body}</p>
          <p className="text-xs text-slate-500">
            {n.authorName} · {formatDateTime(n.publishedAt, timeZone)}
          </p>
        </li>
      ))}
    </ul>
  );
}
