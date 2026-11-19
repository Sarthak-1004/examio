import type { Metadata } from "next";
import Link from "next/link";
import { listHrNames, listHrStaff, type HrListRow, type HrStaffRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { archiveNameAction, createNameAction } from "./actions";
import { EMPLOYMENT_TYPE_LABEL } from "./labels";

export const metadata: Metadata = { title: "HR" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function NameList({ list, title, rows }: { list: "department" | "designation"; title: string; rows: HrListRow[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2">
              <span className={r.archived ? "text-slate-500" : "text-slate-800"}>
                {r.name} <span className="text-slate-500">· {r.staff} staff</span> {r.archived && <Badge>Archived</Badge>}
              </span>
              <ActionForm action={archiveNameAction} inline>
                <input type="hidden" name="list" value={list} />
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="archived" value={r.archived ? "0" : "1"} />
                <SubmitButton variant="ghost" pendingText="Saving…" aria-label={`${r.archived ? "Restore" : "Archive"} ${r.name}`}>
                  {r.archived ? "Restore" : "Archive"}
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={createNameAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 p-5">
        <input type="hidden" name="list" value={list} />
        <Field label={`New ${list}`} htmlFor={`new-${list}`} className="min-w-40 flex-1">
          <Input id={`new-${list}`} name="name" required maxLength={80} />
        </Field>
        <SubmitButton variant="secondary" pendingText="Adding…">{`Add ${list}`}</SubmitButton>
      </ActionForm>
    </Card>
  );
}

export default async function HrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const search = one(sp.q).slice(0, 100);
  const departmentId = one(sp.department);
  const employmentType = one(sp.type);
  const status = one(sp.status) === "left" || one(sp.status) === "all" ? one(sp.status) : "";
  const [staff, departments, designations] = await Promise.all([
    listHrStaff(db, s.ctx, schoolId, { search, departmentId, employmentType, status }),
    listHrNames(db, s.ctx, schoolId, "department"),
    listHrNames(db, s.ctx, schoolId, "designation"),
  ]);
  const columns: Column<HrStaffRow>[] = [
    {
      key: "name",
      header: "Staff member",
      primary: true,
      cell: (r) => (
        <Link href={`/school/hr/staff/${r.staffId}`} className="text-brand-700 hover:underline">
          {`${r.name} (${r.employeeNo})`}
        </Link>
      ),
    },
    { key: "designation", header: "Designation", cell: (r) => r.designation ?? "—" },
    { key: "department", header: "Department", secondary: true, cell: (r) => r.department ?? "—" },
    { key: "type", header: "Type", cell: (r) => (r.employmentType ? EMPLOYMENT_TYPE_LABEL[r.employmentType] : <Badge tone="amber">Not recorded</Badge>) },
    { key: "joined", header: "Joined", secondary: true, cell: (r) => r.joinedOn ?? "—" },
    { key: "pay", header: "Payment details", secondary: true, cell: (r) => (r.hasPaymentDetails ? "Recorded" : <Badge tone="amber">Missing</Badge>) },
  ];
  const filtered = search || departmentId || employmentType || status;

  return (
    <>
      <PageHeader
        title="HR"
        description="Employment records, history, payment details and HR documents. Visible to school administrators only."
        action={
          <span className="flex flex-wrap gap-4 text-sm font-medium">
            <Link href="/school/hr/leave" className="text-brand-700 hover:underline">
              Staff leave
            </Link>
            <Link href="/school/hr/attendance" className="text-brand-700 hover:underline">
              Staff register
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <FilterBar
            basePath="/school/hr"
            search={search}
            searchLabel="Search name or employee number"
            selects={[
              { name: "department", label: "Department", value: departmentId, options: [{ value: "", label: "All" }, ...departments.map((d) => ({ value: d.id, label: d.name }))] },
              { name: "type", label: "Type", value: employmentType, options: [{ value: "", label: "All" }, ...Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))] },
              { name: "status", label: "Status", value: status, options: [{ value: "", label: "Current staff" }, { value: "left", label: "Left" }, { value: "all", label: "All" }] },
            ]}
          />
          <DataTable caption="Staff HR records" columns={columns} rows={staff} rowKey={(r) => r.staffId} empty={{ title: filtered ? "No matching staff" : "No staff yet", body: filtered ? "Try different filters." : "Add staff on the Staff page first." }} />
        </Card>
        <div className="min-w-0 space-y-6">
          <NameList list="department" title="Departments" rows={departments} />
          <NameList list="designation" title="Designations" rows={designations} />
        </div>
      </div>
    </>
  );
}
