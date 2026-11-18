import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getApplication, listAcademicYears, listClasses, listSections, type AdmissionStatus } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { convertAction, documentAction, statusAction, updateApplicationAction } from "../actions";
import { ADMISSION_STATUS, ApplicationFields } from "../application-fields";

export const metadata: Metadata = { title: "Application" };

/** The next steps offered from each status (the database enforces the same rules). */
const NEXT: Record<AdmissionStatus, { to: string; label: string; needsNote?: boolean; variant?: "primary" | "secondary" | "danger" | "ghost" }[]> = {
  enquiry: [{ to: "applied", label: "Application received", variant: "primary" }, { to: "withdrawn", label: "Withdrawn", needsNote: true, variant: "ghost" }],
  applied: [{ to: "under_review", label: "Start review", variant: "primary" }, { to: "withdrawn", label: "Withdrawn", needsNote: true, variant: "ghost" }],
  under_review: [
    { to: "approved", label: "Approve", variant: "primary" },
    { to: "rejected", label: "Reject", needsNote: true, variant: "danger" },
    { to: "withdrawn", label: "Withdrawn", needsNote: true, variant: "ghost" },
  ],
  approved: [{ to: "under_review", label: "Back to review", variant: "ghost" }, { to: "withdrawn", label: "Withdrawn", needsNote: true, variant: "ghost" }],
  rejected: [{ to: "under_review", label: "Reopen for review", variant: "secondary" }],
  withdrawn: [{ to: "under_review", label: "Reopen for review", variant: "secondary" }],
  enrolled: [],
};
const DOC_STATUS = { missing: "Missing", received: "Received", verified: "Verified", waived: "Waived" } as const;

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const a = await getApplication(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const editable = a.status === "enquiry" || a.status === "applied" || a.status === "under_review";
  const open = editable || a.status === "approved";
  const [years, classes, sections] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId), a.status === "approved" ? listSections(db, s.ctx, schoolId, a.yearId) : Promise.resolve([])]);
  const classSections = sections.filter((x) => x.classId === a.classId);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/admissions" className="text-brand-600 hover:text-brand-700">
          ← Admissions
        </Link>
      </p>
      <PageHeader
        title={a.applicantName}
        description={`${a.referenceNo} · ${a.className} · ${a.yearName}`}
        action={<Badge tone={ADMISSION_STATUS[a.status]!.tone}>{ADMISSION_STATUS[a.status]!.label}</Badge>}
      />
      {a.studentId && (
        <div className="mb-6">
          <Alert tone="green">
            Enrolled.{" "}
            <Link href={`/school/students/${a.studentId}`} className="font-semibold underline">
              Open the student record
            </Link>
          </Alert>
        </div>
      )}
      {a.possibleDuplicates.length > 0 && (
        <div className="mb-6">
          <Alert tone="amber">
            Possible duplicate: {a.possibleDuplicates.map((d) => `${d.kind === "student" ? "student" : "application"} ${d.label}`).join("; ")}. Check before approving or converting.
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Documents" description="Approval needs every required document verified or waived (with a reason). Files are private to administrators." />
            <ul className="divide-y divide-slate-100">
              {a.documents.map((d) => (
                <li key={d.kind} className="px-5 py-4 text-sm">
                  <p className="mb-2 font-medium text-slate-900">
                    {d.label} {d.required ? <Badge tone="blue">Required</Badge> : <Badge>Optional</Badge>}{" "}
                    <Badge tone={d.status === "verified" ? "green" : d.status === "waived" ? "slate" : d.status === "received" ? "amber" : "red"}>{DOC_STATUS[d.status]}</Badge>
                  </p>
                  {d.fileId && (
                    <p className="mb-2 text-xs text-slate-600">
                      File: {d.fileStatus === "clean" ? <a href={`/files/${d.fileId}`} className="text-brand-700 underline">{d.fileName}</a> : `${d.fileName} (virus check pending)`}
                    </p>
                  )}
                  {d.note && <p className="mb-2 text-xs text-slate-600">Note: {d.note}</p>}
                  {open && (
                    <ActionForm action={documentAction} keepValues className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="applicationId" value={a.id} />
                      <input type="hidden" name="kind" value={d.kind} />
                      <Field label="Status" htmlFor={`st-${d.kind}`}>
                        <Select id={`st-${d.kind}`} name="status" defaultValue={d.status}>
                          {Object.entries(DOC_STATUS).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="File (optional)" htmlFor={`f-${d.kind}`}>
                        <input id={`f-${d.kind}`} name="file" type="file" accept=".pdf,image/png,image/jpeg,image/webp" className="block w-48 text-xs" />
                      </Field>
                      <Field label="Note" htmlFor={`n-${d.kind}`} className="min-w-40 flex-1">
                        <Input id={`n-${d.kind}`} name="note" maxLength={300} defaultValue={d.note ?? ""} />
                      </Field>
                      <SubmitButton variant="secondary" pendingText="Saving…" aria-label={`Save ${d.label}`}>
                        Save
                      </SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          {editable ? (
            <Card>
              <CardHeader title="Details" />
              <ActionForm action={updateApplicationAction} keepValues className="space-y-4 p-5">
                <input type="hidden" name="applicationId" value={a.id} />
                <ApplicationFields years={years.filter((y) => y.status !== "closed" || y.id === a.yearId)} classes={classes} d={a} />
                <SubmitButton pendingText="Saving…">Save details</SubmitButton>
              </ActionForm>
            </Card>
          ) : (
            <Card>
              <CardHeader title="Details" />
              <dl className="grid gap-3 p-5 text-sm sm:grid-cols-2">
                {[
                  ["Date of birth", a.dateOfBirth ?? "—"],
                  ["Guardian", a.guardianName],
                  ["Mobile", a.guardianPhone ?? "—"],
                  ["Email", a.guardianEmail ?? "—"],
                  ["Previous school", a.previousSchool ?? "—"],
                  ["Decision note", a.decisionNote ?? "—"],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="text-slate-900">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {NEXT[a.status].length > 0 && (
            <Card>
              <CardHeader title="Next step" />
              <ActionForm action={statusAction} className="space-y-3 p-5">
                <input type="hidden" name="applicationId" value={a.id} />
                <Field label="Note" htmlFor="st-note" hint="Required to reject or withdraw.">
                  <Input id="st-note" name="note" maxLength={500} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {NEXT[a.status].map((n) => (
                    <SubmitButton key={n.to} name="to" value={n.to} variant={n.variant ?? "secondary"}>
                      {n.label}
                    </SubmitButton>
                  ))}
                </div>
              </ActionForm>
            </Card>
          )}

          {a.status === "approved" && (
            <Card>
              <CardHeader title="Enroll" description="Creates the student's account and record once. Converting again changes nothing." />
              <ActionForm action={convertAction} keepValues className="space-y-3 p-5">
                <input type="hidden" name="applicationId" value={a.id} />
                <Field label="Admission number" htmlFor="admissionNo">
                  <Input id="admissionNo" name="admissionNo" required maxLength={30} />
                </Field>
                <Field label={`Section of ${a.className} (optional)`} htmlFor="sectionId">
                  <Select id="sectionId" name="sectionId" defaultValue="">
                    <option value="">Not yet</option>
                    {classSections.map((x) => (
                      <option key={x.id} value={x.id}>
                        {a.className} {x.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Roll number (optional)" htmlFor="rollNo">
                  <Input id="rollNo" name="rollNo" type="number" min={1} max={9999} />
                </Field>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="confirmNotDuplicate" className="mt-1" />
                  This is a different child from any student with the same name and birth date
                </label>
                <SubmitButton pendingText="Enrolling…">Create student</SubmitButton>
              </ActionForm>
            </Card>
          )}

          <Card>
            <CardHeader title="Timeline" />
            <ol className="divide-y divide-slate-100 text-sm">
              {a.events.map((e, n) => (
                <li key={n} className="px-5 py-2">
                  <span className="font-medium text-slate-900">{ADMISSION_STATUS[e.to]?.label ?? e.to}</span>
                  {e.note ? ` · ${e.note}` : ""}
                  <span className="block text-xs text-slate-500">
                    {e.by}, {formatDateTime(e.at, s.timeZone)}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
