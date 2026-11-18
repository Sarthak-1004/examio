import type { Metadata } from "next";
import Link from "next/link";
import { listAuthorableSubjects, listExams, type ExamRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { createExamAction } from "./actions";
import { EXAM_STATUS, ExamFields } from "./exam-fields";

export const metadata: Metadata = { title: "Exams" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function ExamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const sp = await searchParams;
  const subjects = await listAuthorableSubjects(db, s.ctx, s.ctx.schoolId);
  const status = ["draft", "pending_approval", "published", "cancelled"].includes(one(sp.status)) ? one(sp.status) : undefined;
  const search = one(sp.q).slice(0, 100);
  const rows = subjects.length ? await listExams(db, s.ctx, s.ctx.schoolId, { status, search }) : [];
  const columns: Column<ExamRow>[] = [
    {
      key: "title",
      header: "Exam",
      primary: true,
      cell: (r) => (
        <Link href={`/school/exams/${r.id}`} className="text-brand-700 hover:underline">
          {r.title}
        </Link>
      ),
    },
    { key: "subject", header: "Subject", cell: (r) => r.subjectName },
    { key: "when", header: "Opens", cell: (r) => (r.opensAt ? `${formatDateTime(r.opensAt, s.timeZone)} · ${r.durationMinutes} min` : "Not scheduled") },
    { key: "counts", header: "Questions · sections · submitted", secondary: true, cell: (r) => `${r.itemCount} · ${r.sectionCount} · ${r.submittedCount}` },
    { key: "status", header: "Status", cell: (r) => <Badge tone={EXAM_STATUS[r.status]!.tone}>{EXAM_STATUS[r.status]!.label}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Exams"
        description={s.roles.includes("school_admin") ? "Formal exams. Teachers submit them; you approve and publish." : "Formal exams for the subjects you teach. Submit them for approval; a school administrator publishes."}
      />
      {subjects.length === 0 ? (
        <Card>
          <EmptyState title="No subjects">You can create exams for subjects you teach. Ask your school administrator to assign you a subject.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <FilterBar
              basePath="/school/exams"
              search={search}
              searchLabel="Search titles"
              selects={[
                {
                  name: "status",
                  label: "Status",
                  value: status ?? "",
                  options: [{ value: "", label: "All" }, ...Object.entries(EXAM_STATUS).map(([value, v]) => ({ value, label: v.label }))],
                },
              ]}
            />
            <DataTable
              caption="Exams"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              empty={status || search ? { title: "No exams match", body: "Try different filters." } : { title: "No exams yet", body: "Create one, add questions and sections, then submit it for approval." }}
            />
          </Card>
          <Card>
            <CardHeader title="New exam" description="For the current academic year." />
            <ActionForm action={createExamAction} className="space-y-4 p-5">
              <Field label="Subject" htmlFor="subjectId">
                <Select id="subjectId" name="subjectId" required defaultValue="">
                  <option value="" disabled>
                    Choose a subject
                  </option>
                  {subjects.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <ExamFields />
              <SubmitButton pendingText="Creating…">Create</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
