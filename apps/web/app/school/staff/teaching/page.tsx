import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listYearTeaching } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { YearPicker, chooseYear } from "../../setup/shared";

export const metadata: Metadata = { title: "Who teaches what" };

/** Every section of a year, its subjects and today's teachers; gaps are highlighted. */
export default async function TeachingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const params = await searchParams;
  const years = await listAcademicYears(db, s.ctx, s.ctx.schoolId);
  const year = chooseYear(years, params.year);
  const sections = year ? await listYearTeaching(db, s.ctx, s.ctx.schoolId, year.id) : [];
  const gaps = sections.reduce((n, sec) => n + sec.subjects.filter((x) => x.teachers.length === 0).length + (sec.classTeacher ? 0 : 1), 0);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/staff" className="text-brand-600 hover:text-brand-700">
          ← Staff
        </Link>
      </p>
      <PageHeader title="Who teaches what" description={year ? `As of today, ${year.name}. ${gaps} gap(s) need a teacher.` : "Create an academic year first."} />
      {year && (
        <div className="mb-4">
          <YearPicker years={years} selected={year} basePath="/school/staff/teaching" />
        </div>
      )}
      {sections.length === 0 ? (
        <Card>
          <EmptyState title="No sections in this year">Add sections under School setup → Classes and sections.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sections.map((sec) => (
            <Card key={sec.sectionId}>
              <CardHeader
                title={`${sec.className} ${sec.sectionName}`}
                description={sec.classTeacher ? `Class teacher: ${sec.classTeacher.name}` : undefined}
                action={sec.classTeacher ? undefined : <Badge tone="amber">No class teacher</Badge>}
              />
              {sec.subjects.length === 0 ? (
                <p className="px-5 py-3 text-sm text-slate-600">No subjects assigned to this class yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {sec.subjects.map((sub) => (
                    <li key={sub.subjectId} className="flex flex-wrap justify-between gap-2 px-5 py-2">
                      <span className="text-slate-900">{sub.subjectName}</span>
                      {sub.teachers.length ? (
                        <span className="text-slate-700">
                          {sub.teachers.map((t, i) => (
                            <span key={t.assignmentId}>
                              {i > 0 && ", "}
                              <Link href={`/school/staff/${t.staffId}`} className="hover:underline">
                                {t.name}
                              </Link>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <Badge tone="amber">No teacher</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
