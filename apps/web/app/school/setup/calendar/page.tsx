import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listAttendanceSessions, listCalendar } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { addCalendarEntryAction, archiveSessionAction, createSessionAction, deleteCalendarEntryAction } from "../actions";
import { ClosedYearNotice, RowAction, YearPicker, chooseYear } from "../shared";

export const metadata: Metadata = { title: "Calendar and attendance" };

const KIND_LABEL = { holiday: "Holiday", event: "Event", exam: "Exams" } as const;

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const params = await searchParams;
  const [years, sessions] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listAttendanceSessions(db, s.ctx, schoolId, { includeArchived: true })]);
  const year = chooseYear(years, params.year);
  const entries = year ? await listCalendar(db, s.ctx, schoolId, year.id) : [];
  const editable = year?.status !== "closed";

  return (
    <>
      <PageHeader title="Calendar and attendance" description="Holidays, events and exam periods for each year, and the attendance sessions taken each day." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {year ? (
            <>
              <YearPicker years={years} selected={year} basePath="/school/setup/calendar" />
              <ClosedYearNotice year={year} />
            </>
          ) : (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Create an academic year first. <Link href="/school/setup/years" className="font-medium underline">Academic years</Link>
            </p>
          )}
          {year && (
            <Card>
              <CardHeader title={`Calendar for ${year.name}`} description={`${year.startsOn} to ${year.endsOn}`} />
              {entries.length === 0 ? (
                <EmptyState title="Nothing on the calendar yet">Add holidays first: attendance and timetables use them.</EmptyState>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {entries.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {e.title} <Badge tone={e.kind === "holiday" ? "green" : e.kind === "exam" ? "amber" : "blue"}>{KIND_LABEL[e.kind]}</Badge>
                        </p>
                        <p className="text-sm text-slate-600">{e.startsOn === e.endsOn ? e.startsOn : `${e.startsOn} to ${e.endsOn}`}</p>
                      </div>
                      {editable && <RowAction action={deleteCalendarEntryAction} fields={{ entryId: e.id }} label="Remove" variant="danger" ariaLabel={`Remove ${e.title}`} />}
                    </li>
                  ))}
                </ul>
              )}
              {editable && (
                <ActionForm action={addCalendarEntryAction} className="grid gap-3 border-t border-slate-100 p-5 sm:grid-cols-2">
                  <input type="hidden" name="yearId" value={year.id} />
                  <Field label="Title" htmlFor="cal-title" className="sm:col-span-2">
                    <Input id="cal-title" name="title" required maxLength={120} />
                  </Field>
                  <Field label="Type" htmlFor="cal-kind">
                    <Select id="cal-kind" name="kind" defaultValue="holiday">
                      <option value="holiday">Holiday</option>
                      <option value="event">Event</option>
                      <option value="exam">Exams</option>
                    </Select>
                  </Field>
                  <div />
                  <Field label="From" htmlFor="cal-start">
                    <Input id="cal-start" name="startsOn" type="date" required min={year.startsOn} max={year.endsOn} />
                  </Field>
                  <Field label="To" htmlFor="cal-end" hint="Leave empty for a single day.">
                    <Input id="cal-end" name="endsOn" type="date" min={year.startsOn} max={year.endsOn} />
                  </Field>
                  <div className="sm:col-span-2">
                    <SubmitButton pendingText="Adding…">Add to calendar</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="Attendance sessions" description="Most schools take attendance once a day. Add more if you mark it, say, morning and afternoon." />
          <ul className="divide-y divide-slate-100">
            {sessions.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <p className="text-sm font-medium text-slate-900">
                  {x.name} {x.archived && <Badge>Archived</Badge>}
                </p>
                <RowAction action={archiveSessionAction} fields={{ sessionId: x.id, archived: String(!x.archived) }} label={x.archived ? "Restore" : "Archive"} ariaLabel={`${x.archived ? "Restore" : "Archive"} ${x.name}`} />
              </li>
            ))}
          </ul>
          <ActionForm action={createSessionAction} className="space-y-3 border-t border-slate-100 p-5">
            <Field label="New session" htmlFor="session-name">
              <Input id="session-name" name="name" required maxLength={40} placeholder="e.g. Afternoon" />
            </Field>
            <Field label="Order" htmlFor="session-order">
              <Input id="session-order" name="sortOrder" type="number" min={-1000} max={1000} defaultValue={sessions.length} />
            </Field>
            <SubmitButton variant="secondary" pendingText="Adding…">
              Add session
            </SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
