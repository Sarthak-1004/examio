import type { Metadata } from "next";
import Link from "next/link";
import { listAuthorableSubjects, listPracticeSets, type PracticeSetRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { createPracticeSetAction } from "./actions";
import { SET_STATUS } from "./settings-fields";

export const metadata: Metadata = { title: "Practice" };


const columns: Column<PracticeSetRow>[] = [
  {
    key: "title",
    header: "Practice set",
    primary: true,
    cell: (r) => (
      <Link href={`/school/practice/${r.id}`} className="text-brand-700 hover:underline">
        {r.title}
      </Link>
    ),
  },
  { key: "where", header: "Subject / topic", cell: (r) => `${r.subjectName}${r.topicPath ? ` · ${r.topicPath}` : ""}` },
  { key: "counts", header: "Questions · sections · submitted", secondary: true, cell: (r) => `${r.itemCount} · ${r.sectionCount} · ${r.submittedCount}` },
  { key: "status", header: "Status", cell: (r) => <Badge tone={SET_STATUS[r.status]!.tone}>{SET_STATUS[r.status]!.label}</Badge> },
];

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PracticeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const sp = await searchParams;
  const subjects = await listAuthorableSubjects(db, s.ctx, s.ctx.schoolId);
  const subjectId = subjects.some((x) => x.id === one(sp.subject)) ? one(sp.subject) : undefined;
  const status = ["draft", "published", "archived"].includes(one(sp.status)) ? one(sp.status) : undefined;
  const search = one(sp.q).slice(0, 100);
  const rows = subjects.length ? await listPracticeSets(db, s.ctx, s.ctx.schoolId, { subjectId, status, search }) : [];

  return (
    <>
      <PageHeader title="Practice" description="Practice sets built from published questions. Students practise as often as you allow; practice never counts towards results." />
      {subjects.length === 0 ? (
        <Card>
          <EmptyState title="No subjects">You can build practice for subjects you teach. Ask your school administrator to assign you a subject.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <FilterBar
              basePath="/school/practice"
              search={search}
              searchLabel="Search titles"
              selects={[
                { name: "subject", label: "Subject", value: subjectId ?? "", options: [{ value: "", label: "All" }, ...subjects.map((x) => ({ value: x.id, label: x.name }))] },
                { name: "status", label: "Status", value: status ?? "", options: [{ value: "", label: "Not archived" }, { value: "draft", label: "Draft" }, { value: "published", label: "Published" }, { value: "archived", label: "Archived" }] },
              ]}
            />
            <DataTable
              caption="Practice sets"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              empty={subjectId || status || search ? { title: "No practice sets match", body: "Try different filters." } : { title: "No practice sets yet", body: "Create one, add published questions, publish it and assign it to a section." }}
            />
          </Card>
          <Card>
            <CardHeader title="New practice set" />
            <ActionForm action={createPracticeSetAction} className="space-y-4 p-5">
              <Field label="Subject" htmlFor="subjectId">
                <Select id="subjectId" name="subjectId" required defaultValue={subjectId ?? ""}>
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
              <Field label="Title" htmlFor="title">
                <Input id="title" name="title" required maxLength={150} />
              </Field>
              <Field label="Show answers and score" htmlFor="feedback">
                <Select id="feedback" name="feedback" defaultValue="immediate">
                  <option value="immediate">Right after submitting</option>
                  <option value="after_close">After the practice closes</option>
                </Select>
              </Field>
              <Field label="Attempt limit" htmlFor="attemptLimit" hint="Leave empty for unlimited attempts.">
                <Input id="attemptLimit" name="attemptLimit" type="number" min={1} max={50} />
              </Field>
              <SubmitButton pendingText="Creating…">Create</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
