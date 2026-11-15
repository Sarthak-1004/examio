import type { Metadata } from "next";
import Link from "next/link";
import { formatMarks, getCurriculum, listAuthorableSubjects, parsePageRequest, searchQuestions, type QuestionListRow } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { Badge, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { TYPE_LABEL } from "./question-fields";

export const metadata: Metadata = { title: "Question bank" };

const STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "slate" }> = {
  draft: { label: "Draft", tone: "amber" },
  in_review: { label: "In review", tone: "blue" },
  published: { label: "Published", tone: "green" },
  archived: { label: "Archived", tone: "slate" },
};

const columns: Column<QuestionListRow>[] = [
  {
    key: "stem",
    header: "Question",
    primary: true,
    cell: (r) => (
      <Link href={`/school/questions/${r.id}`} className="text-brand-700 hover:underline">
        {r.stem.length > 120 ? `${r.stem.slice(0, 117)}…` : r.stem}
      </Link>
    ),
  },
  { key: "where", header: "Subject / topic", cell: (r) => `${r.subjectName}${r.topicPath ? ` · ${r.topicPath}` : ""}` },
  { key: "type", header: "Type", secondary: true, cell: (r) => `${TYPE_LABEL[r.type]} · ${r.difficulty} · ${formatMarks(r.marksX100)} mark(s)` },
  { key: "status", header: "Status", cell: (r) => <Badge tone={STATUS[r.status]!.tone}>{STATUS[r.status]!.label}{r.status !== "published" && r.hasPublished ? " (v. published)" : ""}</Badge> },
];

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function QuestionBankPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const req = parsePageRequest(sp);
  const subjects = await listAuthorableSubjects(db, s.ctx, schoolId);
  const subjectId = subjects.some((x) => x.id === one(sp.subject)) ? one(sp.subject) : undefined;
  const chapters = subjectId ? await getCurriculum(db, s.ctx, schoolId, subjectId) : [];
  const topicOptions = chapters.flatMap((c) => [{ value: c.id, label: c.name }, ...c.topics.map((t) => ({ value: t.id, label: `${c.name} › ${t.name}` }))]);
  const topicId = topicOptions.some((o) => o.value === one(sp.topic)) ? one(sp.topic) : undefined;
  const f = { subjectId, topicId, type: one(sp.type) || undefined, difficulty: one(sp.difficulty) || undefined, status: one(sp.status) || undefined };
  const page = subjects.length ? await searchQuestions(db, s.ctx, schoolId, { ...req, ...f }) : null;
  const params = { q: req.search || undefined, subject: subjectId, topic: topicId, type: f.type, difficulty: f.difficulty, status: f.status };
  const filtered = Object.values(params).some(Boolean);

  return (
    <>
      <PageHeader
        title="Question bank"
        description={s.roles.includes("school_admin") ? "Questions for every subject. Teachers submit; you publish." : "Questions for the subjects you teach. Submit them for review; a school administrator publishes."}
        action={
          subjects.length ? (
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={`/school/questions/new${subjectId ? `?subject=${subjectId}` : ""}`}>New question</ButtonLink>
              <ButtonLink href={`/school/questions/curriculum${subjectId ? `?subject=${subjectId}` : ""}`} variant="secondary">
                Chapters and topics
              </ButtonLink>
              <ButtonLink href="/school/questions/import" variant="secondary">
                Import
              </ButtonLink>
            </div>
          ) : undefined
        }
      />
      {!page ? (
        <Card>
          <EmptyState title="No subjects">You can write questions for subjects you teach. Ask your school administrator to assign you a subject.</EmptyState>
        </Card>
      ) : (
        <Card>
          <FilterBar
            basePath="/school/questions"
            search={req.search}
            searchLabel="Search question text"
            selects={[
              { name: "subject", label: "Subject", value: subjectId ?? "", options: [{ value: "", label: "All" }, ...subjects.map((x) => ({ value: x.id, label: x.name }))] },
              ...(subjectId ? [{ name: "topic", label: "Chapter / topic", value: topicId ?? "", options: [{ value: "", label: "All" }, ...topicOptions] }] : []),
              { name: "type", label: "Type", value: f.type ?? "", options: [{ value: "", label: "Any" }, { value: "single_choice", label: "Single choice" }, { value: "true_false", label: "True / false" }, { value: "descriptive", label: "Descriptive" }] },
              { name: "difficulty", label: "Difficulty", value: f.difficulty ?? "", options: [{ value: "", label: "Any" }, { value: "easy", label: "Easy" }, { value: "medium", label: "Medium" }, { value: "hard", label: "Hard" }] },
              { name: "status", label: "Status", value: f.status ?? "", options: [{ value: "", label: "Not archived" }, { value: "draft", label: "Draft" }, { value: "in_review", label: "In review" }, { value: "published", label: "Published" }, { value: "archived", label: "Archived" }] },
            ]}
          />
          <DataTable
            caption="Questions"
            columns={columns}
            rows={page.rows}
            rowKey={(r) => r.id}
            empty={filtered ? { title: "No questions match", body: "Try a different search or clear the filters." } : { title: "No questions yet", body: "Write the first question, or import a list." }}
          />
          <Pagination basePath="/school/questions" params={params} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="questions" />
        </Card>
      )}
    </>
  );
}
