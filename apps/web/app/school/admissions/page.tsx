import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listApplications, listClasses, type ApplicationRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { createApplicationAction } from "./actions";
import { ADMISSION_STATUS, ApplicationFields } from "./application-fields";

export const metadata: Metadata = { title: "Admissions" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function AdmissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const [allYears, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
  const years = allYears.filter((y) => y.status !== "closed");
  const yearId = allYears.some((y) => y.id === one(sp.year)) ? one(sp.year) : undefined;
  const status = one(sp.status) in ADMISSION_STATUS ? one(sp.status) : undefined;
  const search = one(sp.q).slice(0, 100);
  const { rows, counts } = await listApplications(db, s.ctx, schoolId, { yearId, status, search });
  const columns: Column<ApplicationRow>[] = [
    {
      key: "name",
      header: "Applicant",
      primary: true,
      cell: (r) => (
        <Link href={`/school/admissions/${r.id}`} className="text-brand-700 hover:underline">
          {r.applicantName}
        </Link>
      ),
    },
    { key: "ref", header: "Reference", cell: (r) => r.referenceNo },
    { key: "class", header: "Class", cell: (r) => `${r.className} · ${r.yearName}` },
    { key: "docs", header: "Documents", secondary: true, cell: (r) => `${r.documentsDone} of ${r.documentsRequired} required` },
    { key: "status", header: "Status", cell: (r) => <Badge tone={ADMISSION_STATUS[r.status]!.tone}>{ADMISSION_STATUS[r.status]!.label}</Badge> },
    { key: "updated", header: "Updated", secondary: true, cell: (r) => formatDateTime(r.updatedAt, s.timeZone) },
  ];

  return (
    <>
      <PageHeader
        title="Admissions"
        description="Enquiries and applications recorded by the school office, from first contact to enrollment."
        action={
          <a href={`/school/admissions/export?${new URLSearchParams({ ...(status ? { status } : {}), ...(yearId ? { year: yearId } : {}) }).toString()}`} className="text-sm font-medium text-brand-700 hover:underline">
            Download (CSV)
          </a>
        }
      />
      <ul className="mb-6 flex flex-wrap gap-2" aria-label="Applications by status">
        {Object.entries(ADMISSION_STATUS).map(([k, v]) => (
          <li key={k}>
            <Link
              href={`/school/admissions?status=${k}${yearId ? `&year=${yearId}` : ""}`}
              aria-current={status === k ? "page" : undefined}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-3 text-sm ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
            >
              {v.label} <span className="font-semibold tabular-nums">{counts[k as keyof typeof counts] ?? 0}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <FilterBar
            basePath="/school/admissions"
            search={search}
            searchLabel="Search name, reference or guardian"
            selects={[
              { name: "status", label: "Status", value: status ?? "", options: [{ value: "", label: "All" }, ...Object.entries(ADMISSION_STATUS).map(([value, v]) => ({ value, label: v.label }))] },
              { name: "year", label: "Year", value: yearId ?? "", options: [{ value: "", label: "All" }, ...allYears.map((y) => ({ value: y.id, label: y.name }))] },
            ]}
          />
          <DataTable caption="Applications" columns={columns} rows={rows} rowKey={(r) => r.id} empty={{ title: "No applications", body: status || search || yearId ? "Try different filters." : "Record the first enquiry." }} />
        </Card>
        <Card>
          <CardHeader title="New enquiry" />
          {years.length === 0 ? (
            <p className="p-5 text-sm text-slate-600">Add an academic year that is not closed first.</p>
          ) : (
            <ActionForm action={createApplicationAction} className="space-y-4 p-5">
              <ApplicationFields years={years} classes={classes} />
              <Field label="Stage" htmlFor="stage">
                <Select id="stage" name="stage" defaultValue="enquiry">
                  <option value="enquiry">Enquiry</option>
                  <option value="applied">Application received</option>
                </Select>
              </Field>
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" name="confirmNotDuplicate" className="mt-1" />
                This is a different child from any similar application (tick only if asked)
              </label>
              <SubmitButton pendingText="Saving…">Record</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
