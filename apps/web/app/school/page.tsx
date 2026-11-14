import type { Metadata } from "next";
import { countMembersByRole, getSchool, listMyNotifications } from "@examio/core";
import { markNotificationReadAction } from "@/app/actions/auth";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Badge, Button, Card, CardHeader, PageHeader, SchoolStatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Dashboard" };

export default async function SchoolDashboard({ searchParams }: { searchParams: Promise<{ pw?: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { pw } = await searchParams;
  const [school, counts, notices] = await Promise.all([
    getSchool(db, s.ctx, s.ctx.schoolId),
    countMembersByRole(db, s.ctx, s.ctx.schoolId),
    listMyNotifications(db, s.ctx, 5),
  ]);
  const isAdmin = s.roles.includes("school_admin");

  const stats = [
    { label: "Students", value: counts.student ?? 0 },
    { label: "Teachers", value: counts.teacher ?? 0 },
    { label: "Admins", value: counts.school_admin ?? 0 },
    { label: "Upcoming exams", value: 0 },
  ];

  const checklist = [
    "Set up the academic year",
    "Create classes and sections (1–12)",
    "Add subjects",
    "Add teachers and assign subjects",
    "Import students",
    "Create the first exam",
  ];

  return (
    <>
      <PageHeader
        title={`Welcome, ${s.user.fullName.split(" ")[0]}`}
        description={`${school.board} · ${school.medium} medium`}
        action={<SchoolStatusBadge status={school.status} />}
      />
      {pw === "changed" && (
        <div className="mb-6">
          <Alert tone="green">Your password has been changed.</Alert>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((st) => (
          <Card key={st.label} className="p-5">
            <p className="text-sm text-slate-500">{st.label}</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{st.value}</p>
          </Card>
        ))}
      </div>

      {notices.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Notices" description="Messages for you from Examio." />
          <ul className="divide-y divide-slate-100">
            {notices.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">
                    {n.subject} {!n.readAt && <Badge tone="blue">New</Badge>}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-slate-600">{n.text}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {n.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST
                  </p>
                </div>
                {!n.readAt && (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="notificationId" value={n.id} />
                    <Button variant="secondary" aria-label={`Mark "${n.subject}" as read`}>
                      Mark as read
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isAdmin && (
        <Card className="mt-6">
          <CardHeader title="Getting started" description="These steps arrive in the next build phase (Core MIS)." />
          <ol className="divide-y divide-slate-100">
            {checklist.map((c, i) => (
              <li key={c} className="flex items-center gap-3 px-5 py-3 text-sm text-slate-700">
                <span className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                  {i + 1}
                </span>
                {c}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
