import type { Metadata } from "next";
import Link from "next/link";
import { AppError, addDays, formatPaise, getCollections, getDefaulters, getReconciliation, getSchoolToday, type CollectionsReport } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Fee reports" };

const METHOD: Record<string, string> = { cash: "Cash", cheque: "Cheque", bank_transfer: "Bank transfer", upi: "UPI", online: "Online" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function FeeReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const today = await getSchoolToday(db, s.ctx, schoolId);
  const to = DATE.test(one(sp.to)) ? one(sp.to) : today;
  const from = DATE.test(one(sp.from)) ? one(sp.from) : addDays(to, -29);
  let collections: CollectionsReport | null = null;
  let error: string | null = null;
  try {
    collections = await getCollections(db, s.ctx, schoolId, { from, to });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = e.message;
  }
  const [defaulters, rec] = await Promise.all([getDefaulters(db, s.ctx, schoolId), getReconciliation(db, s.ctx, schoolId)]);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/fees" className="text-brand-600 hover:text-brand-700">
          ← Fees
        </Link>
      </p>
      <PageHeader title="Fee reports" description="Collections by method, defaulters, and the ledger reconciliation check." />
      <Card>
        <CardHeader title="Collections" />
        <form method="get" className="flex flex-wrap items-end gap-3 px-5 pb-4">
          <Field label="From" htmlFor="fr-from">
            <Input id="fr-from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field label="To" htmlFor="fr-to">
            <Input id="fr-to" name="to" type="date" defaultValue={to} max={today} />
          </Field>
          <Button type="submit" variant="secondary">
            Show
          </Button>
          <ButtonLink href={`/school/fees/reports/export?report=collections&from=${from}&to=${to}`} variant="secondary" prefetch={false}>
            Export CSV
          </ButtonLink>
        </form>
        {error && (
          <div className="px-5 pb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {collections && (
          <div className="grid gap-6 border-t border-slate-100 p-5 md:grid-cols-2">
            <div>
              <p className="text-3xl font-bold tabular-nums text-slate-900">{formatPaise(collections.totalPaise)}</p>
              <p className="text-sm text-slate-600">collected{collections.refundsPaise ? `, ${formatPaise(collections.refundsPaise)} refunded` : ""}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {collections.byMethod.map((m) => (
                  <li key={m.method} className="flex justify-between">
                    <span>
                      {METHOD[m.method] ?? m.method} ({m.count})
                    </span>
                    <span className="tabular-nums">{formatPaise(m.totalPaise)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-sm" aria-label="Collections by day">
              {collections.byDay.map((d) => (
                <li key={d.day} className="flex justify-between">
                  <span>{d.day}</span>
                  <span className="tabular-nums">{formatPaise(d.totalPaise)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <Card className="mt-6">
        <CardHeader
          title="Defaulters"
          description="Students with overdue balances, largest first."
          action={
            <ButtonLink href="/school/fees/reports/export?report=defaulters" variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          }
        />
        {defaulters.length === 0 ? (
          <EmptyState title="No overdue balances">Nothing is overdue.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {defaulters.map((d) => (
              <li key={d.studentId} className="flex flex-wrap justify-between gap-2 px-5 py-3">
                <span>
                  <Link href={`/school/fees/students/${d.studentId}`} className="font-medium text-brand-700 hover:underline">
                    {d.displayName}
                  </Link>
                  <span className="block text-xs text-slate-500">
                    {d.admissionNo}
                    {d.className ? ` · ${d.className}` : ""} · oldest due {d.oldestDueOn}
                  </span>
                </span>
                <span className="font-semibold tabular-nums text-red-700">{formatPaise(d.overduePaise)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="mt-6">
        <CardHeader title="Reconciliation check" description="Invoice totals against ledger charges, and payments against ledger credits." />
        <div className="space-y-2 p-5 text-sm">
          {rec.mismatches.length === 0 ? <p className="text-emerald-700">Everything adds up.</p> : rec.mismatches.map((m, i) => <Alert key={i}>{`${m.invoiceNumber}: ${m.detail}`}</Alert>)}
          <p className="text-slate-600">
            Online payments: {rec.pendingOnline} pending, {rec.failedOnline} failed.
          </p>
        </div>
      </Card>
    </>
  );
}
