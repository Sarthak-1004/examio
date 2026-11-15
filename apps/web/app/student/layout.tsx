import { AppShell } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("student");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
  return (
    <AppShell
      nav={[
        { href: "/student", label: "Today", exact: true },
        { href: "/student/homework", label: "Homework" },
        { href: "/student/practice", label: "Practice" },
        { href: "/student/notices", label: "Notices" },
        { href: "/student/timetable", label: "Timetable" },
        { href: "/student/attendance", label: "Attendance" },
        { href: "/student/results", label: "Results", soon: true },
        { href: "/student/progress", label: "My progress" },
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
