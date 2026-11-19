import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getHrRecord, listHrNames, type HrRecord } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { documentAction, employmentAction, paymentAction, removeDocumentAction } from "../../actions";
import { DOCUMENT_LABEL, EMPLOYMENT_TYPE_LABEL, HISTORY_LABEL } from "../../labels";

export const metadata: Metadata = { title: "HR record" };

type Event = HrRecord["history"][number];

export default async function HrStaffPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const { id } = await params;
  const [r, departments, designations] = await Promise.all([
    getHrRecord(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
      if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
      throw e;
    }),
    listHrNames(db, s.ctx, s.ctx.schoolId, "department"),
    listHrNames(db, s.ctx, s.ctx.schoolId, "designation"),
  ]);
  const e = r.employment;
  const active = r.status === "active";
  const historyColumns: Column<Event>[] = [
    { key: "date", header: "Effective", primary: true, cell: (h) => h.effectiveOn },
    { key: "kind", header: "Change", cell: (h) => HISTORY_LABEL[h.kind] ?? h.kind },
    { key: "what", header: "From → to", cell: (h) => (h.kind === "left" || h.kind === "rejoined" ? "—" : `${h.fromValue ?? "—"} → ${h.toValue ?? "—"}`) },
    { key: "note", header: "Note", secondary: true, cell: (h) => h.note ?? "—" },
    { key: "by", header: "Recorded", secondary: true, cell: (h) => `${h.actor}, ${formatDateTime(h.at, s.timeZone)}` },
  ];
  const choices = (rows: typeof departments, current: string | null) => rows.filter((x) => !x.archived || x.id === current);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/hr" className="text-brand-600 hover:text-brand-700">
          ← HR
        </Link>
      </p>
      <PageHeader
        title={r.name}
        description={[r.employeeNo, r.jobTitle, r.joinedOn ? `joined ${r.joinedOn}` : null, r.leftOn ? `left ${r.leftOn}` : null].filter(Boolean).join(" · ")}
        action={
          <span className="flex flex-wrap items-center gap-3">
            {!active && <Badge tone="slate">Left</Badge>}
            <Link href={`/school/staff/${r.staffId}`} className="text-sm font-medium text-brand-700 hover:underline">
              Staff profile
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Employment" description={active ? "Changes to type, department, designation and confirmation are added to the history." : "Rejoin the staff member on their staff profile to change their employment."} />
            <ActionForm action={employmentAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="staffId" value={r.staffId} />
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Employment type" htmlFor="emp-type">
                  <Select id="emp-type" name="employmentType" defaultValue={e?.employmentType ?? "permanent"} disabled={!active}>
                    {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Department" htmlFor="emp-dept">
                  <Select id="emp-dept" name="departmentId" defaultValue={e?.departmentId ?? ""} disabled={!active}>
                    <option value="">None</option>
                    {choices(departments, e?.departmentId ?? null).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Designation" htmlFor="emp-desig">
                  <Select id="emp-desig" name="designationId" defaultValue={e?.designationId ?? ""} disabled={!active}>
                    <option value="">None</option>
                    {choices(designations, e?.designationId ?? null).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Confirmed on (permanent staff)" htmlFor="emp-confirmed">
                  <Input id="emp-confirmed" name="confirmedOn" type="date" defaultValue={e?.confirmedOn ?? ""} disabled={!active} />
                </Field>
                <Field label="Notice period (days)" htmlFor="emp-notice">
                  <Input id="emp-notice" name="noticeDays" type="number" min={0} max={365} defaultValue={e?.noticeDays ?? ""} disabled={!active} />
                </Field>
                <Field label="Change takes effect on" htmlFor="emp-effective" hint="Today if left empty.">
                  <Input id="emp-effective" name="effectiveOn" type="date" disabled={!active} />
                </Field>
                <Field label="Emergency contact" htmlFor="emp-ename">
                  <Input id="emp-ename" name="emergencyName" maxLength={120} defaultValue={e?.emergencyName ?? ""} disabled={!active} />
                </Field>
                <Field label="Emergency contact's mobile" htmlFor="emp-ephone">
                  <Input id="emp-ephone" name="emergencyPhone" type="tel" defaultValue={e?.emergencyPhone ?? ""} disabled={!active} />
                </Field>
                <Field label="Note for the history (optional)" htmlFor="emp-note">
                  <Input id="emp-note" name="note" maxLength={300} disabled={!active} />
                </Field>
              </div>
              {active && <SubmitButton pendingText="Saving…">Save employment</SubmitButton>}
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Employment history" description="Never edited or deleted." />
            <DataTable caption="Employment history" columns={historyColumns} rows={r.history} rowKey={(h) => `${h.at.toISOString()}-${h.kind}`} empty={{ title: "No changes recorded yet" }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Payment details"
              description={r.payment ? `Account ending ${r.payment.accountLast4} · ${r.payment.ifsc}${r.payment.pan ? ` · PAN ${r.payment.pan}` : ""}` : "Not recorded. Needed for payroll."}
            />
            <ActionForm action={paymentAction} className="space-y-4 p-5">
              <input type="hidden" name="staffId" value={r.staffId} />
              <Field label="Account holder" htmlFor="pay-holder">
                <Input id="pay-holder" name="accountHolder" required maxLength={120} defaultValue={r.payment?.accountHolder ?? r.name} />
              </Field>
              <Field label="Account number" htmlFor="pay-acc" hint={r.payment ? "Enter the full number again to change the details." : undefined}>
                <Input id="pay-acc" name="accountNo" required inputMode="numeric" autoComplete="off" />
              </Field>
              <Field label="IFSC" htmlFor="pay-ifsc">
                <Input id="pay-ifsc" name="ifsc" required maxLength={11} autoComplete="off" defaultValue={r.payment?.ifsc ?? ""} />
              </Field>
              <Field label="PAN (optional)" htmlFor="pay-pan">
                <Input id="pay-pan" name="pan" maxLength={10} autoComplete="off" defaultValue={r.payment?.pan ?? ""} />
              </Field>
              <SubmitButton pendingText="Saving…">Save payment details</SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="HR documents" description="Private to school administrators." />
            {r.documents.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {r.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900">{DOCUMENT_LABEL[d.kind] ?? d.kind}</span>
                      {d.fileStatus === "clean" ? (
                        <a href={`/files/${d.fileId}`} className="text-brand-700 underline">
                          {d.fileName}
                        </a>
                      ) : (
                        <span className="text-slate-600">{`${d.fileName} (virus check pending)`}</span>
                      )}
                      {d.note && <span className="block text-xs text-slate-600">{d.note}</span>}
                    </span>
                    <ActionForm action={removeDocumentAction} inline>
                      <input type="hidden" name="documentId" value={d.id} />
                      <SubmitButton variant="ghost" pendingText="Removing…" aria-label={`Remove ${d.fileName}`}>
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={documentAction} className="space-y-4 border-t border-slate-100 p-5">
              <input type="hidden" name="staffId" value={r.staffId} />
              <Field label="Kind" htmlFor="doc-kind">
                <Select id="doc-kind" name="kind" defaultValue="appointment_letter">
                  {Object.entries(DOCUMENT_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="File (PDF or image, up to 10 MB)" htmlFor="doc-file">
                <input id="doc-file" name="file" type="file" required accept=".pdf,image/png,image/jpeg,image/webp" className="block w-full text-sm" />
              </Field>
              <Field label="Note (optional)" htmlFor="doc-note">
                <Input id="doc-note" name="note" maxLength={300} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Uploading…">Upload document</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
