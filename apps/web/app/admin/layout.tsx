import { AppShell } from "@/components/app-shell";
import { requirePlatformAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await requirePlatformAdmin();
  return (
    <AppShell
      title="Platform administration"
      subtitle="Super Admin"
      userName={s.user.fullName}
      userDetail={s.user.email ?? undefined}
      nav={[
        { href: "/admin", label: "Schools", exact: true },
        { href: "/admin/schools/new", label: "Add school" },
        { href: "/admin/plans", label: "Plans" },
        { href: "/admin/usage", label: "Usage" },
        { href: "/admin/settings", label: "Boards & mediums" },
        { href: "/admin/system", label: "System" },
        { href: "/admin/audit", label: "Audit log" },
        { href: "/admin/capacity", label: "Exam capacity", soon: true },
      ]}
    >
      {children}
    </AppShell>
  );
}
