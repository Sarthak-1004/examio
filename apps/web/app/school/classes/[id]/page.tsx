import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getTeacherRoster } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Class list" };

/** Today's students of a section the teacher teaches. Any other section is not found. */
export default async function TeacherRosterPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("teacher");
  const { id } = await params;
  const roster = await getTeacherRoster(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/classes" className="text-brand-600 hover:text-brand-700">
          ← My classes
        </Link>
      </p>
      <PageHeader title={roster.label} description={`${roster.rows.length} student(s) · ${roster.today}`} />
      <Card>
        <CardHeader title="Students" />
        {roster.rows.length === 0 ? (
          <EmptyState title="No students yet">The school has not enrolled students in this section.</EmptyState>
        ) : (
          <ol className="divide-y divide-slate-100">
            {roster.rows.map((r) => (
              <li key={r.enrollmentId} className="flex items-center gap-3 px-5 py-2 text-sm">
                <span className="w-10 text-right tabular-nums text-slate-500">{r.rollNo ?? "—"}</span>
                <span className="text-slate-900">{r.displayName}</span>
                <span className="font-mono text-xs text-slate-500">{r.admissionNo}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
