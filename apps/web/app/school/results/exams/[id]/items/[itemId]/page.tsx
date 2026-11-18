import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, listAnswersToMark } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { markAnswerAction } from "../../../../actions";

export const metadata: Metadata = { title: "Mark answers" };

export default async function MarkAnswersPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { id, itemId } = await params;
  const q = await listAnswersToMark(db, s.ctx, s.ctx.schoolId, id, itemId).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const marked = q.answers.filter((a) => a.marksX100 !== null).length;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/school/results/exams/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Grading
        </Link>
      </p>
      <PageHeader title={`Question ${q.position}`} description={`Out of ${formatMarks(q.maxX100)} · ${marked} of ${q.answers.length} marked`} />
      <p className="mb-6 whitespace-pre-wrap rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-800">{q.stem}</p>
      <div className="space-y-4">
        {q.answers.map((a, n) => (
          <Card key={a.attemptId}>
            <CardHeader title={a.studentName} description={a.marksX100 !== null ? `Marked: ${formatMarks(a.marksX100)}` : "Not marked yet"} />
            <div className="space-y-3 p-5 text-sm">
              <p className="whitespace-pre-wrap text-slate-900">{a.text?.trim() ? a.text : <span className="text-slate-500">No answer written.</span>}</p>
              <ActionForm action={markAnswerAction} keepValues className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="attemptId" value={a.attemptId} />
                <input type="hidden" name="itemId" value={itemId} />
                <Field label={`Marks for answer ${n + 1}`} htmlFor={`m-${a.attemptId}`}>
                  <Input id={`m-${a.attemptId}`} name="marks" inputMode="decimal" required className="w-24" defaultValue={a.marksX100 !== null ? String(a.marksX100 / 100) : ""} />
                </Field>
                <Field label="Comment (optional)" htmlFor={`c-${a.attemptId}`} className="min-w-48 flex-1">
                  <Input id={`c-${a.attemptId}`} name="comment" maxLength={1000} defaultValue={a.comment ?? ""} />
                </Field>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Save
                </SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
