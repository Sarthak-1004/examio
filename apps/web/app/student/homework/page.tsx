import type { Metadata } from "next";
import { AppError, listMyHomework } from "@examio/core";
import { HomeworkList } from "@/components/homework-list";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Homework" };

export default async function MyHomeworkPage() {
  const s = await requireSchoolRole("student");
  const rows = await listMyHomework(db, s.ctx, s.ctx.schoolId).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return [];
    throw e;
  });
  return (
    <>
      <PageHeader title="Homework" description="Homework for your class. Things to do come first." />
      <Card>
        <HomeworkList rows={rows} hrefFor={(id) => `/student/homework/${id}`} />
      </Card>
    </>
  );
}
