import type { Metadata } from "next";
import { listAcademicYears } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { copyYearAction, createYearAction, deleteYearAction, setYearStatusAction, updateYearAction } from "../actions";
import { RowAction, yearStatusBadge } from "../shared";

export const metadata: Metadata = { title: "Academic years" };

export default async function YearsPage() {
  const s = await requireSchoolRole("school_admin");
  const years = await listAcademicYears(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Academic years" description="One year is current at a time. Closing a year makes its setup read-only; you can reopen it." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Years" />
          {years.length === 0 ? (
            <EmptyState title="No academic years yet">Create the first year, then make it current.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {years.map((y) => (
                <li key={y.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">
                        {y.name} {yearStatusBadge(y.status)}
                      </p>
                      <p className="text-sm text-slate-600">
                        {y.startsOn} to {y.endsOn}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {y.status !== "current" && <RowAction action={setYearStatusAction} fields={{ yearId: y.id, status: "current" }} label="Make current" variant="primary" ariaLabel={`Make ${y.name} current`} />}
                      {y.status !== "closed" && <RowAction action={setYearStatusAction} fields={{ yearId: y.id, status: "closed" }} label="Close" ariaLabel={`Close ${y.name}`} />}
                      {y.status === "closed" && <RowAction action={setYearStatusAction} fields={{ yearId: y.id, status: "planned" }} label="Reopen" ariaLabel={`Reopen ${y.name}`} />}
                      {y.status !== "current" && <RowAction action={deleteYearAction} fields={{ yearId: y.id }} label="Delete" variant="danger" ariaLabel={`Delete ${y.name}`} />}
                    </div>
                  </div>
                  {y.status !== "closed" && (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium text-brand-600">Edit {y.name}</summary>
                      <ActionForm action={updateYearAction} keepValues className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
                        <input type="hidden" name="yearId" value={y.id} />
                        <Field label="Name" htmlFor={`name-${y.id}`}>
                          <Input id={`name-${y.id}`} name="name" required maxLength={40} defaultValue={y.name} />
                        </Field>
                        <Field label="Starts" htmlFor={`start-${y.id}`}>
                          <Input id={`start-${y.id}`} name="startsOn" type="date" required defaultValue={y.startsOn} />
                        </Field>
                        <Field label="Ends" htmlFor={`end-${y.id}`}>
                          <Input id={`end-${y.id}`} name="endsOn" type="date" required defaultValue={y.endsOn} />
                        </Field>
                        <SubmitButton variant="secondary" pendingText="Saving…">
                          Save
                        </SubmitButton>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="New academic year" />
            <ActionForm action={createYearAction} className="space-y-4 p-5">
              <Field label="Name" htmlFor="year-name" hint="For example 2026-27.">
                <Input id="year-name" name="name" required maxLength={40} />
              </Field>
              <Field label="Starts" htmlFor="year-start">
                <Input id="year-start" name="startsOn" type="date" required />
              </Field>
              <Field label="Ends" htmlFor="year-end">
                <Input id="year-end" name="endsOn" type="date" required />
              </Field>
              <SubmitButton pendingText="Creating…">Create year</SubmitButton>
            </ActionForm>
          </Card>
          {years.length >= 2 && (
            <Card>
              <CardHeader title="Prepare a year from another" description="Copies sections and subject assignments into an empty year." />
              <ActionForm action={copyYearAction} className="space-y-4 p-5">
                <Field label="Copy from" htmlFor="copy-from">
                  <Select id="copy-from" name="fromYearId" required defaultValue={years.find((y) => y.status === "current")?.id}>
                    {years.map((y) => (
                      <option key={y.id} value={y.id}>
                        {y.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Copy into" htmlFor="copy-to">
                  <Select id="copy-to" name="toYearId" required defaultValue={years.find((y) => y.status === "planned")?.id}>
                    {years
                      .filter((y) => y.status !== "closed")
                      .map((y) => (
                        <option key={y.id} value={y.id}>
                          {y.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <SubmitButton variant="secondary" pendingText="Copying…">
                  Copy structure
                </SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
