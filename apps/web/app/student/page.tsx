import type { Metadata } from "next";
import Link from "next/link";
import { AppError, dayPlan, formatBp, formatMinutes, getSchoolToday, getMyAttendance, getMyStudentRecord, getMyStudentTimetable, listMyHomework, listMyNotices } from "@examio/core";
import { HomeworkList } from "@/components/homework-list";
import { NoticeList } from "@/components/notice-list";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Today" };

const orNull = <T,>(p: Promise<T>) =>
  p.catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return null;
    throw e;
  });

/** A student's day: periods, homework to do, attendance and the latest notices. */
export default async function StudentHome() {
  const s = await requireSchoolRole("student");
  const schoolId = s.ctx.schoolId;
  const [record, slots, homework, notices, attendance, today] = await Promise.all([
    getMyStudentRecord(db, s.ctx, schoolId),
    getMyStudentTimetable(db, s.ctx, schoolId),
    orNull(listMyHomework(db, s.ctx, schoolId)),
    listMyNotices(db, s.ctx, schoolId, 3),
    orNull(getMyAttendance(db, s.ctx, schoolId)),
    getSchoolToday(db, s.ctx, schoolId),
  ]);
  const plan = await dayPlan(db, s.ctx, schoolId, slots, today);
  const todo = (homework ?? []).filter((h) => !h.submittedAt && (new Date(h.dueAt).getTime() >= Date.now() || h.allowLate)).slice(0, 5);

  return (
    <>
      <PageHeader
        title={`Hi, ${(record?.displayName ?? s.user.fullName).split(" ")[0]}`}
        description={record ? [record.sectionLabel ? `${record.sectionLabel}${record.rollNo !== null ? ` · Roll ${record.rollNo}` : ""}` : "No class assigned yet", `Admission no. ${record.admissionNo}`, record.yearName].filter(Boolean).join(" · ") : undefined}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title={`Today, ${today}`} />
          <div className="p-5 text-sm">
            {plan.day?.events.map((e) => (
              <p key={e.title} className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-amber-900">
                {e.kind === "holiday" ? "Holiday" : e.kind === "exam" ? "Exams" : "Event"}: {e.title}
              </p>
            ))}
            {plan.periods.length === 0 ? (
              <p className="text-slate-600">{plan.day?.reason === "weekly_off" ? "No school today." : plan.day?.reason === "holiday" ? "No classes today." : "No periods on the timetable today."}</p>
            ) : (
              <ul className="space-y-1">
                {plan.periods.map((p) => (
                  <li key={p.id}>
                    <span className="tabular-nums text-slate-600">
                      {formatMinutes(p.startMinute)}–{formatMinutes(p.endMinute)}
                    </span>{" "}
                    {p.subjectName}
                    {p.room ? ` · ${p.room}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Homework to do" />
          <HomeworkList rows={todo} hrefFor={(id) => `/student/homework/${id}`} empty="Nothing to do right now." />
          <div className="border-t border-slate-100 px-5 py-3">
            <Link href="/student/homework" className="text-sm text-brand-700 hover:underline">
              All homework
            </Link>
          </div>
        </Card>
        <Card>
          <CardHeader title="Attendance" description="Last 30 days" />
          <div className="p-5">
            <p className="text-3xl font-bold tabular-nums text-slate-900">{attendance ? formatBp(attendance.bp) : "N/A"}</p>
            <ButtonLink href="/student/attendance" variant="secondary" className="mt-3">
              Details
            </ButtonLink>
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Latest notices" />
          <NoticeList notices={notices} />
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader title="Exams" />
          <EmptyState title="No exams scheduled">When your school schedules an exam for you, it will appear here.</EmptyState>
        </Card>
      </div>
    </>
  );
}
