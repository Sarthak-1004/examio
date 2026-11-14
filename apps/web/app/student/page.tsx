import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";

export const metadata: Metadata = { title: "My exams" };

export default async function StudentHome() {
  const s = await requireSchoolRole("student");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
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
      <PageHeader title={`Hi, ${s.user.fullName.split(" ")[0]}`} />
      <Card>
        <EmptyState title="No exams scheduled">When your school schedules an exam for you, it will appear here.</EmptyState>
      </Card>
    </AppShell>
  );
}
