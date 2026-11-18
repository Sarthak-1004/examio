import type { Metadata } from "next";
import Link from "next/link";
import { attendanceBp, countMembersByRole, formatBp, getAttendanceSettings, getDayStatus, getMyRegisters, getMyTeaching, getSchool, getSetupChecklist, listMyNotifications, type DayStatus } from "@examio/core";
import { markNotificationReadAction } from "@/app/actions/auth";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Badge, Button, Card, CardHeader, PageHeader, SchoolStatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function SchoolDashboard({ searchParams }: { searchParams: Promise<{ pw?: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { pw } = await searchParams;
  const isAdmin = s.roles.includes("school_admin");
  const isTeacher = s.roles.includes("teacher");
  // School-wide figures are for administrators; a teacher sees their own classes instead.
  const [school, counts, notices, setup, teaching] = await Promise.all([
    getSchool(db, s.ctx, s.ctx.schoolId),
    isAdmin ? countMembersByRole(db, s.ctx, s.ctx.schoolId) : Promise.resolve(null),
    listMyNotifications(db, s.ctx, 5),
    isAdmin ? getSetupChecklist(db, s.ctx, s.ctx.schoolId) : Promise.resolve(null),
    isTeacher ? getMyTeaching(db, s.ctx, s.ctx.schoolId) : Promise.resolve(null),
  ]);
  // Today's registers: school-wide for administrators, own sections for teachers.
  const settings = await getAttendanceSettings(db, s.ctx, s.ctx.schoolId);
  const registers: DayStatus = isAdmin ? await getDayStatus(db, s.ctx, s.ctx.schoolId, settings.today) : await getMyRegisters(db, s.ctx, s.ctx.schoolId);
  const due = registers.rows.filter((r) => r.state !== "no_students");
  const taken = due.filter((r) => r.state === "complete").length;

  const stats = counts
    ? [
        { label: "Students", value: counts.student ?? 0 },
        { label: "Teachers", value: counts.teacher ?? 0 },
        { label: "Admins", value: counts.school_admin ?? 0 },
        // No exams module yet: show the current academic year instead of a misleading zero.
        { label: "Academic year", value: setup?.currentYear?.name ?? "Not set" },
      ]
    : [];


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

      {stats.length > 0 && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((st) => (
          <Card key={st.label} className="p-5">
            <p className="text-sm text-slate-500">{st.label}</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{st.value}</p>
          </Card>
        ))}
      </div>}

      {registers.day?.schoolDay && due.length > 0 && (
        <Card className="mt-6">
          <CardHeader
            title="Attendance today"
            description={`${taken} of ${due.length} register(s) taken${taken ? ` · attendance ${formatBp(attendanceBp(registers.counts))}` : ""}`}
          />
          <ul className="divide-y divide-slate-100 text-sm">
            {due
              .filter((r) => r.state !== "complete")
              .slice(0, 8)
              .map((r) => (
                <li key={`${r.sectionId}-${r.sessionId}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <Link href={`/school/attendance/register?section=${r.sectionId}&session=${r.sessionId}&date=${registers.date}`} className="font-medium text-brand-700 hover:underline">
                    {r.sectionLabel} · {r.sessionName}
                  </Link>
                  <Badge tone={r.state === "partial" ? "amber" : "red"}>{r.state === "partial" ? "Incomplete" : "Not taken"}</Badge>
                </li>
              ))}
            {taken === due.length && <li className="px-5 py-3 text-slate-600">All registers are taken.</li>}
          </ul>
        </Card>
      )}

      {teaching && (
        <Card className="mt-6">
          <CardHeader title="My classes today" description={teaching.yearName ? `${teaching.yearName} · ${teaching.today}` : teaching.today} />
          {teaching.subjects.length === 0 && teaching.classTeacherOf.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-600">You have no classes assigned today. Your school administrator assigns classes and subjects.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {teaching.classTeacherOf.map((c) => (
                <li key={`ct-${c.sectionId}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <Link href={`/school/classes/${c.sectionId}`} className="font-medium text-brand-700 hover:underline">
                    {c.label}
                  </Link>
                  <Badge tone="blue">Class teacher</Badge>
                </li>
              ))}
              {teaching.subjects.map((a) => (
                <li key={`${a.sectionId}-${a.subjectName}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <Link href={`/school/classes/${a.sectionId}`} className="font-medium text-brand-700 hover:underline">
                    {a.label}
                  </Link>
                  <span className="text-slate-700">{a.subjectName}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

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
                    {formatDateTime(n.createdAt, s.timeZone)}
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

      {isAdmin && setup && (
        <Card className="mt-6">
          <CardHeader
            title="School setup"
            description={setup.ready ? "All required steps are done." : `${setup.items.filter((i) => i.required && i.done).length} of ${setup.items.filter((i) => i.required).length} required steps done.`}
            action={
              <Link href="/school/setup" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Open setup
              </Link>
            }
          />
          <ol className="divide-y divide-slate-100">
            {setup.items
              .filter((i) => !i.done)
              .slice(0, 4)
              .map((i) => (
                <li key={i.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="text-slate-700">
                    {i.label} {!i.required && <Badge>Optional</Badge>}
                  </span>
                  <Link href={i.href} className="font-medium text-brand-600 hover:text-brand-700">
                    Set up<span className="sr-only">: {i.label}</span>
                  </Link>
                </li>
              ))}
            {setup.items.every((i) => i.done) && <li className="px-5 py-3 text-sm text-emerald-700">Everything is set up.</li>}
          </ol>
        </Card>
      )}
    </>
  );
}
