import type { Metadata } from "next";
import Link from "next/link";
import { WEEKDAY_NAMES, addDays, isoWeekday, formatBp, attendanceBp, getAttendanceSettings, getDayStatus, getMyRegisters, type DayStatus, type RegisterStatusRow } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { attendanceSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Attendance" };

const STATE: Record<RegisterStatusRow["state"], { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  complete: { label: "Taken", tone: "green" },
  partial: { label: "Incomplete", tone: "amber" },
  missing: { label: "Not taken", tone: "red" },
  no_students: { label: "No students", tone: "slate" },
};

function registerHref(r: RegisterStatusRow, date: string) {
  return `/school/attendance/register?section=${r.sectionId}&session=${r.sessionId}&date=${date}`;
}

function DayTable({ status, date }: { status: DayStatus; date: string }) {
  const rows = status.rows.filter((r) => r.state !== "no_students");
  if (!status.yearName) return <EmptyState title="No academic year">This date is outside every academic year.</EmptyState>;
  if (status.day && !status.day.schoolDay && status.day.reason !== "future")
    return (
      <EmptyState title="Not a school day">
        {status.day.reason === "holiday" ? `Holiday: ${status.day.events.filter((e) => e.kind === "holiday").map((e) => e.title).join(", ")}.` : status.day.reason === "weekly_off" ? "Weekly day off." : "Outside the academic year."}
      </EmptyState>
    );
  if (status.day?.reason === "future") return <EmptyState title="Future date">Attendance is taken on the day.</EmptyState>;
  if (rows.length === 0) return <EmptyState title="No registers">No sections with students on this date.</EmptyState>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={`${r.sectionId}-${r.sessionId}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
          <Link href={registerHref(r, date)} className="font-medium text-brand-700 hover:underline">
            {r.sectionLabel}
            {status.rows.some((x) => x.sessionId !== r.sessionId) ? ` · ${r.sessionName}` : ""}
          </Link>
          <span className="flex items-center gap-3">
            <span className="tabular-nums text-slate-600">
              {r.marked}/{r.students}
            </span>
            <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const isAdmin = s.roles.includes("school_admin");
  const sp = await searchParams;
  const settings = await getAttendanceSettings(db, s.ctx, schoolId);
  const requested = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : settings.today;
  const status = isAdmin ? await getDayStatus(db, s.ctx, schoolId, requested) : await getMyRegisters(db, s.ctx, schoolId, requested);
  const taken = status.rows.filter((r) => r.state === "complete").length;
  const needed = status.rows.filter((r) => r.state !== "no_students").length;

  return (
    <>
      <PageHeader
        title="Attendance"
        description={isAdmin ? "Registers for every section. Teachers take their own sections' registers." : `Registers for the sections you teach. You can take or change attendance up to ${settings.editDays} day(s) after the date.`}
        action={
          <ButtonLink href="/school/attendance/reports" variant="secondary">
            Reports
          </ButtonLink>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={`${WEEKDAY_NAMES[isoWeekday(requested) - 1]}, ${requested}`} description={needed ? `${taken} of ${needed} register(s) taken · attendance ${formatBp(attendanceBp(status.counts))}` : undefined} />
          <form method="get" className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 pb-4">
            <Field label="Date" htmlFor="at-date">
              <Input id="at-date" name="date" type="date" defaultValue={requested} max={settings.today} />
            </Field>
            <Button type="submit" variant="secondary">
              Show
            </Button>
            <Link href={`/school/attendance?date=${addDays(requested, -1)}`} className="min-h-11 content-center text-sm text-brand-700 hover:underline">
              ← Previous day
            </Link>
            {requested < settings.today && (
              <Link href={`/school/attendance?date=${addDays(requested, 1)}`} className="min-h-11 content-center text-sm text-brand-700 hover:underline">
                Next day →
              </Link>
            )}
          </form>
          <DayTable status={status} date={requested} />
        </Card>
        {isAdmin && (
          <Card>
            <CardHeader title="Settings" description="Applies to the whole school." />
            <ActionForm action={attendanceSettingsAction} keepValues className="space-y-4 p-5">
              <Field label="Teachers may change attendance for" htmlFor="as-days" hint="Days after the date. 0 = only on the day.">
                <Input id="as-days" name="editDays" type="number" min={0} max={31} required defaultValue={settings.editDays} />
              </Field>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-slate-900">Weekly days off</legend>
                <div className="grid grid-cols-2 gap-1">
                  {WEEKDAY_NAMES.map((d, i) => (
                    <label key={d} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="weeklyOff" value={i + 1} defaultChecked={settings.weeklyOffDays.includes(i + 1)} className="h-5 w-5 rounded border-slate-300" />
                      {d}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Lock attendance up to and including" htmlFor="as-lock" hint="Locked dates can only be corrected by an administrator, with a reason. Leave empty for no lock.">
                <Input id="as-lock" name="lockedThrough" type="date" max={settings.today} defaultValue={settings.lockedThrough ?? ""} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save settings
              </SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
