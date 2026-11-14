import type { Metadata } from "next";
import Link from "next/link";
import { listMembersWithoutProfile, listMembershipInvitations, parsePageRequest, searchStaff, type StaffListRow } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { SubmitButton } from "@/components/submit-button";
import { Badge, ButtonLink, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { RowAction } from "../setup/shared";
import { addProfileForMemberAction, createStaffAction, inviteAction, revokeInvitationAction } from "./actions";

export const metadata: Metadata = { title: "Staff" };

const ROLE_LABEL: Record<string, string> = { school_admin: "Admin", teacher: "Teacher", finance: "Finance" };

const columns: Column<StaffListRow>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    cell: (r) => (
      <Link href={`/school/staff/${r.id}`} className="text-brand-700 hover:underline">
        {r.displayName}
      </Link>
    ),
  },
  { key: "no", header: "Employee no.", cell: (r) => <span className="font-mono text-xs">{r.employeeNo}</span> },
  { key: "roles", header: "Role", cell: (r) => r.roles.map((x) => ROLE_LABEL[x] ?? x).join(", ") || "—" },
  { key: "contact", header: "Contact", secondary: true, cell: (r) => r.email ?? r.phone ?? "—" },
  { key: "status", header: "Status", cell: (r) => (r.status === "active" ? <Badge tone="green">Active</Badge> : <Badge>Left</Badge>) },
];

export default async function StaffPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const params = await searchParams;
  const req = parsePageRequest(params);
  const status = params.status === "active" || params.status === "left" ? params.status : undefined;
  const role = typeof params.role === "string" && ["school_admin", "teacher", "finance"].includes(params.role) ? params.role : undefined;
  const [page, pending, invitations] = await Promise.all([
    searchStaff(db, s.ctx, schoolId, { ...req, status, role }),
    listMembersWithoutProfile(db, s.ctx, schoolId),
    listMembershipInvitations(db, s.ctx, schoolId),
  ]);
  const openInvitations = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt.getTime() > Date.now());
  const filtered = req.search !== "" || !!status || !!role;
  const exportQuery = new URLSearchParams({ ...(req.search ? { q: req.search } : {}), ...(status ? { status } : {}), ...(role ? { role } : {}) }).toString();

  return (
    <>
      <PageHeader
        title="Staff"
        description="Teachers and office staff of your school."
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/school/staff/teaching" variant="secondary">
              Who teaches what
            </ButtonLink>
            <ButtonLink href="/school/staff/import" variant="secondary">
              Import
            </ButtonLink>
            <ButtonLink href={`/school/staff/export${exportQuery ? `?${exportQuery}` : ""}`} variant="secondary" prefetch={false}>
              Export CSV
            </ButtonLink>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {pending.length > 0 && (
            <Card>
              <CardHeader title="Members without staff details" description="They joined your school (for example by invitation). Add their employee number to finish." />
              <ul className="divide-y divide-slate-100">
                {pending.map((m) => (
                  <li key={m.userId} className="space-y-2 px-5 py-3">
                    <p className="text-sm font-medium text-slate-900">
                      {m.fullName} <span className="text-slate-500">{m.email}</span> {m.roles.map((r) => <Badge key={r}>{ROLE_LABEL[r] ?? r}</Badge>)}
                    </p>
                    <ActionForm action={addProfileForMemberAction} inline>
                      <input type="hidden" name="userId" value={m.userId} />
                      <input type="hidden" name="displayName" value={m.fullName} />
                      <label className="sr-only" htmlFor={`emp-${m.userId}`}>
                        Employee number for {m.fullName}
                      </label>
                      <Input id={`emp-${m.userId}`} name="employeeNo" required maxLength={30} placeholder="Employee no." className="w-40" />
                      <label className="sr-only" htmlFor={`job-${m.userId}`}>
                        Job title for {m.fullName}
                      </label>
                      <Input id={`job-${m.userId}`} name="jobTitle" maxLength={80} placeholder="Job title (optional)" className="w-48" />
                      <SubmitButton variant="secondary" pendingText="Adding…">
                        Add details
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <FilterBar
              basePath="/school/staff"
              search={req.search}
              searchLabel="Search name, number, email or phone"
              selects={[
                { name: "status", label: "Status", value: status ?? "", options: [{ value: "", label: "Any" }, { value: "active", label: "Active" }, { value: "left", label: "Left" }] },
                { name: "role", label: "Role", value: role ?? "", options: [{ value: "", label: "Any" }, { value: "teacher", label: "Teacher" }, { value: "finance", label: "Finance" }, { value: "school_admin", label: "Admin" }] },
              ]}
            />
            <DataTable
              caption="Staff"
              columns={columns}
              rows={page.rows}
              rowKey={(r) => r.id}
              empty={filtered ? { title: "No staff match", body: "Try a different search or clear the filters." } : { title: "No staff yet", body: "Add your first teacher with the form, or import a list." }}
            />
            <Pagination basePath="/school/staff" params={{ q: req.search || undefined, status, role }} page={page.page} pageCount={page.pageCount} total={page.total} pageSize={page.pageSize} noun="staff" />
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Add a staff member" description="Creates their account. You get a one-time code to hand over; they choose their own password." />
            <ActionForm action={createStaffAction} className="space-y-4 p-5">
              <Field label="Full name" htmlFor="st-name">
                <Input id="st-name" name="fullName" required minLength={2} maxLength={120} />
              </Field>
              <Field label="Employee number" htmlFor="st-no">
                <Input id="st-no" name="employeeNo" required maxLength={30} />
              </Field>
              <Field label="Email" htmlFor="st-email" hint="Email or mobile number is needed to sign in.">
                <Input id="st-email" name="email" type="email" />
              </Field>
              <Field label="Mobile number" htmlFor="st-phone">
                <Input id="st-phone" name="phone" type="tel" />
              </Field>
              <Field label="Role" htmlFor="st-role">
                <Select id="st-role" name="role" defaultValue="teacher">
                  <option value="teacher">Teacher</option>
                  <option value="finance">Finance</option>
                </Select>
              </Field>
              <Field label="Job title" htmlFor="st-job" hint="Optional, e.g. Science teacher.">
                <Input id="st-job" name="jobTitle" maxLength={80} />
              </Field>
              <Field label="Joined on" htmlFor="st-joined">
                <Input id="st-joined" name="joinedOn" type="date" />
              </Field>
              <SubmitButton pendingText="Adding…">Add staff member</SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Invite an existing Examio user" description="For someone who already has an account, e.g. at another school. They accept while signed in." />
            <ActionForm action={inviteAction} className="space-y-4 p-5">
              <Field label="Who is it for?" htmlFor="inv-label" hint="For your records, e.g. their name.">
                <Input id="inv-label" name="recipientLabel" required minLength={2} maxLength={200} />
              </Field>
              <Field label="Role" htmlFor="inv-role">
                <Select id="inv-role" name="role" defaultValue="teacher">
                  <option value="teacher">Teacher</option>
                  <option value="finance">Finance</option>
                </Select>
              </Field>
              <SubmitButton variant="secondary" pendingText="Creating…">
                Create invitation
              </SubmitButton>
            </ActionForm>
            {openInvitations.length > 0 && (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {openInvitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span>
                      {i.recipientLabel} <Badge>{ROLE_LABEL[i.role] ?? i.role}</Badge>
                    </span>
                    <RowAction action={revokeInvitationAction} fields={{ invitationId: i.id }} label="Cancel" ariaLabel={`Cancel invitation for ${i.recipientLabel}`} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="text-sm text-slate-600">Additional school administrators are added by Examio platform support.</p>
        </div>
      </div>
    </>
  );
}
