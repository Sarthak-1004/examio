import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, listComponents, listRuns, type ComponentRow, type RunRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { componentAction, componentArchiveAction, createRunAction } from "./actions";
import { CALC_LABEL, monthLabel } from "./labels";

export const metadata: Metadata = { title: "Payroll" };

const RUN_STATUS: Record<string, { label: string; tone: "amber" | "green" | "blue" }> = { draft: { label: "Draft", tone: "amber" }, approved: { label: "Approved", tone: "blue" }, paid: { label: "Paid", tone: "green" } };

export default async function PayrollPage() {
  const s = await requireSchoolRole("school_admin", "finance");
  const isAdmin = s.roles.includes("school_admin");
  const [runs, components] = await Promise.all([listRuns(db, s.ctx, s.ctx.schoolId), listComponents(db, s.ctx, s.ctx.schoolId)]);
  const runColumns: Column<RunRow>[] = [
    {
      key: "month",
      header: "Month",
      primary: true,
      cell: (r) => (
        <Link href={`/school/payroll/runs/${r.id}`} className="text-brand-700 hover:underline">
          {monthLabel(r.periodStart)}
        </Link>
      ),
    },
    { key: "status", header: "Status", cell: (r) => <Badge tone={RUN_STATUS[r.status]!.tone}>{RUN_STATUS[r.status]!.label}</Badge> },
    { key: "staff", header: "Payslips", align: "right", cell: (r) => r.staff },
    { key: "net", header: "Net pay", align: "right", cell: (r) => formatPaise(r.netPaise) },
    { key: "calc", header: "Calculated", secondary: true, cell: (r) => (r.calculatedAt ? formatDateTime(r.calculatedAt, s.timeZone) : "—") },
  ];
  const componentColumns: Column<ComponentRow>[] = [
    { key: "name", header: "Component", primary: true, cell: (c) => (c.archived ? <span className="text-slate-500">{c.name} <Badge>Archived</Badge></span> : c.name) },
    { key: "kind", header: "Kind", cell: (c) => (c.kind === "earning" ? "Earning" : "Deduction") },
    { key: "calc", header: "Calculation", cell: (c) => `${CALC_LABEL[c.calc]}${c.calc === "fixed" && !c.prorate ? ", not prorated" : ""}${c.capPaise !== null ? `, at most ${formatPaise(c.capPaise)}` : ""}` },
    ...(isAdmin
      ? [
          {
            key: "act",
            header: "Actions",
            cell: (c: ComponentRow) => (
              <ActionForm action={componentArchiveAction} inline>
                <input type="hidden" name="componentId" value={c.id} />
                <input type="hidden" name="archived" value={c.archived ? "0" : "1"} />
                <SubmitButton variant="ghost" pendingText="Saving…" aria-label={`${c.archived ? "Restore" : "Archive"} ${c.name}`}>
                  {c.archived ? "Restore" : "Archive"}
                </SubmitButton>
              </ActionForm>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Monthly payroll from salaries, staff attendance and leave. Components are defined by the school; no statutory rules are built in."
        action={
          <span className="flex flex-wrap gap-4 text-sm font-medium">
            <Link href="/school/payroll/salaries" className="text-brand-700 hover:underline">
              Salaries
            </Link>
            <Link href="/school/payroll/adjustments" className="text-brand-700 hover:underline">
              Adjustments
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Payroll runs" description="One run per month." />
            <DataTable caption="Payroll runs" columns={runColumns} rows={runs} rowKey={(r) => r.id} empty={{ title: "No payroll runs yet", body: "Record salaries first, then start a month." }} />
          </Card>
          <Card>
            <CardHeader title="Components" description="Earnings and deductions used in salaries." />
            <DataTable caption="Payroll components" columns={componentColumns} rows={components} rowKey={(c) => c.id} empty={{ title: "No components yet", body: isAdmin ? "Add earnings such as HRA and deductions such as PF." : "An administrator adds them." }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Start a month" />
            <ActionForm action={createRunAction} className="space-y-4 p-5">
              <Field label="Month" htmlFor="run-month" hint="Calculated straight away; recalculate it as often as needed while it is a draft.">
                <Input id="run-month" name="month" type="month" required />
              </Field>
              <SubmitButton pendingText="Calculating…">Start and calculate</SubmitButton>
            </ActionForm>
          </Card>
          {isAdmin && (
            <Card>
              <CardHeader title="Add a component" />
              <ActionForm action={componentAction} className="space-y-4 p-5">
                <Field label="Name" htmlFor="cmp-name">
                  <Input id="cmp-name" name="name" required maxLength={60} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Kind" htmlFor="cmp-kind">
                    <Select id="cmp-kind" name="kind" defaultValue="earning">
                      <option value="earning">Earning</option>
                      <option value="deduction">Deduction</option>
                    </Select>
                  </Field>
                  <Field label="Calculation" htmlFor="cmp-calc">
                    <Select id="cmp-calc" name="calc" defaultValue="fixed">
                      <option value="fixed">Fixed amount</option>
                      <option value="percent_basic">% of basic</option>
                      <option value="percent_gross">% of gross (deductions)</option>
                    </Select>
                  </Field>
                  <Field label="Fixed amounts" htmlFor="cmp-prorate">
                    <Select id="cmp-prorate" name="prorate" defaultValue="yes">
                      <option value="yes">Reduce for unpaid days</option>
                      <option value="no">Always in full</option>
                    </Select>
                  </Field>
                  <Field label="Monthly cap (₹, percentages)" htmlFor="cmp-cap">
                    <Input id="cmp-cap" name="cap" inputMode="decimal" />
                  </Field>
                  <Field label="Order on payslips" htmlFor="cmp-order">
                    <Input id="cmp-order" name="sortOrder" type="number" min={0} max={999} />
                  </Field>
                </div>
                <SubmitButton variant="secondary" pendingText="Adding…">Add component</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
