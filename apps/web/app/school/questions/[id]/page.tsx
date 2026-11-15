import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, formatMarks, getCurriculum, getQuestion, learnerView, type QuestionVersionDetail } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { RowAction } from "../../setup/shared";
import { questionStateAction, updateQuestionAction } from "../actions";
import { QuestionFields, TYPE_LABEL } from "../question-fields";

export const metadata: Metadata = { title: "Question" };

const STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "slate" }> = {
  draft: { label: "Draft", tone: "amber" },
  in_review: { label: "In review", tone: "blue" },
  published: { label: "Published", tone: "green" },
  archived: { label: "Archived", tone: "slate" },
};

/** What a student would see (the learner view: no key, no explanation). */
function StudentPreview({ v }: { v: QuestionVersionDetail }) {
  const lv = learnerView(v);
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4 text-sm">
      <p className="whitespace-pre-wrap text-slate-900">{lv.stem}</p>
      {lv.imageFileId && (v.imageStatus === "clean" ? <img src={`/files/${lv.imageFileId}`} alt="Question figure" className="max-h-64 rounded border border-slate-200" /> : <p className="text-xs text-slate-500">Image: virus check pending.</p>)}
      {lv.type === "single_choice" && (
        <ol className="space-y-1">
          {lv.options!.map((o) => (
            <li key={o.id} className="flex gap-2">
              <span className="font-semibold text-slate-500">{o.id.toUpperCase()}.</span>
              <span>{o.text}</span>
            </li>
          ))}
        </ol>
      )}
      {lv.type === "true_false" && <p className="text-slate-600">True / False</p>}
      {lv.type === "descriptive" && <p className="text-slate-600">Written answer</p>}
      <p className="text-xs text-slate-500">
        {formatMarks(lv.marksX100)} mark(s){lv.negativeMarksX100 ? `, −${formatMarks(lv.negativeMarksX100)} for a wrong answer` : ""}
      </p>
    </div>
  );
}

function AnswerKeyView({ v }: { v: QuestionVersionDetail }) {
  const key = v.answerKey as { correct?: string | boolean; modelAnswer?: string | null };
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-semibold">Answer: </span>
        {v.type === "single_choice" ? `${String(key.correct).toUpperCase()}. ${v.options?.find((o) => o.id === key.correct)?.text ?? ""}` : v.type === "true_false" ? (key.correct ? "True" : "False") : key.modelAnswer ? key.modelAnswer : "No model answer (graded by hand)."}
      </p>
      {v.explanation && (
        <p className="whitespace-pre-wrap text-slate-700">
          <span className="font-semibold">Explanation: </span>
          {v.explanation}
        </p>
      )}
    </div>
  );
}

export default async function QuestionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const { id } = await params;
  const sp = await searchParams;
  const q = await getQuestion(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const chapters = await getCurriculum(db, s.ctx, s.ctx.schoolId, q.subjectId);
  const latest = q.versions[0]!;
  const key = latest.answerKey as { correct?: string | boolean; modelAnswer?: string | null };

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/questions" className="text-brand-600 hover:text-brand-700">
          ← Question bank
        </Link>
      </p>
      <PageHeader
        title={`${TYPE_LABEL[latest.type]} · ${q.subjectName}`}
        description={`${q.topicPath ?? "No chapter"} · version ${q.currentRevision}${q.publishedRevision ? ` · version ${q.publishedRevision} published` : ""} · by ${q.authorName ?? "staff"}`}
        action={<Badge tone={STATUS[q.status]!.tone}>{STATUS[q.status]!.label}</Badge>}
      />
      {sp.saved === "1" && (
        <div className="mb-6">
          <Alert tone="green">Question saved.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Preview" description="As a student sees it: no answer and no explanation." />
            <div className="space-y-4 p-5">
              <StudentPreview v={latest} />
              <AnswerKeyView v={latest} />
            </div>
          </Card>
          {q.status !== "archived" && (
            <Card>
              <CardHeader title="Edit" description={latest.locked ? "This version is published and fixed: saving creates a new version." : "Changes are saved to this version."} />
              <ActionForm action={updateQuestionAction} keepValues className="space-y-4 p-5">
                <input type="hidden" name="questionId" value={q.id} />
                <QuestionFields
                  type={latest.type}
                  chapters={chapters}
                  d={{
                    stem: latest.stem,
                    options: latest.options,
                    correct: latest.type === "true_false" ? String(key.correct) : typeof key.correct === "string" ? key.correct : undefined,
                    modelAnswer: key.modelAnswer ?? null,
                    explanation: latest.explanation,
                    marks: formatMarks(latest.marksX100),
                    negativeMarks: formatMarks(latest.negativeMarksX100),
                    difficulty: latest.difficulty,
                    topicId: q.topicId,
                    imageFileId: latest.imageFileId,
                  }}
                />
                <SubmitButton pendingText="Saving…">{latest.locked ? "Save as new version" : "Save"}</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {q.versions.length > 1 && (
            <Card>
              <CardHeader title="Version history" description="Every version is kept; published versions never change." />
              <ul className="divide-y divide-slate-100">
                {q.versions.slice(1).map((v) => (
                  <li key={v.id} className="space-y-2 px-5 py-4 text-sm">
                    <p className="font-medium text-slate-900">
                      Version {v.revision} {v.revision === q.publishedRevision && <Badge tone="green">Published</Badge>} {v.locked && v.revision !== q.publishedRevision && <Badge>Earlier published</Badge>}
                      <span className="block text-xs font-normal text-slate-500">
                        {v.createdByName ?? "staff"}, {new Date(v.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                      </span>
                    </p>
                    <StudentPreview v={v} />
                    <AnswerKeyView v={v} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="Review" />
          <div className="flex flex-col items-start gap-3 p-5 text-sm">
            {q.status === "draft" && <RowAction action={questionStateAction} fields={{ questionId: q.id, op: "submit" }} label="Submit for review" />}
            {q.canPublish && (q.status === "draft" || q.status === "in_review") && <RowAction action={questionStateAction} fields={{ questionId: q.id, op: "publish" }} label={`Publish version ${q.currentRevision}`} variant="primary" />}
            {q.canPublish && q.status === "in_review" && <RowAction action={questionStateAction} fields={{ questionId: q.id, op: "sendBack" }} label="Send back to draft" variant="ghost" />}
            {q.canPublish && q.status !== "archived" && <RowAction action={questionStateAction} fields={{ questionId: q.id, op: "archive" }} label="Archive" variant="ghost" />}
            {q.canPublish && q.status === "archived" && <RowAction action={questionStateAction} fields={{ questionId: q.id, op: "restore" }} label="Restore" />}
            {!q.canPublish && <p className="text-slate-600">A school administrator publishes questions after review.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
