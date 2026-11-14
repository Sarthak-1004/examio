import type { Metadata } from "next";
import Link from "next/link";
import { parsePageRequest, searchSchools, type SchoolListRow, type SchoolStatus } from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { ButtonLink, Card, PageHeader, SchoolStatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Schools" };

const STATUSES: SchoolStatus[] = ["onboarding", "active", "suspended"];

const columns: Column<SchoolListRow>[] = [
  {
    key: "name",
    header: "School",
    primary: true,
    cell: (s) => (
      <Link href={`/admin/schools/${s.id}`} className="text-brand-700 hover:underline">
        {s.name}
      </Link>
    ),
  },
  { key: "code", header: "Code", cell: (s) => <span className="font-mono">{s.code}</span> },
  { key: "board", header: "Board · medium", secondary: true, cell: (s) => `${s.board} · ${s.medium}` },
  { key: "accounts", header: "Accounts", align: "right", secondary: true, cell: (s) => <span className="tabular-nums">{s.memberCount}</span> },
  { key: "status", header: "Status", cell: (s) => <SchoolStatusBadge status={s.status} /> },
];

export default async function SchoolsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requirePlatformAdmin();
  const params = await searchParams;
  const req = parsePageRequest(params);
  const rawStatus = typeof params.status === "string" ? params.status : "";
  const status = (STATUSES as string[]).includes(rawStatus) ? (rawStatus as SchoolStatus) : undefined;
  const result = await searchSchools(db, s.ctx, { ...req, status });
  const filtered = req.search !== "" || status !== undefined;

  return (
    <>
      <PageHeader
        title="Schools"
        description={filtered ? `${result.total} matching` : `${result.total} school${result.total === 1 ? "" : "s"} on the platform`}
        action={<ButtonLink href="/admin/schools/new">+ Add school</ButtonLink>}
      />
      <Card>
        <FilterBar
          basePath="/admin"
          search={req.search}
          searchLabel="Search by name or code"
          selects={[
            {
              name: "status",
              label: "Status",
              value: status ?? "",
              options: [{ value: "", label: "Any status" }, ...STATUSES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))],
            },
          ]}
        />
        <DataTable
          caption="Schools"
          columns={columns}
          rows={result.rows}
          rowKey={(r) => r.id}
          empty={
            filtered
              ? { title: "No schools match", body: "Try a different search, or clear the filters." }
              : { title: "No schools yet", body: "Add the first school to get started." }
          }
        />
        <Pagination
          basePath="/admin"
          params={{ q: req.search || undefined, status }}
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
          pageSize={result.pageSize}
          noun="schools"
        />
      </Card>
    </>
  );
}
