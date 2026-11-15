import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatPaise, getStudentAccount, listFeeHeads } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../../../setup/shared";
import { cancelInvoiceAction, recordPaymentAction, requestAdjustmentAction, requestConcessionAction, revokeConcessionAction } from "../../actions";

export const metadata: Metadata = { title: "Student account" };

const METHOD: Record<string, string> = { cash: "Cash", cheque: "Cheque", bank_transfer: "Bank transfer", upi: "UPI", online: "Online" };
const KIND: Record<string, string> = { charge: "Invoice", late_fee: "Late fee", payment: "Payment", adjustment: "Adjustment", refund: "Refund", reversal: "Reversal" };
const ADJ: Record<string, string> = { waiver: "Waiver", extra_charge: "Extra charge", refund: "Refund", receipt_reversal: "Receipt reversal" };
const when = (d: Date) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function StudentFeeAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const { id } = await params;
  const acc = await getStudentAccount(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const heads = (await listFeeHeads(db, s.ctx, s.ctx.schoolId)).filter((h) => !h.archived);
  const isAdmin = s.roles.includes("school_admin");
  const captured = acc.payments.filter((p) => p.status === "captured");

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/fees" className="text-brand-600 hover:text-brand-700">
          ← Fees
        </Link>
      </p>
      <PageHeader
        title={acc.displayName}
        description={`Admission no. ${acc.admissionNo}`}
        action={<Badge tone={acc.balancePaise > 0 ? (acc.overduePaise > 0 ? "red" : "amber") : "green"}>{acc.balancePaise > 0 ? `${formatPaise(acc.balancePaise)} due` : acc.balancePaise < 0 ? `${formatPaise(-acc.balancePaise)} in credit` : "Nothing due"}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Invoices" />
            {acc.invoices.length === 0 ? (
              <EmptyState title="No invoices">Invoices appear when finance issues a fee structure's instalment.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {acc.invoices.map((inv) => (
                  <li key={inv.id} className="space-y-2 px-5 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-medium text-slate-900">{inv.number}</span> · {inv.structureName}
                        <span className="block text-xs text-slate-500">due {inv.dueOn}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{formatPaise(inv.totalPaise)}</span>
                        {inv.status === "cancelled" ? <Badge>Cancelled</Badge> : inv.balancePaise <= 0 ? <Badge tone="green">Paid</Badge> : <Badge tone="amber">{formatPaise(inv.balancePaise)} due</Badge>}
                      </span>
                    </div>
                    <ul className="text-xs text-slate-600">
                      {inv.lines.map((l, i) => (
                        <li key={i}>
                          {l.description}: {formatPaise(l.amountPaise)}
                          {l.discountPaise ? ` − ${formatPaise(l.discountPaise)} concession` : ""}
                          {l.taxPaise ? ` + ${formatPaise(l.taxPaise)} tax` : ""} = {formatPaise(l.totalPaise)}
                        </li>
                      ))}
                    </ul>
                    {inv.status === "open" && inv.balancePaise > 0 && (
                      <ActionForm action={recordPaymentAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="invoiceId" value={inv.id} />
                        <input type="hidden" name="key" value={randomUUID()} />
                        <Field label="Amount (₹)" htmlFor={`pay-${inv.id}`}>
                          <Input id={`pay-${inv.id}`} name="amount" required inputMode="decimal" defaultValue={(inv.balancePaise / 100).toFixed(2)} className="w-32" />
                        </Field>
                        <Field label="Method" htmlFor={`pm-${inv.id}`}>
                          <Select id={`pm-${inv.id}`} name="method" defaultValue="cash">
                            <option value="cash">Cash</option>
                            <option value="cheque">Cheque</option>
                            <option value="bank_transfer">Bank transfer</option>
                            <option value="upi">UPI</option>
                          </Select>
                        </Field>
                        <Field label="Reference" htmlFor={`pr-${inv.id}`}>
                          <Input id={`pr-${inv.id}`} name="reference" maxLength={100} placeholder="Cheque / UTR no." className="w-40" />
                        </Field>
                        <SubmitButton variant="secondary" pendingText="Recording…">
                          Record payment
                        </SubmitButton>
                      </ActionForm>
                    )}
                    {isAdmin && inv.status === "open" && (
                      <ActionForm action={cancelInvoiceAction} inline>
                        <input type="hidden" name="invoiceId" value={inv.id} />
                        <label className="sr-only" htmlFor={`cr-${inv.id}`}>
                          Reason for cancelling {inv.number}
                        </label>
                        <Input id={`cr-${inv.id}`} name="reason" minLength={3} maxLength={200} placeholder="Reason to cancel" className="w-48" />
                        <SubmitButton variant="ghost" pendingText="Cancelling…" className="min-h-9 px-3 py-1.5 text-xs">
                          Cancel invoice
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Payments" />
            {acc.payments.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-slate-600">No payments yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {acc.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span>
                      {p.receiptNo ? (
                        <Link href={`/receipts/${p.id}`} className="font-medium text-brand-700 hover:underline">
                          {p.receiptNo}
                        </Link>
                      ) : (
                        <span className="font-medium text-slate-900">Online payment</span>
                      )}{" "}
                      · {METHOD[p.method] ?? p.method} · {p.invoiceNumber}
                      <span className="block text-xs text-slate-500">
                        {when(p.capturedAt ?? p.createdAt)}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatPaise(p.amountPaise)}</span>
                      {p.status === "captured" ? <Badge tone="green">Received</Badge> : p.status === "pending" ? <Badge tone="amber">Pending</Badge> : <Badge tone="red">Failed</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Ledger" description="Every entry, newest first. Positive amounts are owed; negative amounts are credits." />
            <ul className="divide-y divide-slate-100 text-sm">
              {acc.ledger.map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 px-5 py-2">
                  <span>
                    {KIND[e.kind] ?? e.kind}
                    {e.memo ? ` · ${e.memo}` : ""} {e.reversed && <Badge>Reversed</Badge>}
                    <span className="block text-xs text-slate-500">{when(e.createdAt)}</span>
                  </span>
                  <span className="tabular-nums">{formatPaise(e.amountPaise)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Concessions" description="Apply to invoices issued after approval." />
            {acc.concessions.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {acc.concessions.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span>
                      {c.kind === "percent" ? `${(c.value / 100).toFixed(2)}%` : formatPaise(c.value)} on {c.headName ?? "all fees"}
                      <span className="block text-xs text-slate-500">{c.reason}</span>
                    </span>
                    {c.revoked ? <Badge>Revoked</Badge> : c.status === "approved" ? <RowAction action={revokeConcessionAction} fields={{ concessionId: c.id }} label="Revoke" variant="ghost" /> : <Badge tone={c.status === "pending" ? "amber" : "slate"}>{c.status}</Badge>}
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={requestConcessionAction} className="space-y-3 border-t border-slate-100 p-5">
              <input type="hidden" name="studentId" value={acc.studentId} />
              <Field label="On" htmlFor="cn-head">
                <Select id="cn-head" name="feeHeadId" defaultValue="">
                  <option value="">All fee heads</option>
                  {heads.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type" htmlFor="cn-kind">
                  <Select id="cn-kind" name="kind" defaultValue="percent">
                    <option value="percent">Percent</option>
                    <option value="amount">Amount (₹)</option>
                  </Select>
                </Field>
                <Field label="Value" htmlFor="cn-value">
                  <Input id="cn-value" name="value" required inputMode="decimal" />
                </Field>
              </div>
              <Field label="Reason" htmlFor="cn-reason">
                <Input id="cn-reason" name="reason" required minLength={3} maxLength={200} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Requesting…">
                Request concession
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Adjustments" description="Take effect only when a school administrator other than you approves them." />
            {acc.adjustments.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {acc.adjustments.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2 px-5 py-3">
                    <span>
                      {ADJ[a.kind] ?? a.kind} {formatPaise(a.amountPaise)}
                      <span className="block text-xs text-slate-500">{a.reason}</span>
                    </span>
                    <Badge tone={a.status === "approved" ? "green" : a.status === "pending" ? "amber" : "slate"}>{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={requestAdjustmentAction} className="space-y-3 border-t border-slate-100 p-5">
              <input type="hidden" name="studentId" value={acc.studentId} />
              <Field label="Kind" htmlFor="ad-kind">
                <Select id="ad-kind" name="kind" defaultValue="waiver">
                  <option value="waiver">Waiver (reduce what is owed)</option>
                  <option value="extra_charge">Extra charge</option>
                  <option value="refund">Refund of a payment</option>
                  <option value="receipt_reversal">Reverse a receipt entered in error</option>
                </Select>
              </Field>
              <Field label="Invoice (waiver, extra charge)" htmlFor="ad-inv">
                <Select id="ad-inv" name="invoiceId" defaultValue="">
                  <option value="">Not tied to an invoice</option>
                  {acc.invoices
                    .filter((i) => i.status === "open")
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.number}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Payment (refund, reversal)" htmlFor="ad-pay">
                <Select id="ad-pay" name="paymentId" defaultValue="">
                  <option value="">—</option>
                  {captured.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.receiptNo} · {formatPaise(p.amountPaise)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount (₹)" htmlFor="ad-amount" hint="Not needed for a reversal (the whole receipt).">
                <Input id="ad-amount" name="amount" inputMode="decimal" />
              </Field>
              <Field label="Reason" htmlFor="ad-reason">
                <Input id="ad-reason" name="reason" required minLength={3} maxLength={200} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Requesting…">
                Request adjustment
              </SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
