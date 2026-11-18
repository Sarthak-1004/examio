import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getExamGrading, getStudentExamMarks } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { correctExamMarkAction, designateAttemptAction } from "../../../../actions";

export const metadata: Metadata = { title: "Student marks" };

export default async function StudentMarksPage({ params }: { params: Promise<{ id: string; studentId: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { id, studentId } = await params;
  const load = async () => Promise.all([getStudentExamMarks(db, s.ctx, s.ctx.schoolId, id, studentId), getExamGrading(db, s.ctx, s.ctx.schoolId, id)]);
  const [m, g] = await load().catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const released = g.status === "released";
  const row = g.students.find((x) => x.studentId === studentId);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/school/results/exams/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Grading
        </Link>
      </p>
      <PageHeader
        title={m.name}
        description={`${g.title} · ${row?.scoreX100 !== null && row?.scoreX100 !== undefined ? `${formatMarks(row.scoreX100)} of ${formatMarks(g.maxX100)}` : "not released"}${row && row.revision > 1 ? ` · corrected (revision ${row.revision})` : ""}`}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {m.items.map((i) => (
            <Card key={i.itemId}>
              <CardHeader title={`Question ${i.position}`} description={`${i.marksX100 === null ? "Not marked" : formatMarks(i.marksX100)} of ${formatMarks(i.maxX100)}`} />
              <div className="space-y-2 p-5 text-sm">
                <p className="whitespace-pre-wrap text-slate-900">{i.stem}</p>
                <p>
                  <span className="font-semibold">Answer: </span>
                  <span className="whitespace-pre-wrap">{i.answer}</span>
                </p>
                {i.key && (
                  <p>
                    <span className="font-semibold">{i.type === "descriptive" ? "Model answer: " : "Correct answer: "}</span>
                    {i.key}
                  </p>
                )}
                {i.comment && <p className="text-slate-600">Comment: {i.comment}</p>}
                {released && g.canPublish && (
                  <ActionForm action={correctExamMarkAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
                    <input type="hidden" name="attemptId" value={m.attemptId ?? ""} />
                    <input type="hidden" name="itemId" value={i.itemId} />
                    <Field label="Corrected marks" htmlFor={`cm-${i.itemId}`}>
                      <Input id={`cm-${i.itemId}`} name="marks" inputMode="decimal" required className="w-24" />
                    </Field>
                    <Field label="Reason" htmlFor={`cr-${i.itemId}`} className="min-w-48 flex-1">
                      <Input id={`cr-${i.itemId}`} name="reason" required minLength={3} maxLength={300} />
                    </Field>
                    <SubmitButton variant="secondary" pendingText="Saving…">
                      Correct
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
            </Card>
          ))}
        </div>
        {g.canPublish && m.attempts.length > 1 && (
          <Card>
            <CardHeader title="Which attempt counts" description="Choose a retake to count instead, with the reason. Its written answers must be marked." />
            <ActionForm action={designateAttemptAction} className="space-y-3 p-5">
              <input type="hidden" name="examId" value={id} />
              <input type="hidden" name="studentId" value={studentId} />
              <Field label="Attempt" htmlFor="att">
                <Select id="att" name="attemptId" defaultValue={m.attemptId ?? ""}>
                  {m.attempts.map((a) => (
                    <option key={a.id} value={a.id}>
                      Attempt {a.no}
                      {a.id === m.attemptId ? " (counts now)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason" htmlFor="att-reason">
                <Input id="att-reason" name="reason" required minLength={3} maxLength={300} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Count this attempt
              </SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
