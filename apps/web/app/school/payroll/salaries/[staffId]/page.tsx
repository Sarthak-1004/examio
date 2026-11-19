import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, componentValueText, formatPaise, getStaffSalaries, listComponents } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { salaryAction } from "../../actions";

export const metadata: Metadata = { title: "Salary" };

export default async function StaffSalaryPage({ params }: { params: Promise<{ staffId: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const isAdmin = s.roles.includes("school_admin");
  const { staffId } = await params;
  const [data, components] = await Promise.all([
    getStaffSalaries(db, s.ctx, s.ctx.schoolId, staffId).catch((e: unknown) => {
      if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
      throw e;
    }),
    listComponents(db, s.ctx, s.ctx.schoolId),
  ]);
  const active = components.filter((c) => !c.archived);
  const current = data.versions[0];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/payroll/salaries" className="text-brand-600 hover:text-brand-700">
          ← Salaries
        </Link>
      </p>
      <PageHeader title={data.name} description={`${data.employeeNo} · salary versions, newest first`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {data.versions.length === 0 ? (
            <Card>
              <EmptyState title="No salary recorded">{isAdmin ? "Add the first version." : "An administrator records salaries."}</EmptyState>
            </Card>
          ) : (
            data.versions.map((v) => (
              <Card key={v.id}>
                <CardHeader title={`From ${v.effectiveFrom}`} description={`Basic ${formatPaise(v.basicPaise)} a month · added by ${v.createdBy}, ${formatDateTime(v.createdAt, s.timeZone)}${v.note ? ` · ${v.note}` : ""}`} />
                {v.lines.length === 0 ? (
                  <p className="px-5 pb-4 text-sm text-slate-600">No other components.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {v.lines.map((l) => (
                      <li key={l.componentId} className="flex justify-between gap-3 px-5 py-2">
                        <span>{`${l.name} (${l.kind === "earning" ? "earning" : "deduction"})`}</span>
                        <span className="tabular-nums">{l.calc === "fixed" ? formatPaise(l.value) : componentValueText(l.calc, l.value)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))
          )}
        </div>
        {isAdmin && (
          <Card>
            <CardHeader title="New salary version" description="Takes effect from the date given; earlier months keep their version." />
            <ActionForm action={salaryAction} className="space-y-4 p-5">
              <input type="hidden" name="staffId" value={data.staffId} />
              <Field label="Effective from" htmlFor="sal-from">
                <Input id="sal-from" name="effectiveFrom" type="date" required />
              </Field>
              <Field label="Monthly basic (₹)" htmlFor="sal-basic">
                <Input id="sal-basic" name="basic" required inputMode="decimal" defaultValue={current ? String(current.basicPaise / 100) : ""} />
              </Field>
              {active.map((c) => {
                const prev = current?.lines.find((l) => l.componentId === c.id);
                return (
                  <Field key={c.id} label={`${c.name} (${c.calc === "fixed" ? "₹ a month" : "%"}; blank if not paid)`} htmlFor={`sal-${c.id}`}>
                    <Input id={`sal-${c.id}`} name={`c:${c.id}`} inputMode="decimal" defaultValue={prev ? componentValueText(c.calc, prev.value).replace("%", "") : ""} />
                  </Field>
                );
              })}
              <Field label="Note (optional)" htmlFor="sal-note">
                <Input id="sal-note" name="note" maxLength={300} />
              </Field>
              <SubmitButton pendingText="Saving…">Save new version</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
