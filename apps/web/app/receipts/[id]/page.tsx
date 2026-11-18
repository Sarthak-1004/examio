import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError, formatPaise, getReceipt } from "@examio/core";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Fee receipt" };

const METHOD: Record<string, string> = { cash: "Cash", cheque: "Cheque", bank_transfer: "Bank transfer", upi: "UPI", online: "Online payment" };

/**
 * A printable fee receipt. Visible to the school's finance staff and administrators and to the
 * student's linked parents; anyone else gets "not found". Print or save as PDF from the browser.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  if (!s.ctx.schoolId) notFound();
  const r = await getReceipt(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION" || e.code === "FORBIDDEN")) notFound();
    throw e;
  });
  return (
    <main id="main" className="mx-auto max-w-xl bg-white p-8 text-slate-900 print:p-0">
      <h1 className="text-xl font-bold">{r.schoolName}</h1>
      <p className="text-sm text-slate-600">Fee receipt</p>
      {r.reversed && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">This receipt was reversed and is no longer valid.</p>}
      <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-slate-600">Receipt no.</dt>
        <dd className="font-mono font-semibold">{r.receiptNo}</dd>
        <dt className="text-slate-600">Date</dt>
        <dd>{formatDateTime(r.capturedAt, s.timeZone, { long: true })}</dd>
        <dt className="text-slate-600">Student</dt>
        <dd>
          {r.studentName} ({r.admissionNo})
        </dd>
        <dt className="text-slate-600">Invoice</dt>
        <dd className="font-mono">{r.invoiceNumber}</dd>
        <dt className="text-slate-600">Paid by</dt>
        <dd>
          {METHOD[r.method] ?? r.method}
          {r.reference ? ` · ${r.reference}` : ""}
        </dd>
        <dt className="text-slate-600">Amount</dt>
        <dd className="text-lg font-bold">{formatPaise(r.amountPaise)}</dd>
      </dl>
      <p className="mt-8 text-xs text-slate-500">Computer-generated receipt from Examio. Use your browser&apos;s Print to save or print it.</p>
    </main>
  );
}
