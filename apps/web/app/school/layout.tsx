import { AppShell, type NavItem } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";

export default async function SchoolLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId)!;
  const isAdmin = s.roles.includes("school_admin");
  const isTeacher = s.roles.includes("teacher");
  const isFinance = s.roles.includes("finance");
  const staffArea = isAdmin || isTeacher;

  const nav: NavItem[] = [
    ...(staffArea ? [{ href: "/school", label: "Dashboard", exact: true }] : []),
    ...(isAdmin ? [{ href: "/school/setup", label: "School setup" }] : []),
    ...(isAdmin ? [{ href: "/school/students", label: "Students" }] : []),
    ...(isAdmin ? [{ href: "/school/admissions", label: "Admissions" }] : []),
    ...(isAdmin ? [{ href: "/school/library", label: "Library" }] : []),
    ...(isAdmin ? [{ href: "/school/inventory", label: "Inventory" }] : []),
    ...(s.roles.includes("teacher") ? [{ href: "/school/classes", label: "My classes" }] : []),
    ...(isAdmin ? [{ href: "/school/staff", label: "Staff" }] : []),
    ...(staffArea
      ? [
          { href: "/school/attendance", label: "Attendance" },
          { href: "/school/homework", label: "Homework" },
          { href: "/school/announcements", label: "Notices" },
          { href: "/school/timetable", label: isAdmin ? "Timetable" : "My timetable" },
        ]
      : []),
    ...(isAdmin || isFinance ? [{ href: "/school/fees", label: "Fees" }] : []),
    ...(staffArea
      ? [
          { href: "/school/questions", label: "Question bank" },
          { href: "/school/practice", label: "Practice" },
          { href: "/school/exams", label: "Exams" },
          { href: "/school/results", label: "Results" },
        ]
      : []),
    ...(isAdmin ? [{ href: "/school/audit", label: "Audit log" }] : []),
  ];

  return (
    <AppShell
      nav={nav}
      title={m?.schoolName ?? "School"}
      subtitle={isAdmin ? "School Admin" : isTeacher ? "Teacher" : "Finance"}
      userName={s.user.fullName}
      userDetail={s.user.email ?? s.user.phone ?? undefined}
    >
      {children}
    </AppShell>
  );
}
