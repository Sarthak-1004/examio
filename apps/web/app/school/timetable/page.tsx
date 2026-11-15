import type { Metadata } from "next";
import { WEEKDAY_NAMES, dayPlan, getAttendanceSettings, getMyTimetable, getSectionTimetable, listAcademicYears, listYearTeaching, formatMinutes } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { TimetableWeek } from "@/components/timetable-week";
import { Button, ButtonLink, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction, chooseYear } from "../setup/shared";
import { addSlotAction, removeSlotAction } from "./actions";

export const metadata: Metadata = { title: "Timetable" };

async function TeacherTimetable({ s }: { s: Awaited<ReturnType<typeof requireSchoolRole>> }) {
  const schoolId = s.ctx.schoolId;
  const [slots, settings] = await Promise.all([getMyTimetable(db, s.ctx, schoolId), getAttendanceSettings(db, s.ctx, schoolId)]);
  const today = await dayPlan(db, s.ctx, schoolId, slots, settings.today);
  return (
    <>
      <PageHeader title="My timetable" description="Your periods each week in the current academic year." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Week" />
          <TimetableWeek slots={slots} show="section" emptyText="The school has not put your periods on the timetable yet." />
        </Card>
        <Card>
          <CardHeader title={`Today, ${settings.today}`} />
          <div className="p-5 text-sm">
            {today.day?.events.map((e) => (
              <p key={e.title} className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-amber-900">
                {e.kind === "holiday" ? "Holiday" : e.kind === "exam" ? "Exam period" : "Event"}: {e.title}
              </p>
            ))}
            {today.periods.length === 0 ? (
              <p className="text-slate-600">{today.day?.reason === "weekly_off" ? "Weekly day off." : today.day?.reason === "holiday" ? "No classes today." : "No periods today."}</p>
            ) : (
              <ul className="space-y-1">
                {today.periods.map((p) => (
                  <li key={p.id}>
                    <span className="tabular-nums text-slate-600">
                      {formatMinutes(p.startMinute)}–{formatMinutes(p.endMinute)}
                    </span>{" "}
                    {p.subjectName} · {p.sectionLabel}
                    {p.room ? ` · ${p.room}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

export default async function TimetablePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  if (!s.roles.includes("school_admin")) return <TeacherTimetable s={s} />;
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const years = await listAcademicYears(db, s.ctx, schoolId);
  const year = chooseYear(years, sp.year);
  const teaching = year ? await listYearTeaching(db, s.ctx, schoolId, year.id) : [];
  const sections = teaching.map((t) => ({ id: t.sectionId, label: `${t.className} ${t.sectionName}`, t }));
  const selected = sections.find((x) => x.id === sp.section) ?? sections[0];
  const slots = selected ? await getSectionTimetable(db, s.ctx, schoolId, selected.id) : [];
  // The section's assigned teachers, each with the subjects they teach there.
  const byTeacher = new Map<string, { name: string; subjects: string[] }>();
  for (const sub of selected?.t.subjects ?? []) {
    for (const t of sub.teachers) {
      const cur = byTeacher.get(t.staffId) ?? { name: t.name, subjects: [] };
      cur.subjects.push(sub.subjectName);
      byTeacher.set(t.staffId, cur);
    }
  }
  const teachers = [...byTeacher.entries()].map(([staffId, t]) => ({ staffId, label: `${t.name} (${t.subjects.join(", ")})` }));
  const open = year?.status !== "closed";

  return (
    <>
      <PageHeader
        title="Timetable"
        description={year ? `Weekly periods for ${year.name}. The same section, teacher or room cannot have two periods at the same time.` : "Create an academic year first."}
        action={
          year ? (
            <ButtonLink href={`/school/timetable/load?year=${year.id}`} variant="secondary">
              Teacher load
            </ButtonLink>
          ) : undefined
        }
      />
      {sections.length === 0 ? (
        <Card>
          <EmptyState title="No sections">Add sections under School setup → Classes.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <form method="get" className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-5">
              {year && <input type="hidden" name="year" value={year.id} />}
              <Field label="Section" htmlFor="tt-section">
                <Select id="tt-section" name="section" defaultValue={selected?.id}>
                  {sections.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary">
                Show
              </Button>
            </form>
            <TimetableWeek
              slots={slots}
              show="teacher"
              emptyText="Add the first period with the form."
              action={open ? (slot) => <RowAction action={removeSlotAction} fields={{ slotId: slot.id }} label="Remove" variant="ghost" ariaLabel={`Remove ${slot.subjectName} on ${WEEKDAY_NAMES[slot.weekday - 1]} at ${formatMinutes(slot.startMinute)}`} /> : undefined}
            />
          </Card>
          {selected && open && (
            <Card>
              <CardHeader title={`Add a period to ${selected.label}`} />
              {selected.t.subjects.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">This class has no subjects for the year. Add them under School setup → Subjects.</p>
              ) : (
                <ActionForm action={addSlotAction} keepValues className="space-y-4 p-5">
                  <input type="hidden" name="sectionId" value={selected.id} />
                  <Field label="Day" htmlFor="sl-day">
                    <Select id="sl-day" name="weekday" defaultValue="1">
                      {WEEKDAY_NAMES.map((d, i) => (
                        <option key={d} value={i + 1}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Starts" htmlFor="sl-start">
                      <Input id="sl-start" name="start" type="time" required defaultValue="09:00" />
                    </Field>
                    <Field label="Ends" htmlFor="sl-end">
                      <Input id="sl-end" name="end" type="time" required defaultValue="09:40" />
                    </Field>
                  </div>
                  <Field label="Subject" htmlFor="sl-subject">
                    <Select id="sl-subject" name="subjectId" required>
                      {selected.t.subjects.map((x) => (
                        <option key={x.subjectId} value={x.subjectId}>
                          {x.subjectName}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Teacher" htmlFor="sl-teacher" hint="Must be assigned to that subject in this section.">
                    <Select id="sl-teacher" name="staffId" defaultValue="">
                      <option value="">No teacher</option>
                      {teachers.map((t) => (
                        <option key={t.staffId} value={t.staffId}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Room" htmlFor="sl-room" hint="Optional, e.g. Lab 1.">
                    <Input id="sl-room" name="room" maxLength={40} />
                  </Field>
                  <SubmitButton pendingText="Adding…">Add period</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
