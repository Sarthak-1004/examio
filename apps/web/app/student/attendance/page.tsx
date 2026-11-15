import type { Metadata } from "next";
import { AppError, getMyAttendance } from "@examio/core";
import { AttendanceSummary } from "@/components/attendance-summary";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My attendance" };

export default async function MyAttendancePage() {
  const s = await requireSchoolRole("student");
  const a = await getMyAttendance(db, s.ctx, s.ctx.schoolId).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") return null;
    throw e;
  });
  return (
    <>
      <PageHeader title="My attendance" description="The last 30 days." />
      {a ? (
        <AttendanceSummary a={a} />
      ) : (
        <Card>
          <EmptyState title="Not available yet">Your school has not added your student details yet.</EmptyState>
        </Card>
      )}
    </>
  );
}
