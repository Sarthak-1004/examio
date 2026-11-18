import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getExam, listExamSectionOptions, searchQuestions, type AttemptState } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { RowAction } from "../../setup/shared";
import { accommodationAction, addExamQuestionsAction, cancelExamAction, examStateAction, removeExamQuestionAction, setExamSectionsAction, updateExamAction } from "../actions";
import { EXAM_STATUS, ExamFields } from "../exam-fields";

export const metadata: Metadata = { title: "Exam" };

const TYPE: Record<string, string> = { single_choice: "Single choice", true_false: "True / false", descriptive: "Written answer" };
const STATE: Record<AttemptState, { label: string; tone: "slate" | "blue" | "amber" | "green" }> = {
  not_started: { label: "Not started", tone: "slate" },
  in_progress: { label: "In progress", tone: "blue" },
  time_up: { label: "Time up", tone: "amber" },
  submitted: { label: "Submitted", tone: "green" },
};
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function ExamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const sp = await searchParams;
  const e = await getExam(db, s.ctx, schoolId, id).catch((err: unknown) => {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "VALIDATION")) notFound();
    throw err;
  });
  const when = (d: Date) => formatDateTime(d, s.timeZone);
  const draft = e.status === "draft";
  const search = one(sp.q).slice(0, 100);
  const bank = draft ? await searchQuestions(db, s.ctx, schoolId, { page: 1, pageSize: 25, search, subjectId: e.subjectId, status: "published" }) : null;
  const inExam = new Set(e.items.map((i) => i.questionId));
  const sectionOptions = draft ? await listExamSectionOptions(db, s.ctx, schoolId, e.id) : [];
  const chosen = new Set(e.targets.map((t) => t.sectionId));
  const students = e.targets.flatMap((t) => t.students.map((st) => ({ ...st, section: t.label })));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/exams" className="text-brand-600 hover:text-brand-700">
          ← Exams
        </Link>
      </p>
      <PageHeader
        title={e.title}
        description={[
          `${e.subjectName} · ${e.yearName}`,
          e.opensAt && e.closesAt ? `${when(e.opensAt)} to ${when(e.closesAt)}` : "Not scheduled",
          `${e.durationMinutes} min`,
          `${e.attemptLimit} attempt(s)`,
          `${e.items.length} question(s), ${formatMarks(e.totalMarksX100)} marks`,
          e.negativeMarking ? "negative marks apply" : "no negative marks",
        ].join(" · ")}
        action={<Badge tone={EXAM_STATUS[e.status]!.tone}>{EXAM_STATUS[e.status]!.label}</Badge>}
      />
      {e.status === "cancelled" && (
        <p role="status" className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          Cancelled {e.cancelledAt ? when(e.cancelledAt) : ""}: {e.cancelReason}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Questions" description="As students will see them, in this order. Each is the question's published version; answers are not shown to students." />
            {e.items.length === 0 ? (
              <EmptyState title="No questions yet">Add published questions below.</EmptyState>
            ) : (
              <ol className="divide-y divide-slate-100">
                {e.items.map((i, n) => (
                  <li key={i.id} className="flex flex-col gap-2 px-5 py-4 text-sm sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium text-slate-900">
                        {n + 1}.{" "}
                        <Link href={`/school/questions/${i.questionId}`} className="whitespace-pre-wrap font-normal hover:underline">
                          {i.stem}
                        </Link>
                      </p>
                      {i.options && (
                        <ul className="pl-5 text-slate-700">
                          {i.options.map((o) => (
                            <li key={o.id}>
                              <span className="font-semibold text-slate-500">{o.id.toUpperCase()}.</span> {o.text}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="text-xs text-slate-500">
                        {TYPE[i.type]} · {formatMarks(i.marksX100)} mark(s)
                        {e.negativeMarking && i.negativeMarksX100 ? `, −${formatMarks(i.negativeMarksX100)} if wrong` : ""} · version {i.revision}
                      </p>
                    </div>
                    {draft && <RowAction action={removeExamQuestionAction} fields={{ examId: e.id, itemId: i.id }} label="Remove" variant="ghost" ariaLabel={`Remove question ${n + 1}`} />}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {draft && bank && (
            <Card>
              <CardHeader title="Add questions" description={`Published ${e.subjectName} questions.`} />
              <form method="get" role="search" className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4">
                <Field label="Search question text" htmlFor="bank-q">
                  <Input id="bank-q" name="q" type="search" defaultValue={search} maxLength={100} />
                </Field>
                <button type="submit" className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Search
                </button>
              </form>
              {bank.rows.length === 0 ? (
                <EmptyState title="No published questions">{search ? "Nothing matches that search." : "Publish questions for this subject in the question bank first."}</EmptyState>
              ) : (
                <ActionForm action={addExamQuestionsAction} className="space-y-3 p-5">
                  <input type="hidden" name="examId" value={e.id} />
                  <fieldset>
                    <legend className="sr-only">Questions to add</legend>
                    <ul className="space-y-2">
                      {bank.rows.map((q) => (
                        <li key={q.id}>
                          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                            <input type="checkbox" name="questionId" value={q.id} disabled={inExam.has(q.id)} className="mt-1" />
                            <span>
                              <span className="text-slate-900">{q.stem.length > 160 ? `${q.stem.slice(0, 157)}…` : q.stem}</span>
                              <span className="block text-xs text-slate-500">
                                {TYPE[q.type]} · {q.difficulty} · {formatMarks(q.marksX100)} mark(s){q.topicPath ? ` · ${q.topicPath}` : ""}
                                {inExam.has(q.id) ? " · already in the exam" : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                  {bank.total > bank.rows.length && <p className="text-xs text-slate-500">Showing {bank.rows.length} of {bank.total}. Search to narrow the list.</p>}
                  <SubmitButton pendingText="Adding…">Add selected</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          {(e.status === "published" || e.status === "cancelled") && (
            <Card>
              <CardHeader title="Attempts" description="Every student currently in the chosen sections. Time up: the worker submits these shortly with the answers saved by the deadline." />
              {e.targets.map((t) => {
                const done = t.students.filter((x) => x.state === "submitted").length;
                const live = t.students.filter((x) => x.state === "in_progress").length;
                return (
                  <section key={t.sectionId} aria-labelledby={`sec-${t.sectionId}`} className="border-t border-slate-100 py-4 first:border-t-0">
                    <h3 id={`sec-${t.sectionId}`} className="px-5 text-sm font-semibold text-slate-900">
                      {t.label} <span className="font-normal text-slate-500">· {done} of {t.students.length} submitted · {live} in progress</span>
                    </h3>
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <caption className="sr-only">Attempts in {t.label}</caption>
                        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                          <tr>
                            <th scope="col" className="px-5 py-2">Student</th>
                            <th scope="col" className="px-5 py-2">State</th>
                            <th scope="col" className="px-5 py-2">Answered</th>
                            <th scope="col" className="px-5 py-2">Submitted</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {t.students.map((x) => (
                            <tr key={x.studentId}>
                              <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                                {x.rollNo !== null ? `${x.rollNo}. ` : ""}
                                {x.name}
                                {x.extraMinutes || x.extraAttempts ? <span className="block text-xs text-slate-500">Accommodation: {[x.extraMinutes ? `+${x.extraMinutes} min` : "", x.extraAttempts ? `+${x.extraAttempts} attempt(s)` : ""].filter(Boolean).join(", ")}</span> : null}
                              </th>
                              <td className="px-5 py-2">
                                <Badge tone={STATE[x.state].tone}>{STATE[x.state].label}</Badge>
                                {x.attempts > 1 && <span className="ml-1 text-xs text-slate-500">attempt {x.attempts}</span>}
                              </td>
                              <td className="px-5 py-2 tabular-nums">{x.state === "not_started" ? "—" : `${x.answered} of ${e.items.length}`}</td>
                              <td className="px-5 py-2">
                                {x.submittedAt ? when(x.submittedAt) : "—"}
                                {x.submitKind && x.submitKind !== "student" && <span className="block text-xs text-slate-500">{x.submitKind === "deadline" ? "at the deadline" : "exam cancelled"}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Status" />
            <div className="flex flex-col items-start gap-3 p-5 text-sm">
              {draft && (
                <>
                  <p className="text-slate-600">Add questions and sections and set the window, then {e.canPublish ? "publish it, or submit it for another administrator's review" : "submit it for approval"}.</p>
                  {!e.canPublish && <RowAction action={examStateAction} fields={{ examId: e.id, op: "submit" }} label="Submit for approval" variant="primary" />}
                  {e.canPublish && <RowAction action={examStateAction} fields={{ examId: e.id, op: "publish" }} label="Publish" variant="primary" />}
                </>
              )}
              {e.status === "pending_approval" && (
                <>
                  <p className="text-slate-600">Waiting for a school administrator. It cannot be changed until it is sent back to draft.</p>
                  {e.canPublish && <RowAction action={examStateAction} fields={{ examId: e.id, op: "publish" }} label="Approve and publish" variant="primary" />}
                  <RowAction action={examStateAction} fields={{ examId: e.id, op: "sendBack" }} label="Back to draft" variant="ghost" />
                </>
              )}
              {e.status === "published" && (
                <>
                  <p className="text-slate-600">Published {e.publishedAt ? when(e.publishedAt) : ""}. Questions, sections and timing are fixed.</p>
                  {e.canPublish && (
                    <ActionForm action={cancelExamAction} className="w-full space-y-3 border-t border-slate-100 pt-3">
                      <input type="hidden" name="examId" value={e.id} />
                      <Field label="Reason for cancelling" htmlFor="cancel-reason" hint="Ends attempts in progress. Cannot be undone.">
                        <Input id="cancel-reason" name="reason" required minLength={5} maxLength={300} />
                      </Field>
                      <SubmitButton variant="danger" pendingText="Cancelling…">
                        Cancel exam
                      </SubmitButton>
                    </ActionForm>
                  )}
                </>
              )}
              {e.status === "cancelled" && <p className="text-slate-600">Cancelled. Attempts are kept.</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Sections" description={draft ? "Students currently in these sections may sit the exam." : undefined} />
            {draft ? (
              sectionOptions.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">No section of the current year that studies {e.subjectName}{s.roles.includes("school_admin") ? "" : " and that you teach"}.</p>
              ) : (
                <ActionForm action={setExamSectionsAction} keepValues className="space-y-3 p-5">
                  <input type="hidden" name="examId" value={e.id} />
                  <fieldset className="space-y-2">
                    <legend className="sr-only">Sections</legend>
                    {sectionOptions.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="sectionId" value={o.id} defaultChecked={chosen.has(o.id)} />
                        {o.label}
                      </label>
                    ))}
                  </fieldset>
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    Save sections
                  </SubmitButton>
                </ActionForm>
              )
            ) : (
              <p className="p-5 text-sm text-slate-700">{e.targets.map((t) => t.label).join(", ") || "None"}</p>
            )}
          </Card>

          {draft && (
            <Card>
              <CardHeader title="Settings" />
              <ActionForm action={updateExamAction} keepValues className="space-y-4 p-5">
                <input type="hidden" name="examId" value={e.id} />
                <ExamFields d={e} />
                <SubmitButton pendingText="Saving…">Save</SubmitButton>
              </ActionForm>
            </Card>
          )}

          {e.canPublish && e.status !== "cancelled" && (
            <Card>
              <CardHeader title="Accommodations" description="Extra time and/or a retake for one student, with the reason. Applies to attempts started afterwards." />
              {e.accommodations.length > 0 && (
                <ul className="divide-y divide-slate-100 border-b border-slate-100 text-sm">
                  {e.accommodations.map((a) => (
                    <li key={a.studentId} className="px-5 py-2">
                      <span className="font-medium text-slate-900">{a.name}</span>: {[a.extraMinutes ? `+${a.extraMinutes} min` : "", a.extraAttempts ? `+${a.extraAttempts} attempt(s)` : ""].filter(Boolean).join(", ")}
                      <span className="block text-xs text-slate-500">{a.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              {students.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">Choose sections first.</p>
              ) : (
                <ActionForm action={accommodationAction} className="space-y-3 p-5">
                  <input type="hidden" name="examId" value={e.id} />
                  <Field label="Student" htmlFor="acc-student">
                    <Select id="acc-student" name="studentId" required defaultValue="">
                      <option value="" disabled>
                        Choose a student
                      </option>
                      {students.map((x) => (
                        <option key={x.studentId} value={x.studentId}>
                          {x.name} ({x.section})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Extra minutes" htmlFor="acc-min">
                      <Input id="acc-min" name="extraMinutes" type="number" min={0} max={240} defaultValue={0} />
                    </Field>
                    <Field label="Extra attempts" htmlFor="acc-att">
                      <Input id="acc-att" name="extraAttempts" type="number" min={0} max={3} defaultValue={0} />
                    </Field>
                  </div>
                  <Field label="Reason" htmlFor="acc-reason">
                    <Input id="acc-reason" name="reason" required minLength={3} maxLength={300} />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    Save accommodation
                  </SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
