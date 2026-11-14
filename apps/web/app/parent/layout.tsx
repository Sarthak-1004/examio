import { listMyChildren } from "@examio/core";
import { AppShell, type NavItem } from "@/components/app-shell";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

/** Parent portal: one entry per linked child in the selected school. Other schools: switch school. */
export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSchoolRole("parent");
  const m = s.memberships.find((x) => x.schoolId === s.ctx.schoolId);
  const kids = await listMyChildren(db, s.ctx, s.ctx.schoolId);
  const nav: NavItem[] = [
    { href: "/parent", label: "My children", exact: true },
    ...kids.map((k) => ({ href: `/parent/children/${k.studentId}`, label: k.displayName })),
    { href: "/parent/attendance", label: "Attendance", soon: true },
    { href: "/parent/results", label: "Results", soon: true },
  ];
  return (
    <AppShell nav={nav} title={m?.schoolName ?? "School"} subtitle="Parent" userName={s.user.fullName} userDetail={s.user.email ?? s.user.phone ?? undefined}>
      {children}
    </AppShell>
  );
}
