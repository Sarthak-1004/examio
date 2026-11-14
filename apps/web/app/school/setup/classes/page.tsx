import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listClasses, listSections } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { addStandardClassesAction, archiveItemAction, createClassAction, createSectionAction, deleteItemAction, updateClassAction } from "../actions";
import { ClosedYearNotice, RowAction, YearPicker, chooseYear } from "../shared";

export const metadata: Metadata = { title: "Classes and sections" };

export default async function ClassesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const params = await searchParams;
  const showArchived = params.archived === "1";
  const [years, allClasses] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId, { includeArchived: true })]);
  const year = chooseYear(years, params.year);
  const sections = year ? await listSections(db, s.ctx, schoolId, year.id, { includeArchived: true }) : [];
  const classes = allClasses.filter((c) => showArchived || !c.archived);
  const editable = year?.status !== "closed";

  return (
    <>
      <PageHeader title="Classes and sections" description="Classes stay the same from year to year; sections belong to one academic year." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {year ? (
            <>
              <YearPicker years={years} selected={year} basePath="/school/setup/classes" />
              <ClosedYearNotice year={year} />
            </>
          ) : (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Create an academic year first to add sections. <Link href="/school/setup/years" className="font-medium underline">Academic years</Link>
            </p>
          )}
          <Card>
            <CardHeader
              title="Classes"
              action={
                <Link
                  href={`/school/setup/classes?${new URLSearchParams({ ...(year ? { year: year.id } : {}), ...(showArchived ? {} : { archived: "1" }) })}`}
                  className="text-sm font-medium text-brand-600"
                >
                  {showArchived ? "Hide archived" : "Show archived"}
                </Link>
              }
            />
            {classes.length === 0 ? (
              <EmptyState title="No classes yet">Add Class 1 to Class 12 in one step, or add classes one by one.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {classes.map((c) => {
                  const own = sections.filter((x) => x.classId === c.id && (showArchived || !x.archived));
                  return (
                    <li key={c.id} className="space-y-3 px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">
                          {c.name} {c.archived && <Badge>Archived</Badge>}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <RowAction action={archiveItemAction} fields={{ kind: "class", id: c.id, archived: String(!c.archived) }} label={c.archived ? "Restore" : "Archive"} ariaLabel={`${c.archived ? "Restore" : "Archive"} ${c.name}`} />
                          <RowAction action={deleteItemAction} fields={{ kind: "class", id: c.id }} label="Delete" variant="danger" ariaLabel={`Delete ${c.name}`} />
                        </div>
                      </div>
                      {year && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-slate-500">Sections in {year.name}:</span>
                          {own.length === 0 && <span className="text-sm text-amber-700">none yet</span>}
                          {own.map((sec) => (
                            <span key={sec.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-sm text-slate-800">
                              {sec.name}
                              {sec.capacity !== null && <span className="text-xs text-slate-500">({sec.capacity})</span>}
                              {sec.archived && <Badge>Archived</Badge>}
                              {editable && (
                                <>
                                  <RowAction action={archiveItemAction} fields={{ kind: "section", id: sec.id, archived: String(!sec.archived) }} label={sec.archived ? "Restore" : "Archive"} variant="ghost" ariaLabel={`${sec.archived ? "Restore" : "Archive"} section ${sec.name} of ${c.name}`} />
                                  <RowAction action={deleteItemAction} fields={{ kind: "section", id: sec.id }} label="Delete" variant="ghost" ariaLabel={`Delete section ${sec.name} of ${c.name}`} />
                                </>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                      {year && editable && !c.archived && (
                        <ActionForm action={createSectionAction} inline>
                          <input type="hidden" name="yearId" value={year.id} />
                          <input type="hidden" name="classId" value={c.id} />
                          <label className="sr-only" htmlFor={`sec-${c.id}`}>
                            New section name for {c.name}
                          </label>
                          <Input id={`sec-${c.id}`} name="name" required maxLength={20} placeholder="Section, e.g. A" className="w-40" />
                          <label className="sr-only" htmlFor={`cap-${c.id}`}>
                            Capacity (optional)
                          </label>
                          <Input id={`cap-${c.id}`} name="capacity" type="number" min={1} max={500} placeholder="Capacity" className="w-28" />
                          <SubmitButton variant="secondary" pendingText="Adding…">
                            Add section
                          </SubmitButton>
                        </ActionForm>
                      )}
                      <details>
                        <summary className="cursor-pointer text-sm font-medium text-brand-600">Rename or reorder {c.name}</summary>
                        <ActionForm action={updateClassAction} keepValues inline className="mt-2">
                          <input type="hidden" name="classId" value={c.id} />
                          <label className="sr-only" htmlFor={`cn-${c.id}`}>
                            Class name
                          </label>
                          <Input id={`cn-${c.id}`} name="name" required maxLength={40} defaultValue={c.name} className="w-48" />
                          <label className="sr-only" htmlFor={`co-${c.id}`}>
                            Order
                          </label>
                          <Input id={`co-${c.id}`} name="sortOrder" type="number" min={-1000} max={1000} defaultValue={c.sortOrder} className="w-24" />
                          <SubmitButton variant="secondary" pendingText="Saving…">
                            Save
                          </SubmitButton>
                        </ActionForm>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Add classes" />
            <div className="space-y-5 p-5">
              <ActionForm action={addStandardClassesAction}>
                <SubmitButton variant="secondary" pendingText="Adding…">
                  Add Class 1 to Class 12
                </SubmitButton>
              </ActionForm>
              <ActionForm action={createClassAction} className="space-y-4">
                <Field label="Class name" htmlFor="class-name" hint="For example Nursery, LKG, Class 1.">
                  <Input id="class-name" name="name" required maxLength={40} />
                </Field>
                <Field label="Order" htmlFor="class-order" hint="Lower numbers come first.">
                  <Input id="class-order" name="sortOrder" type="number" min={-1000} max={1000} defaultValue={0} />
                </Field>
                <SubmitButton pendingText="Adding…">Add class</SubmitButton>
              </ActionForm>
            </div>
          </Card>
          <p className="text-sm text-slate-600">
            A class or section that is already in use cannot be deleted. Archive it instead: it disappears from new setup but its history is kept.
          </p>
        </div>
      </div>
    </>
  );
}
