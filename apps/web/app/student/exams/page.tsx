import type { Metadata } from "next";
import { AppError, formatMarks, listMyExams, type FamilyExamRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { ExamList } from "@/components/exam-list";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { startExamAction } from "./actions";

export const metadata: Metadata = { title: "Exams" };

function startButton(r: FamilyExamRow) {
  const canStart = r.inProgressAttemptId !== null || (r.window === "open" && r.attemptsUsed < r.attemptsAllowed);
  if (!canStart) return null;
  return (
    <ActionForm action={startExamAction} inline keepValues>
      <input type="hidden" name="examId" value={r.examId} />
      <SubmitButton pendingText="Opening…" aria-label={`${r.inProgressAttemptId ? "Continue" : "Start"} ${r.title}`}>
        {r.inProgressAttemptId ? "Continue" : r.attemptsUsed > 0 ? "Start retake" : "Start"}
      </SubmitButton>
    </ActionForm>
  );
}

export default async function MyExamsPage() {
  const s = await requireSchoolRole("student");
  const rows = await listMyExams(db, s.ctx, s.ctx.schoolId).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return [];
    throw e;
  });
  return (
    <>
      <PageHeader title="Exams" description="Exams for your class. The timer starts when you press Start and does not stop if you close the page." />
      <Card>
        <ExamList rows={rows} timeZone={s.timeZone} action={startButton} empty="No exams for your class right now." detail={(r) => `${r.itemCount} question(s), ${formatMarks(r.totalMarksX100)} marks`} />
      </Card>
    </>
  );
}
