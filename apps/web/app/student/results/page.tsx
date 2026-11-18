import type { Metadata } from "next";
import { AppError, getMyReportCard } from "@examio/core";
import { ReportCardView } from "@/components/report-card";
import { PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Results" };

export default async function MyResultsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const s = await requireSchoolRole("student");
  const { year } = await searchParams;
  const card = await getMyReportCard(db, s.ctx, s.ctx.schoolId, year).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return null;
    throw e;
  });
  return (
    <>
      <PageHeader title="Results" description="Your released results and report card." />
      {card ? (
        <ReportCardView card={card} basePath="/student/results" examHref={(id) => `/student/results/exams/${id}`} />
      ) : (
        <p className="text-sm text-slate-600">Your school has not added your student details yet.</p>
      )}
    </>
  );
}
