import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatPaise, getRun, type SlipRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { calculateRunAction } from "../../actions";
import { monthLabel } from "../../labels";

export const metadata: Metadata = { title: "Payroll run" };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const { id } = await params;
  const run = await getRun(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const flagged = run.slips.filter((x) => x.flagged).length;
  const columns: Column<SlipRow>[] = [
    { key: "name", header: "Staff member", primary: true, cell: (r) => `${r.name} (${r.employeeNo})` },
    { key: "days", header: "Payable days", align: "right", cell: (r) => `${r.payableDays} of ${r.workingDays}${r.lopDays !== "0" ? ` (${r.lopDays} unpaid)` : ""}` },
    { key: "gross", header: "Gross", align: "right", cell: (r) => formatPaise(r.grossPaise) },
    { key: "ded", header: "Deductions", align: "right", secondary: true, cell: (r) => formatPaise(r.deductionsPaise) },
    { key: "net", header: "Net pay", align: "right", cell: (r) => (r.flagged ? <Badge tone="red">{formatPaise(r.netPaise)}</Badge> : formatPaise(r.netPaise)) },
    {
      key: "detail",
      header: "Details",
      cell: (r) => (
        <details className="text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Payslip of ${r.name}`}</summary>
          <dl className="mt-2 w-64 space-y-1">
            <div className="flex justify-between gap-3">
              <dt>{`Basic (${formatPaise(r.basicPaise)} a month)`}</dt>
              <dd className="tabular-nums">{formatPaise(r.earnedBasicPaise)}</dd>
            </div>
            {r.lines.map((l) => (
              <div key={l.componentId} className="flex justify-between gap-3">
                <dt>{l.kind === "deduction" ? `− ${l.name}` : l.name}</dt>
                <dd className="tabular-nums">{formatPaise(l.amountPaise)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ),
    },
  ];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/payroll" className="text-brand-600 hover:text-brand-700">
          ← Payroll
        </Link>
      </p>
      <PageHeader
        title={`Payroll for ${monthLabel(run.periodStart)}`}
        description={`${run.periodStart} to ${run.periodEnd} · prepared by ${run.preparedBy}${run.calculatedAt ? ` · calculated ${formatDateTime(run.calculatedAt, s.timeZone)}${run.calculatedBy ? ` by ${run.calculatedBy}` : ""}` : ""}`}
        action={<Badge tone={run.status === "draft" ? "amber" : "green"}>{run.status === "draft" ? "Draft" : run.status === "approved" ? "Approved" : "Paid"}</Badge>}
      />
      {flagged > 0 && (
        <div className="mb-4">
          <Alert tone="amber">{`${flagged} payslip${flagged === 1 ? " has" : "s have"} deductions larger than earnings. Check those salaries.`}</Alert>
        </div>
      )}
      <ul className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          ["Gross", run.totals.grossPaise],
          ["Deductions", run.totals.deductionsPaise],
          ["Net pay", run.totals.netPaise],
        ].map(([label, value]) => (
          <li key={label as string}>
            <Card className="p-5">
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{formatPaise(value as number)}</p>
            </Card>
          </li>
        ))}
      </ul>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Payslips" />
          <DataTable caption="Payslips" columns={columns} rows={run.slips} rowKey={(r) => r.id} empty={{ title: "No payslips", body: "Record salaries, then recalculate." }} />
        </Card>
        <div className="min-w-0 space-y-6">
          {run.status === "draft" && (
            <Card>
              <CardHeader title="Recalculate" description="Uses today's salaries, attendance and leave. Approval follows in a later release." />
              <ActionForm action={calculateRunAction} className="p-5">
                <input type="hidden" name="runId" value={run.id} />
                <SubmitButton pendingText="Calculating…">Recalculate</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card>
            <CardHeader title="Not included" description="Staff employed this month without a salary in effect." />
            {run.notIncluded.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-slate-600">Everyone is included.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {run.notIncluded.map((n) => (
                  <li key={n.staffId} className="px-5 py-2">
                    <Link href={`/school/payroll/salaries/${n.staffId}`} className="text-brand-700 hover:underline">{`${n.name} (${n.employeeNo})`}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
