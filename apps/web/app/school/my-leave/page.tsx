import type { Metadata } from "next";
import { getMyLeave, getMyRegister, listLeaveTypes, schoolToday, type LeaveRequestRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { leaveDates, LeaveStatus } from "@/components/leave-status";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { myLeaveCancelAction, myLeaveRequestAction } from "./actions";

export const metadata: Metadata = { title: "My leave" };

const MARK: Record<string, string> = { present: "Present", absent: "Absent", half_day: "Half day", leave: "Leave", half_leave: "Half-day leave" };

export default async function MyLeavePage() {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  const month = schoolToday(s.timeZone).slice(0, 7);
  const [mine, types, register] = await Promise.all([getMyLeave(db, s.ctx, s.ctx.schoolId), listLeaveTypes(db, s.ctx, s.ctx.schoolId), getMyRegister(db, s.ctx, s.ctx.schoolId, month)]);
  if (!mine) {
    return (
      <>
        <PageHeader title="My leave" />
        <EmptyState title="No staff record">Your school has not added your staff details yet.</EmptyState>
      </>
    );
  }
  const active = types.filter((t) => !t.archived);
  const columns: Column<LeaveRequestRow>[] = [
    { key: "dates", header: "Dates", primary: true, cell: (r) => leaveDates(r) },
    { key: "type", header: "Type", cell: (r) => r.type },
    { key: "status", header: "Status", cell: (r) => <LeaveStatus status={r.status} /> },
    { key: "note", header: "Reason · decision", secondary: true, cell: (r) => [r.reason, r.decisionNote].filter(Boolean).join(" · ") },
    {
      key: "act",
      header: "Actions",
      cell: (r) =>
        r.status === "pending" ? (
          <ActionForm action={myLeaveCancelAction} inline>
            <input type="hidden" name="requestId" value={r.id} />
            <SubmitButton variant="ghost" pendingText="Cancelling…" aria-label={`Cancel leave from ${r.fromOn}`}>
              Cancel
            </SubmitButton>
          </ActionForm>
        ) : (
          "—"
        ),
    },
  ];
  return (
    <>
      <PageHeader title="My leave" description={mine.yearName ? `Balances for ${mine.yearName}. Leave counts working days only.` : "Leave counts working days only."} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Balances" />
            {mine.balances.length === 0 ? (
              <EmptyState title="No paid leave types yet" />
            ) : (
              <ul className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-3">
                {mine.balances.map((b) => (
                  <li key={b.leaveTypeId} className="bg-white px-5 py-4">
                    <p className="text-sm text-slate-500">{b.name}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{`${b.remainingDays} of ${b.quotaDays}`}</p>
                    <p className="text-sm text-slate-600">{`${b.approvedDays} taken · ${b.pendingDays} pending`}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="My requests" />
            <DataTable caption="My leave requests" columns={columns} rows={mine.requests} rowKey={(r) => r.id} empty={{ title: "No leave requested yet" }} />
          </Card>
          <Card>
            <CardHeader title="My attendance this month" description="Marked by the school office." />
            {register.length === 0 ? (
              <EmptyState title="Nothing marked this month yet" />
            ) : (
              <ul className="flex flex-wrap gap-2 px-5 py-4 text-sm">
                {register.map((d) => (
                  <li key={d.on} className="rounded-lg bg-slate-50 px-3 py-1.5 ring-1 ring-inset ring-slate-200">
                    {`${d.on.slice(8)}: ${d.status ? MARK[d.status] : "Not marked"}`}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title="Request leave" />
          {active.length === 0 ? (
            <p className="p-5 text-sm text-slate-600">Your school has not set up leave types yet.</p>
          ) : (
            <ActionForm action={myLeaveRequestAction} className="space-y-4 p-5">
              <Field label="Leave type" htmlFor="lv-type">
                <Select id="lv-type" name="leaveTypeId" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {active.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.paid ? `${t.name} (${t.quotaDays} days a year)` : `${t.name} (unpaid)`}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="From" htmlFor="lv-from">
                  <Input id="lv-from" name="fromOn" type="date" required />
                </Field>
                <Field label="To (blank for one day)" htmlFor="lv-to">
                  <Input id="lv-to" name="toOn" type="date" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" name="halfDay" /> Half a day (the From date only)
              </label>
              <Field label="Reason" htmlFor="lv-reason">
                <Input id="lv-reason" name="reason" required minLength={3} maxLength={300} />
              </Field>
              <SubmitButton pendingText="Requesting…">Request leave</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
