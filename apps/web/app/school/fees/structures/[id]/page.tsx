import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatPaise, getFeeStructure, listFeeHeads } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../../../setup/shared";
import { addItemAction, approveStructureAction, archiveStructureAction, issueAction, removeItemAction } from "../../actions";

export const metadata: Metadata = { title: "Fee structure" };

export default async function FeeStructurePage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const { id } = await params;
  const st = await getFeeStructure(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const heads = (await listFeeHeads(db, s.ctx, s.ctx.schoolId)).filter((h) => !h.archived);
  const isAdmin = s.roles.includes("school_admin");
  const instalments = [...new Set(st.items.map((i) => i.dueOn))].sort();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/fees/setup" className="text-brand-600 hover:text-brand-700">
          ← Fee setup
        </Link>
      </p>
      <PageHeader
        title={`${st.className}: ${st.name}`}
        description={`${st.yearName} · ${formatPaise(st.totalPaise)} before concessions and tax${st.lateFeePaise ? ` · late fee ${formatPaise(st.lateFeePaise)} after ${st.lateGraceDays} day(s)` : ""}`}
        action={<Badge tone={st.status === "approved" ? "green" : st.status === "draft" ? "amber" : "slate"}>{st.status === "approved" ? "Approved" : st.status === "draft" ? "Draft" : "Archived"}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Items" description={st.status === "draft" ? "Items can change until the structure is approved." : "Approved: items are fixed."} />
          {st.items.length === 0 ? (
            <EmptyState title="No items">Add the first item.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {st.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <span className="font-medium text-slate-900">
                      {i.headName}: {i.label}
                    </span>
                    <span className="block text-xs text-slate-500">
                      due {i.dueOn}
                      {i.taxBp ? ` · tax ${(i.taxBp / 100).toFixed(2)}%` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{formatPaise(i.amountPaise)}</span>
                    {st.status === "draft" && <RowAction action={removeItemAction} fields={{ itemId: i.id }} label="Remove" variant="ghost" ariaLabel={`Remove ${i.headName} ${i.label}`} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {st.status === "draft" && heads.length > 0 && (
            <ActionForm action={addItemAction} className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-4">
              <input type="hidden" name="structureId" value={st.id} />
              <Field label="Fee head" htmlFor="it-head">
                <Select id="it-head" name="feeHeadId">
                  {heads.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label" htmlFor="it-label">
                <Input id="it-label" name="label" required maxLength={80} placeholder="e.g. Term 1" />
              </Field>
              <Field label="Amount (₹)" htmlFor="it-amount">
                <Input id="it-amount" name="amount" required inputMode="decimal" />
              </Field>
              <Field label="Due on" htmlFor="it-due">
                <Input id="it-due" name="dueOn" type="date" required />
              </Field>
              <div className="sm:col-span-4">
                <SubmitButton variant="secondary" pendingText="Adding…">
                  Add item
                </SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
        <Card>
          <CardHeader title={st.status === "approved" ? "Issue invoices" : "Approval"} />
          <div className="space-y-4 p-5 text-sm">
            {st.status === "draft" &&
              (isAdmin ? (
                <ActionForm action={approveStructureAction}>
                  <input type="hidden" name="structureId" value={st.id} />
                  <p className="mb-2 text-slate-600">Approving fixes the items. Invoices can then be issued.</p>
                  <SubmitButton pendingText="Approving…">Approve</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-slate-600">A school administrator must approve this structure before it can be billed.</p>
              ))}
            {st.status === "approved" && (
              <>
                <p className="text-slate-600">Issues one invoice per student currently in {st.className} for the chosen instalment. Running it again only bills students who do not have it yet.</p>
                {instalments.map((d) => (
                  <ActionForm key={d} action={issueAction} inline>
                    <input type="hidden" name="structureId" value={st.id} />
                    <input type="hidden" name="dueOn" value={d} />
                    <SubmitButton variant="secondary" pendingText="Issuing…">
                      Issue instalment due {d}
                    </SubmitButton>
                  </ActionForm>
                ))}
                {isAdmin && <RowAction action={archiveStructureAction} fields={{ structureId: st.id }} label="Archive structure" variant="ghost" />}
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
