import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getChildAttendance, getChildTimetable, getMyChild } from "@examio/core";
import { AttendanceSummary } from "@/components/attendance-summary";
import { TimetableWeek } from "@/components/timetable-week";
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
  const [attendance, timetable] = await Promise.all([getChildAttendance(db, s.ctx, s.ctx.schoolId, id), getChildTimetable(db, s.ctx, s.ctx.schoolId, id)]);
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
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Homework and results will appear here as your school starts using them. To correct details, contact the school.</p>
        </Card>
        <div className="lg:col-span-2">
          <AttendanceSummary a={attendance} title="Attendance (last 30 days)" />
        </div>
        <Card>
          <CardHeader title="Timetable" />
          <TimetableWeek slots={timetable} show="none" emptyText="No timetable published for this class yet." />
        </Card>
      </div>
    </>
  );
}
