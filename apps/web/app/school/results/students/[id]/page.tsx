import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStudentReportCard } from "@examio/core";
import { ReportCardView } from "@/components/report-card";
import { PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Report card" };

/** Administrators: a student's report card for each year they were enrolled. */
export default async function StaffReportCardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ year?: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const { id } = await params;
  const { year } = await searchParams;
  const card = await getStudentReportCard(db, s.ctx, s.ctx.schoolId, id, year).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/school/students/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Student record
        </Link>
      </p>
      <PageHeader title="Report card" description="Released results only." />
      <ReportCardView card={card} basePath={`/school/results/students/${id}`} />
    </>
  );
}
