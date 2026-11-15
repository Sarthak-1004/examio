import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getChildPracticeAttempt } from "@examio/core";
import { AttemptReview } from "@/components/practice";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Practice attempt" };

/** A child's practice attempt, read-only; answers and results follow the set's feedback rule. */
export default async function ChildPracticeAttemptPage({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const s = await requireSchoolRole("parent");
  const { id, attemptId } = await params;
  const v = await getChildPracticeAttempt(db, s.ctx, s.ctx.schoolId, id, attemptId).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/parent/children/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Back to child
        </Link>
      </p>
      <PageHeader title={v.title} description={`${v.subjectName} · attempt ${v.attemptNo} · ${v.status === "submitted" ? "submitted" : "in progress"}`} />
      <Card>
        <div className="p-5">
          {v.status === "in_progress" ? <p className="text-sm text-slate-600">This attempt is still in progress.</p> : <AttemptReview v={v} />}
        </div>
      </Card>
    </>
  );
}
