import type { Metadata } from "next";
import Link from "next/link";
import { getCurriculum, listAuthorableSubjects, type QuestionType } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Button, Card, CardHeader, EmptyState, Field, PageHeader, Select } from "@/components/ui";
import { createQuestionAction } from "../actions";
import { QuestionFields, TypeTabs } from "../question-fields";

export const metadata: Metadata = { title: "New question" };

const TYPES: QuestionType[] = ["single_choice", "true_false", "descriptive"];
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function NewQuestionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const sp = await searchParams;
  const subjects = await listAuthorableSubjects(db, s.ctx, s.ctx.schoolId);
  const subject = subjects.find((x) => x.id === one(sp.subject)) ?? subjects[0];
  const type = (TYPES as string[]).includes(one(sp.type)) ? (one(sp.type) as QuestionType) : "single_choice";
  const chapters = subject ? await getCurriculum(db, s.ctx, s.ctx.schoolId, subject.id) : [];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/questions" className="text-brand-600 hover:text-brand-700">
          ← Question bank
        </Link>
      </p>
      <PageHeader title="New question" />
      {!subject ? (
        <Card>
          <EmptyState title="No subjects">You can write questions for subjects you teach.</EmptyState>
        </Card>
      ) : (
        <Card>
          <CardHeader title={subject.name} />
          <div className="space-y-4 p-5">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="type" value={type} />
              <Field label="Subject" htmlFor="nq-subject">
                <Select id="nq-subject" name="subject" defaultValue={subject.id}>
                  {subjects.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary">
                Change subject
              </Button>
            </form>
            <TypeTabs current={type} href={(t) => `/school/questions/new?subject=${subject.id}&type=${t}`} />
            <ActionForm action={createQuestionAction} keepValues className="space-y-4">
              <input type="hidden" name="subjectId" value={subject.id} />
              <QuestionFields type={type} chapters={chapters} />
              <div className="flex flex-wrap gap-3">
                <SubmitButton pendingText="Saving…">Save draft</SubmitButton>
                <SubmitButton variant="secondary" name="submit" value="1" pendingText="Saving…">
                  Save and submit for review
                </SubmitButton>
              </div>
            </ActionForm>
          </div>
        </Card>
      )}
    </>
  );
}
