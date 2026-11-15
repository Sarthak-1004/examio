import type { Metadata } from "next";
import Link from "next/link";
import { addDays, formatPaise, getCollections, getOutstandingByClass, getReconciliation, getSchoolToday, listPendingApprovals, searchFeeStudents } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { lateFeesAction, reconcileAction, remindersAction } from "./actions";

export const metadata: Metadata = { title: "Fees" };

export default async function FeesHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const today = await getSchoolToday(db, s.ctx, schoolId);
  const [day, month, outstanding, approvals, rec, students] = await Promise.all([
    getCollections(db, s.ctx, schoolId, { from: today, to: today }),
    getCollections(db, s.ctx, schoolId, { from: `${today.slice(0, 8)}01`, to: today }),
    getOutstandingByClass(db, s.ctx, schoolId),
    listPendingApprovals(db, s.ctx, schoolId),
    getReconciliation(db, s.ctx, schoolId),
    q ? searchFeeStudents(db, s.ctx, schoolId, q) : Promise.resolve([]),
  ]);
  const totalOutstanding = outstanding.reduce((a, r) => a + r.outstandingPaise, 0);
  const totalOverdue = outstanding.reduce((a, r) => a + r.overduePaise, 0);
  const stats = [
    { label: "Collected today", value: formatPaise(day.totalPaise) },
    { label: "Collected this month", value: formatPaise(month.totalPaise) },
    { label: "Outstanding", value: formatPaise(totalOutstanding) },
    { label: "Overdue", value: formatPaise(totalOverdue) },
  ];

  return (
    <>
      <PageHeader
        title="Fees"
        description="Amounts in Indian rupees. The student ledger is never edited: corrections are approved adjustments or reversals."
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/school/fees/setup" variant="secondary">
              Fee setup
            </ButtonLink>
            <ButtonLink href="/school/fees/approvals" variant="secondary">
              Approvals{approvals.length ? ` (${approvals.length})` : ""}
            </ButtonLink>
            <ButtonLink href="/school/fees/reports" variant="secondary">
              Reports
            </ButtonLink>
          </div>
        }
      />
      {rec.mismatches.length > 0 && (
        <div className="mb-6">
          <Alert>The reconciliation check found {rec.mismatches.length} problem(s). Open Reports for details.</Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((st) => (
          <Card key={st.label} className="p-5">
            <p className="text-sm text-slate-500">{st.label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{st.value}</p>
          </Card>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Find a student" description="Open a student's account to record a payment, request a concession or an adjustment." />
          <form method="get" className="flex flex-wrap items-end gap-3 px-5 pb-4">
            <Field label="Name or admission number" htmlFor="fs-q">
              <Input id="fs-q" name="q" defaultValue={q} maxLength={100} />
            </Field>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
          {q &&
            (students.length === 0 ? (
              <EmptyState title="No students match">Try another name or admission number.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {students.map((r) => (
                  <li key={r.studentId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span>
                      <Link href={`/school/fees/students/${r.studentId}`} className="font-medium text-brand-700 hover:underline">
                        {r.displayName}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {r.admissionNo}
                        {r.className ? ` · ${r.className}` : ""}
                      </span>
                    </span>
                    <span className={`tabular-nums ${r.balancePaise > 0 ? "font-semibold text-slate-900" : "text-slate-600"}`}>{r.balancePaise > 0 ? `${formatPaise(r.balancePaise)} due` : r.balancePaise < 0 ? `${formatPaise(-r.balancePaise)} in credit` : "Nothing due"}</span>
                  </li>
                ))}
              </ul>
            ))}
        </Card>
        <Card>
          <CardHeader title="Routine tasks" />
          <div className="space-y-4 p-5 text-sm">
            <ActionForm action={lateFeesAction}>
              <p className="mb-2 text-slate-600">Add the late fee to overdue invoices past their grace days (once per invoice).</p>
              <SubmitButton variant="secondary" pendingText="Applying…">
                Apply late fees
              </SubmitButton>
            </ActionForm>
            <ActionForm action={remindersAction}>
              <p className="mb-2 text-slate-600">Remind parents of overdue invoices (at most once a day each).</p>
              <SubmitButton variant="secondary" pendingText="Sending…">
                Send overdue reminders
              </SubmitButton>
            </ActionForm>
            <ActionForm action={reconcileAction}>
              <p className="mb-2 text-slate-600">
                Ask the payment provider about online payments still pending ({rec.pendingOnline} pending, {rec.failedOnline} failed).
              </p>
              <SubmitButton variant="secondary" pendingText="Checking…">
                Reconcile online payments
              </SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="Outstanding by class" description={`As of ${today}; overdue means past the due date.`} />
        {outstanding.length === 0 ? (
          <EmptyState title="Nothing outstanding">Issued invoices appear here once they are due.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {outstanding.map((r) => (
              <li key={r.classId ?? "none"} className="flex flex-wrap justify-between gap-2 px-5 py-3">
                <span className="font-medium text-slate-900">{r.className}</span>
                <span className="tabular-nums text-slate-700">
                  {formatPaise(r.outstandingPaise)} from {r.students} student(s) · overdue {formatPaise(r.overduePaise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-4 text-xs text-slate-500">Last 30 days: see Reports from {addDays(today, -29)}.</p>
    </>
  );
}
