import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getHomeworkForStaff } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { FileList } from "@/components/file-list";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { RowAction } from "../../setup/shared";
import { archiveHomeworkAction, feedbackAction, remindHomeworkAction, updateHomeworkAction } from "../actions";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Homework" };


export default async function HomeworkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const when = (d: Date | string) => formatDateTime(d, s.timeZone);
  const { id } = await params;
  const h = await getHomeworkForStaff(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const submitted = h.rows.filter((r) => r.submissionId).length;
  const open = h.status === "published";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/homework" className="text-brand-600 hover:text-brand-700">
          ← Homework
        </Link>
      </p>
      <PageHeader
        title={h.title}
        description={`${h.sectionLabel} · ${h.subjectName} · due ${when(h.dueAt)}${h.allowLate ? " · late accepted" : ""}`}
        action={open ? <Badge tone="green">Published</Badge> : <Badge>Archived</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Submissions" description={`${submitted} of ${h.rows.length} submitted`} />
          {h.rows.length === 0 ? (
            <EmptyState title="No students">No students are enrolled in this section.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {h.rows.map((r) => (
                <li key={r.studentId} className="space-y-2 px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {r.rollNo !== null && <span className="mr-2 tabular-nums text-slate-500">{r.rollNo}.</span>}
                      {r.displayName}
                    </span>
                    <span className="flex gap-2">
                      {!r.submissionId ? <Badge tone="red">Not submitted</Badge> : r.late ? <Badge tone="amber">Late</Badge> : <Badge tone="green">On time</Badge>}
                      {r.returnedAt && <Badge tone="blue">Feedback returned</Badge>}
                    </span>
                  </div>
                  {r.submissionId && (
                    <>
                      {r.body && <p className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-slate-800">{r.body}</p>}
                      <FileList files={r.files} />
                      <p className="text-xs text-slate-500">Submitted {r.submittedAt ? when(r.submittedAt) : ""}</p>
                      <ActionForm action={feedbackAction} className="space-y-2">
                        <input type="hidden" name="submissionId" value={r.submissionId} />
                        <Field label={`Feedback for ${r.displayName}`} htmlFor={`fb-${r.submissionId}`}>
                          <Textarea id={`fb-${r.submissionId}`} name="feedback" rows={2} maxLength={2000} required defaultValue={r.feedback ?? ""} />
                        </Field>
                        <SubmitButton variant="secondary" pendingText="Saving…" className="min-h-9 px-3 py-1.5 text-xs">
                          {r.returnedAt ? "Update feedback" : "Return feedback"}
                        </SubmitButton>
                      </ActionForm>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Instructions" />
            <div className="space-y-3 p-5 text-sm">
              <p className="whitespace-pre-wrap text-slate-800">{h.instructions ?? "No instructions."}</p>
              <FileList files={h.attachments} />
            </div>
          </Card>
          {open && (
            <>
              <Card>
                <CardHeader title="Remind and archive" />
                <div className="flex flex-wrap gap-3 p-5">
                  <RowAction action={remindHomeworkAction} fields={{ homeworkId: h.id }} label="Remind who has not submitted" ariaLabel="Send a reminder to students who have not submitted" />
                  <RowAction action={archiveHomeworkAction} fields={{ homeworkId: h.id }} label="Archive" variant="ghost" />
                </div>
              </Card>
              <Card>
                <CardHeader title="Edit" />
                <ActionForm action={updateHomeworkAction} keepValues className="space-y-4 p-5">
                  <input type="hidden" name="homeworkId" value={h.id} />
                  <Field label="Title" htmlFor="eh-title">
                    <Input id="eh-title" name="title" required maxLength={150} defaultValue={h.title} />
                  </Field>
                  <Field label="Instructions" htmlFor="eh-instructions">
                    <Textarea id="eh-instructions" name="instructions" rows={4} maxLength={5000} defaultValue={h.instructions ?? ""} />
                  </Field>
                  <Field label="Due" htmlFor="eh-due" hint="School time.">
                    <Input id="eh-due" name="dueAt" type="datetime-local" required defaultValue={h.dueLocal} />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <input type="checkbox" name="allowLate" defaultChecked={h.allowLate} className="h-5 w-5 rounded border-slate-300" />
                    Accept late submissions
                  </label>
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    Save changes
                  </SubmitButton>
                </ActionForm>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
