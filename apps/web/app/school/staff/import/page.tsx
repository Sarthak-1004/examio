import type { Metadata } from "next";
import Link from "next/link";
import { requireSchoolRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ImportFlow } from "./import-flow";

export const metadata: Metadata = { title: "Import staff" };

export default async function ImportStaffPage() {
  await requireSchoolRole("school_admin");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/staff" className="text-brand-600 hover:text-brand-700">
          ← Staff
        </Link>
      </p>
      <PageHeader title="Import staff" description="Add many staff at once from a spreadsheet saved as CSV. All rows are imported together, or none." />
      <ImportFlow />
    </>
  );
}
