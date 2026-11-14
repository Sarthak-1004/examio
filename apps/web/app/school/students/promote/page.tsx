import type { Metadata } from "next";
import Link from "next/link";
import { AppError, listAcademicYears, listClasses, listSections, previewPromotion, type PromotionPreview } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, PageHeader, Select } from "@/components/ui";
import { promoteAction } from "../actions";
import { sectionOptions } from "../shared";

export const metadata: Metadata = { title: "Promote students" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PromotePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
  const groups = await Promise.all(years.map(async (y) => ({ year: y, options: sectionOptions(await listSections(db, s.ctx, schoolId, y.id), classes) })));
  const from = one(sp.from);
  const to = one(sp.to);
  let preview: PromotionPreview | null = null;
  let error: string | null = null;
  if (from && to) {
    try {
      preview = await previewPromotion(db, s.ctx, schoolId, { fromSectionId: from, toSectionId: to === "graduate" ? null : to });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      error = e.message;
    }
  }
  const ready = preview?.rows.filter((r) => r.state === "ready") ?? [];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/students" className="text-brand-600 hover:text-brand-700">
          ← Students
        </Link>
      </p>
      <PageHeader
        title="Promote students"
        description="Move a section's students into a section of the next academic year, or mark a final class as graduated. Do this before closing the old year if you want its enrollments to end on its last day; earlier classes are never rewritten."
      />
      <Card>
        <CardHeader title="1. Choose sections" />
        <form method="get" className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="From section" htmlFor="pr-from">
            <Select id="pr-from" name="from" defaultValue={from} required>
              <option value="">Choose…</option>
              {groups.map((g) => (
                <optgroup key={g.year.id} label={g.year.name}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="To section" htmlFor="pr-to">
            <Select id="pr-to" name="to" defaultValue={to} required>
              <option value="">Choose…</option>
              <option value="graduate">Graduated (leaving school)</option>
              {groups
                .filter((g) => g.year.status !== "closed")
                .map((g) => (
                  <optgroup key={g.year.id} label={g.year.name}>
                    {g.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              Show students
            </Button>
          </div>
        </form>
      </Card>

      {error && (
        <div className="mt-6">
          <Alert>{error}</Alert>
        </div>
      )}

      {preview && (
        <Card className="mt-6">
          <CardHeader
            title="2. Review and confirm"
            description={preview.toLabel ? `${preview.fromLabel} (${preview.fromYearName}) → ${preview.toLabel} (${preview.toYearName}). Untick students who repeat the year.` : `${preview.fromLabel} (${preview.fromYearName}) → graduated. Their access ends and their record is kept.`}
          />
          {preview.rows.length === 0 ? (
            <EmptyState title="No students">This section has no current students.</EmptyState>
          ) : (
            <ActionForm action={promoteAction} className="space-y-4 p-5">
              <input type="hidden" name="fromSectionId" value={from} />
              <input type="hidden" name="toSectionId" value={to} />
              <fieldset>
                <legend className="sr-only">Students to move</legend>
                <ul className="divide-y divide-slate-100">
                  {preview.rows.map((r) => (
                    <li key={r.studentId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <label className="flex min-h-11 items-center gap-3">
                        <input type="checkbox" name="studentIds" value={r.studentId} defaultChecked={r.state === "ready"} disabled={r.state !== "ready"} className="h-5 w-5 rounded border-slate-300" />
                        <span>
                          {r.rollNo !== null && <span className="tabular-nums text-slate-500">{r.rollNo}. </span>}
                          {r.displayName} <span className="font-mono text-xs text-slate-500">{r.admissionNo}</span>
                        </span>
                      </label>
                      {r.state === "already_enrolled" && <Badge>Already in {r.targetLabel}</Badge>}
                    </li>
                  ))}
                </ul>
              </fieldset>
              {preview.toLabel && (
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" name="keepRollNumbers" className="h-5 w-5 rounded border-slate-300" />
                  Keep the same roll numbers
                </label>
              )}
              {ready.length > 0 ? (
                <SubmitButton pendingText="Saving…">{preview.toLabel ? "Promote ticked students" : "Mark ticked students as graduated"}</SubmitButton>
              ) : (
                <p className="text-sm text-slate-600">Everyone here is already in the target year.</p>
              )}
            </ActionForm>
          )}
        </Card>
      )}
    </>
  );
}
