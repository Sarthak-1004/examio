import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getChildReportCard } from "@examio/core";
import { ReportCardView } from "@/components/report-card";
import { PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Report card" };

/** A linked child's released results (totals and grades; question-level answers stay with the student). */
export default async function ChildResultsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ year?: string }> }) {
  const s = await requireSchoolRole("parent");
  const { id } = await params;
  const { year } = await searchParams;
  const card = await getChildReportCard(db, s.ctx, s.ctx.schoolId, id, year).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/parent/children/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Back to child
        </Link>
      </p>
      <PageHeader title="Report card" description="Released results only." />
      <ReportCardView card={card} basePath={`/parent/children/${id}/results`} />
    </>
  );
}
