import type { Metadata } from "next";
import { getMyStudentRecord } from "@examio/core";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My exams" };

export default async function StudentHome() {
  const s = await requireSchoolRole("student");
  const record = await getMyStudentRecord(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader
        title={`Hi, ${(record?.displayName ?? s.user.fullName).split(" ")[0]}`}
        description={record ? [record.sectionLabel ? `${record.sectionLabel}${record.rollNo !== null ? ` · Roll ${record.rollNo}` : ""}` : "No class assigned yet", `Admission no. ${record.admissionNo}`, record.yearName].filter(Boolean).join(" · ") : undefined}
      />
      <Card>
        <CardHeader title="Exams" />
        <EmptyState title="No exams scheduled">When your school schedules an exam for you, it will appear here.</EmptyState>
      </Card>
    </>
  );
}
