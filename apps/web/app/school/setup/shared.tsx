import Link from "next/link";
import type { AcademicYear } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, cx } from "@/components/ui";
import type { FormState } from "@/lib/forms";

/** Small building blocks shared by the setup pages. */

export const yearStatusBadge = (status: AcademicYear["status"]) => (
  <Badge tone={status === "current" ? "green" : status === "closed" ? "slate" : "amber"}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>
);

/** Picks the year shown on a page: ?year= if valid, else the current year, else the newest. */
export function chooseYear(years: AcademicYear[], requested: string | string[] | undefined): AcademicYear | undefined {
  const id = typeof requested === "string" ? requested : undefined;
  return years.find((y) => y.id === id) ?? years.find((y) => y.status === "current") ?? years[0];
}

export function YearPicker({ years, selected, basePath }: { years: AcademicYear[]; selected: AcademicYear; basePath: string }) {
  return (
    <nav aria-label="Academic year" className="flex flex-wrap gap-2">
      {years.map((y) => (
        <Link
          key={y.id}
          href={`${basePath}?year=${y.id}`}
          aria-current={y.id === selected.id ? "true" : undefined}
          className={cx(
            "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-inset",
            y.id === selected.id ? "bg-brand-50 text-brand-700 ring-brand-600" : "text-slate-700 ring-slate-300 hover:bg-slate-50",
          )}
        >
          {y.name} {yearStatusBadge(y.status)}
        </Link>
      ))}
    </nav>
  );
}

/** A one-button form for a row action whose refusal must be shown (archive, delete, make default…). */
export function RowAction({
  action,
  fields,
  label,
  variant = "secondary",
  ariaLabel,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  fields: Record<string, string>;
  label: string;
  variant?: "secondary" | "danger" | "primary" | "ghost";
  ariaLabel?: string;
}) {
  return (
    <ActionForm action={action} inline keepValues>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton variant={variant} aria-label={ariaLabel} className="min-h-9 px-3 py-1.5 text-xs">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

export function ClosedYearNotice({ year }: { year: AcademicYear }) {
  if (year.status !== "closed") return null;
  return (
    <p role="status" className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
      {year.name} is closed, so its setup is read-only. Reopen it on the Academic years page to make changes.
    </p>
  );
}
