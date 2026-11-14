import type { Metadata } from "next";
import Link from "next/link";
import { getMyTeaching } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "My classes" };

/** A teacher's sections today, each linking to its student list. */
export default async function MyClassesPage() {
  const s = await requireSchoolRole("teacher");
  const t = await getMyTeaching(db, s.ctx, s.ctx.schoolId);
  const sections = new Map<string, { label: string; subjects: string[]; classTeacher: boolean }>();
  for (const c of t.classTeacherOf) sections.set(c.sectionId, { label: c.label, subjects: [], classTeacher: true });
  for (const a of t.subjects) {
    const cur = sections.get(a.sectionId) ?? { label: a.label, subjects: [], classTeacher: false };
    cur.subjects.push(a.subjectName);
    sections.set(a.sectionId, cur);
  }
  return (
    <>
      <PageHeader title="My classes" description={t.yearName ? `${t.yearName} · ${t.today}` : t.today} />
      <Card>
        <CardHeader title="Sections you teach today" />
        {sections.size === 0 ? (
          <EmptyState title="No classes assigned">Your school administrator assigns classes and subjects.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {[...sections.entries()].map(([id, x]) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <Link href={`/school/classes/${id}`} className="font-medium text-brand-700 hover:underline">
                  {x.label}
                </Link>
                <span className="flex flex-wrap items-center gap-2 text-slate-700">
                  {x.classTeacher && <Badge tone="blue">Class teacher</Badge>}
                  {x.subjects.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
