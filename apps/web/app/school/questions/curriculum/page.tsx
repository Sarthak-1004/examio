import type { Metadata } from "next";
import Link from "next/link";
import { getCurriculum, listAuthorableSubjects } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../../setup/shared";
import { archiveTopicAction, createChapterAction, createTopicAction } from "../actions";

export const metadata: Metadata = { title: "Chapters and topics" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function CurriculumPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const sp = await searchParams;
  const subjects = await listAuthorableSubjects(db, s.ctx, s.ctx.schoolId);
  const subject = subjects.find((x) => x.id === one(sp.subject)) ?? subjects[0];
  const chapters = subject ? await getCurriculum(db, s.ctx, s.ctx.schoolId, subject.id) : [];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/questions" className="text-brand-600 hover:text-brand-700">
          ← Question bank
        </Link>
      </p>
      <PageHeader title="Chapters and topics" description="Each subject has chapters, and chapters have topics. Archived ones stay for the questions that use them." />
      {!subject ? (
        <Card>
          <EmptyState title="No subjects">You can manage chapters for subjects you teach.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <form method="get" className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-5">
              <Field label="Subject" htmlFor="cu-subject">
                <Select id="cu-subject" name="subject" defaultValue={subject.id}>
                  {subjects.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary">
                Show
              </Button>
            </form>
            {chapters.length === 0 ? (
              <EmptyState title="No chapters">Add the first chapter with the form.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {chapters.map((c) => (
                  <li key={c.id} className="space-y-2 px-5 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        {c.name} <span className="text-xs font-normal text-slate-500">{c.questions} question(s)</span> {c.archived && <Badge>Archived</Badge>}
                      </span>
                      <RowAction action={archiveTopicAction} fields={{ topicId: c.id, archive: c.archived ? "0" : "1" }} label={c.archived ? "Restore" : "Archive"} variant="ghost" ariaLabel={`${c.archived ? "Restore" : "Archive"} chapter ${c.name}`} />
                    </div>
                    <ul className="ml-4 space-y-1">
                      {c.topics.map((t) => (
                        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {t.name} <span className="text-xs text-slate-500">{t.questions} question(s)</span> {t.archived && <Badge>Archived</Badge>}
                          </span>
                          <RowAction action={archiveTopicAction} fields={{ topicId: t.id, archive: t.archived ? "0" : "1" }} label={t.archived ? "Restore" : "Archive"} variant="ghost" ariaLabel={`${t.archived ? "Restore" : "Archive"} topic ${t.name}`} />
                        </li>
                      ))}
                    </ul>
                    {!c.archived && (
                      <ActionForm action={createTopicAction} inline>
                        <input type="hidden" name="chapterId" value={c.id} />
                        <label className="sr-only" htmlFor={`nt-${c.id}`}>
                          New topic in {c.name}
                        </label>
                        <Input id={`nt-${c.id}`} name="name" required maxLength={120} placeholder="New topic" className="w-56" />
                        <SubmitButton variant="secondary" pendingText="Adding…" className="min-h-9 px-3 py-1.5 text-xs">
                          Add topic
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title={`New chapter in ${subject.name}`} />
            <ActionForm action={createChapterAction} className="space-y-3 p-5">
              <input type="hidden" name="subjectId" value={subject.id} />
              <Field label="Chapter name" htmlFor="nc-name">
                <Input id="nc-name" name="name" required maxLength={120} />
              </Field>
              <SubmitButton pendingText="Adding…">Add chapter</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
