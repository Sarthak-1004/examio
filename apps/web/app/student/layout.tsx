import { AppShell } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("student");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
  return (
    <AppShell
      nav={[
        { href: "/student", label: "My exams", exact: true },
        { href: "/student/timetable", label: "Timetable" },
        { href: "/student/attendance", label: "Attendance" },
        { href: "/student/results", label: "Results", soon: true },
        { href: "/student/progress", label: "My progress", soon: true },
      ]}
      title={m?.schoolName ?? "School"}
      subtitle="Student"
      userName={s.user.fullName}
      userDetail={s.user.username ?? undefined}
    >
      {children}
    </AppShell>
  );
}
