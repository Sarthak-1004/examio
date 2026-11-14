import Link from "next/link";
import { cx } from "./ui";

/**
 * Server-side pagination as plain links, so it works without JavaScript and every page has a
 * shareable URL. Keeps the other query parameters (search, filters) and drops `page` when it
 * would be 1.
 */
export function Pagination({
  basePath,
  params,
  page,
  pageCount,
  total,
  pageSize,
  noun,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  /** Plural noun for the summary, e.g. "schools". */
  noun: string;
}) {
  const href = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== "page") q.set(k, v);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const link = "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-inset ring-slate-300";

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
      <p className="text-sm text-slate-600" aria-live="polite">
        {total === 0 ? `No ${noun}` : `${from}–${to} of ${total} ${noun}`}
        {pageCount > 1 && ` · page ${Math.min(page, pageCount)} of ${pageCount}`}
      </p>
      {pageCount > 1 && (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={href(Math.min(page - 1, pageCount))} rel="prev" className={cx(link, "text-slate-800 hover:bg-slate-50")}>
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={cx(link, "text-slate-400")}>
              Previous
            </span>
          )}
          {page < pageCount ? (
            <Link href={href(page + 1)} rel="next" className={cx(link, "text-slate-800 hover:bg-slate-50")}>
              Next
            </Link>
          ) : (
            <span aria-disabled="true" className={cx(link, "text-slate-400")}>
              Next
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
