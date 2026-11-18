import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getMyHomework } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { HomeworkView } from "@/components/homework-view";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, PageHeader, Textarea } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { submitHomeworkAction } from "../actions";

export const metadata: Metadata = { title: "Homework" };

export default async function MyHomeworkDetail({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("student");
  const { id } = await params;
  const h = await getMyHomework(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/student/homework" className="text-brand-600 hover:text-brand-700">
          ← Homework
        </Link>
      </p>
      <PageHeader title={h.title} description={h.sectionLabel} />
      <HomeworkView timeZone={s.timeZone} h={h}>
        {h.canSubmit ? (
          <ActionForm action={submitHomeworkAction} className="space-y-3 border-t border-slate-100 pt-3">
            <input type="hidden" name="homeworkId" value={h.id} />
            <Field label={h.submission ? "Change your answer" : "Your answer"} htmlFor="sub-body" hint="Only you, your parents and your teachers can see it.">
              <Textarea id="sub-body" name="body" rows={5} maxLength={5000} defaultValue={h.submission?.body ?? ""} />
            </Field>
            <Field label="Files" htmlFor="sub-files" hint="PDF, image or text, up to 10 MB each.">
              <input id="sub-files" name="files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" className="block text-sm" />
            </Field>
            <SubmitButton pendingText="Submitting…">{h.submission ? "Update submission" : "Submit"}</SubmitButton>
          </ActionForm>
        ) : (
          h.closedReason && <Alert tone="amber">{h.closedReason}</Alert>
        )}
      </HomeworkView>
    </>
  );
}
