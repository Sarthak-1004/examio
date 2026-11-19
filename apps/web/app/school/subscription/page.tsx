import type { Metadata } from "next";
import { formatPaise, getMySubscription, PLAN_MODULE_LABELS } from "@examio/core";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Subscription" };

const ACCESS = { active: { label: "Active", tone: "green" }, due: { label: "Renewal due", tone: "amber" }, grace: { label: "In grace", tone: "amber" }, read_only: { label: "Read-only", tone: "red" } } as const;
const INVOICE = { issued: { label: "Unpaid", tone: "amber" }, paid: { label: "Paid", tone: "green" }, cancelled: { label: "Cancelled", tone: "slate" } } as const;

export default async function SubscriptionPage() {
  const s = await requireSchoolRole("school_admin");
  const sub = await getMySubscription(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Subscription" description="Your school's Examio plan, usage and invoices. Renewals and changes are arranged with the Examio team." action={<Badge tone={ACCESS[sub.access].tone}>{ACCESS[sub.access].label}</Badge>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Plan" />
          <dl className="space-y-3 px-5 pb-5 text-sm">
            {[
              ["Plan", sub.plan?.name ?? "No plan assigned: full access without an end date"],
              ["Period", sub.startsOn ? `${sub.startsOn} to ${sub.endsOn}` : "—"],
              ["Modules", `Core, ${sub.modules.map((m) => PLAN_MODULE_LABELS[m]).join(", ") || "no optional modules"}`],
              ["Active students", `${sub.activeStudents} of ${sub.maxStudents ?? "unlimited"}`],
            ].map(([k, v]) => (
              <div key={k} className="grid gap-1 sm:grid-cols-3">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium text-slate-900 sm:col-span-2">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            After the end date there are 15 days of grace; then Examio becomes read-only until renewal. Records are never deleted, and an exam already started can always be finished.
          </p>
        </Card>
        <Card>
          <CardHeader title="Invoices" />
          {sub.invoices.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-slate-600">No invoices yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {sub.invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span>
                    <span className="block font-medium text-slate-900">{`${i.number} · ${formatPaise(i.amountPaise)}`}</span>
                    <span className="text-slate-600">{`${i.periodFrom} to ${i.periodTo}`}</span>
                  </span>
                  <Badge tone={INVOICE[i.status].tone}>{i.status === "paid" ? `Paid ${i.paidOn}` : INVOICE[i.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
