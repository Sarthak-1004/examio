import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, listAcademicYears, listClasses, listFeeHeads, listFeeStructures } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../../setup/shared";
import { archiveHeadAction, createHeadAction, createStructureAction } from "../actions";

export const metadata: Metadata = { title: "Fee setup" };

const STATUS: Record<string, { label: string; tone: "amber" | "green" | "slate" }> = { draft: { label: "Draft", tone: "amber" }, approved: { label: "Approved", tone: "green" }, archived: { label: "Archived", tone: "slate" } };

export default async function FeeSetupPage() {
  const s = await requireSchoolRole("school_admin", "finance");
  const schoolId = s.ctx.schoolId;
  const [heads, structures, years, classes] = await Promise.all([listFeeHeads(db, s.ctx, schoolId), listFeeStructures(db, s.ctx, schoolId), listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
  const openYears = years.filter((y) => y.status !== "closed");

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/fees" className="text-brand-600 hover:text-brand-700">
          ← Fees
        </Link>
      </p>
      <PageHeader title="Fee setup" description="Fee heads, and fee structures per class and year. A structure is billed only after a school administrator approves it." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Fee structures" />
          {structures.length === 0 ? (
            <EmptyState title="No fee structures">Create one with the form.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {structures.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <Link href={`/school/fees/structures/${x.id}`} className="font-medium text-brand-700 hover:underline">
                      {x.className}: {x.name}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {x.yearName} · {formatPaise(x.totalPaise)} in {x.instalments} instalment(s){x.lateFeePaise ? ` · late fee ${formatPaise(x.lateFeePaise)} after ${x.lateGraceDays} day(s)` : ""}
                    </span>
                  </span>
                  <Badge tone={STATUS[x.status]!.tone}>{STATUS[x.status]!.label}</Badge>
                </li>
              ))}
            </ul>
          )}
          {openYears.length > 0 && classes.length > 0 && (
            <ActionForm action={createStructureAction} className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2">
              <p className="text-sm font-semibold text-slate-900 sm:col-span-2">New fee structure</p>
              <Field label="Academic year" htmlFor="st-year">
                <Select id="st-year" name="yearId" defaultValue={openYears.find((y) => y.status === "current")?.id ?? openYears[0]?.id}>
                  {openYears.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Class" htmlFor="st-class">
                <Select id="st-class" name="classId">
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Name" htmlFor="st-name" className="sm:col-span-2">
                <Input id="st-name" name="name" required maxLength={80} placeholder="e.g. Annual fees" />
              </Field>
              <Field label="Late fee (₹)" htmlFor="st-late" hint="Added once to an unpaid invoice. Empty = none.">
                <Input id="st-late" name="lateFee" inputMode="decimal" />
              </Field>
              <Field label="Grace days" htmlFor="st-grace" hint="Days after the due date before the late fee.">
                <Input id="st-grace" name="lateGraceDays" type="number" min={0} max={365} defaultValue={0} />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton pendingText="Creating…">Create draft</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
        <Card>
          <CardHeader title="Fee heads" description="Kinds of fees. Tax is charged on the amount after any concession." />
          {heads.length === 0 ? (
            <p className="px-5 pb-2 text-sm text-slate-600">No fee heads yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {heads.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    {h.name} <span className="text-xs text-slate-500">tax {(h.taxBp / 100).toFixed(2)}%</span> {h.archived && <Badge>Archived</Badge>}
                  </span>
                  <RowAction action={archiveHeadAction} fields={{ headId: h.id, archive: h.archived ? "0" : "1" }} label={h.archived ? "Restore" : "Archive"} variant="ghost" ariaLabel={`${h.archived ? "Restore" : "Archive"} ${h.name}`} />
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={createHeadAction} className="space-y-3 border-t border-slate-100 p-5">
            <Field label="Fee head name" htmlFor="fh-name">
              <Input id="fh-name" name="name" required maxLength={80} placeholder="e.g. Tuition" />
            </Field>
            <Field label="Tax (%)" htmlFor="fh-tax" hint="Usually 0 for school tuition. Check with your accountant.">
              <Input id="fh-tax" name="taxPercent" inputMode="decimal" defaultValue="0" />
            </Field>
            <SubmitButton variant="secondary" pendingText="Adding…">
              Add fee head
            </SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
