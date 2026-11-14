import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listClassSubjects, listClasses, listSections, listSubjects } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { archiveItemAction, createSubjectAction, deleteItemAction, renameSubjectAction, setClassSubjectsAction } from "../actions";
import { ClosedYearNotice, RowAction, YearPicker, chooseYear } from "../shared";

export const metadata: Metadata = { title: "Subjects" };

export default async function SubjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const params = await searchParams;
  const [years, subjects, classes] = await Promise.all([
    listAcademicYears(db, s.ctx, schoolId),
    listSubjects(db, s.ctx, schoolId, { includeArchived: true }),
    listClasses(db, s.ctx, schoolId),
  ]);
  const year = chooseYear(years, params.year);
  const [maps, sections] = year ? await Promise.all([listClassSubjects(db, s.ctx, schoolId, year.id), listSections(db, s.ctx, schoolId, year.id)]) : [[], []];
  const active = subjects.filter((x) => !x.archived);
  const editable = year?.status !== "closed";
  const classesWithSections = classes.filter((c) => sections.some((x) => x.classId === c.id));

  return (
    <>
      <PageHeader title="Subjects" description="Subjects belong to the school; each year you choose which subjects every class studies." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Subjects" />
            {subjects.length === 0 ? (
              <EmptyState title="No subjects yet">Add the subjects your school teaches.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {subjects.map((sub) => (
                  <li key={sub.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">
                        {sub.name} <span className="font-mono text-xs text-slate-500">{sub.code}</span> {sub.archived && <Badge>Archived</Badge>}
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs font-medium text-brand-600">Rename</summary>
                        <ActionForm action={renameSubjectAction} keepValues inline className="mt-2">
                          <input type="hidden" name="subjectId" value={sub.id} />
                          <label className="sr-only" htmlFor={`sn-${sub.id}`}>
                            New name for {sub.name}
                          </label>
                          <Input id={`sn-${sub.id}`} name="name" required maxLength={80} defaultValue={sub.name} className="w-56" />
                          <SubmitButton variant="secondary" pendingText="Saving…">
                            Save
                          </SubmitButton>
                        </ActionForm>
                      </details>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <RowAction action={archiveItemAction} fields={{ kind: "subject", id: sub.id, archived: String(!sub.archived) }} label={sub.archived ? "Restore" : "Archive"} ariaLabel={`${sub.archived ? "Restore" : "Archive"} ${sub.name}`} />
                      <RowAction action={deleteItemAction} fields={{ kind: "subject", id: sub.id }} label="Delete" variant="danger" ariaLabel={`Delete ${sub.name}`} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Subjects by class" description="Classes with at least one section in the selected year." />
            <div className="space-y-4 p-5">
              {year ? (
                <>
                  <YearPicker years={years} selected={year} basePath="/school/setup/subjects" />
                  <ClosedYearNotice year={year} />
                </>
              ) : (
                <p className="text-sm text-slate-600">
                  Create an academic year first. <Link href="/school/setup/years" className="font-medium text-brand-600">Academic years</Link>
                </p>
              )}
              {year && classesWithSections.length === 0 && (
                <p className="text-sm text-slate-600">
                  No class has a section in {year.name} yet. <Link href={`/school/setup/classes?year=${year.id}`} className="font-medium text-brand-600">Add sections</Link>
                </p>
              )}
              {year && active.length === 0 && classesWithSections.length > 0 && <p className="text-sm text-slate-600">Add subjects first.</p>}
              {year &&
                active.length > 0 &&
                classesWithSections.map((c) => {
                  const chosen = new Set(maps.find((m) => m.classId === c.id)?.subjectIds ?? []);
                  return (
                    <ActionForm key={c.id} action={setClassSubjectsAction} keepValues className="rounded-lg p-4 ring-1 ring-slate-200">
                      <input type="hidden" name="yearId" value={year.id} />
                      <input type="hidden" name="classId" value={c.id} />
                      <fieldset disabled={!editable}>
                        <legend className="font-medium text-slate-900">
                          {c.name} <span className="text-sm font-normal text-slate-500">({chosen.size} subject{chosen.size === 1 ? "" : "s"})</span>
                        </legend>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {active.map((sub) => (
                            <label key={sub.id} className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
                              <input type="checkbox" name="subjectIds" value={sub.id} defaultChecked={chosen.has(sub.id)} className="size-5" />
                              {sub.name}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      {editable && (
                        <SubmitButton variant="secondary" pendingText="Saving…" aria-label={`Save subjects for ${c.name}`}>
                          Save
                        </SubmitButton>
                      )}
                    </ActionForm>
                  );
                })}
            </div>
          </Card>
        </div>
        <Card>
          <CardHeader title="New subject" />
          <ActionForm action={createSubjectAction} className="space-y-4 p-5">
            <Field label="Subject name" htmlFor="subject-name">
              <Input id="subject-name" name="name" required maxLength={80} />
            </Field>
            <Field label="Code" htmlFor="subject-code" hint="2–12 letters or digits, e.g. MATH. Cannot be changed later.">
              <Input id="subject-code" name="code" required maxLength={12} autoCapitalize="characters" className="font-mono uppercase" />
            </Field>
            <SubmitButton pendingText="Adding…">Add subject</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
