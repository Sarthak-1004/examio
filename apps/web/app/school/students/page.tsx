import type { Metadata } from "next";
import Link from "next/link";
import { listAcademicYears, listClasses, listSections, listStudentMembersWithoutProfile, parsePageRequest, searchStudents, type StudentListRow } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { SubmitButton } from "@/components/submit-button";
import { Badge, ButtonLink, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { chooseYear } from "../setup/shared";
import { addStudentProfileAction, admitStudentAction } from "./actions";
import { sectionOptions } from "./shared";

export const metadata: Metadata = { title: "Students" };

const columns: Column<StudentListRow>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    cell: (r) => (
      <Link href={`/school/students/${r.id}`} className="text-brand-700 hover:underline">
        {r.displayName}
      </Link>
    ),
  },
  { key: "adm", header: "Admission no.", cell: (r) => <span className="font-mono text-xs">{r.admissionNo}</span> },
  { key: "class", header: "Class", cell: (r) => r.sectionLabel ?? <span className="text-slate-500">Not enrolled</span> },
  { key: "roll", header: "Roll", secondary: true, cell: (r) => (r.rollNo === null ? "—" : r.rollNo) },
  { key: "status", header: "Status", cell: (r) => (r.status === "active" ? <Badge tone="green">Active</Badge> : <Badge>Left</Badge>) },
];

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function StudentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const params = await searchParams;
  const req = parsePageRequest(params);
  const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
  const year = chooseYear(years, params.year);
  const sections = year ? await listSections(db, s.ctx, schoolId, year.id) : [];
  const options = sectionOptions(sections, classes);
  const status = params.status === "active" || params.status === "left" ? params.status : params.status === "any" ? undefined : "active";
  const sectionId = options.some((o) => o.id === one(params.section)) ? one(params.section) : undefined;
  const enrolled = params.section === "none" ? ("none" as const) : undefined;
  const [page, pending] = await Promise.all([
    searchStudents(db, s.ctx, schoolId, { ...req, status, yearId: year?.id, sectionId, enrolled }),
    listStudentMembersWithoutProfile(db, s.ctx, schoolId),
  ]);
  const filtered = req.search !== "" || !!sectionId || !!enrolled || status !== "active";
  const query = {
    q: req.search || undefined,
    year: year?.id,
    section: sectionId ?? (enrolled ? "none" : undefined),
    status: status === "active" ? undefined : (status ?? "any"),
  };
  const exportQuery = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1])).toString();
  const canEnroll = year && year.status !== "closed";

  return (
    <>
      <PageHeader
        title="Students"
        description={year ? `Classes shown for ${year.name}.` : "Create an academic year under School setup to enroll students in classes."}
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/school/students/reports" variant="secondary">
              Class strength
            </ButtonLink>
            <ButtonLink href="/school/students/promote" variant="secondary">
              Promote
            </ButtonLink>
            <ButtonLink href="/school/students/import" variant="secondary">
              Import
            </ButtonLink>
            <ButtonLink href={`/school/students/export${exportQuery ? `?${exportQuery}` : ""}`} variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {pending.length > 0 && (
            <Card>
              <CardHeader title="Members without student details" description="They joined your school as students (for example by invitation). Add their admission number to finish." />
              <ul className="divide-y divide-slate-100">
                {pending.map((m) => (
                  <li key={m.userId} className="space-y-2 px-5 py-3">
                    <p className="text-sm font-medium text-slate-900">
                      {m.fullName} <span className="text-slate-500">{m.username ?? m.email}</span>
                    </p>
                    <ActionForm action={addStudentProfileAction} inline>
                      <input type="hidden" name="userId" value={m.userId} />
                      <input type="hidden" name="displayName" value={m.fullName} />
                      <label className="sr-only" htmlFor={`adm-${m.userId}`}>
                        Admission number for {m.fullName}
                      </label>
                      <Input id={`adm-${m.userId}`} name="admissionNo" required maxLength={30} placeholder="Admission no." className="w-40" />
                      <SubmitButton variant="secondary" pendingText="Adding…">
                        Add details
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <FilterBar
              basePath="/school/students"
              search={req.search}
              searchLabel="Search name, admission number or sign-in name"
              selects={[
                ...(years.length > 1 ? [{ name: "year", label: "Year", value: year?.id ?? "", options: years.map((y) => ({ value: y.id, label: y.name })) }] : []),
                { name: "section", label: "Class", value: sectionId ?? (enrolled ? "none" : ""), options: [{ value: "", label: "All" }, { value: "none", label: "Not enrolled" }, ...options.map((o) => ({ value: o.id, label: o.label }))] },
                { name: "status", label: "Status", value: status === "active" ? "" : (status ?? "any"), options: [{ value: "", label: "Active" }, { value: "left", label: "Left" }, { value: "any", label: "Any" }] },
              ]}
            />
            <DataTable
              caption="Students"
              columns={columns}
              rows={page.rows}
              rowKey={(r) => r.id}
              empty={filtered ? { title: "No students match", body: "Try a different search or clear the filters." } : { title: "No students yet", body: "Admit your first student with the form, or import a class list." }}
            />
            <Pagination basePath="/school/students" params={query} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="students" />
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Admit a student" description="Creates the student's account. Students sign in with a sign-in name made from your school code and the admission number." />
            <ActionForm action={admitStudentAction} className="space-y-4 p-5">
              <Field label="Full name" htmlFor="ad-name">
                <Input id="ad-name" name="fullName" required minLength={2} maxLength={120} />
              </Field>
              <Field label="Admission number" htmlFor="ad-no" hint="Unique in your school; cannot be changed later.">
                <Input id="ad-no" name="admissionNo" required maxLength={30} />
              </Field>
              <Field label="Admission date" htmlFor="ad-on" hint="Leave empty for today.">
                <Input id="ad-on" name="admittedOn" type="date" />
              </Field>
              <Field label="Date of birth" htmlFor="ad-dob">
                <Input id="ad-dob" name="dateOfBirth" type="date" />
              </Field>
              {canEnroll && options.length > 0 && (
                <>
                  <Field label="Class and section" htmlFor="ad-section" hint={`Enrolls the student in ${year.name}.`}>
                    <Select id="ad-section" name="sectionId" defaultValue="">
                      <option value="">Not yet</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Roll number" htmlFor="ad-roll" hint="Optional.">
                    <Input id="ad-roll" name="rollNo" inputMode="numeric" pattern="[0-9]*" maxLength={4} />
                  </Field>
                </>
              )}
              <SubmitButton pendingText="Admitting…">Admit student</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
