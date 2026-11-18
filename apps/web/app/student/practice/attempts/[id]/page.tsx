import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getMyPracticeAttempt } from "@examio/core";
import { AttemptReview } from "@/components/practice";
import { Alert, Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ClosedSubmit } from "./closed-submit";
import { PracticeRunner, type RunnerItem } from "./practice-runner";

export const metadata: Metadata = { title: "Practice attempt" };

export default async function PracticeAttemptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("student");
  const { id } = await params;
  const sp = await searchParams;
  const v = await getMyPracticeAttempt(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const items: RunnerItem[] = v.items.map((i) => ({
    itemId: i.itemId,
    position: i.position,
    type: i.type,
    stem: i.stem,
    options: i.options,
    marks: formatMarks(i.marksX100),
    negativeMarks: i.negativeMarksX100 ? formatMarks(i.negativeMarksX100) : null,
    imageFileId: i.imageFileId,
    response: i.answer?.response ?? null,
    revision: i.answer?.revision ?? 0,
  }));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/student/practice" className="text-brand-600 hover:text-brand-700">
          ← Practice
        </Link>
      </p>
      <PageHeader title={v.title} description={`${v.subjectName} · attempt ${v.attemptNo}${v.status === "submitted" ? " · submitted" : ""}`} />
      {sp.submitted === "1" && v.status === "submitted" && (
        <div className="mb-6">
          <Alert tone="green">Your answers have been submitted.</Alert>
        </div>
      )}
      {v.instructions && <p className="mb-4 whitespace-pre-wrap rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{v.instructions}</p>}
      {v.status === "in_progress" && v.canAnswer ? (
        <PracticeRunner attemptId={v.id} items={items} />
      ) : (
        <Card>
          <CardHeader title={v.status === "in_progress" ? "This practice has closed" : "Your answers"} description={v.status === "in_progress" ? "Answers can no longer be changed. Submit to finish this attempt." : undefined} />
          <div className="p-5">
            {v.status === "in_progress" && <ClosedSubmit attemptId={v.id} />}
            <AttemptReview timeZone={s.timeZone} v={v} />
          </div>
        </Card>
      )}
    </>
  );
}
