import type { Metadata } from "next";
import Link from "next/link";
import { formatPaise, getChildFees, listMyChildren } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { PayButton } from "./pay-button";

export const metadata: Metadata = { title: "Fees" };

const METHOD: Record<string, string> = { cash: "Cash", cheque: "Cheque", bank_transfer: "Bank transfer", upi: "UPI", online: "Online" };

export default async function ParentFeesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("parent");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const m = s.memberships.find((x) => x.schoolId === schoolId);
  const kids = await listMyChildren(db, s.ctx, schoolId);
  const accounts = await Promise.all(kids.map((k) => getChildFees(db, s.ctx, schoolId, k.studentId)));

  return (
    <>
      <PageHeader title="Fees" description="Statements and receipts for your children. Amounts in rupees." />
      {sp.payment === "processing" && (
        <div className="mb-6">
          <Alert tone="amber">Payment processing. It appears here as soon as the payment provider confirms it; you do not need to pay again.</Alert>
        </div>
      )}
      {sp.payment === "unavailable" && (
        <div className="mb-6">
          <Alert>Online payment could not be opened. Try again later or pay at the school office.</Alert>
        </div>
      )}
      {accounts.length === 0 ? (
        <Card>
          <EmptyState title="No child linked">The school links you to your child.</EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {accounts.map((a) => (
            <Card key={a.studentId}>
              <CardHeader
                title={a.displayName}
                description={`Admission no. ${a.admissionNo}`}
                action={<Badge tone={a.balancePaise > 0 ? (a.overduePaise > 0 ? "red" : "amber") : "green"}>{a.balancePaise > 0 ? `${formatPaise(a.balancePaise)} due` : "Nothing due"}</Badge>}
              />
              {a.invoices.length === 0 ? (
                <p className="px-5 py-4 text-sm text-slate-600">No fee invoices yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {a.invoices
                    .filter((i) => i.status === "open")
                    .map((inv) => (
                      <li key={inv.id} className="space-y-2 px-5 py-4 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            <span className="font-medium text-slate-900">{inv.number}</span> · {inv.structureName}
                            <span className="block text-xs text-slate-500">due {inv.dueOn}</span>
                          </span>
                          {inv.balancePaise <= 0 ? <Badge tone="green">Paid</Badge> : <Badge tone="amber">{formatPaise(inv.balancePaise)} due</Badge>}
                        </div>
                        <ul className="text-xs text-slate-600">
                          {inv.lines.map((l, i) => (
                            <li key={i}>
                              {l.description}: {formatPaise(l.totalPaise)}
                              {l.discountPaise ? ` (after ${formatPaise(l.discountPaise)} concession)` : ""}
                            </li>
                          ))}
                        </ul>
                        {inv.balancePaise > 0 && <PayButton invoiceId={inv.id} label={`Pay ${formatPaise(inv.balancePaise)}`} schoolName={m?.schoolName ?? "School"} />}
                      </li>
                    ))}
                </ul>
              )}
              {a.payments.filter((p) => p.status === "captured").length > 0 && (
                <div className="border-t border-slate-100 px-5 py-4 text-sm">
                  <p className="mb-2 font-semibold text-slate-900">Receipts</p>
                  <ul className="space-y-1">
                    {a.payments
                      .filter((p) => p.status === "captured")
                      .map((p) => (
                        <li key={p.id} className="flex flex-wrap justify-between gap-2">
                          <Link href={`/receipts/${p.id}`} className="text-brand-700 hover:underline">
                            {p.receiptNo} · {METHOD[p.method] ?? p.method}
                          </Link>
                          <span className="tabular-nums">{formatPaise(p.amountPaise)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
