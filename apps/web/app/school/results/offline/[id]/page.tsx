import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getCurrentAcademicYear, getOfflineAssessment, listClasses, listSections } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { RowAction } from "../../../setup/shared";
import { correctOfflineAction, importOfflineAction, offlineStateAction, saveOfflineMarksAction, updateOfflineAction } from "../../actions";
import { OFFLINE_STATUS, entryText, pct } from "../../shared";

export const metadata: Metadata = { title: "Paper exam" };

export default async function OfflinePage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const o = await getOfflineAssessment(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const editable = o.status === "draft" || o.status === "submitted";
  const max = o.maxX100 / 100;
  const entered = o.sections.reduce((a, x) => a + x.rows.filter((r) => r.status).length, 0);
  const total = o.sections.reduce((a, x) => a + x.rows.length, 0);
  const year = o.canPublish && o.status === "draft" ? await getCurrentAcademicYear(db, s.ctx, schoolId) : null;
  const sectionOptions = year
    ? await Promise.all([listSections(db, s.ctx, schoolId, year.id), listClasses(db, s.ctx, schoolId)]).then(([secs, classes]) => {
        const cls = new Map(classes.map((c) => [c.id, c]));
        return secs.map((x) => ({ id: x.id, label: `${cls.get(x.classId)?.name ?? ""} ${x.name}`, order: cls.get(x.classId)?.sortOrder ?? 0 })).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
      })
    : [];
  const chosen = new Set(o.sections.map((x) => x.sectionId));
  const allRows = o.sections.flatMap((x) => x.rows.map((r) => ({ ...r, section: x.label })));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/results" className="text-brand-600 hover:text-brand-700">
          ← Results
        </Link>
      </p>
      <PageHeader
        title={o.title}
        description={`${o.subjectName}${o.heldOn ? ` · ${o.heldOn}` : ""} · out of ${max} · ${entered} of ${total} entered`}
        action={<Badge tone={OFFLINE_STATUS[o.status]!.tone}>{OFFLINE_STATUS[o.status]!.label}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {o.sections.map((sec) => (
            <Card key={sec.sectionId}>
              <CardHeader
                title={sec.label}
                description={sec.canEnter ? (editable ? `Enter marks out of ${max}, AB for absent or EX for exempt. Every student needs an entry.` : undefined) : "Marks of this section are entered by its subject teacher."}
              />
              {sec.rows.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">{sec.canEnter ? "No students in this section." : "Not visible to you."}</p>
              ) : sec.canEnter && editable ? (
                <ActionForm action={saveOfflineMarksAction} keepValues className="space-y-4 p-5">
                  <input type="hidden" name="assessmentId" value={o.id} />
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {sec.rows.map((r) => (
                      <li key={r.studentId} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
                        <label htmlFor={`v-${r.studentId}`} className="min-w-0 truncate text-slate-900">
                          {r.rollNo !== null ? `${r.rollNo}. ` : ""}
                          {r.name}
                        </label>
                        <Input id={`v-${r.studentId}`} name={`v:${r.studentId}`} defaultValue={entryText(r.status, r.marksX100)} className="w-20 text-right" maxLength={8} inputMode="decimal" />
                      </li>
                    ))}
                  </ul>
                  <SubmitButton pendingText="Saving…">Save {sec.label}</SubmitButton>
                </ActionForm>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <caption className="sr-only">Marks of {sec.label}</caption>
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                      <tr>
                        <th scope="col" className="px-5 py-2">Student</th>
                        <th scope="col" className="px-5 py-2">Marks</th>
                        <th scope="col" className="px-5 py-2">Percent</th>
                        <th scope="col" className="px-5 py-2">Grade</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sec.rows.map((r) => (
                        <tr key={r.studentId}>
                          <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                            {r.name}
                          </th>
                          <td className="px-5 py-2 tabular-nums">{entryText(r.status, r.marksX100) || "—"}</td>
                          <td className="px-5 py-2 tabular-nums">{pct(r.percentBp)}</td>
                          <td className="px-5 py-2">{r.grade ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}

          {o.changes.length > 0 && (
            <Card>
              <CardHeader title="Changes after locking" description="Earlier entries are kept." />
              <ul className="divide-y divide-slate-100 text-sm">
                {o.changes.map((c, n) => (
                  <li key={n} className="px-5 py-2">
                    {c.student}: {c.detail} · {c.reason}
                    <span className="block text-xs text-slate-500">
                      {c.by}, {formatDateTime(c.at, s.timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Status" />
            <div className="flex flex-col items-start gap-3 p-5 text-sm">
              {o.status === "draft" && o.canSubmit && <RowAction action={offlineStateAction} fields={{ assessmentId: o.id, to: "submitted" }} label="Submit marks" variant="primary" />}
              {o.status === "submitted" && o.canSubmit && <RowAction action={offlineStateAction} fields={{ assessmentId: o.id, to: "draft" }} label="Back to entering" variant="ghost" />}
              {editable && o.canPublish && (
                <>
                  <p className="text-slate-600">Locking needs an entry for every student. After locking, changes need a reason.</p>
                  <RowAction action={offlineStateAction} fields={{ assessmentId: o.id, to: "locked" }} label="Lock marks" variant="secondary" />
                </>
              )}
              {o.status === "locked" && o.canPublish && (
                <>
                  <p className="text-slate-600">Releasing shows the marks to students and parents and notifies them.</p>
                  <RowAction action={offlineStateAction} fields={{ assessmentId: o.id, to: "released" }} label="Release marks" variant="primary" />
                </>
              )}
              {o.status === "released" && <p className="text-slate-600">Released. Students and parents can see these marks.</p>}
              <a href={`/school/results/offline/${o.id}/export`} className="font-medium text-brand-700 hover:underline">
                Download marks (CSV)
              </a>
            </div>
          </Card>

          {editable && o.sections.some((x) => x.canEnter) && (
            <Card>
              <CardHeader title="Import marks" description="One line per student: admission number, then marks, AB or EX. All lines or none." />
              <ActionForm action={importOfflineAction} className="space-y-3 p-5">
                <input type="hidden" name="assessmentId" value={o.id} />
                <Field label="CSV file" htmlFor="imp-file">
                  <input id="imp-file" name="file" type="file" accept=".csv,text/csv" className="block w-full text-sm" />
                </Field>
                <Field label="Or paste lines" htmlFor="imp-text">
                  <Textarea id="imp-text" name="text" rows={4} placeholder={"admission_no,marks\nS-001,45.5\nS-002,AB"} />
                </Field>
                <SubmitButton variant="secondary" pendingText="Importing…">
                  Import
                </SubmitButton>
              </ActionForm>
            </Card>
          )}

          {(o.status === "locked" || o.status === "released") && o.canPublish && allRows.length > 0 && (
            <Card>
              <CardHeader title="Correct an entry" description="With a reason; the earlier entry is kept and, once released, the family is notified." />
              <ActionForm action={correctOfflineAction} className="space-y-3 p-5">
                <input type="hidden" name="assessmentId" value={o.id} />
                <Field label="Student" htmlFor="cor-student">
                  <Select id="cor-student" name="studentId" required defaultValue="">
                    <option value="" disabled>
                      Choose a student
                    </option>
                    {allRows.map((r) => (
                      <option key={r.studentId} value={r.studentId}>
                        {r.name} ({r.section}): {entryText(r.status, r.marksX100) || "—"}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="New entry" htmlFor="cor-value" hint="Marks, AB or EX.">
                  <Input id="cor-value" name="value" required maxLength={8} />
                </Field>
                <Field label="Reason" htmlFor="cor-reason">
                  <Input id="cor-reason" name="reason" required minLength={3} maxLength={300} />
                </Field>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Correct
                </SubmitButton>
              </ActionForm>
            </Card>
          )}

          {o.status === "draft" && o.canPublish && (
            <Card>
              <CardHeader title="Details" />
              <ActionForm action={updateOfflineAction} keepValues className="space-y-4 p-5">
                <input type="hidden" name="assessmentId" value={o.id} />
                <Field label="Title" htmlFor="ed-title">
                  <Input id="ed-title" name="title" required maxLength={150} defaultValue={o.title} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date" htmlFor="ed-date">
                    <Input id="ed-date" name="heldOn" type="date" defaultValue={o.heldOn ?? ""} />
                  </Field>
                  <Field label="Maximum marks" htmlFor="ed-max">
                    <Input id="ed-max" name="maxMarks" inputMode="decimal" required defaultValue={String(max)} />
                  </Field>
                </div>
                <fieldset className="space-y-1">
                  <legend className="mb-1 text-sm font-medium text-slate-700">Sections</legend>
                  {sectionOptions.map((x) => (
                    <label key={x.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="sectionId" value={x.id} defaultChecked={chosen.has(x.id)} />
                      {x.label}
                    </label>
                  ))}
                </fieldset>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Save
                </SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
