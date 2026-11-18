import type { Metadata } from "next";
import { listMyLoans } from "@examio/core";
import { LibraryLoans } from "@/components/library-loans";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Library" };

export default async function MyLibraryPage() {
  const s = await requireSchoolRole("student");
  const rows = await listMyLoans(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Library" description="Books you have borrowed from the school library. Return or renew them at the library desk." />
      <Card>
        <LibraryLoans rows={rows} empty="You have not borrowed any books." />
      </Card>
    </>
  );
}
