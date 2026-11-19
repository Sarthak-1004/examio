import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatPaise, getRun, schoolToday, type SlipRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { approveRunAction, calculateRunAction, payRunAction, paySlipAction, voidPaymentAction } from "../../actions";
import { monthLabel } from "../../labels";

export const metadata: Metadata = { title: "Payroll run" };

const STATUS = { draft: { label: "Draft", tone: "amber" }, approved: { label: "Approved", tone: "blue" }, paid: { label: "Paid", tone: "green" } } as const;

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const isAdmin = s.roles.includes("school_admin");
  const { id } = await params;
  const run = await getRun(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const today = schoolToday(s.timeZone);
  const draft = run.status === "draft";
  const flagged = run.slips.filter((x) => x.flagged).length;
  const unpaid = run.slips.filter((x) => !x.payment).length;
  const mayApprove = draft && isAdmin && run.preparedById !== s.user.id && run.calculatedById !== s.user.id;

  const columns: Column<SlipRow>[] = [
    {
      key: "name",
      header: "Staff member",
      primary: true,
      cell: (r) => (
        <Link href={`/school/payroll/slips/${r.id}`} className="text-brand-700 hover:underline">
          {`${r.name} (${r.employeeNo})`}
        </Link>
      ),
    },
    { key: "days", header: "Payable days", align: "right", cell: (r) => `${r.payableDays} of ${r.workingDays}${r.lopDays !== "0" ? ` (${r.lopDays} unpaid)` : ""}` },
    { key: "gross", header: "Gross", align: "right", secondary: true, cell: (r) => formatPaise(r.grossPaise) },
    { key: "ded", header: "Deductions", align: "right", secondary: true, cell: (r) => formatPaise(r.deductionsPaise) },
    { key: "net", header: "Net pay", align: "right", cell: (r) => (r.flagged ? <Badge tone="red">{formatPaise(r.netPaise)}</Badge> : formatPaise(r.netPaise)) },
    ...(draft
      ? []
      : [
          {
            key: "pay",
            header: "Payment",
            cell: (r: SlipRow) =>
              r.payment ? (
                <details className="text-sm">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-slate-100">
                    <Badge tone="green">{`Paid ${r.payment.paidOn}`}</Badge>
                  </summary>
                  <p className="mt-1 text-slate-600">{`Reference ${r.payment.reference}`}</p>
                  <ActionForm action={voidPaymentAction} className="mt-2 w-60 space-y-2">
                    <input type="hidden" name="paymentId" value={r.payment.id} />
                    <Field label="Reason to void" htmlFor={`void-${r.id}`}>
                      <Input id={`void-${r.id}`} name="reason" required minLength={3} maxLength={300} />
                    </Field>
                    <SubmitButton variant="danger" pendingText="Voiding…" aria-label={`Void payment of ${r.name}`}>
                      Void payment
                    </SubmitButton>
                  </ActionForm>
                </details>
              ) : (
                <details className="text-sm">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Record payment for ${r.name}`}</summary>
                  <ActionForm action={paySlipAction} className="mt-2 w-60 space-y-2">
                    <input type="hidden" name="slipId" value={r.id} />
                    <Field label="Paid on" htmlFor={`paid-${r.id}`}>
                      <Input id={`paid-${r.id}`} name="paidOn" type="date" required defaultValue={today} />
                    </Field>
                    <Field label="Reference" htmlFor={`ref-${r.id}`}>
                      <Input id={`ref-${r.id}`} name="reference" required maxLength={80} />
                    </Field>
                    <SubmitButton variant="secondary" pendingText="Saving…">
                      Record payment
                    </SubmitButton>
                  </ActionForm>
                </details>
              ),
          },
        ]),
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
        description={[
          `${run.periodStart} to ${run.periodEnd}`,
          `prepared by ${run.preparedBy}`,
          run.calculatedAt ? `calculated ${formatDateTime(run.calculatedAt, s.timeZone)}${run.calculatedBy ? ` by ${run.calculatedBy}` : ""}` : null,
          run.approvedAt ? `approved ${formatDateTime(run.approvedAt, s.timeZone)} by ${run.approvedBy ?? "an administrator"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        action={<Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>}
      />
      {flagged > 0 && (
        <div className="mb-4">
          <Alert tone="amber">{`${flagged} payslip${flagged === 1 ? " has" : "s have"} deductions larger than earnings. Fix the salary and recalculate before approval.`}</Alert>
        </div>
      )}
      <ul className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(
          [
            ["Gross", run.totals.grossPaise],
            ["Deductions", run.totals.deductionsPaise],
            ["Net pay", run.totals.netPaise],
          ] as const
        ).map(([label, value]) => (
          <li key={label}>
            <Card className="p-5">
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{formatPaise(value)}</p>
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
          {draft && (
            <Card>
              <CardHeader title="Recalculate" description="Uses today's salaries, attendance, leave and approved adjustments." />
              <ActionForm action={calculateRunAction} className="p-5">
                <input type="hidden" name="runId" value={run.id} />
                <SubmitButton variant="secondary" pendingText="Calculating…">Recalculate</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {draft && (
            <Card>
              <CardHeader title="Approve" description="An administrator who did not prepare or calculate the run approves it. Approval locks it." />
              {mayApprove ? (
                <ActionForm action={approveRunAction} className="p-5">
                  <input type="hidden" name="runId" value={run.id} />
                  <SubmitButton pendingText="Approving…">Approve and lock</SubmitButton>
                </ActionForm>
              ) : (
                <p className="px-5 pb-4 text-sm text-slate-600">{isAdmin ? "You prepared or calculated this run, so another administrator approves it." : "A school administrator approves payroll."}</p>
              )}
            </Card>
          )}
          {!draft && (
            <Card>
              <CardHeader title="Payment" description={unpaid ? `${unpaid} payslip${unpaid === 1 ? "" : "s"} not yet paid.` : "Every payslip is paid."} />
              <div className="space-y-4 p-5">
                <a href={`/school/payroll/runs/${run.id}/bank`} className="inline-block text-sm font-medium text-brand-700 hover:underline">
                  Download the bank file (CSV)
                </a>
                {unpaid > 0 && (
                  <ActionForm action={payRunAction} className="space-y-3">
                    <input type="hidden" name="runId" value={run.id} />
                    <Field label="Paid on" htmlFor="run-paid">
                      <Input id="run-paid" name="paidOn" type="date" required defaultValue={today} />
                    </Field>
                    <Field label="Bank reference" htmlFor="run-ref">
                      <Input id="run-ref" name="reference" required maxLength={80} />
                    </Field>
                    <SubmitButton pendingText="Saving…">Mark all unpaid as paid</SubmitButton>
                  </ActionForm>
                )}
              </div>
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
