import type { AuditRow, Page } from "@examio/core";
import { DataTable, type Column } from "./data-table";
import { FilterBar } from "./filter-bar";
import { Pagination } from "./pagination";
import { Card } from "./ui";
import { formatDateTime } from "@/lib/format";

const details = (data: unknown) => {
  if (data === null || data === undefined) return "—";
  const text = JSON.stringify(data);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

const columns = (timeZone: string): Column<AuditRow>[] => [
  { key: "time", header: "Time", primary: true, cell: (r) => <span className="whitespace-nowrap font-normal">{formatDateTime(r.createdAt, timeZone, { seconds: true })}</span> },
  { key: "action", header: "Action", cell: (r) => <span className="font-mono text-xs">{r.action}</span> },
  { key: "actor", header: "By", cell: (r) => r.actorName ?? (r.actorUserId ? "Platform administrator" : "System") },
  { key: "entity", header: "Record", secondary: true, cell: (r) => (r.entityType ? `${r.entityType}` : "—") },
  { key: "data", header: "Details", secondary: true, cell: (r) => <span className="break-all text-xs text-slate-600">{details(r.data)}</span> },
];

/** Read-only audit log with action search, date range and pagination, all in the URL. */
export function AuditTable({ basePath, page, search, from, to, timeZone }: { basePath: string; page: Page<AuditRow>; search: string; from: string; to: string; timeZone: string }) {
  const filtered = search !== "" || from !== "" || to !== "";
  return (
    <Card>
      <FilterBar
        basePath={basePath}
        search={search}
        searchLabel="Action contains"
        dates={[
          { name: "from", label: "From", value: from },
          { name: "to", label: "To", value: to },
        ]}
      />
      <DataTable
        caption="Audit log"
        columns={columns(timeZone)}
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={filtered ? { title: "No events match", body: "Try a wider date range or a different search." } : { title: "No events yet" }}
      />
      <Pagination
        basePath={basePath}
        params={{ q: search || undefined, from: from || undefined, to: to || undefined }}
        page={page.page}
        pageCount={page.pageCount}
        total={page.total}
        pageSize={page.pageSize}
        noun="events"
      />
    </Card>
  );
}

export function auditDates(params: Record<string, string | string[] | undefined>): { from: string; to: string } {
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  return { from: day(params.from), to: day(params.to) };
}
