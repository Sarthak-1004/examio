import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getSectionRoster, listAcademicYears, listClasses, listSections } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { numberRollsAction } from "../../actions";
import { sectionOptions } from "../../shared";

export const metadata: Metadata = { title: "Section" };

export default async function SectionRosterPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { id } = await params;
  const rows = await getSectionRoster(db, s.ctx, schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
  let label: string | null = null;
  let yearName = "";
  let open = false;
  for (const y of years) {
    const found = sectionOptions(await listSections(db, s.ctx, schoolId, y.id), classes).find((o) => o.id === id);
    if (found) {
      label = found.label;
      yearName = y.name;
      open = y.status !== "closed";
      break;
    }
  }
  if (!label) notFound();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/students/reports" className="text-brand-600 hover:text-brand-700">
          ← Class strength
        </Link>
      </p>
      <PageHeader title={label} description={`${yearName} · ${rows.length} student(s)`} />
      <Card>
        <CardHeader title="Students" description="Open a student to change their roll number or section." />
        {rows.length === 0 ? (
          <EmptyState title="No students">Enroll students from their page, or import a class list.</EmptyState>
        ) : (
          <ol className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.enrollmentId} className="flex items-center gap-3 px-5 py-2 text-sm">
                <span className="w-10 text-right tabular-nums text-slate-500">{r.rollNo ?? "—"}</span>
                <Link href={`/school/students/${r.studentId}`} className="text-brand-700 hover:underline">
                  {r.displayName}
                </Link>
                <span className="font-mono text-xs text-slate-500">{r.admissionNo}</span>
              </li>
            ))}
          </ol>
        )}
        {open && rows.length > 0 && (
          <ActionForm action={numberRollsAction} className="border-t border-slate-100 p-5">
            <input type="hidden" name="sectionId" value={id} />
            <p className="mb-3 text-sm text-slate-600">Replaces every roll number in this section with 1, 2, 3… in alphabetical order of name.</p>
            <SubmitButton variant="secondary" pendingText="Numbering…">
              Number alphabetically
            </SubmitButton>
          </ActionForm>
        )}
      </Card>
    </>
  );
}
