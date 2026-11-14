import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStudentDetail, listAcademicYears, listClasses, listSections, listStudentDocuments, findSchoolParents } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../../setup/shared";
import {
  changeSectionAction,
  correctEnrollmentAction,
  createGuardianAction,
  enrollAction,
  guardianCodeAction,
  issueStudentCodeAction,
  linkGuardianAction,
  markStudentLeftAction,
  readmitAction,
  removeDocumentAction,
  revokeGuardianAction,
  setRollAction,
  signOutStudentAction,
  updateStudentAction,
  uploadDocumentAction,
} from "../actions";
import { END_LABEL, LEAVE_LABEL, RELATIONSHIP_LABEL, sectionOptions } from "../shared";

export const metadata: Metadata = { title: "Student" };

function RelationshipSelect({ id }: { id: string }) {
  return (
    <Select id={id} name="relationship" defaultValue="mother">
      {Object.entries(RELATIONSHIP_LABEL).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
}

export default async function StudentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const sp = await searchParams;
  const student = await getStudentDetail(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const parentSearch = typeof sp.parent === "string" ? sp.parent.slice(0, 100) : "";
  const [years, classes, documents, parents] = await Promise.all([
    listAcademicYears(db, s.ctx, schoolId),
    listClasses(db, s.ctx, schoolId),
    listStudentDocuments(db, s.ctx, schoolId, id),
    parentSearch.length >= 2 ? findSchoolParents(db, s.ctx, schoolId, parentSearch) : Promise.resolve([]),
  ]);
  const openYears = years.filter((y) => y.status !== "closed");
  const optionsByYear = await Promise.all(openYears.map(async (y) => ({ year: y, options: sectionOptions(await listSections(db, s.ctx, schoolId, y.id), classes) })));
  const active = student.status === "active";
  const open = student.enrollments.filter((e) => !e.endsOn);
  const linked = student.guardians.filter((g) => !g.revokedAt);
  const pastGuardians = student.guardians.filter((g) => g.revokedAt);
  const enrollableYears = optionsByYear.filter((x) => x.options.length > 0 && !open.some((e) => e.yearId === x.year.id));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/students" className="text-brand-600 hover:text-brand-700">
          ← Students
        </Link>
      </p>
      <PageHeader
        title={student.displayName}
        description={`Admission no. ${student.admissionNo} · Sign-in name ${student.username ?? "—"}`}
        action={active ? <Badge tone="green">Active</Badge> : <Badge>{LEAVE_LABEL[student.leaveReason ?? "other"]} {student.leftOn}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Class and history" description="Each row is a period in one section. Rows are never deleted." />
            {student.enrollments.length === 0 ? (
              <EmptyState title="Not enrolled">{active ? "Enroll the student in a section below." : "The student has left."}</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {student.enrollments.map((e) => (
                  <li key={e.id} className="space-y-2 px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-medium text-slate-900">{e.sectionLabel}</span>
                        {e.rollNo !== null && <span className="text-slate-600"> · Roll {e.rollNo}</span>}
                        <span className="block text-xs text-slate-500">
                          {e.yearName}: {e.startsOn} to {e.endsOn ?? "now"}
                          {e.endReason ? ` · ${END_LABEL[e.endReason] ?? e.endReason}` : ""}
                        </span>
                      </span>
                      {!e.endsOn && e.yearStatus !== "closed" && active && (
                        <RowAction action={correctEnrollmentAction} fields={{ enrollmentId: e.id }} label="Mistake: undo" variant="ghost" ariaLabel={`Mark the enrollment in ${e.sectionLabel} as a correction`} />
                      )}
                    </div>
                    {!e.endsOn && e.yearStatus !== "closed" && active && (
                      <div className="flex flex-wrap gap-4">
                        <ActionForm action={setRollAction} inline>
                          <input type="hidden" name="enrollmentId" value={e.id} />
                          <label className="sr-only" htmlFor={`roll-${e.id}`}>
                            Roll number in {e.sectionLabel}
                          </label>
                          <Input id={`roll-${e.id}`} name="rollNo" defaultValue={e.rollNo ?? ""} inputMode="numeric" pattern="[0-9]*" maxLength={4} className="w-24" placeholder="Roll" />
                          <SubmitButton variant="secondary" pendingText="Saving…" className="min-h-9 px-3 py-1.5 text-xs">
                            Save roll
                          </SubmitButton>
                        </ActionForm>
                        {(() => {
                          const same = optionsByYear.find((x) => x.year.id === e.yearId)?.options.filter((o) => o.id !== e.sectionId) ?? [];
                          return same.length > 0 ? (
                            <ActionForm action={changeSectionAction} inline>
                              <input type="hidden" name="enrollmentId" value={e.id} />
                              <label className="sr-only" htmlFor={`move-${e.id}`}>
                                Move to section
                              </label>
                              <Select id={`move-${e.id}`} name="sectionId" className="w-36">
                                {same.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.label}
                                  </option>
                                ))}
                              </Select>
                              <label className="sr-only" htmlFor={`move-on-${e.id}`}>
                                Move from date
                              </label>
                              <Input id={`move-on-${e.id}`} name="effectiveOn" type="date" className="w-40" />
                              <SubmitButton variant="secondary" pendingText="Moving…" className="min-h-9 px-3 py-1.5 text-xs">
                                Move
                              </SubmitButton>
                            </ActionForm>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {active && enrollableYears.length > 0 && (
              <ActionForm action={enrollAction} className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-4">
                <input type="hidden" name="studentId" value={student.id} />
                <Field label="Enroll in" htmlFor="en-section" className="sm:col-span-2">
                  <Select id="en-section" name="sectionId" required>
                    {enrollableYears.map((x) => (
                      <optgroup key={x.year.id} label={x.year.name}>
                        {x.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                <Field label="Roll" htmlFor="en-roll">
                  <Input id="en-roll" name="rollNo" inputMode="numeric" pattern="[0-9]*" maxLength={4} />
                </Field>
                <Field label="From" htmlFor="en-from" hint="Empty: today.">
                  <Input id="en-from" name="startsOn" type="date" />
                </Field>
                <div className="sm:col-span-4">
                  <SubmitButton variant="secondary" pendingText="Enrolling…">
                    Enroll
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>

          <Card>
            <CardHeader title="Parents and guardians" description="A parent sees only the children they are linked to here." />
            {linked.length === 0 ? (
              <EmptyState title="No parent linked">Add a parent below.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {linked.map((g) => (
                  <li key={g.linkId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span>
                      <span className="font-medium text-slate-900">{g.name}</span> <Badge tone="blue">{RELATIONSHIP_LABEL[g.relationship] ?? g.relationship}</Badge>
                      <span className="block text-xs text-slate-500">{[g.email, g.phone].filter(Boolean).join(" · ") || "No contact details"}</span>
                    </span>
                    <RowAction action={revokeGuardianAction} fields={{ linkId: g.linkId }} label="Unlink" variant="danger" ariaLabel={`Unlink ${g.name}`} />
                  </li>
                ))}
              </ul>
            )}
            {pastGuardians.length > 0 && <p className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500">Earlier links: {pastGuardians.map((g) => g.name).join(", ")}</p>}
            {active && (
              <div className="grid gap-6 border-t border-slate-100 p-5 md:grid-cols-2">
                <ActionForm action={createGuardianAction} className="space-y-3">
                  <input type="hidden" name="studentId" value={student.id} />
                  <p className="text-sm font-semibold text-slate-900">New parent account</p>
                  <Field label="Parent's name" htmlFor="g-name">
                    <Input id="g-name" name="fullName" required minLength={2} maxLength={120} />
                  </Field>
                  <Field label="Parent's mobile number" htmlFor="g-phone">
                    <Input id="g-phone" name="phone" type="tel" />
                  </Field>
                  <Field label="Parent's email" htmlFor="g-email" hint="Mobile number or email is needed to sign in.">
                    <Input id="g-email" name="email" type="email" />
                  </Field>
                  <Field label="Relationship" htmlFor="g-rel">
                    <RelationshipSelect id="g-rel" />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Adding…">
                    Add parent
                  </SubmitButton>
                </ActionForm>
                <div className="space-y-6">
                  <div className="space-y-3">
                    <p className="text-sm font-semibold text-slate-900">Parent of a sibling</p>
                    <form method="get" className="flex flex-wrap items-end gap-2">
                      <Field label="Find a parent of this school" htmlFor="g-find">
                        <Input id="g-find" name="parent" defaultValue={parentSearch} minLength={2} maxLength={100} placeholder="Name, phone or email" />
                      </Field>
                      <button type="submit" className="min-h-11 rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
                        Search
                      </button>
                    </form>
                    {parentSearch.length >= 2 && parents.length === 0 && <p className="text-sm text-slate-600">No parent matches.</p>}
                    {parents.map((p) => (
                      <ActionForm key={p.userId} action={linkGuardianAction} inline>
                        <input type="hidden" name="studentId" value={student.id} />
                        <input type="hidden" name="guardianUserId" value={p.userId} />
                        <span className="text-sm">
                          {p.fullName} <span className="text-slate-500">({p.children.join(", ") || "no child linked"})</span>
                        </span>
                        <label className="sr-only" htmlFor={`rel-${p.userId}`}>
                          Relationship of {p.fullName}
                        </label>
                        <RelationshipSelect id={`rel-${p.userId}`} />
                        <SubmitButton variant="secondary" pendingText="Linking…" className="min-h-9 px-3 py-1.5 text-xs">
                          Link
                        </SubmitButton>
                      </ActionForm>
                    ))}
                  </div>
                  <ActionForm action={guardianCodeAction} className="space-y-3">
                    <input type="hidden" name="studentId" value={student.id} />
                    <p className="text-sm font-semibold text-slate-900">Parent who already uses Examio</p>
                    <Field label="Who is it for?" htmlFor="gc-label" hint="For your records, e.g. their name.">
                      <Input id="gc-label" name="recipientLabel" required minLength={2} maxLength={200} />
                    </Field>
                    <Field label="Relationship" htmlFor="gc-rel">
                      <RelationshipSelect id="gc-rel" />
                    </Field>
                    <SubmitButton variant="secondary" pendingText="Creating…">
                      Create code for this child
                    </SubmitButton>
                  </ActionForm>
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Documents" description="Private: only school administrators can see them. PDF or image, up to 10 MB." />
            {documents.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-600">No documents.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span>
                      {d.fileStatus === "clean" ? (
                        <a href={`/files/${d.fileId}`} className="font-medium text-brand-700 hover:underline">
                          {d.title}
                        </a>
                      ) : (
                        <span className="font-medium text-slate-900">{d.title}</span>
                      )}
                      <span className="block text-xs text-slate-500">
                        {d.fileName}
                        {d.fileStatus === "quarantined" ? " · Virus check pending" : d.fileStatus === "rejected" ? " · Blocked by the virus check" : ""}
                      </span>
                    </span>
                    <RowAction action={removeDocumentAction} fields={{ documentId: d.id }} label="Remove" variant="ghost" ariaLabel={`Remove ${d.title}`} />
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={uploadDocumentAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 p-5">
              <input type="hidden" name="studentId" value={student.id} />
              <Field label="Title" htmlFor="doc-title">
                <Input id="doc-title" name="title" maxLength={120} placeholder="e.g. Birth certificate" />
              </Field>
              <Field label="File" htmlFor="doc-file">
                <input id="doc-file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp" className="block text-sm" />
              </Field>
              <SubmitButton variant="secondary" pendingText="Uploading…">
                Upload
              </SubmitButton>
            </ActionForm>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <ActionForm action={updateStudentAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="studentId" value={student.id} />
              <Field label="Name" htmlFor="sd-name">
                <Input id="sd-name" name="displayName" required minLength={2} maxLength={120} defaultValue={student.displayName} />
              </Field>
              <Field label="Admission date" htmlFor="sd-admitted">
                <Input id="sd-admitted" name="admittedOn" type="date" required defaultValue={student.admittedOn} />
              </Field>
              <Field label="Date of birth" htmlFor="sd-dob">
                <Input id="sd-dob" name="dateOfBirth" type="date" defaultValue={student.dateOfBirth ?? ""} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save details
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Account access" />
            <div className="space-y-4 p-5">
              {student.manageable ? (
                <ActionForm action={issueStudentCodeAction} className="space-y-3">
                  <input type="hidden" name="userId" value={student.userId} />
                  <Field label="Purpose" htmlFor="sc-purpose">
                    <Select id="sc-purpose" name="purpose" defaultValue="password_reset">
                      <option value="password_reset">Forgot password: reset code</option>
                      <option value="activation">Never signed in: new activation code</option>
                    </Select>
                  </Field>
                  <Field label="Reason" htmlFor="sc-reason" hint="How you confirmed who is asking. Recorded in the audit log.">
                    <Input id="sc-reason" name="reason" required minLength={5} maxLength={200} />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Creating…">
                    Create one-time code
                  </SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">This account is shared with another school, so its password is managed by the person.</p>
              )}
              {active && student.manageable && (
                <ActionForm action={signOutStudentAction}>
                  <input type="hidden" name="userId" value={student.userId} />
                  <SubmitButton variant="ghost" pendingText="Signing out…">
                    Sign out of all devices
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title={active ? "Leaving the school" : "Readmission"} />
            <div className="p-5">
              {active ? (
                <ActionForm action={markStudentLeftAction} className="space-y-3">
                  <input type="hidden" name="studentId" value={student.id} />
                  <p className="text-sm text-slate-600">Ends the student&apos;s access at once and ends their current class. The record and history are kept; linked parents still see them.</p>
                  <Field label="Reason" htmlFor="sl-reason">
                    <Select id="sl-reason" name="reason" defaultValue="withdrawn">
                      {Object.entries(LEAVE_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Last day" htmlFor="sl-on" hint="Leave empty for today.">
                    <Input id="sl-on" name="leftOn" type="date" />
                  </Field>
                  <SubmitButton variant="danger" pendingText="Saving…">
                    Mark as left
                  </SubmitButton>
                </ActionForm>
              ) : (
                <ActionForm action={readmitAction} className="space-y-3">
                  <input type="hidden" name="studentId" value={student.id} />
                  <p className="text-sm text-slate-600">Restores the student&apos;s access. Enroll them in a section afterwards.</p>
                  <SubmitButton variant="secondary" pendingText="Readmitting…">
                    Readmit
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
