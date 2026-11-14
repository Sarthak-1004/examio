import type { Metadata } from "next";
import { getMyStudentRecord } from "@examio/core";
import { AppShell } from "@/components/app-shell";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My exams" };

export default async function StudentHome() {
  const s = await requireSchoolRole("student");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
  const record = await getMyStudentRecord(db, s.ctx, s.ctx.schoolId);
  return (
    <AppShell
      nav={[
        { href: "/student", label: "My exams", exact: true },
        { href: "/student/results", label: "Results", soon: true },
        { href: "/student/progress", label: "My progress", soon: true },
      ]}
      title={m?.schoolName ?? "School"}
      subtitle="Student"
      userName={s.user.fullName}
      userDetail={s.user.username ?? undefined}
    >
      <PageHeader
        title={`Hi, ${(record?.displayName ?? s.user.fullName).split(" ")[0]}`}
        description={record ? [record.sectionLabel ? `${record.sectionLabel}${record.rollNo !== null ? ` · Roll ${record.rollNo}` : ""}` : "No class assigned yet", `Admission no. ${record.admissionNo}`, record.yearName].filter(Boolean).join(" · ") : undefined}
      />
      <Card>
        <CardHeader title="Exams" />
        <EmptyState title="No exams scheduled">When your school schedules an exam for you, it will appear here.</EmptyState>
      </Card>
    </AppShell>
  );
}
