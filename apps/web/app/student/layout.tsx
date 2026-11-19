import { getSchoolAccess } from "@examio/core";
import { AccessBanner, withinPlan } from "@/components/access-banner";
import { AppShell } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("student");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
  const access = await getSchoolAccess(db, s.ctx, s.ctx.schoolId);
  return (
    <AppShell
      nav={withinPlan([
        { href: "/student", label: "Today", exact: true },
        { href: "/student/homework", label: "Homework" },
        { href: "/student/exams", label: "Exams" },
        { href: "/student/practice", label: "Practice" },
        { href: "/student/notices", label: "Notices" },
        { href: "/student/timetable", label: "Timetable" },
        { href: "/student/attendance", label: "Attendance" },
        { href: "/student/results", label: "Results" },
        { href: "/student/library", label: "Library" },
        { href: "/student/transport", label: "Transport" },
        { href: "/student/progress", label: "My progress" },
      ], access.modules)}
      title={m?.schoolName ?? "School"}
      subtitle="Student"
      userName={s.user.fullName}
      userDetail={s.user.username ?? undefined}
    >
      <AccessBanner a={access} isAdmin={false} />
      {children}
    </AppShell>
  );
}
