import type { ReactNode } from "react";
import { EmptyState, cx } from "./ui";

/**
 * Accessible data table (server component). The caption names the table for screen readers;
 * column headers use `scope="col"`. On narrow screens the table scrolls inside its own
 * container (focusable, so keyboard users can scroll it) instead of the whole page.
 * Columns marked `secondary` are hidden below the `md` breakpoint.
 */
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  secondary?: boolean;
  /** Use for the column that names the row; rendered as a row header. */
  primary?: boolean;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Shown instead of the table when there are no rows. Say whether filters hid them. */
  empty: { title: string; body?: ReactNode };
}) {
  if (rows.length === 0) return <EmptyState title={empty.title}>{empty.body}</EmptyState>;
  const align = (c: Column<T>) => (c.align === "right" ? "text-right" : "text-left");
  const hide = (c: Column<T>) => (c.secondary ? "hidden md:table-cell" : "");
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx("px-5 py-3 font-semibold text-slate-700", align(c), hide(c))}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-slate-50">
              {columns.map((c) =>
                c.primary ? (
                  <th key={c.key} scope="row" className={cx("px-5 py-3 font-medium text-slate-900", align(c), hide(c))}>
                    {c.cell(row)}
                  </th>
                ) : (
                  <td key={c.key} className={cx("px-5 py-3 text-slate-700", align(c), hide(c))}>
                    {c.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
