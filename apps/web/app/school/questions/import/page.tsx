import type { Metadata } from "next";
import Link from "next/link";
import { requireSchoolRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { QuestionImportFlow } from "./import-flow";

export const metadata: Metadata = { title: "Import questions" };

export default async function ImportQuestionsPage() {
  await requireSchoolRole("school_admin", "teacher");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/questions" className="text-brand-600 hover:text-brand-700">
          ← Question bank
        </Link>
      </p>
      <PageHeader title="Import questions" description="Add many questions from a spreadsheet saved as CSV. Every row is checked like the editor; all rows are imported together, or none." />
      <QuestionImportFlow />
    </>
  );
}
