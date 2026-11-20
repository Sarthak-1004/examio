import type { Metadata } from "next";
import Link from "next/link";
import { listHrStaff, listLeaveRequests, listLeaveTypes, type LeaveRequestRow, type LeaveTypeRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { leaveDates, LeaveStatus } from "@/components/leave-status";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { cancelLeaveAdminAction, decideLeaveAction, leaveTypeAction, leaveTypeUpdateAction, requestForStaffAction } from "../actions";

export const metadata: Metadata = { title: "Staff leave" };

export default async function StaffLeavePage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { status } = await searchParams;
  const filter = typeof status === "string" && ["approved", "rejected", "cancelled"].includes(status) ? status : undefined;
  const [pending, decided, types, staff] = await Promise.all([
    listLeaveRequests(db, s.ctx, schoolId, { status: "pending" }),
    filter ? listLeaveRequests(db, s.ctx, schoolId, { status: filter }) : listLeaveRequests(db, s.ctx, schoolId).then((r) => r.filter((x) => x.status !== "pending").slice(0, 50)),
    listLeaveTypes(db, s.ctx, schoolId),
    listHrStaff(db, s.ctx, schoolId),
  ]);
  const activeTypes = types.filter((t) => !t.archived);

  const pendingColumns: Column<LeaveRequestRow>[] = [
    { key: "staff", header: "Staff member", primary: true, cell: (r) => r.staff },
    { key: "dates", header: "Dates", cell: (r) => leaveDates(r) },
    { key: "type", header: "Type", cell: (r) => (r.remaining !== null ? `${r.type} · ${r.remaining} left` : r.paid ? r.type : `${r.type} (unpaid)`) },
    { key: "reason", header: "Reason", secondary: true, cell: (r) => r.reason },
    {
      key: "decide",
      header: "Decision",
      cell: (r) => (
        <ActionForm action={decideLeaveAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="requestId" value={r.id} />
          <label className="sr-only" htmlFor={`note-${r.id}`}>{`Note for ${r.staff}`}</label>
          <Input id={`note-${r.id}`} name="note" placeholder="Note (needed to reject)" maxLength={300} className="w-48" />
          <SubmitButton name="decision" value="approve" pendingText="Saving…" aria-label={`Approve leave for ${r.staff}`}>
            Approve
          </SubmitButton>
          <SubmitButton name="decision" value="reject" variant="secondary" pendingText="Saving…" aria-label={`Reject leave for ${r.staff}`}>
            Reject
          </SubmitButton>
        </ActionForm>
      ),
    },
  ];
  const decidedColumns: Column<LeaveRequestRow>[] = [
    { key: "staff", header: "Staff member", primary: true, cell: (r) => r.staff },
    { key: "dates", header: "Dates", cell: (r) => leaveDates(r) },
    { key: "type", header: "Type", secondary: true, cell: (r) => r.type },
    { key: "status", header: "Status", cell: (r) => <LeaveStatus status={r.status} /> },
    { key: "by", header: "Decided by", secondary: true, cell: (r) => [r.decidedBy, r.decisionNote].filter(Boolean).join(" · ") || "—" },
    {
      key: "act",
      header: "Actions",
      cell: (r) =>
        r.status === "approved" ? (
          <details className="text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">Cancel leave</summary>
            <ActionForm action={cancelLeaveAdminAction} className="mt-2 w-60 space-y-2">
              <input type="hidden" name="requestId" value={r.id} />
              <Field label="Reason" htmlFor={`cancel-${r.id}`}>
                <Input id={`cancel-${r.id}`} name="reason" required minLength={3} maxLength={300} />
              </Field>
              <SubmitButton variant="danger" pendingText="Cancelling…" aria-label={`Cancel leave: ${r.staff}`}>
                Cancel leave
              </SubmitButton>
            </ActionForm>
          </details>
        ) : (
          "—"
        ),
    },
  ];
  const typeColumns: Column<LeaveTypeRow>[] = [
    { key: "name", header: "Leave type", primary: true, cell: (t) => (t.archived ? <span className="text-slate-500">{t.name} <Badge>Archived</Badge></span> : t.name) },
    {
      key: "quota",
      header: "Days a year",
      cell: (t) =>
        t.paid ? (
          <ActionForm action={leaveTypeUpdateAction} inline keepValues>
            <input type="hidden" name="typeId" value={t.id} />
            <input type="hidden" name="archived" value="" />
            <label className="sr-only" htmlFor={`quota-${t.id}`}>{`Days a year of ${t.name}`}</label>
            <Input id={`quota-${t.id}`} name="quotaDays" defaultValue={t.quotaDays ?? ""} className="w-20" inputMode="decimal" />
            <SubmitButton variant="secondary" pendingText="Saving…" aria-label={`Save days for ${t.name}`}>
              Save
            </SubmitButton>
          </ActionForm>
        ) : (
          "Unpaid"
        ),
    },
    {
      key: "archive",
      header: "Actions",
      cell: (t) => (
        <ActionForm action={leaveTypeUpdateAction} inline>
          <input type="hidden" name="typeId" value={t.id} />
          <input type="hidden" name="archived" value={t.archived ? "0" : "1"} />
          <SubmitButton variant="ghost" pendingText="Saving…" aria-label={`${t.archived ? "Restore" : "Archive"} ${t.name}`}>
            {t.archived ? "Restore" : "Archive"}
          </SubmitButton>
        </ActionForm>
      ),
    },
  ];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/school/hr" className="text-brand-600 hover:text-brand-700">
          ← HR
        </Link>
      </p>
      <PageHeader title="Staff leave" description="Requests are decided by an administrator other than the staff member and whoever made the request." action={<Link href="/school/hr/attendance" className="text-sm font-medium text-brand-700 hover:underline">Staff register</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Waiting for a decision" description="Oldest first." />
            <DataTable caption="Pending leave requests" columns={pendingColumns} rows={pending} rowKey={(r) => r.id} empty={{ title: "No pending requests" }} />
          </Card>
          <Card>
            <CardHeader
              title={filter ? `${filter[0]!.toUpperCase()}${filter.slice(1)} requests` : "Recent decisions"}
              action={
                <span className="flex flex-wrap gap-3 text-sm">
                  {["approved", "rejected", "cancelled"].map((st) => (
                    <Link key={st} href={filter === st ? "/school/hr/leave" : `/school/hr/leave?status=${st}`} aria-current={filter === st ? "page" : undefined} className="font-medium text-brand-700 hover:underline">
                      {st[0]!.toUpperCase() + st.slice(1)}
                    </Link>
                  ))}
                </span>
              }
            />
            <DataTable caption="Decided leave requests" columns={decidedColumns} rows={decided} rowKey={(r) => r.id} empty={{ title: "Nothing here yet" }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Leave types" />
            <DataTable caption="Leave types" columns={typeColumns} rows={types} rowKey={(t) => t.id} empty={{ title: "No leave types yet" }} />
            <ActionForm action={leaveTypeAction} className="space-y-4 border-t border-slate-100 p-5">
              <Field label="Name" htmlFor="lt-name">
                <Input id="lt-name" name="name" required maxLength={60} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Pay" htmlFor="lt-paid">
                  <Select id="lt-paid" name="paid" defaultValue="yes">
                    <option value="yes">Paid</option>
                    <option value="no">Unpaid</option>
                  </Select>
                </Field>
                <Field label="Days a year (paid)" htmlFor="lt-quota">
                  <Input id="lt-quota" name="quotaDays" inputMode="decimal" />
                </Field>
              </div>
              <SubmitButton variant="secondary" pendingText="Adding…">Add leave type</SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Request for a staff member" description="Another administrator decides it." />
            <ActionForm action={requestForStaffAction} className="space-y-4 p-5">
              <Field label="Staff member" htmlFor="rq-staff">
                <Select id="rq-staff" name="staffId" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {staff.map((p) => (
                    <option key={p.staffId} value={p.staffId}>{`${p.name} (${p.employeeNo})`}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Leave type" htmlFor="rq-type">
                <Select id="rq-type" name="leaveTypeId" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {activeTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="From" htmlFor="rq-from">
                  <Input id="rq-from" name="fromOn" type="date" required />
                </Field>
                <Field label="To (blank for one day)" htmlFor="rq-to">
                  <Input id="rq-to" name="toOn" type="date" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" name="halfDay" /> Half a day
              </label>
              <Field label="Reason" htmlFor="rq-reason">
                <Input id="rq-reason" name="reason" required minLength={3} maxLength={300} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Requesting…">Request leave</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
