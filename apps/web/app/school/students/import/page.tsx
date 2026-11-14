import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { StudentImportFlow } from "./import-flow";

export const metadata: Metadata = { title: "Import students" };

export default async function ImportStudentsPage() {
  const s = await requireSchoolRole("school_admin");
  const years = (await listAcademicYears(db, s.ctx, s.ctx.schoolId)).filter((y) => y.status !== "closed");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/students" className="text-brand-600 hover:text-brand-700">
          ← Students
        </Link>
      </p>
      <PageHeader title="Import students" description="Add a class list from a spreadsheet saved as CSV. All rows are imported together, or none." />
      {years.length === 0 ? (
        <Card>
          <EmptyState title="No open academic year">Create an academic year under School setup first.</EmptyState>
        </Card>
      ) : (
        <StudentImportFlow years={years.map((y) => ({ id: y.id, name: y.name, current: y.status === "current" }))} />
      )}
    </>
  );
}
