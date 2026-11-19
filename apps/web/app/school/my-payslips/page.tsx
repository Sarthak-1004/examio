import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, getMyEmployment, listMyPayslips, type MyPayslipRow } from "@examio/core";
import { DataTable, type Column } from "@/components/data-table";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My payslips" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TYPE: Record<string, string> = { permanent: "Permanent", probation: "Probation", contract: "Contract", part_time: "Part-time", temporary: "Temporary" };
const CHANGE: Record<string, string> = { employment_type: "Employment type", department: "Department", designation: "Designation", confirmed: "Confirmation", left: "Left", rejoined: "Rejoined" };

export default async function MyPayslipsPage() {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  const [slips, me] = await Promise.all([listMyPayslips(db, s.ctx, s.ctx.schoolId), getMyEmployment(db, s.ctx, s.ctx.schoolId)]);
  const columns: Column<MyPayslipRow>[] = [
    {
      key: "month",
      header: "Month",
      primary: true,
      cell: (r) => (
        <Link href={`/school/my-payslips/${r.id}`} className="text-brand-700 hover:underline">
          {`${MONTHS[Number(r.month.slice(5, 7)) - 1]} ${r.month.slice(0, 4)}`}
        </Link>
      ),
    },
    { key: "net", header: "Net pay", align: "right", cell: (r) => formatPaise(r.netPaise) },
    { key: "paid", header: "Payment", cell: (r) => (r.paidOn ? <Badge tone="green">{`Paid ${r.paidOn}`}</Badge> : <Badge tone="blue">Approved</Badge>) },
  ];
  return (
    <>
      <PageHeader title="My payslips" description="Your payslips once the school approves each month's payroll, and your employment record." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Payslips" />
          <DataTable caption="My payslips" columns={columns} rows={slips} rowKey={(r) => r.id} empty={{ title: "No payslips yet", body: "They appear here after the school approves a month's payroll." }} />
        </Card>
        <Card>
          <CardHeader title="Employment" />
          {!me ? (
            <EmptyState title="No staff record">Your school has not added your staff details yet.</EmptyState>
          ) : (
            <>
              <dl className="space-y-2 px-5 pb-4 text-sm">
                {[
                  ["Employee no.", me.employeeNo],
                  ["Joined", me.joinedOn ?? "—"],
                  ["Type", me.employmentType ? (TYPE[me.employmentType] ?? me.employmentType) : "—"],
                  ["Department", me.department ?? "—"],
                  ["Designation", me.designation ?? "—"],
                  ["Confirmed", me.confirmedOn ?? "—"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="font-medium text-slate-900">{v}</dd>
                  </div>
                ))}
              </dl>
              {me.history.length > 0 && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
                  {me.history.map((h, i) => (
                    <li key={`${h.effectiveOn}-${h.kind}-${i}`} className="px-5 py-2 text-slate-700">
                      {`${h.effectiveOn}: ${CHANGE[h.kind] ?? h.kind}${h.toValue ? ` → ${h.toValue}` : ""}`}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
