import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStaffDetail, listAcademicYears, listClasses, listSections, listSubjects } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction, chooseYear } from "../../setup/shared";
import { assignAction, classTeacherAction, endAssignmentAction, issueStaffCodeAction, markLeftAction, reactivateAction, signOutEverywhereAction, updateStaffAction } from "../actions";

export const metadata: Metadata = { title: "Staff member" };

const ROLE_LABEL: Record<string, string> = { school_admin: "Admin", teacher: "Teacher", finance: "Finance" };

export default async function StaffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const staff = await getStaffDetail(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const [years, classes, subjects] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId), listSubjects(db, s.ctx, schoolId)]);
  const year = chooseYear(years, undefined);
  const sections = year && year.status !== "closed" ? await listSections(db, s.ctx, schoolId, year.id) : [];
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const sectionOptions = sections
    .filter((x) => className.has(x.classId))
    .map((x) => ({ id: x.id, label: `${className.get(x.classId)} ${x.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const isTeacher = staff.roles.includes("teacher");
  const active = staff.status === "active";
  const current = staff.assignments.filter((a) => !a.endsOn);
  const past = staff.assignments.filter((a) => a.endsOn);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/staff" className="text-brand-600 hover:text-brand-700">
          ← Staff
        </Link>
      </p>
      <PageHeader
        title={staff.displayName}
        description={`${staff.employeeNo}${staff.jobTitle ? ` · ${staff.jobTitle}` : ""} · ${staff.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "No school role"}`}
        action={
          <span className="flex flex-wrap items-center gap-3">
            {active ? <Badge tone="green">Active</Badge> : <Badge>Left {staff.leftOn}</Badge>}
            <Link href={`/school/hr/staff/${id}`} className="text-sm font-medium text-brand-700 hover:underline">
              HR record
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Teaching" description={year ? `Current assignments; new ones are added to ${year.name}.` : "Create an academic year first."} />
            {current.length === 0 ? (
              <EmptyState title="No current assignments">{isTeacher ? "Assign subjects and sections below." : "Only staff with the teacher role teach classes."}</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {current.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <span>
                      <span className="font-medium text-slate-900">{a.sectionLabel}</span> · {a.kind === "class_teacher" ? <Badge tone="blue">Class teacher</Badge> : a.subjectName}
                      <span className="block text-xs text-slate-500">
                        {a.yearName}, since {a.startsOn}
                      </span>
                    </span>
                    {!a.yearClosed && <RowAction action={endAssignmentAction} fields={{ kind: a.kind, id: a.id }} label="End today" ariaLabel={`End ${a.kind === "class_teacher" ? "class teacher role" : a.subjectName} for ${a.sectionLabel}`} />}
                  </li>
                ))}
              </ul>
            )}
            {active && isTeacher && year && year.status !== "closed" && sectionOptions.length > 0 && (
              <div className="grid gap-6 border-t border-slate-100 p-5 md:grid-cols-2">
                <ActionForm action={assignAction} className="space-y-3">
                  <input type="hidden" name="staffId" value={staff.id} />
                  <p className="text-sm font-semibold text-slate-900">Assign a subject</p>
                  <Field label="Section" htmlFor="as-section">
                    <Select id="as-section" name="sectionId" required>
                      {sectionOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Subject" htmlFor="as-subject" hint="Must be a subject the class studies this year.">
                    <Select id="as-subject" name="subjectId" required>
                      {subjects.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="From" htmlFor="as-start" hint="Leave empty for today.">
                    <Input id="as-start" name="startsOn" type="date" min={year.startsOn} max={year.endsOn} />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Assigning…">
                    Assign
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={classTeacherAction} className="space-y-3">
                  <input type="hidden" name="staffId" value={staff.id} />
                  <p className="text-sm font-semibold text-slate-900">Make class teacher</p>
                  <Field label="Section" htmlFor="ct-section">
                    <Select id="ct-section" name="sectionId" required>
                      {sectionOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="From" htmlFor="ct-start" hint="Replaces the current class teacher from this date.">
                    <Input id="ct-start" name="startsOn" type="date" min={year.startsOn} max={year.endsOn} />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    Make class teacher
                  </SubmitButton>
                </ActionForm>
              </div>
            )}
          </Card>
          {past.length > 0 && (
            <Card>
              <CardHeader title="Past assignments" />
              <ul className="divide-y divide-slate-100 text-sm">
                {past.map((a) => (
                  <li key={a.id} className="px-5 py-2 text-slate-700">
                    {a.sectionLabel} · {a.kind === "class_teacher" ? "Class teacher" : a.subjectName} · {a.startsOn} to {a.endsOn} ({a.yearName})
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <ActionForm action={updateStaffAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="staffId" value={staff.id} />
              <Field label="Name" htmlFor="d-name">
                <Input id="d-name" name="displayName" required minLength={2} maxLength={120} defaultValue={staff.displayName} />
              </Field>
              <Field label="Employee number" htmlFor="d-no">
                <Input id="d-no" name="employeeNo" required maxLength={30} defaultValue={staff.employeeNo} />
              </Field>
              <Field label="Job title" htmlFor="d-job">
                <Input id="d-job" name="jobTitle" maxLength={80} defaultValue={staff.jobTitle ?? ""} />
              </Field>
              <Field label="Joined on" htmlFor="d-joined">
                <Input id="d-joined" name="joinedOn" type="date" defaultValue={staff.joinedOn ?? ""} />
              </Field>
              <p className="text-sm text-slate-600">Contact: {[staff.email, staff.phone].filter(Boolean).join(" · ") || "—"}</p>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save details
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Account access" />
            <div className="space-y-4 p-5">
              {staff.manageable ? (
                <ActionForm action={issueStaffCodeAction} className="space-y-3">
                  <input type="hidden" name="userId" value={staff.userId} />
                  <Field label="Purpose" htmlFor="code-purpose">
                    <Select id="code-purpose" name="purpose" defaultValue="password_reset">
                      <option value="password_reset">Forgot password: reset code</option>
                      <option value="activation">Never signed in: new activation code</option>
                    </Select>
                  </Field>
                  <Field label="Reason" htmlFor="code-reason" hint="How you confirmed who is asking. Recorded in the audit log.">
                    <Input id="code-reason" name="reason" required minLength={5} maxLength={200} />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Creating…">
                    Create one-time code
                  </SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">This account is shared with another school or is an administrator, so its password is managed by the person or by Examio support.</p>
              )}
              {active && staff.manageable && (
                <ActionForm action={signOutEverywhereAction}>
                  <input type="hidden" name="userId" value={staff.userId} />
                  <SubmitButton variant="ghost" pendingText="Signing out…">
                    Sign out of all devices
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title={active ? "Leaving the school" : "Returning"} />
            <div className="p-5">
              {active ? (
                <ActionForm action={markLeftAction} className="space-y-3">
                  <input type="hidden" name="staffId" value={staff.id} />
                  <p className="text-sm text-slate-600">Ends their access to this school at once and ends their assignments. Their history is kept.</p>
                  <Field label="Last day" htmlFor="left-on" hint="Leave empty for today.">
                    <Input id="left-on" name="leftOn" type="date" />
                  </Field>
                  <Field label="Reason" htmlFor="left-reason">
                    <Input id="left-reason" name="reason" required minLength={3} maxLength={200} />
                  </Field>
                  <SubmitButton variant="danger" pendingText="Saving…">
                    Mark as left
                  </SubmitButton>
                </ActionForm>
              ) : (
                <ActionForm action={reactivateAction} className="space-y-3">
                  <input type="hidden" name="staffId" value={staff.id} />
                  <p className="text-sm text-slate-600">Restores their access. Assignments are not restored; add them again.</p>
                  <SubmitButton variant="secondary" pendingText="Restoring…">
                    Bring back
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
