import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, listPlatformUsage, type SchoolUsageRow } from "@examio/core";
import { DataTable, type Column } from "@/components/data-table";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Usage" };

const ACCESS = { active: { label: "Active", tone: "green" }, due: { label: "Renewal due", tone: "amber" }, grace: { label: "In grace", tone: "amber" }, read_only: { label: "Read-only", tone: "red" } } as const;
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Per-school counts (Phase 15.2). Records stay closed; open them only through a support access grant. */
export default async function UsagePage() {
  const s = await requirePlatformAdmin();
  const rows = await listPlatformUsage(db, s.ctx);
  const total = rows.reduce(
    (a, r) => ({ students: a.students + r.activeStudents, staff: a.staff + r.activeStaff, attempts: a.attempts + r.examAttemptsMonth, bytes: a.bytes + r.fileBytes, dead: a.dead + r.deadJobs, unpaid: a.unpaid + r.unpaidPaise }),
    { students: 0, staff: 0, attempts: 0, bytes: 0, dead: 0, unpaid: 0 },
  );
  const columns: Column<SchoolUsageRow>[] = [
    {
      key: "school",
      header: "School",
      primary: true,
      cell: (r) => (
        <Link href={`/admin/schools/${r.schoolId}`} className="text-brand-700 hover:underline">
          {`${r.name} (${r.code})`}
        </Link>
      ),
    },
    { key: "plan", header: "Plan", cell: (r) => <span className="flex flex-wrap items-center gap-2">{r.plan ?? "No plan"} <Badge tone={ACCESS[r.access].tone}>{ACCESS[r.access].label}</Badge>{r.status === "suspended" && <Badge tone="red">Suspended</Badge>}</span> },
    { key: "people", header: "Students · staff", align: "right", cell: (r) => `${r.activeStudents} · ${r.activeStaff}` },
    { key: "month", header: "This month", align: "right", secondary: true, cell: (r) => `${r.attendanceMarksMonth} marks · ${r.examAttemptsMonth} attempts` },
    { key: "files", header: "Files", align: "right", secondary: true, cell: (r) => mb(r.fileBytes) },
    { key: "jobs", header: "Failed jobs", align: "right", cell: (r) => (r.deadJobs ? <Badge tone="red">{r.deadJobs}</Badge> : "0") },
    { key: "unpaid", header: "Unpaid invoices", align: "right", cell: (r) => (r.unpaidInvoices ? `${r.unpaidInvoices} · ${formatPaise(r.unpaidPaise)}` : "—") },
    { key: "last", header: "Last activity", secondary: true, cell: (r) => (r.lastActivity ? formatDateTime(r.lastActivity) : "—") },
  ];
  return (
    <>
      <PageHeader title="Usage" description="Counts per school. School records are not shown here; open them only through a support access grant on the school's page, which the school's administrators can see." />
      <ul className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {(
          [
            ["Schools", String(rows.length)],
            ["Active students", String(total.students)],
            ["Exam attempts this month", String(total.attempts)],
            ["Stored files", mb(total.bytes)],
            ["Unpaid invoices", formatPaise(total.unpaid)],
          ] as const
        ).map(([k, v]) => (
          <li key={k}>
            <Card className="p-5">
              <p className="text-sm text-slate-500">{k}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{v}</p>
            </Card>
          </li>
        ))}
      </ul>
      {total.dead > 0 && (
        <p className="mb-4 text-sm text-red-700">
          {`${total.dead} background job${total.dead === 1 ? "" : "s"} failed. Retry them under `}
          <Link href="/admin/system" className="font-medium underline">
            System
          </Link>
          .
        </p>
      )}
      <Card>
        <DataTable caption="Usage by school" columns={columns} rows={rows} rowKey={(r) => r.schoolId} empty={{ title: "No schools yet" }} />
      </Card>
    </>
  );
}
