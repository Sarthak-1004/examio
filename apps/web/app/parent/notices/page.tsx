import type { Metadata } from "next";
import { listMyNotices } from "@examio/core";
import { NoticeList } from "@/components/notice-list";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Notices" };

export default async function ParentNoticesPage() {
  const s = await requireSchoolRole("parent");
  const notices = await listMyNotices(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Notices" description="From the school and your children's classes." />
      <Card>
        <NoticeList timeZone={s.timeZone} notices={notices} />
      </Card>
    </>
  );
}
