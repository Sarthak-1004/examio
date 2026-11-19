import type { Metadata } from "next";
import Link from "next/link";
import { getStaffRegister } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { registerAction } from "../actions";

export const metadata: Metadata = { title: "Staff register" };

export default async function StaffRegisterPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const s = await requireSchoolRole("school_admin");
  const { date } = await searchParams;
  const asked = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const r = await getStaffRegister(db, s.ctx, s.ctx.schoolId, asked);
  const future = r.date > r.today;
  const anyMarked = r.rows.some((x) => x.marked && x.status !== "leave" && x.status !== "half_leave");

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/hr" className="text-brand-600 hover:text-brand-700">
          ← HR
        </Link>
      </p>
      <PageHeader title="Staff register" description="Mark staff present, absent or half day. Approved leave is filled in from leave requests." action={<Link href="/school/hr/leave" className="text-sm font-medium text-brand-700 hover:underline">Staff leave</Link>} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Day" htmlFor="reg-date">
          <Input id="reg-date" name="date" type="date" defaultValue={r.date} max={r.today} />
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {!r.workingDay && (
        <div className="mb-4">
          <Alert tone="amber">This is not a working day (a weekly off day or a school holiday). You can still mark staff who worked.</Alert>
        </div>
      )}
      <Card>
        <CardHeader title={r.date} description={`${r.rows.length} staff`} />
        {future ? (
          <EmptyState title="Days in the future cannot be marked" />
        ) : r.rows.length === 0 ? (
          <EmptyState title="No staff on this day" />
        ) : (
          <ActionForm action={registerAction} keepValues className="space-y-4 p-5">
            <input type="hidden" name="date" value={r.date} />
            <ul className="divide-y divide-slate-100">
              {r.rows.map((x) => (
                <li key={x.staffId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <span className="font-medium text-slate-900">{`${x.name} (${x.employeeNo})`}</span>
                  {x.status === "leave" || x.status === "half_leave" ? (
                    <Badge tone="blue">{`${x.status === "leave" ? "On leave" : "Half-day leave"}${x.leaveType ? ` · ${x.leaveType}` : ""}`}</Badge>
                  ) : (
                    <span>
                      <label className="sr-only" htmlFor={`m-${x.staffId}`}>{`Mark for ${x.name}`}</label>
                      <Select id={`m-${x.staffId}`} name={`m:${x.staffId}`} defaultValue={x.status ?? ""} className="w-40">
                        <option value="">Not marked</option>
                        <option value="present">Present</option>
                        <option value="absent">Absent</option>
                        <option value="half_day">Half day</option>
                      </Select>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {anyMarked && (
              <Field label="Reason for corrections (needed to change a saved mark)" htmlFor="reg-reason">
                <Input id="reg-reason" name="reason" maxLength={300} />
              </Field>
            )}
            <SubmitButton pendingText="Saving…">Save register</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </>
  );
}
