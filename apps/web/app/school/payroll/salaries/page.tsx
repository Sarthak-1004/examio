import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, listSalaries, type SalaryRow } from "@examio/core";
import { DataTable, type Column } from "@/components/data-table";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Salaries" };

export default async function SalariesPage() {
  const s = await requireSchoolRole("school_admin", "finance");
  const rows = await listSalaries(db, s.ctx, s.ctx.schoolId);
  const columns: Column<SalaryRow>[] = [
    {
      key: "name",
      header: "Staff member",
      primary: true,
      cell: (r) => (
        <Link href={`/school/payroll/salaries/${r.staffId}`} className="text-brand-700 hover:underline">
          {`${r.name} (${r.employeeNo})`}
        </Link>
      ),
    },
    { key: "basic", header: "Monthly basic", align: "right", cell: (r) => (r.basicPaise === null ? <Badge tone="amber">No salary</Badge> : formatPaise(r.basicPaise)) },
    { key: "from", header: "Since", secondary: true, cell: (r) => r.effectiveFrom ?? "—" },
  ];
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/payroll" className="text-brand-600 hover:text-brand-700">
          ← Payroll
        </Link>
      </p>
      <PageHeader title="Salaries" description="The salary in effect today for each current staff member. Each change is a new version from a date." />
      <Card>
        <DataTable caption="Salaries" columns={columns} rows={rows} rowKey={(r) => r.staffId} empty={{ title: "No current staff" }} />
      </Card>
    </>
  );
}
