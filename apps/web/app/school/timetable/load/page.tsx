import type { Metadata } from "next";
import Link from "next/link";
import { getTeacherLoad, listAcademicYears } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { YearPicker, chooseYear } from "../../setup/shared";

export const metadata: Metadata = { title: "Teacher load" };

export default async function TeacherLoadPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const sp = await searchParams;
  const years = await listAcademicYears(db, s.ctx, s.ctx.schoolId);
  const year = chooseYear(years, sp.year);
  const rows = year ? await getTeacherLoad(db, s.ctx, s.ctx.schoolId, year.id) : [];
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/timetable" className="text-brand-600 hover:text-brand-700">
          ← Timetable
        </Link>
      </p>
      <PageHeader
        title="Teacher load"
        description="Periods and teaching hours per week, from the timetable."
        action={
          year ? (
            <ButtonLink href={`/school/timetable/load/export?year=${year.id}`} variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          ) : undefined
        }
      />
      {year && years.length > 1 && (
        <div className="mb-6">
          <YearPicker years={years} selected={year} basePath="/school/timetable/load" />
        </div>
      )}
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No periods with teachers">Add periods with a teacher on the timetable.</EmptyState>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Teacher load table">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Teaching load per teacher</caption>
              <thead>
                <tr className="text-left text-slate-700">
                  <th scope="col" className="px-5 py-2">Teacher</th>
                  <th scope="col" className="px-5 py-2 text-right">Periods / week</th>
                  <th scope="col" className="px-5 py-2 text-right">Hours / week</th>
                  <th scope="col" className="px-5 py-2 text-right">Sections</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.staffId}>
                    <td className="px-5 py-2">
                      <Link href={`/school/staff/${r.staffId}`} className="text-brand-700 hover:underline">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{r.periods}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{(r.minutes / 60).toFixed(1)}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{r.sections}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
