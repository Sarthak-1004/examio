import type { Metadata } from "next";
import { formatPaise, listPlans, PLAN_MODULE_LABELS, type PlanModule, type PlanRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { createPlanAction, updatePlanAction } from "../subscription-actions";

export const metadata: Metadata = { title: "Plans" };

const MODULES = Object.entries(PLAN_MODULE_LABELS) as [PlanModule, string][];

function PlanFields({ prefix, plan }: { prefix: string; plan?: PlanRow }) {
  return (
    <>
      <Field label="Name" htmlFor={`${prefix}-name`}>
        <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={plan?.name} />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Optional modules included</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {MODULES.map(([m, label]) => (
            <label key={m} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="modules" value={m} defaultChecked={plan?.modules.includes(m)} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Max active students" htmlFor={`${prefix}-max`} hint="Blank for no limit.">
          <Input id={`${prefix}-max`} name="maxStudents" type="number" min={1} max={100000} defaultValue={plan?.maxStudents ?? ""} />
        </Field>
        <Field label="Price (₹ per period)" htmlFor={`${prefix}-price`}>
          <Input id={`${prefix}-price`} name="price" inputMode="decimal" defaultValue={plan?.pricePaise != null ? String(plan.pricePaise / 100) : ""} />
        </Field>
        <Field label="Period (months)" htmlFor={`${prefix}-period`}>
          <Input id={`${prefix}-period`} name="periodMonths" type="number" min={1} max={36} required defaultValue={plan?.periodMonths ?? 12} />
        </Field>
      </div>
    </>
  );
}

export default async function PlansPage() {
  const s = await requirePlatformAdmin();
  const plans = await listPlans(db, s.ctx);
  return (
    <>
      <PageHeader title="Plans" description="Core modules (setup, students, staff, attendance, timetable, homework, notices, question bank) are always included. Changes apply to every school on the plan at once." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {plans.length === 0 && (
            <Card>
              <p className="p-5 text-sm text-slate-600">No plans yet. Schools without a plan keep full access without an end date.</p>
            </Card>
          )}
          {plans.map((p) => (
            <Card key={p.id}>
              <CardHeader
                title={`${p.name} (${p.code})`}
                description={`${p.modules.length ? p.modules.map((m) => PLAN_MODULE_LABELS[m]).join(", ") : "Core only"} · ${p.maxStudents ? `up to ${p.maxStudents} students` : "no student limit"} · ${p.pricePaise != null ? `${formatPaise(p.pricePaise)} per ${p.periodMonths} months` : "no price set"} · ${p.schools} school${p.schools === 1 ? "" : "s"}`}
                action={p.archived ? <Badge>Archived</Badge> : undefined}
              />
              <details className="px-5 pb-5 text-sm">
                <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Edit ${p.name}`}</summary>
                <ActionForm action={updatePlanAction} keepValues className="mt-3 space-y-4">
                  <input type="hidden" name="planId" value={p.id} />
                  <input type="hidden" name="archived" value="" />
                  <PlanFields prefix={`plan-${p.id}`} plan={p} />
                  <SubmitButton pendingText="Saving…">Save plan</SubmitButton>
                </ActionForm>
                <ActionForm action={updatePlanAction} className="mt-3">
                  <input type="hidden" name="planId" value={p.id} />
                  <input type="hidden" name="archived" value={p.archived ? "0" : "1"} />
                  <input type="hidden" name="name" value={p.name} />
                  {p.modules.map((m) => (
                    <input key={m} type="hidden" name="modules" value={m} />
                  ))}
                  <input type="hidden" name="maxStudents" value={p.maxStudents ?? ""} />
                  <input type="hidden" name="price" value={p.pricePaise != null ? String(p.pricePaise / 100) : ""} />
                  <input type="hidden" name="periodMonths" value={p.periodMonths} />
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    {p.archived ? "Restore plan" : "Archive plan"}
                  </SubmitButton>
                </ActionForm>
              </details>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader title="New plan" />
          <ActionForm action={createPlanAction} className="space-y-4 p-5">
            <Field label="Code" htmlFor="new-code" hint="Lowercase letters, digits and hyphens, e.g. standard.">
              <Input id="new-code" name="code" required maxLength={20} />
            </Field>
            <PlanFields prefix="new" />
            <SubmitButton pendingText="Creating…">Create plan</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
