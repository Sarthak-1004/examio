import type { Metadata } from "next";
import Link from "next/link";
import { addDays, getAttendanceSettings, getMyTeaching, listAcademicYears, listClasses, listHomeworkForStaff, listSections, listSubjects } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui";
import { chooseYear } from "../setup/shared";
import { sectionOptions } from "../students/shared";
import { createHomeworkAction } from "./actions";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Homework" };


export default async function HomeworkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const when = (d: Date | string) => formatDateTime(d, s.timeZone);
  const schoolId = s.ctx.schoolId;
  const isAdmin = s.roles.includes("school_admin");
  const sp = await searchParams;
  const archived = sp.view === "archived";
  const [rows, subjects, settings] = await Promise.all([
    listHomeworkForStaff(db, s.ctx, schoolId, { status: archived ? "archived" : "published" }),
    listSubjects(db, s.ctx, schoolId),
    getAttendanceSettings(db, s.ctx, schoolId),
  ]);
  let targets: { id: string; label: string }[];
  if (isAdmin) {
    const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
    const year = chooseYear(years, undefined);
    targets = year && year.status !== "closed" ? sectionOptions(await listSections(db, s.ctx, schoolId, year.id), classes) : [];
  } else {
    const t = await getMyTeaching(db, s.ctx, schoolId);
    const seen = new Map<string, string>();
    for (const x of [...t.subjects, ...t.classTeacherOf]) seen.set(x.sectionId, x.label);
    targets = [...seen.entries()].map(([id, label]) => ({ id, label }));
  }
  const now = Date.now();

  return (
    <>
      <PageHeader title="Homework" description={isAdmin ? "Homework set across the school." : "Homework for the sections you teach. Students and their parents see it as soon as you set it."} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <nav aria-label="Homework list" className="flex gap-2 border-b border-slate-100 px-5 py-3 text-sm">
            <Link href="/school/homework" aria-current={!archived ? "page" : undefined} className={cx("rounded-md px-3 py-2", !archived ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50")}>
              Current
            </Link>
            <Link href="/school/homework?view=archived" aria-current={archived ? "page" : undefined} className={cx("rounded-md px-3 py-2", archived ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50")}>
              Archived
            </Link>
          </nav>
          {rows.length === 0 ? (
            <EmptyState title={archived ? "Nothing archived" : "No homework yet"}>{archived ? "Archived homework appears here." : "Set the first homework with the form."}</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <Link href={`/school/homework/${h.id}`} className="font-medium text-brand-700 hover:underline">
                      {h.title}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {h.sectionLabel} · {h.subjectName} · due {when(h.dueAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-slate-600">
                      {h.submitted}/{h.students} submitted
                    </span>
                    {new Date(h.dueAt).getTime() < now ? <Badge>Past due</Badge> : <Badge tone="green">Open</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Set homework" />
          {targets.length === 0 ? (
            <p className="p-5 text-sm text-slate-600">{isAdmin ? "Add sections for the current year under School setup." : "You have no classes assigned today."}</p>
          ) : (
            <ActionForm action={createHomeworkAction} className="space-y-4 p-5">
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-slate-900">Sections</legend>
                <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">
                  {targets.map((t) => (
                    <label key={t.id} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="sectionIds" value={t.id} defaultChecked={targets.length === 1} className="h-5 w-5 rounded border-slate-300" />
                      {t.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Subject" htmlFor="hw-subject">
                <Select id="hw-subject" name="subjectId" required>
                  {subjects.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title" htmlFor="hw-title">
                <Input id="hw-title" name="title" required maxLength={150} />
              </Field>
              <Field label="Instructions" htmlFor="hw-instructions">
                <Textarea id="hw-instructions" name="instructions" rows={4} maxLength={5000} />
              </Field>
              <Field label="Due" htmlFor="hw-due" hint="School time.">
                <Input id="hw-due" name="dueAt" type="datetime-local" required defaultValue={`${addDays(settings.today, 1)}T17:00`} />
              </Field>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="allowLate" className="h-5 w-5 rounded border-slate-300" />
                Accept late submissions (marked late)
              </label>
              <Field label="Attachments" htmlFor="hw-files" hint="Optional: PDF, image or text, up to 10 MB each, at most 5.">
                <input id="hw-files" name="files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" className="block text-sm" />
              </Field>
              <SubmitButton pendingText="Setting…">Set homework</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
