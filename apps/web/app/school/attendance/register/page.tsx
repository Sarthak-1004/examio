import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getRegister, getRegisterHistory } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, cx } from "@/components/ui";
import { submitRegisterAction } from "../actions";

export const metadata: Metadata = { title: "Register" };

const OPTIONS = [
  { value: "present", label: "Present", tone: "peer-checked:bg-emerald-600 peer-checked:text-white peer-checked:ring-emerald-600" },
  { value: "absent", label: "Absent", tone: "peer-checked:bg-red-600 peer-checked:text-white peer-checked:ring-red-600" },
  { value: "late", label: "Late", tone: "peer-checked:bg-amber-500 peer-checked:text-white peer-checked:ring-amber-500" },
  { value: "excused", label: "Excused", tone: "peer-checked:bg-slate-600 peer-checked:text-white peer-checked:ring-slate-600" },
] as const;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const sp = await searchParams;
  const input = { sectionId: one(sp.section), sessionId: one(sp.session), date: one(sp.date) };
  const r = await getRegister(db, s.ctx, s.ctx.schoolId, input).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const history = r.isAdmin ? await getRegisterHistory(db, s.ctx, s.ctx.schoolId, input) : [];
  const allMarked = r.marked > 0 && r.marked >= r.rows.length;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/school/attendance?date=${r.date}`} className="text-brand-600 hover:text-brand-700">
          ← Attendance
        </Link>
      </p>
      <PageHeader
        title={`${r.sectionLabel} · ${r.date}`}
        description={`${r.sessionName} · ${r.rows.length} student(s)`}
        action={allMarked ? <Badge tone="green">Taken</Badge> : r.marked > 0 ? <Badge tone="amber">Incomplete</Badge> : <Badge tone="red">Not taken</Badge>}
      />
      {r.events.length > 0 && (
        <p className="mb-4 text-sm text-slate-700">
          On the calendar: {r.events.map((e) => `${e.title} (${e.kind})`).join(", ")}
        </p>
      )}
      <Card>
        {r.notSchoolDay ? (
          <EmptyState title="No register on this date">{r.notSchoolDay}</EmptyState>
        ) : r.rows.length === 0 ? (
          <EmptyState title="No students">No students are enrolled in this section on this date.</EmptyState>
        ) : (
          <ActionForm action={submitRegisterAction} className="space-y-4 p-5">
            <input type="hidden" name="sectionId" value={r.sectionId} />
            <input type="hidden" name="sessionId" value={r.sessionId} />
            <input type="hidden" name="date" value={r.date} />
            <input type="hidden" name="version" value={r.version} />
            {!r.canWrite && <Alert tone="amber">{r.lockedThrough && r.date <= r.lockedThrough ? "This date is locked. Ask the school administrator to correct it." : "This date is outside the period in which teachers can change attendance. Ask the school administrator."}</Alert>}
            <ul className="divide-y divide-slate-100">
              {r.rows.map((x) => (
                <li key={x.enrollmentId} className="py-3">
                  <input type="hidden" name="enrollment" value={x.enrollmentId} />
                  <fieldset disabled={!r.canWrite} className="flex flex-wrap items-center justify-between gap-3">
                    <legend className="float-left text-sm text-slate-900">
                      <span className="mr-2 inline-block w-8 text-right tabular-nums text-slate-500">{x.rollNo ?? "—"}</span>
                      {x.displayName}
                    </legend>
                    <div className="flex flex-wrap gap-1">
                      {OPTIONS.map((o) => (
                        <label key={o.value} className="relative">
                          <input type="radio" name={`status-${x.enrollmentId}`} value={o.value} defaultChecked={(x.status ?? "present") === o.value} className="peer sr-only" />
                          <span className={cx("inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600", o.tone)}>
                            {o.label}
                          </span>
                        </label>
                      ))}
                    </div>
                    <label className="sr-only" htmlFor={`note-${x.enrollmentId}`}>
                      Note for {x.displayName}
                    </label>
                    <Input id={`note-${x.enrollmentId}`} name={`note-${x.enrollmentId}`} defaultValue={x.note ?? ""} maxLength={200} placeholder="Note (optional)" className="w-full sm:w-56" />
                  </fieldset>
                </li>
              ))}
            </ul>
            {r.canWrite && (r.changesNeedReason || r.writeNeedsReason) && (
              <Field label="Reason for changes" htmlFor="reg-reason" hint={r.writeNeedsReason ? "This date is locked or outside the teachers' period: a reason is required and recorded." : "Required if you change entries already saved for this date; recorded with the change."}>
                <Input id="reg-reason" name="reason" maxLength={200} />
              </Field>
            )}
            {r.canWrite && <SubmitButton pendingText="Saving…">{r.marked > 0 ? "Save changes" : "Save register"}</SubmitButton>}
          </ActionForm>
        )}
      </Card>
      {history.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Changes" description="Every change after the first marking." />
          <ul className="divide-y divide-slate-100 text-sm">
            {history.map((h, i) => (
              <li key={i} className="px-5 py-2 text-slate-700">
                {h.studentName}: {h.oldStatus} → {h.newStatus} by {h.changedBy}, {h.changedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                {h.reason ? ` · “${h.reason}”` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
