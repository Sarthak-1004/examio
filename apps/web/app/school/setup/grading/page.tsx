import type { Metadata } from "next";
import { bpToPercent, listGradingSchemes } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { archiveSchemeAction, createGradingSchemeAction, createPresetSchemeAction, setDefaultSchemeAction } from "../actions";
import { RowAction } from "../shared";

export const metadata: Metadata = { title: "Grading" };

const BAND_ROWS = 10;

export default async function GradingPage() {
  const s = await requireSchoolRole("school_admin");
  const schemes = await listGradingSchemes(db, s.ctx, s.ctx.schoolId, { includeArchived: true });
  return (
    <>
      <PageHeader title="Grading" description="How percentages turn into grades, and the pass mark. Marks are compared exactly, without rounding." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {schemes.length === 0 ? (
            <Card>
              <EmptyState title="No grading scheme yet">Start from the CBSE-style scale, or create your own.</EmptyState>
            </Card>
          ) : (
            schemes.map((scheme) => (
              <Card key={scheme.id}>
                <CardHeader
                  title={scheme.name}
                  description={`Pass mark ${bpToPercent(scheme.passBp)}%`}
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      {scheme.isDefault && <Badge tone="green">Default</Badge>}
                      {scheme.archived && <Badge>Archived</Badge>}
                      {!scheme.isDefault && !scheme.archived && <RowAction action={setDefaultSchemeAction} fields={{ schemeId: scheme.id }} label="Make default" ariaLabel={`Make ${scheme.name} the default`} />}
                      {!scheme.isDefault && (
                        <RowAction action={archiveSchemeAction} fields={{ schemeId: scheme.id, archived: String(!scheme.archived) }} label={scheme.archived ? "Restore" : "Archive"} ariaLabel={`${scheme.archived ? "Restore" : "Archive"} ${scheme.name}`} />
                      )}
                    </div>
                  }
                />
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Grades in {scheme.name}</caption>
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="px-5 py-2 text-left font-semibold text-slate-700">
                        Grade
                      </th>
                      <th scope="col" className="px-5 py-2 text-left font-semibold text-slate-700">
                        Percentage
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scheme.bands.map((b, i) => {
                      const upper = i === 0 ? "100" : `below ${bpToPercent(scheme.bands[i - 1]!.minBp)}`;
                      return (
                        <tr key={b.label}>
                          <th scope="row" className="px-5 py-2 text-left font-medium text-slate-900">
                            {b.label}
                          </th>
                          <td className="px-5 py-2 tabular-nums text-slate-700">
                            {bpToPercent(b.minBp)}% to {upper}%
                            {b.description && <span className="text-slate-500"> · {b.description}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            ))
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Quick start" />
            <ActionForm action={createPresetSchemeAction} className="space-y-3 p-5">
              <p className="text-sm text-slate-600">CBSE-style eight grades (A1 91–100% down to E below 33%), pass mark 33%. You can change it afterwards.</p>
              <SubmitButton variant="secondary" pendingText="Creating…">
                Use CBSE-style scale
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="New scheme" description="Each grade starts at its minimum percentage. One grade must start at 0." />
            <ActionForm action={createGradingSchemeAction} className="space-y-4 p-5">
              <Field label="Scheme name" htmlFor="scheme-name">
                <Input id="scheme-name" name="name" required maxLength={60} />
              </Field>
              <Field label="Pass mark (%)" htmlFor="scheme-pass">
                <Input id="scheme-pass" name="passPercent" required inputMode="decimal" placeholder="33" />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-700">Grades (leave unused rows empty)</legend>
                {Array.from({ length: BAND_ROWS }, (_, i) => (
                  <div key={i} className="flex gap-2">
                    <label className="sr-only" htmlFor={`band-label-${i}`}>
                      Grade {i + 1} name
                    </label>
                    <Input id={`band-label-${i}`} name="bandLabel" maxLength={10} placeholder={i === 0 ? "A" : ""} className="w-24" />
                    <label className="sr-only" htmlFor={`band-min-${i}`}>
                      Grade {i + 1} minimum percentage
                    </label>
                    <Input id={`band-min-${i}`} name="bandMin" inputMode="decimal" placeholder={i === 0 ? "90" : ""} className="w-28" />
                  </div>
                ))}
              </fieldset>
              <SubmitButton pendingText="Creating…">Create scheme</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
