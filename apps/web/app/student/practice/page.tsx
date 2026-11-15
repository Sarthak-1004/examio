import type { Metadata } from "next";
import Link from "next/link";
import { AppError, listMyPractice } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { PracticeList } from "@/components/practice";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { startPracticeAction } from "./actions";

export const metadata: Metadata = { title: "Practice" };

export default async function MyPracticePage() {
  const s = await requireSchoolRole("student");
  const rows = await listMyPractice(db, s.ctx, s.ctx.schoolId).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return [];
    throw e;
  });
  return (
    <>
      <PageHeader
        title="Practice"
        description="Practice sets from your teachers. Practice does not count towards your results."
        action={
          <Link href="/student/progress" className="text-sm font-medium text-brand-700 hover:underline">
            My progress →
          </Link>
        }
      />
      <Card>
        <PracticeList
          rows={rows}
          attemptHref={(id) => `/student/practice/attempts/${id}`}
          empty="Your teachers have not assigned any practice to your class yet."
          action={(r) => {
            const canStart = r.inProgressAttemptId !== null || (r.open && (r.attemptLimit === null || r.attemptsUsed < r.attemptLimit));
            if (!canStart) return null;
            return (
              <ActionForm action={startPracticeAction} inline keepValues>
                <input type="hidden" name="setId" value={r.setId} />
                <SubmitButton pendingText="Opening…" aria-label={`${r.inProgressAttemptId ? "Continue" : "Start"} ${r.title}`}>
                  {r.inProgressAttemptId ? "Continue" : r.attemptsUsed > 0 ? "Try again" : "Start"}
                </SubmitButton>
              </ActionForm>
            );
          }}
        />
      </Card>
    </>
  );
}
