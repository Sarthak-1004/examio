import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getMyExamResult } from "@examio/core";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Exam result" };

/** A released exam result: each question with the student's answer, marks, comment and the correct answer. */
export default async function ExamResultPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("student");
  const { id } = await params;
  const r = await getMyExamResult(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const summary =
    r.status === "absent"
      ? `${r.subjectName} · absent`
      : `${r.subjectName} · ${formatMarks(r.scoreX100 ?? 0)} of ${formatMarks(r.maxX100)} · ${((r.percentBp ?? 0) / 100).toFixed(2)}%`;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/student/results" className="text-brand-600 hover:text-brand-700">
          ← Results
        </Link>
      </p>
      <PageHeader title={r.title} description={summary} action={r.grade ? <Badge tone={r.passed ? "green" : "red"}>Grade {r.grade}</Badge> : undefined} />
      {r.revision > 1 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">This result was corrected by the school after it was released.</p>
      )}
      <div className="space-y-4">
        {r.items.map((i) => (
          <Card key={i.itemId}>
            <CardHeader title={`Question ${i.position}`} description={`${i.marksX100 === null ? "—" : formatMarks(i.marksX100)} of ${formatMarks(i.maxX100)} mark(s)`} />
            <div className="space-y-2 p-5 text-sm">
              <p className="whitespace-pre-wrap text-slate-900">{i.stem}</p>
              <p>
                <span className="font-semibold">Your answer: </span>
                <span className="whitespace-pre-wrap">{i.answer}</span>
              </p>
              {i.key && (
                <p>
                  <span className="font-semibold">{i.type === "descriptive" ? "Model answer: " : "Correct answer: "}</span>
                  <span className="whitespace-pre-wrap">{i.key}</span>
                </p>
              )}
              {i.explanation && <p className="whitespace-pre-wrap text-slate-600">{i.explanation}</p>}
              {i.comment && <p className="rounded-md bg-brand-50 px-3 py-2 text-brand-900">Teacher&apos;s comment: {i.comment}</p>}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
