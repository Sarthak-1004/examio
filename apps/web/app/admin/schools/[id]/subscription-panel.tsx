import { formatPaise, getSubscription, listPlans, PLAN_MODULE_LABELS, schoolToday, type PlanModule } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { cancelInvoiceAction, createInvoiceAction, recordInvoicePaymentAction, setOverridesAction, setSubscriptionAction } from "../../subscription-actions";

const MODULES = Object.entries(PLAN_MODULE_LABELS) as [PlanModule, string][];
export const ACCESS_LABEL = { active: { label: "Active", tone: "green" }, due: { label: "Renewal due", tone: "amber" }, grace: { label: "In grace", tone: "amber" }, read_only: { label: "Read-only", tone: "red" } } as const;
const INVOICE = { issued: { label: "Unpaid", tone: "amber" }, paid: { label: "Paid", tone: "green" }, cancelled: { label: "Cancelled", tone: "slate" } } as const;

/** The platform administrator's view of one school's subscription, overrides and invoices. */
export async function SubscriptionPanel({ ctx, schoolId }: { ctx: RequestContext; schoolId: string }) {
  const [sub, plans] = await Promise.all([getSubscription(db, ctx, schoolId), listPlans(db, ctx)]);
  const today = schoolToday("Asia/Kolkata");
  const active = plans.filter((p) => !p.archived || p.id === sub.plan?.id);
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Card>
          <CardHeader
            title="Subscription"
            description={
              sub.plan
                ? `${sub.plan.name} · ${sub.startsOn} to ${sub.endsOn} · ${sub.activeStudents} of ${sub.maxStudents ?? "unlimited"} active students`
                : `No plan: full access without an end date · ${sub.activeStudents} active students`
            }
            action={<Badge tone={ACCESS_LABEL[sub.access].tone}>{ACCESS_LABEL[sub.access].label}</Badge>}
          />
          <p className="px-5 pb-4 text-sm text-slate-700">{`Modules: ${sub.modules.map((m) => PLAN_MODULE_LABELS[m]).join(", ") || "core only"}`}</p>
        </Card>
        <Card>
          <CardHeader title="Invoices" description="Raised manually; recording the same payment twice changes nothing." />
          {sub.invoices.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-slate-600">No invoices yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {sub.invoices.map((i) => (
                <li key={i.id} className="space-y-2 px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">{`${i.number} · ${i.periodFrom} to ${i.periodTo} · ${formatPaise(i.amountPaise)}`}</span>
                    <Badge tone={INVOICE[i.status].tone}>{i.status === "paid" ? `Paid ${i.paidOn} (${i.paymentReference})` : INVOICE[i.status].label}</Badge>
                  </div>
                  {i.cancelledReason && <p className="text-slate-600">{`Cancelled: ${i.cancelledReason}`}</p>}
                  {i.status === "issued" && (
                    <div className="flex flex-wrap gap-4">
                      <details>
                        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Record payment for ${i.number}`}</summary>
                        <ActionForm action={recordInvoicePaymentAction} className="mt-2 w-60 space-y-2">
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <Field label="Paid on" htmlFor={`paid-${i.id}`}>
                            <Input id={`paid-${i.id}`} name="paidOn" type="date" required defaultValue={today} />
                          </Field>
                          <Field label="Reference (UTR, cheque no.)" htmlFor={`ref-${i.id}`}>
                            <Input id={`ref-${i.id}`} name="reference" required maxLength={80} />
                          </Field>
                          <SubmitButton pendingText="Saving…">Record payment</SubmitButton>
                        </ActionForm>
                      </details>
                      <details>
                        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Cancel ${i.number}`}</summary>
                        <ActionForm action={cancelInvoiceAction} className="mt-2 w-60 space-y-2">
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <Field label="Reason" htmlFor={`cancel-${i.id}`}>
                            <Input id={`cancel-${i.id}`} name="reason" required minLength={3} maxLength={300} />
                          </Field>
                          <SubmitButton variant="danger" pendingText="Cancelling…">Cancel invoice</SubmitButton>
                        </ActionForm>
                      </details>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Subscription history" />
          {sub.history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-slate-600">No changes yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {sub.history.map((h, i) => (
                <li key={`${h.at.toISOString()}-${i}`} className="px-5 py-2 text-slate-700">
                  {`${formatDateTime(h.at)} · ${h.kind} by ${h.actor}${h.reason ? ` · ${h.reason}` : ""}`}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader title={sub.plan ? "Change plan or dates" : "Assign a plan"} />
          {active.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-slate-600">Create a plan first.</p>
          ) : (
            <ActionForm action={setSubscriptionAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="schoolId" value={schoolId} />
              <Field label="Plan" htmlFor="sub-plan">
                <Select id="sub-plan" name="planId" required defaultValue={sub.plan?.id ?? ""}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {active.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts on" htmlFor="sub-start">
                  <Input id="sub-start" name="startsOn" type="date" required defaultValue={sub.startsOn ?? today} />
                </Field>
                <Field label="Ends on" htmlFor="sub-end">
                  <Input id="sub-end" name="endsOn" type="date" required defaultValue={sub.endsOn ?? ""} />
                </Field>
              </div>
              {sub.plan && (
                <Field label="Reason for the change" htmlFor="sub-reason">
                  <Input id="sub-reason" name="reason" required minLength={3} maxLength={300} />
                </Field>
              )}
              <SubmitButton pendingText="Saving…">Save subscription</SubmitButton>
            </ActionForm>
          )}
        </Card>
        {sub.plan && (
          <Card>
            <CardHeader title="Overrides for this school" description="Always with a reason; recorded in the history." />
            <ActionForm action={setOverridesAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="schoolId" value={schoolId} />
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-slate-700">Add modules</legend>
                {MODULES.map(([m, label]) => (
                  <label key={m} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" name="added" value={m} defaultChecked={sub.modulesAdded.includes(m)} /> {label}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-slate-700">Remove modules</legend>
                {MODULES.map(([m, label]) => (
                  <label key={m} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" name="removed" value={m} defaultChecked={sub.modulesRemoved.includes(m)} /> {label}
                  </label>
                ))}
              </fieldset>
              <Field label="Max active students (blank: the plan's)" htmlFor="ov-max">
                <Input id="ov-max" name="maxStudentsOverride" type="number" min={1} max={100000} defaultValue={sub.maxStudentsOverride ?? ""} />
              </Field>
              <Field label="Reason" htmlFor="ov-reason">
                <Input id="ov-reason" name="reason" required minLength={3} maxLength={300} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Saving…">Save overrides</SubmitButton>
            </ActionForm>
          </Card>
        )}
        <Card>
          <CardHeader title="New invoice" />
          <ActionForm action={createInvoiceAction} className="space-y-4 p-5">
            <input type="hidden" name="schoolId" value={schoolId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Period from" htmlFor="inv-from">
                <Input id="inv-from" name="periodFrom" type="date" required />
              </Field>
              <Field label="Period to" htmlFor="inv-to">
                <Input id="inv-to" name="periodTo" type="date" required />
              </Field>
            </div>
            <Field label="Amount (₹)" htmlFor="inv-amount">
              <Input id="inv-amount" name="amount" required inputMode="decimal" />
            </Field>
            <Field label="Note (optional)" htmlFor="inv-note">
              <Input id="inv-note" name="note" maxLength={300} />
            </Field>
            <SubmitButton variant="secondary" pendingText="Issuing…">Issue invoice</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
