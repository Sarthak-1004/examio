import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getChildAttendance, getChildPracticeProgress, getChildTimetable, getMyChild, listChildExams, listChildHomework, listChildLoans, listChildPractice } from "@examio/core";
import { ExamList } from "@/components/exam-list";
import { PracticeList, PracticeProgressView } from "@/components/practice";
import { HomeworkList } from "@/components/homework-list";
import { AttendanceSummary } from "@/components/attendance-summary";
import { TimetableWeek } from "@/components/timetable-week";
import { LibraryLoans } from "@/components/library-loans";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Child" };

const END: Record<string, string> = { promoted: "Promoted", section_changed: "Moved section", left: "Left", corrected: "Corrected by the school" };

/** One linked child. Any other student is not found, exactly like an unknown id. */
export default async function ChildPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("parent");
  const { id } = await params;
  const child = await getMyChild(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const history = child.enrollments.filter((e) => e.endReason !== "corrected");
  const [attendance, timetable, homework, practice, progress, examRows, loans] = await Promise.all([
    getChildAttendance(db, s.ctx, s.ctx.schoolId, id),
    getChildTimetable(db, s.ctx, s.ctx.schoolId, id),
    listChildHomework(db, s.ctx, s.ctx.schoolId, id),
    listChildPractice(db, s.ctx, s.ctx.schoolId, id),
    getChildPracticeProgress(db, s.ctx, s.ctx.schoolId, id),
    listChildExams(db, s.ctx, s.ctx.schoolId, id),
    listChildLoans(db, s.ctx, s.ctx.schoolId, id),
  ]);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/parent" className="text-brand-600 hover:text-brand-700">
          ← My children
        </Link>
      </p>
      <PageHeader
        title={child.displayName}
        description={`Admission no. ${child.admissionNo}`}
        action={child.status === "left" ? <Badge>Left the school</Badge> : child.sectionLabel ? <Badge tone="green">{child.sectionLabel}</Badge> : undefined}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Classes" />
          {history.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-600">No class assigned yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {history.map((e) => (
                <li key={e.id} className="px-5 py-3">
                  <span className="font-medium text-slate-900">{e.sectionLabel}</span>
                  {e.rollNo !== null && <span className="text-slate-600"> · Roll {e.rollNo}</span>}
                  <span className="block text-xs text-slate-500">
                    {e.yearName}: {e.startsOn} to {e.endsOn ?? "now"}
                    {e.endReason ? ` · ${END[e.endReason] ?? e.endReason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Details" />
          <dl className="space-y-2 p-5 text-sm">
            <div>
              <dt className="text-slate-500">You are</dt>
              <dd className="font-medium capitalize text-slate-900">{child.relationship}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Date of birth</dt>
              <dd className="text-slate-900">{child.dateOfBirth ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Admitted on</dt>
              <dd className="text-slate-900">{child.admittedOn}</dd>
            </div>
          </dl>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">To correct details, contact the school.</p>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Homework" />
          <HomeworkList timeZone={s.timeZone} rows={homework} hrefFor={(hw) => `/parent/children/${id}/homework/${hw}`} empty="No homework for this class right now." />
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Exams"
            description="Schedule and submissions. Results appear once the school releases them."
            action={
              <Link href={`/parent/children/${id}/results`} className="text-sm font-medium text-brand-700 hover:underline">
                Report card
              </Link>
            }
          />
          <ExamList rows={examRows} timeZone={s.timeZone} empty="No exams for this class right now." />
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Practice" description="Practice does not count towards results." />
          <PracticeList timeZone={s.timeZone} rows={practice} attemptHref={(a) => `/parent/children/${id}/practice/${a}`} empty="No practice assigned to this class yet." />
          <div className="border-t border-slate-100 pt-4">
            <PracticeProgressView timeZone={s.timeZone} p={progress} attemptHref={(a) => `/parent/children/${id}/practice/${a}`} />
          </div>
        </Card>
        <div className="lg:col-span-2">
          <AttendanceSummary a={attendance} title="Attendance (last 30 days)" />
        </div>
        <Card className="lg:col-span-2">
          <CardHeader title="Library" description="Books borrowed from the school library." />
          <LibraryLoans rows={loans} empty="No library books borrowed." />
        </Card>
        <Card>
          <CardHeader title="Timetable" />
          <TimetableWeek slots={timetable} show="none" emptyText="No timetable published for this class yet." />
        </Card>
      </div>
    </>
  );
}
