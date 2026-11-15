import type { Metadata } from "next";
import Link from "next/link";
import { listPendingApprovals } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { decideAction } from "../actions";

export const metadata: Metadata = { title: "Fee approvals" };

const LABEL: Record<string, string> = { percent: "Concession", amount: "Concession", waiver: "Waiver", extra_charge: "Extra charge", refund: "Refund", receipt_reversal: "Receipt reversal" };
const when = (d: Date) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function ApprovalsPage() {
  const s = await requireSchoolRole("school_admin", "finance");
  const rows = await listPendingApprovals(db, s.ctx, s.ctx.schoolId);
  const isAdmin = s.roles.includes("school_admin");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/fees" className="text-brand-600 hover:text-brand-700">
          ← Fees
        </Link>
      </p>
      <PageHeader title="Approvals" description="Concessions and adjustments waiting for a school administrator. Nobody approves their own request." />
      <Card>
        <CardHeader title={`${rows.length} waiting`} />
        {rows.length === 0 ? (
          <EmptyState title="Nothing to approve">New requests appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                <span>
                  <span className="font-medium text-slate-900">
                    {LABEL[r.kind] ?? r.kind} {r.amountText}
                  </span>{" "}
                  for{" "}
                  <Link href={`/school/fees/students/${r.studentId}`} className="text-brand-700 hover:underline">
                    {r.studentName}
                  </Link>
                  <span className="block text-xs text-slate-500">
                    {r.reason} · requested by {r.requestedBy ?? "a staff member"}, {when(r.createdAt)}
                  </span>
                </span>
                {r.requestedByMe ? (
                  <Badge>Your request</Badge>
                ) : isAdmin ? (
                  <span className="flex gap-2">
                    {(["approve", "reject"] as const).map((d) => (
                      <ActionForm key={d} action={decideAction} inline>
                        <input type="hidden" name="type" value={r.type} />
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="decision" value={d} />
                        <SubmitButton variant={d === "approve" ? "primary" : "ghost"} pendingText="Saving…" className="min-h-9 px-3 py-1.5 text-xs" aria-label={`${d === "approve" ? "Approve" : "Reject"} ${LABEL[r.kind] ?? r.kind} for ${r.studentName}`}>
                          {d === "approve" ? "Approve" : "Reject"}
                        </SubmitButton>
                      </ActionForm>
                    ))}
                  </span>
                ) : (
                  <Badge tone="amber">Waiting for an administrator</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
