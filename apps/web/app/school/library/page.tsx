import type { Metadata } from "next";
import { formatPaise, getLibrarySettings, listOpenLoans, type LoanRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, ButtonLink, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { issueAction, lostAction, renewAction, returnAction, settingsAction } from "./actions";

export const metadata: Metadata = { title: "Library" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const rupees = (paise: number) => (paise === 0 ? "0" : (paise / 100).toFixed(2).replace(/\.00$/, ""));

/** The library desk: issue and return by accession number, open loans, and lending rules. */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const overdueOnly = one(sp.show) === "overdue";
  const search = one(sp.q).slice(0, 100);
  const [settings, loans] = await Promise.all([getLibrarySettings(db, s.ctx, schoolId), listOpenLoans(db, s.ctx, schoolId, { overdueOnly, search })]);

  const columns: Column<LoanRow>[] = [
    { key: "title", header: "Book", primary: true, cell: (r) => `${r.title} · ${r.accessionNo}` },
    { key: "borrower", header: "Borrower", cell: (r) => r.borrower },
    {
      key: "due",
      header: "Due",
      cell: (r) => (r.overdueDays > 0 ? <Badge tone="red">{`${r.dueOn} · ${r.overdueDays} day${r.overdueDays === 1 ? "" : "s"} late`}</Badge> : r.dueOn),
    },
    { key: "renewals", header: "Renewals", secondary: true, align: "right", cell: (r) => `${r.renewals} of ${settings.maxRenewals}` },
    {
      key: "actions",
      header: "Actions",
      cell: (r) => (
        <div className="flex flex-wrap items-start gap-2">
          <ActionForm action={renewAction} inline>
            <input type="hidden" name="loanId" value={r.loanId} />
            <SubmitButton variant="secondary" pendingText="Renewing…" aria-label={`Renew ${r.accessionNo}`}>
              Renew
            </SubmitButton>
          </ActionForm>
          <details className="text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">Mark lost</summary>
            <ActionForm action={lostAction} className="mt-2 space-y-2">
              <input type="hidden" name="loanId" value={r.loanId} />
              {r.borrowerKind === "student" && (
                <Field label="Replacement charge (₹, optional)" htmlFor={`charge-${r.loanId}`}>
                  <Input id={`charge-${r.loanId}`} name="charge" inputMode="decimal" className="w-40" />
                </Field>
              )}
              <SubmitButton variant="danger" pendingText="Saving…" aria-label={`Mark lost: ${r.accessionNo}`}>
                Mark lost
              </SubmitButton>
            </ActionForm>
          </details>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Library"
        description="Issue and return books by accession number. Late and lost-book charges for students go to Fees for another administrator to approve."
        action={
          <span className="flex flex-wrap items-center gap-4">
            <a href={overdueOnly ? "/school/library/export?show=overdue" : "/school/library/export"} className="text-sm font-medium text-brand-700 hover:underline">
              {overdueOnly ? "Download overdue (CSV)" : "Download loans (CSV)"}
            </a>
            <ButtonLink href="/school/library/catalogue" variant="secondary">
              Catalogue
            </ButtonLink>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader title="Issue" description={`Due back in ${settings.loanDays} days.`} />
              <ActionForm action={issueAction} className="space-y-4 p-5">
                <Field label="Accession number" htmlFor="issue-acc">
                  <Input id="issue-acc" name="accessionNo" required autoComplete="off" />
                </Field>
                <Field label="Borrower (admission or employee number)" htmlFor="issue-borrower">
                  <Input id="issue-borrower" name="borrower" required autoComplete="off" />
                </Field>
                <SubmitButton pendingText="Issuing…">Issue</SubmitButton>
              </ActionForm>
            </Card>
            <Card>
              <CardHeader title="Return" description={settings.finePerDayPaise > 0 ? `Late fine ${formatPaise(settings.finePerDayPaise)} per day for students.` : "No late fine is set."} />
              <ActionForm action={returnAction} className="space-y-4 p-5">
                <Field label="Accession number" htmlFor="return-acc">
                  <Input id="return-acc" name="accessionNo" required autoComplete="off" />
                </Field>
                <SubmitButton pendingText="Returning…">Return</SubmitButton>
              </ActionForm>
            </Card>
          </div>
          <Card>
            <CardHeader title="Books on loan" />
            <FilterBar
              basePath="/school/library"
              search={search}
              searchLabel="Search book, accession number or borrower"
              selects={[{ name: "show", label: "Show", value: overdueOnly ? "overdue" : "", options: [{ value: "", label: "All on loan" }, { value: "overdue", label: "Overdue" }] }]}
            />
            <DataTable
              caption="Books on loan"
              columns={columns}
              rows={loans}
              rowKey={(r) => r.loanId}
              empty={{ title: overdueOnly ? "Nothing overdue" : "No books on loan", body: search ? "Try a different search." : undefined }}
            />
          </Card>
        </div>
        <Card>
          <CardHeader title="Lending rules" />
          <ActionForm action={settingsAction} keepValues className="space-y-4 p-5">
            <Field label="Loan period (days)" htmlFor="loanDays">
              <Input id="loanDays" name="loanDays" type="number" min={1} max={120} defaultValue={settings.loanDays} required />
            </Field>
            <Field label="Renewals allowed" htmlFor="maxRenewals">
              <Input id="maxRenewals" name="maxRenewals" type="number" min={0} max={10} defaultValue={settings.maxRenewals} required />
            </Field>
            <Field label="Books a student may hold" htmlFor="maxLoansStudent">
              <Input id="maxLoansStudent" name="maxLoansStudent" type="number" min={1} max={20} defaultValue={settings.maxLoansStudent} required />
            </Field>
            <Field label="Books a staff member may hold" htmlFor="maxLoansStaff">
              <Input id="maxLoansStaff" name="maxLoansStaff" type="number" min={1} max={50} defaultValue={settings.maxLoansStaff} required />
            </Field>
            <Field label="Late fine per day for students (₹)" htmlFor="finePerDay" hint="0 for no fine. Staff are never fined.">
              <Input id="finePerDay" name="finePerDay" inputMode="decimal" defaultValue={rupees(settings.finePerDayPaise)} />
            </Field>
            <SubmitButton pendingText="Saving…">Save rules</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
