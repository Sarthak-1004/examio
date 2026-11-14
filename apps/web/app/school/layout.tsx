import { AppShell, type NavItem } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";

export default async function SchoolLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId)!;
  const isAdmin = s.roles.includes("school_admin");

  const nav: NavItem[] = [
    { href: "/school", label: "Dashboard", exact: true },
    ...(isAdmin ? [{ href: "/school/setup", label: "School setup" }] : []),
    { href: "/school/students", label: "Students", soon: true },
    ...(isAdmin ? [{ href: "/school/staff", label: "Staff" }] : []),
    { href: "/school/attendance", label: "Attendance", soon: true },
    { href: "/school/questions", label: "Question bank", soon: true },
    { href: "/school/exams", label: "Exams", soon: true },
    { href: "/school/results", label: "Results", soon: true },
    ...(isAdmin ? [{ href: "/school/audit", label: "Audit log" }] : []),
  ];

  return (
    <AppShell
      nav={nav}
      title={m?.schoolName ?? "School"}
      subtitle={isAdmin ? "School Admin" : "Teacher"}
      userName={s.user.fullName}
      userDetail={s.user.email ?? s.user.phone ?? undefined}
    >
      {children}
    </AppShell>
  );
}
