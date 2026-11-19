import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, listPayrollAdjustments, listSalaries, type AdjustmentRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { adjustmentAction, decideAdjustmentAction } from "../actions";
import { monthLabel } from "../labels";

export const metadata: Metadata = { title: "Payroll adjustments" };

const STATUS = { pending: { label: "Pending", tone: "amber" }, approved: { label: "Approved", tone: "green" }, rejected: { label: "Rejected", tone: "red" } } as const;

export default async function AdjustmentsPage() {
  const s = await requireSchoolRole("school_admin", "finance");
  const isAdmin = s.roles.includes("school_admin");
  const [rows, staff] = await Promise.all([listPayrollAdjustments(db, s.ctx, s.ctx.schoolId), listSalaries(db, s.ctx, s.ctx.schoolId)]);
  const columns: Column<AdjustmentRow>[] = [
    { key: "staff", header: "Staff member", primary: true, cell: (r) => r.staff },
    { key: "what", header: "Adjustment", cell: (r) => `${r.kind === "earning" ? "Arrears" : "Recovery"} ${formatPaise(r.amountPaise)} · ${r.reason}` },
    { key: "status", header: "Status", cell: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> },
    { key: "paid", header: "Paid in", secondary: true, cell: (r) => (r.appliedMonth ? monthLabel(r.appliedMonth) : r.status === "approved" ? "Next draft run" : "—") },
    {
      key: "decide",
      header: "Decision",
      cell: (r) =>
        r.status === "pending" && isAdmin ? (
          <ActionForm action={decideAdjustmentAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="adjustmentId" value={r.id} />
            <label className="sr-only" htmlFor={`note-${r.id}`}>{`Note for ${r.staff}`}</label>
            <Input id={`note-${r.id}`} name="note" placeholder="Note (needed to reject)" maxLength={300} className="w-44" />
            <SubmitButton name="decision" value="approve" pendingText="Saving…" aria-label={`Approve adjustment for ${r.staff}`}>
              Approve
            </SubmitButton>
            <SubmitButton name="decision" value="reject" variant="secondary" pendingText="Saving…" aria-label={`Reject adjustment for ${r.staff}`}>
              Reject
            </SubmitButton>
          </ActionForm>
        ) : (
          [r.decidedBy, r.decisionNote].filter(Boolean).join(" · ") || (r.status === "pending" ? "Waiting for an administrator" : "—")
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
      <PageHeader title="Payroll adjustments" description="Corrections after a run is approved: arrears or a recovery, decided by someone other than the requester and paid by the next draft run." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <DataTable caption="Payroll adjustments" columns={columns} rows={rows} rowKey={(r) => r.id} empty={{ title: "No adjustments" }} />
        </Card>
        <Card>
          <CardHeader title="Request an adjustment" />
          <ActionForm action={adjustmentAction} className="space-y-4 p-5">
            <Field label="Staff member" htmlFor="adj-staff">
              <Select id="adj-staff" name="staffId" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {staff.map((p) => (
                  <option key={p.staffId} value={p.staffId}>{`${p.name} (${p.employeeNo})`}</option>
                ))}
              </Select>
            </Field>
            <Field label="Kind" htmlFor="adj-kind">
              <Select id="adj-kind" name="kind" defaultValue="earning">
                <option value="earning">Arrears (paid to the staff member)</option>
                <option value="deduction">Recovery (deducted)</option>
              </Select>
            </Field>
            <Field label="Amount (₹)" htmlFor="adj-amount">
              <Input id="adj-amount" name="amount" required inputMode="decimal" />
            </Field>
            <Field label="Reason (shown on the payslip)" htmlFor="adj-reason">
              <Input id="adj-reason" name="reason" required minLength={3} maxLength={200} />
            </Field>
            <SubmitButton pendingText="Requesting…">Request</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
