import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentAcademicYear, listClasses, listGradableExams, listOfflineAssessments, listSections, listSubjects, type GradableExamRow, type OfflineRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { createOfflineAction, startGradingAction } from "./actions";
import { OFFLINE_STATUS } from "./shared";

export const metadata: Metadata = { title: "Results" };

const STATE: Record<GradableExamRow["state"], { label: string; tone: "slate" | "blue" | "amber" | "green" | "red" }> = {
  open: { label: "Still open", tone: "slate" },
  ready: { label: "Ready to grade", tone: "amber" },
  grading: { label: "Grading", tone: "blue" },
  released: { label: "Released", tone: "green" },
  cancelled: { label: "Cancelled", tone: "red" },
};

export default async function ResultsPage() {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const isAdmin = s.roles.includes("school_admin");
  const [exams, offline] = await Promise.all([listGradableExams(db, s.ctx, schoolId), listOfflineAssessments(db, s.ctx, schoolId)]);
  const year = isAdmin ? await getCurrentAcademicYear(db, s.ctx, schoolId) : null;
  const [subjects, classes, sections] = isAdmin && year ? await Promise.all([listSubjects(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId), listSections(db, s.ctx, schoolId, year.id)]) : [[], [], []];
  const className = new Map(classes.map((c) => [c.id, c]));
  const sectionOptions = sections
    .map((x) => ({ id: x.id, label: `${className.get(x.classId)?.name ?? ""} ${x.name}`, order: className.get(x.classId)?.sortOrder ?? 0 }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const examColumns: Column<GradableExamRow>[] = [
    {
      key: "title",
      header: "Exam",
      primary: true,
      cell: (r) =>
        r.state === "grading" || r.state === "released" ? (
          <Link href={`/school/results/exams/${r.examId}`} className="text-brand-700 hover:underline">
            {r.title}
          </Link>
        ) : (
          r.title
        ),
    },
    { key: "subject", header: "Subject", cell: (r) => r.subjectName },
    { key: "closes", header: "Closed", secondary: true, cell: (r) => formatDateTime(r.closesAt, s.timeZone) },
    { key: "state", header: "State", cell: (r) => <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge> },
    { key: "mark", header: "Written answers to mark", cell: (r) => (r.state === "grading" ? String(r.toMark) : "—") },
    {
      key: "go",
      header: "",
      cell: (r) =>
        r.state === "ready" ? (
          <ActionForm action={startGradingAction} inline keepValues>
            <input type="hidden" name="examId" value={r.examId} />
            <SubmitButton variant="secondary" pendingText="Starting…" aria-label={`Start grading ${r.title}`}>
              Start grading
            </SubmitButton>
          </ActionForm>
        ) : null,
    },
  ];
  const offlineColumns: Column<OfflineRow>[] = [
    {
      key: "title",
      header: "Assessment",
      primary: true,
      cell: (r) => (
        <Link href={`/school/results/offline/${r.id}`} className="text-brand-700 hover:underline">
          {r.title}
        </Link>
      ),
    },
    { key: "subject", header: "Subject", cell: (r) => `${r.subjectName}${r.heldOn ? ` · ${r.heldOn}` : ""}` },
    { key: "max", header: "Out of", secondary: true, cell: (r) => String(r.maxX100 / 100) },
    { key: "entered", header: "Entered", cell: (r) => `${r.entered} of ${r.students}` },
    { key: "status", header: "Status", cell: (r) => <Badge tone={OFFLINE_STATUS[r.status]!.tone}>{OFFLINE_STATUS[r.status]!.label}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Results" description="Grade online exams, enter paper exam marks, and release results. Students and parents see nothing until results are released." />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Online exams" description="Grading starts after an exam closes. Single-choice and true/false questions are scored automatically; written answers are marked here." />
          <DataTable caption="Online exams" columns={examColumns} rows={exams} rowKey={(r) => r.examId} empty={{ title: "No exams to grade", body: "Published exams of your subjects appear here." }} />
        </Card>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Paper exams (offline)" description="Marks entered by the subject's teacher of each section, locked and released by an administrator." />
            <DataTable caption="Offline assessments" columns={offlineColumns} rows={offline} rowKey={(r) => r.id} empty={{ title: "No offline assessments", body: isAdmin ? "Add one to record marks of a paper exam." : "Your administrator adds paper exams here." }} />
          </Card>
          {isAdmin && (
            <Card>
              <CardHeader title="New paper exam" description={year ? `For ${year.name}.` : "Set a current academic year first."} />
              {year && (
                <ActionForm action={createOfflineAction} className="space-y-4 p-5">
                  <Field label="Subject" htmlFor="off-subject">
                    <Select id="off-subject" name="subjectId" required defaultValue="">
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
                  <Field label="Title" htmlFor="off-title">
                    <Input id="off-title" name="title" required maxLength={150} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Date (optional)" htmlFor="off-date">
                      <Input id="off-date" name="heldOn" type="date" />
                    </Field>
                    <Field label="Maximum marks" htmlFor="off-max">
                      <Input id="off-max" name="maxMarks" inputMode="decimal" required defaultValue="100" />
                    </Field>
                  </div>
                  <fieldset className="space-y-1">
                    <legend className="mb-1 text-sm font-medium text-slate-700">Sections</legend>
                    {sectionOptions.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="sectionId" value={o.id} />
                        {o.label}
                      </label>
                    ))}
                  </fieldset>
                  <SubmitButton pendingText="Creating…">Create</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
        </div>
        {sectionOptions.length > 0 && (
          <Card>
            <CardHeader title="Class overview" description="Released results of a section: each student's percentage per subject." />
            <ul className="flex flex-wrap gap-2 p-5">
              {sectionOptions.map((o) => (
                <li key={o.id}>
                  <Link href={`/school/results/sections/${o.id}`} className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
                    {o.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
