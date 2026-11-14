import type { Metadata } from "next";
import Link from "next/link";
import { getEnrollmentReport, listAcademicYears } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { YearPicker, chooseYear } from "../../setup/shared";

export const metadata: Metadata = { title: "Class strength" };

export default async function EnrollmentReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const years = await listAcademicYears(db, s.ctx, schoolId);
  const year = chooseYear(years, sp.year);
  const report = year ? await getEnrollmentReport(db, s.ctx, schoolId, year.id) : null;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/students" className="text-brand-600 hover:text-brand-700">
          ← Students
        </Link>
      </p>
      <PageHeader
        title="Class strength"
        description="Students currently enrolled in each section."
        action={
          year ? (
            <ButtonLink href={`/school/students/reports/export?year=${year.id}`} variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          ) : undefined
        }
      />
      {year && years.length > 1 && (
        <div className="mb-6">
          <YearPicker years={years} selected={year} basePath="/school/students/reports" />
        </div>
      )}
      <Card>
        {!report || report.sections.length === 0 ? (
          <EmptyState title="No sections">Add sections for this year under School setup → Classes.</EmptyState>
        ) : (
          <>
            <CardHeader title={`${report.totalEnrolled} enrolled`} description={report.activeNotEnrolled > 0 ? `${report.activeNotEnrolled} active student(s) are not in any section this year.` : "Every active student has a section this year."} />
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Class strength table">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Students per section</caption>
                <thead>
                  <tr className="text-left text-slate-700">
                    <th scope="col" className="px-5 py-2">Section</th>
                    <th scope="col" className="px-5 py-2 text-right">Enrolled</th>
                    <th scope="col" className="px-5 py-2 text-right">Capacity</th>
                    <th scope="col" className="px-5 py-2 text-right">No roll number</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.sections.map((r) => (
                    <tr key={r.sectionId}>
                      <td className="px-5 py-2">
                        <Link href={`/school/students/sections/${r.sectionId}`} className="text-brand-700 hover:underline">
                          {r.label}
                        </Link>
                      </td>
                      <td className={`px-5 py-2 text-right tabular-nums ${r.capacity !== null && r.enrolled > r.capacity ? "font-semibold text-red-700" : ""}`}>{r.enrolled}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{r.capacity ?? "—"}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{r.withoutRoll || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
