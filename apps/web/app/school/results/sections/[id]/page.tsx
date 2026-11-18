import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getSectionResultsOverview } from "@examio/core";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { pct } from "../../shared";

export const metadata: Metadata = { title: "Class results" };

/** A section's released results: percentage per subject and overall for each current student. */
export default async function SectionResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { id } = await params;
  const o = await getSectionResultsOverview(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const isAdmin = s.roles.includes("school_admin");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/results" className="text-brand-600 hover:text-brand-700">
          ← Results
        </Link>
      </p>
      <PageHeader
        title={`${o.sectionLabel}: results`}
        description={isAdmin ? "Released results of the current year. No ranking." : "Released results of the subjects you teach. No ranking."}
      />
      <Card>
        <CardHeader title="By subject" />
        {o.subjects.length === 0 ? (
          <EmptyState title="No released results">Results appear once they are released.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Percentages by subject</caption>
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-2">
                    Student
                  </th>
                  {o.subjects.map((x) => (
                    <th key={x.subjectId} scope="col" className="px-5 py-2">
                      {x.subjectName}
                    </th>
                  ))}
                  <th scope="col" className="px-5 py-2">
                    Overall
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {o.students.map((st) => (
                  <tr key={st.studentId}>
                    <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                      {isAdmin ? (
                        <Link href={`/school/results/students/${st.studentId}`} className="text-brand-700 hover:underline">
                          {st.name}
                        </Link>
                      ) : (
                        st.name
                      )}
                    </th>
                    {o.subjects.map((x) => (
                      <td key={x.subjectId} className="px-5 py-2 tabular-nums">
                        {pct(st.bySubject[x.subjectId] ?? null)}
                      </td>
                    ))}
                    <td className="px-5 py-2 font-semibold tabular-nums">{pct(st.overallBp)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50">
                  <th scope="row" className="px-5 py-2 text-left font-semibold text-slate-900">
                    Class average
                  </th>
                  {o.subjects.map((x) => (
                    <td key={x.subjectId} className="px-5 py-2 font-semibold tabular-nums">
                      {pct(x.averageBp)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
