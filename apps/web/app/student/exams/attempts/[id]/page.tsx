import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getMyExamAttempt } from "@examio/core";
import { Alert, Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { ExamRunner, type RunnerItem } from "./exam-runner";

export const metadata: Metadata = { title: "Exam" };
export const dynamic = "force-dynamic";

const KIND = { student: "by you", deadline: "automatically when time was up", cancelled: "because the exam was cancelled" } as const;

export default async function ExamAttemptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("student");
  const { id } = await params;
  const sp = await searchParams;
  const v = await getMyExamAttempt(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });

  if (v.status === "submitted" && v.receipt) {
    const r = v.receipt;
    return (
      <>
        <p className="mb-2 text-sm">
          <Link href="/student/exams" className="text-brand-600 hover:text-brand-700">
            ← Exams
          </Link>
        </p>
        <PageHeader title={v.title} description={`${v.subjectName} · attempt ${v.attemptNo}`} />
        {sp.submitted === "1" && (
          <div className="mb-6">
            <Alert tone="green">Your exam has been submitted.</Alert>
          </div>
        )}
        <Card>
          <dl className="grid gap-4 p-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Receipt</dt>
              <dd className="font-mono text-lg font-semibold tracking-wider text-slate-900" data-testid="exam-receipt">
                {r.receipt}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Submitted</dt>
              <dd className="text-slate-900">
                {formatDateTime(r.submittedAt, s.timeZone, { seconds: true })}, {KIND[r.submitKind]}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Answered</dt>
              <dd className="text-slate-900">
                {r.answered} of {r.questionCount} questions
              </dd>
            </div>
          </dl>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Keep the receipt. Results appear once your school releases them.</p>
        </Card>
      </>
    );
  }

  const items: RunnerItem[] = v.items.map((i) => ({
    itemId: i.itemId,
    position: i.position,
    type: i.type,
    stem: i.stem,
    options: i.options,
    marks: formatMarks(i.marksX100),
    negativeMarks: i.negativeMarksX100 ? formatMarks(i.negativeMarksX100) : null,
    imageFileId: i.imageFileId,
    response: i.response,
    revision: i.revision,
    flagged: i.flagged,
  }));

  return (
    <>
      <PageHeader title={v.title} description={`${v.subjectName} · attempt ${v.attemptNo} · ends ${formatDateTime(v.deadlineAt, s.timeZone)}`} />
      {v.instructions && <p className="mb-4 whitespace-pre-wrap rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{v.instructions}</p>}
      <ExamRunner attemptId={v.attemptId} deadlineAt={v.deadlineAt.toISOString()} serverNow={v.serverNow.toISOString()} items={items} />
    </>
  );
}
