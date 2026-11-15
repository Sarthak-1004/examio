import type { Metadata } from "next";
import { getMyStudentTimetable } from "@examio/core";
import { TimetableWeek } from "@/components/timetable-week";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "My timetable" };

export default async function MyTimetablePage() {
  const s = await requireSchoolRole("student");
  const slots = await getMyStudentTimetable(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="My timetable" description="Your class's periods each week." />
      <Card>
        <TimetableWeek slots={slots} show="none" emptyText="Your school has not published a timetable for your class yet." />
      </Card>
    </>
  );
}
