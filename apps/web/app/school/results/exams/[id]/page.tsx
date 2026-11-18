import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getExamGrading, listGraderOptions } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, ButtonLink, Card, CardHeader, Field, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { RowAction } from "../../../setup/shared";
import { graderAction, releaseExamAction } from "../../actions";
import { pct } from "../../shared";

export const metadata: Metadata = { title: "Grading" };

const TYPE: Record<string, string> = { single_choice: "Single choice (automatic)", true_false: "True / false (automatic)", descriptive: "Written" };

export default async function ExamGradingPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { id } = await params;
  const g = await getExamGrading(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const graderOptions = await listGraderOptions(db, s.ctx, s.ctx.schoolId, id);
  const toMark = g.students.reduce((a, x) => a + x.unmarked, 0);
  const released = g.status === "released";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/results" className="text-brand-600 hover:text-brand-700">
          ← Results
        </Link>
      </p>
      <PageHeader
        title={g.title}
        description={`${g.subjectName} · out of ${formatMarks(g.maxX100)}${g.scheme ? ` · grading scheme ${g.scheme.name}` : ""}`}
        action={<Badge tone={released ? "green" : "blue"}>{released ? `Released ${g.releasedAt ? formatDateTime(g.releasedAt, s.timeZone) : ""}` : "Grading"}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {g.summary && (
            <Card>
              <CardHeader title="Summary" />
              <dl className="grid grid-cols-2 gap-4 p-5 text-sm sm:grid-cols-4">
                {[
                  ["Sat the exam", `${g.summary.counted} (${g.summary.absent} absent)`],
                  ["Average", pct(g.summary.averageBp)],
                  ["Highest · lowest", `${pct(g.summary.highestBp)} · ${pct(g.summary.lowestBp)}`],
                  ["Passed", `${g.summary.passed} of ${g.summary.counted}`],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="font-semibold text-slate-900">{v}</dd>
                  </div>
                ))}
              </dl>
              {g.summary.grades.length > 0 && (
                <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-700">
                  Grades: {g.summary.grades.filter((x) => x.count > 0).map((x) => `${x.grade} ${x.count}`).join(" · ") || "none"}
                </p>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="Questions" description={released ? undefined : "Mark each written question; the others are already scored."} />
            <ul className="divide-y divide-slate-100">
              {g.items.map((i) => (
                <li key={i.itemId} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="font-semibold text-slate-500">{i.position}.</span> {i.stem}
                    <span className="block text-xs text-slate-500">
                      {TYPE[i.type]} · {formatMarks(i.maxX100)} mark(s){i.type === "descriptive" ? ` · ${i.marked} marked` : ""}
                    </span>
                  </span>
                  {i.type === "descriptive" && !released && (
                    <ButtonLink href={`/school/results/exams/${g.examId}/items/${i.itemId}`} variant="secondary" className="min-h-9 px-3 py-1.5 text-xs">
                      Mark answers
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Students" description="The first submitted attempt counts unless an administrator chose another." />
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Students and their results</caption>
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-2">Student</th>
                    <th scope="col" className="px-5 py-2">{released ? "Score" : "So far"}</th>
                    <th scope="col" className="px-5 py-2">{released ? "Grade" : "Left to mark"}</th>
                    <th scope="col" className="px-5 py-2"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {g.students.map((x) => (
                    <tr key={x.studentId}>
                      <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                        {x.name}
                        {x.attempts > 1 && <span className="block text-xs text-slate-500">attempt {x.attemptNo} of {x.attempts} counts</span>}
                      </th>
                      <td className="px-5 py-2 tabular-nums">
                        {!x.attemptId ? "Absent" : released ? `${formatMarks(x.scoreX100 ?? 0)} (${pct(x.percentBp)})` : formatMarks(x.marksSoFarX100)}
                        {x.revision > 1 && <span className="block text-xs text-amber-700">corrected</span>}
                      </td>
                      <td className="px-5 py-2">{released ? (x.grade ? <Badge tone={x.passed ? "green" : "red"}>{x.grade}</Badge> : "—") : x.attemptId ? String(x.unmarked) : "—"}</td>
                      <td className="px-5 py-2">
                        {x.attemptId && !x.name.startsWith("Student (") && (
                          <Link href={`/school/results/exams/${g.examId}/students/${x.studentId}`} className="text-brand-700 hover:underline">
                            Marks
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {g.changes.length > 0 && (
            <Card>
              <CardHeader title="Changes after release" description="Earlier marks are kept." />
              <ul className="divide-y divide-slate-100 text-sm">
                {g.changes.map((c, n) => (
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
            <CardHeader title={released ? "Released" : "Release"} />
            <div className="space-y-3 p-5 text-sm">
              {released ? (
                <>
                  <p className="text-slate-600">Students and parents can see these results. Corrections need an administrator and a reason.</p>
                  <a href={`/school/results/exams/${g.examId}/export`} className="font-medium text-brand-700 hover:underline">
                    Download results (CSV)
                  </a>
                </>
              ) : toMark > 0 ? (
                <p className="text-slate-600">{toMark} written answer(s) still need marks before the results can be released.</p>
              ) : g.canPublish ? (
                <>
                  <p className="text-slate-600">Everything is marked. Releasing shows the results to students and parents and notifies them.</p>
                  <RowAction action={releaseExamAction} fields={{ examId: g.examId }} label="Release results" variant="primary" />
                </>
              ) : (
                <p className="text-slate-600">Everything is marked. A school administrator releases the results.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Graders" description="Teachers who may mark the written answers, besides administrators and the subject's teachers." />
            {g.graders.length > 0 && (
              <ul className="divide-y divide-slate-100 border-b border-slate-100 text-sm">
                {g.graders.map((x) => (
                  <li key={x.userId} className="flex items-center justify-between px-5 py-2">
                    {x.name}
                    <RowAction action={graderAction} fields={{ examId: g.examId, userId: x.userId, op: "remove" }} label="Remove" variant="ghost" ariaLabel={`Remove ${x.name}`} />
                  </li>
                ))}
              </ul>
            )}
            {graderOptions.length > 0 ? (
              <ActionForm action={graderAction} className="flex flex-wrap items-end gap-3 p-5">
                <input type="hidden" name="examId" value={g.examId} />
                <Field label="Teacher" htmlFor="grader">
                  <Select id="grader" name="userId" required defaultValue="">
                    <option value="" disabled>
                      Choose
                    </option>
                    {graderOptions.map((o) => (
                      <option key={o.userId} value={o.userId}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="secondary" pendingText="Adding…">
                  Add
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="p-5 text-sm text-slate-600">No other teachers to add.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
