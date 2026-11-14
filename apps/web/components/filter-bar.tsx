import Link from "next/link";
import { Button, Input, Select } from "./ui";

/**
 * Search and filters as a plain GET form: the state lives in the URL, it works without
 * JavaScript, and Enter submits. Changing a filter always returns to page 1.
 */
export interface FilterSelect {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}

export interface FilterDate {
  name: string;
  label: string;
  value: string;
}

export function FilterBar({
  basePath,
  search,
  searchLabel,
  selects = [],
  dates = [],
}: {
  basePath: string;
  search: string;
  searchLabel: string;
  selects?: FilterSelect[];
  dates?: FilterDate[];
}) {
  const active = search !== "" || selects.some((s) => s.value !== "") || dates.some((d) => d.value !== "");
  return (
    <form method="get" action={basePath} role="search" className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4">
      <div className="min-w-48 flex-1">
        <label htmlFor="filter-q" className="mb-1.5 block text-sm font-medium text-slate-700">
          {searchLabel}
        </label>
        <Input id="filter-q" name="q" type="search" defaultValue={search} maxLength={100} autoComplete="off" />
      </div>
      {selects.map((s) => (
        <div key={s.name} className="w-full sm:w-44">
          <label htmlFor={`filter-${s.name}`} className="mb-1.5 block text-sm font-medium text-slate-700">
            {s.label}
          </label>
          <Select id={`filter-${s.name}`} name={s.name} defaultValue={s.value}>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ))}
      {dates.map((d) => (
        <div key={d.name} className="w-full sm:w-44">
          <label htmlFor={`filter-${d.name}`} className="mb-1.5 block text-sm font-medium text-slate-700">
            {d.label}
          </label>
          <Input id={`filter-${d.name}`} name={d.name} type="date" defaultValue={d.value} />
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="secondary" type="submit">
          Apply
        </Button>
        {active && (
          <Link href={basePath} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-brand-600 hover:bg-slate-50">
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
