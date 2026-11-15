import type { Metadata } from "next";
import { listMyNotices } from "@examio/core";
import { NoticeList } from "@/components/notice-list";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Notices" };

export default async function StudentNoticesPage() {
  const s = await requireSchoolRole("student");
  const notices = await listMyNotices(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Notices" description="From your school and your class." />
      <Card>
        <NoticeList notices={notices} />
      </Card>
    </>
  );
}
