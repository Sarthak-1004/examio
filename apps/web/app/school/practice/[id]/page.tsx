import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatBp, formatMarks, getCurriculum, getPracticeSet, listAssignableSections, searchQuestions } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { RowAction } from "../../setup/shared";
import { addPracticeQuestionsAction, addPracticeTopicAction, assignPracticeAction, practiceSetStateAction, removePracticeItemAction, unassignPracticeAction, updatePracticeSetAction } from "../actions";
import { SET_STATUS, SettingsFields } from "../settings-fields";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Practice set" };

const TYPE: Record<string, string> = { single_choice: "Single choice", true_false: "True / false", descriptive: "Descriptive" };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PracticeSetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const when = (d: Date | string) => formatDateTime(d, s.timeZone);
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const sp = await searchParams;
  const set = await getPracticeSet(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const draft = set.status === "draft";
  const chapters = (await getCurriculum(db, s.ctx, schoolId, set.subjectId)).filter((c) => !c.archived).map((c) => ({ ...c, topics: c.topics.filter((t) => !t.archived) }));
  const search = one(sp.q).slice(0, 100);
  const bank = draft ? await searchQuestions(db, s.ctx, schoolId, { page: 1, pageSize: 25, search, subjectId: set.subjectId, status: "published" }) : null;
  const inSet = new Set(set.items.map((i) => i.questionId));
  const sections = set.status === "published" ? await listAssignableSections(db, s.ctx, schoolId, set.id) : [];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/practice" className="text-brand-600 hover:text-brand-700">
          ← Practice
        </Link>
      </p>
      <PageHeader
        title={set.title}
        description={`${set.subjectName}${set.topicPath ? ` · ${set.topicPath}` : ""} · ${set.items.length} question(s) · ${set.attemptLimit ? `${set.attemptLimit} attempt(s)` : "unlimited attempts"} · answers ${set.feedback === "immediate" ? "right after submitting" : "after it closes"}`}
        action={<Badge tone={SET_STATUS[set.status]!.tone}>{SET_STATUS[set.status]!.label}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Questions" description={draft ? "Questions are fixed when the set is published. Each uses the question's published version." : "Fixed. Accuracy is over submitted attempts."} />
            {set.items.length === 0 ? (
              <EmptyState title="No questions yet">Add published questions below.</EmptyState>
            ) : (
              <ol className="divide-y divide-slate-100">
                {set.items.map((i, n) => (
                  <li key={i.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-slate-900">
                        <span className="font-semibold text-slate-500">{n + 1}.</span>{" "}
                        <Link href={`/school/questions/${i.questionId}`} className="hover:underline">
                          {i.stem.length > 140 ? `${i.stem.slice(0, 137)}…` : i.stem}
                        </Link>
                      </p>
                      <p className="text-xs text-slate-500">
                        {TYPE[i.type]} · {formatMarks(i.marksX100)} mark(s) · version {i.revision}
                        {i.topicPath ? ` · ${i.topicPath}` : ""}
                        {!draft && (i.type === "descriptive" ? " · not scored" : i.answered ? ` · ${formatBp(i.correctBp)} correct of ${i.answered}` : " · no answers yet")}
                      </p>
                    </div>
                    {draft && <RowAction action={removePracticeItemAction} fields={{ setId: set.id, itemId: i.id }} label="Remove" variant="ghost" ariaLabel={`Remove question ${n + 1}`} />}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {draft && bank && (
            <Card>
              <CardHeader title="Add questions" description={`Published ${set.subjectName} questions.`} />
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
                <ActionForm action={addPracticeQuestionsAction} className="space-y-3 p-5">
                  <input type="hidden" name="setId" value={set.id} />
                  <fieldset>
                    <legend className="sr-only">Questions to add</legend>
                    <ul className="space-y-2">
                      {bank.rows.map((q) => (
                        <li key={q.id}>
                          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                            <input type="checkbox" name="questionId" value={q.id} disabled={inSet.has(q.id)} className="mt-1" />
                            <span>
                              <span className="text-slate-900">{q.stem.length > 160 ? `${q.stem.slice(0, 157)}…` : q.stem}</span>
                              <span className="block text-xs text-slate-500">
                                {TYPE[q.type]} · {q.difficulty} · {formatMarks(q.marksX100)} mark(s){q.topicPath ? ` · ${q.topicPath}` : ""}
                                {inSet.has(q.id) ? " · already in the set" : ""}
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
              {chapters.length > 0 && (
                <ActionForm action={addPracticeTopicAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 p-5">
                  <input type="hidden" name="setId" value={set.id} />
                  <Field label="Add from chapter / topic" htmlFor="add-topic">
                    <Select id="add-topic" name="topicId" required defaultValue="">
                      <option value="" disabled>
                        Choose
                      </option>
                      {chapters.map((c) => (
                        <optgroup key={c.id} label={c.name}>
                          <option value={c.id}>{c.name} (all topics)</option>
                          {c.topics.map((t) => (
                            <option key={t.id} value={t.id}>
                              {c.name} › {t.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  <Field label="How many" htmlFor="add-count">
                    <Input id="add-count" name="count" type="number" min={1} max={100} defaultValue={10} className="w-24" />
                  </Field>
                  <SubmitButton variant="secondary" pendingText="Adding…">
                    Add
                  </SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          {set.status !== "draft" && (
            <Card>
              <CardHeader title="Sections and participation" description="Students currently in each section, with their attempts at this set." />
              {set.assignments.length === 0 ? (
                <EmptyState title="Not assigned">{set.status === "published" ? "Assign the set to a section so its students can practise." : "This set is archived."}</EmptyState>
              ) : (
                <div className="divide-y divide-slate-100">
                  {set.assignments.map((a) => {
                    const done = a.students.filter((x) => x.submitted > 0).length;
                    return (
                      <section key={a.id} aria-labelledby={`asg-${a.id}`} className="py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-5">
                          <div className="text-sm">
                            <h3 id={`asg-${a.id}`} className="font-semibold text-slate-900">
                              {a.sectionLabel}
                            </h3>
                            <p className="text-xs text-slate-500">
                              {a.opensAt ? `Opens ${when(a.opensAt)}` : "Open now"}
                              {a.closesAt ? ` · closes ${when(a.closesAt)}` : " · no closing time"} · {done} of {a.students.length} submitted
                            </p>
                          </div>
                          <RowAction action={unassignPracticeAction} fields={{ assignmentId: a.id }} label="Remove" variant="ghost" ariaLabel={`Remove assignment to ${a.sectionLabel}`} />
                        </div>
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-full text-sm">
                            <caption className="sr-only">Participation in {a.sectionLabel}</caption>
                            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                              <tr>
                                <th scope="col" className="px-5 py-2">Student</th>
                                <th scope="col" className="px-5 py-2">Attempts</th>
                                <th scope="col" className="px-5 py-2">Best</th>
                                <th scope="col" className="px-5 py-2">Last submitted</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {a.students.map((x) => (
                                <tr key={x.studentId}>
                                  <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                                    {x.rollNo !== null ? `${x.rollNo}. ` : ""}
                                    {x.name}
                                  </th>
                                  <td className="px-5 py-2 tabular-nums">{x.attempts === 0 ? "Not started" : `${x.submitted} submitted${x.attempts > x.submitted ? ", 1 in progress" : ""}`}</td>
                                  <td className="px-5 py-2 tabular-nums">{x.bestBp !== null ? formatBp(x.bestBp) : "—"}</td>
                                  <td className="px-5 py-2">{x.lastSubmittedAt ? when(x.lastSubmittedAt) : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title={draft ? "Publish" : "Status"} />
            <div className="flex flex-col items-start gap-3 p-5 text-sm">
              {draft && (
                <>
                  <p className="text-slate-600">Publishing fixes the questions. Then assign the set to sections.</p>
                  <RowAction action={practiceSetStateAction} fields={{ setId: set.id, op: "publish" }} label="Publish set" variant="primary" />
                </>
              )}
              {set.status === "published" && (
                <>
                  <p className="text-slate-600">Published {set.publishedAt ? when(set.publishedAt) : ""}. Archiving hides it from students; attempts are kept.</p>
                  <RowAction action={practiceSetStateAction} fields={{ setId: set.id, op: "archive" }} label="Archive" variant="ghost" />
                </>
              )}
              {set.status === "archived" && <p className="text-slate-600">Archived. Students no longer see it.</p>}
            </div>
          </Card>

          {set.status === "published" && (
            <Card>
              <CardHeader title="Assign to a section" description="Times are in the school's time zone. Leave them empty to open now with no closing time." />
              {sections.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">No more sections to assign: it is assigned to every section of the current year that studies {set.subjectName} {s.roles.includes("school_admin") ? "" : "and that you teach"}.</p>
              ) : (
                <ActionForm action={assignPracticeAction} className="space-y-4 p-5">
                  <input type="hidden" name="setId" value={set.id} />
                  <Field label="Section" htmlFor="sectionId">
                    <Select id="sectionId" name="sectionId" required defaultValue="">
                      <option value="" disabled>
                        Choose a section
                      </option>
                      {sections.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Opens (optional)" htmlFor="opensAt">
                    <Input id="opensAt" name="opensAt" type="datetime-local" />
                  </Field>
                  <Field label="Closes (optional)" htmlFor="closesAt">
                    <Input id="closesAt" name="closesAt" type="datetime-local" />
                  </Field>
                  <SubmitButton pendingText="Assigning…">Assign</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          {set.status !== "archived" && (
            <Card>
              <CardHeader title="Settings" />
              <ActionForm action={updatePracticeSetAction} keepValues className="space-y-4 p-5">
                <input type="hidden" name="setId" value={set.id} />
                <SettingsFields chapters={chapters} d={set} />
                <SubmitButton pendingText="Saving…">Save</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
