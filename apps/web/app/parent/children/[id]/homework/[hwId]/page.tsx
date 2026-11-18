import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getChildHomework } from "@examio/core";
import { HomeworkView } from "@/components/homework-view";
import { PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Homework" };

/** A linked child's homework and submission (read-only for parents). */
export default async function ChildHomeworkPage({ params }: { params: Promise<{ id: string; hwId: string }> }) {
  const s = await requireSchoolRole("parent");
  const { id, hwId } = await params;
  const h = await getChildHomework(db, s.ctx, s.ctx.schoolId, id, hwId).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/parent/children/${id}`} className="text-brand-600 hover:text-brand-700">
          ← Back to your child
        </Link>
      </p>
      <PageHeader title={h.title} description={h.sectionLabel} />
      <HomeworkView timeZone={s.timeZone} h={h} />
    </>
  );
}
