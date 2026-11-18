import type { Metadata } from "next";
import { AppError, getMyPracticeProgress } from "@examio/core";
import { PracticeProgressView } from "@/components/practice";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My progress" };

export default async function MyProgressPage() {
  const s = await requireSchoolRole("student");
  const p = await getMyPracticeProgress(db, s.ctx, s.ctx.schoolId).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return { topics: [], attempts: [] };
    throw e;
  });
  return (
    <>
      <PageHeader title="My progress" description="How you are doing in practice, by chapter and topic. Practice does not count towards your results." />
      <Card>
        <CardHeader title="Practice by topic" />
        <PracticeProgressView timeZone={s.timeZone} p={p} attemptHref={(id) => `/student/practice/attempts/${id}`} />
      </Card>
    </>
  );
}
