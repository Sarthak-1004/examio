import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getTitle, type TitleDetail } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { addCopiesAction, copyStatusAction, updateTitleAction } from "../../actions";
import { TitleFields } from "../title-fields";

export const metadata: Metadata = { title: "Library title" };

type Copy = TitleDetail["copies"][number];
type Loan = TitleDetail["history"][number];
const COPY: Record<Copy["status"], { label: string; tone: "green" | "blue" | "red" | "slate" }> = {
  available: { label: "On the shelf", tone: "green" },
  issued: { label: "On loan", tone: "blue" },
  lost: { label: "Lost", tone: "red" },
  withdrawn: { label: "Withdrawn", tone: "slate" },
};
const LOAN: Record<string, string> = { open: "On loan", returned: "Returned", lost: "Lost" };

export default async function TitlePage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const { id } = await params;
  const t = await getTitle(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  const copyColumns: Column<Copy>[] = [
    { key: "acc", header: "Accession no.", primary: true, cell: (c) => c.accessionNo },
    { key: "shelf", header: "Shelf", secondary: true, cell: (c) => c.shelf ?? "—" },
    { key: "status", header: "Status", cell: (c) => <Badge tone={COPY[c.status].tone}>{COPY[c.status].label}</Badge> },
    { key: "who", header: "Borrower", cell: (c) => (c.borrower ? `${c.borrower}, due ${c.dueOn}` : c.note ?? "—") },
    {
      key: "act",
      header: "Actions",
      cell: (c) =>
        c.status === "issued" ? (
          "—"
        ) : (
          <ActionForm action={copyStatusAction} inline>
            <input type="hidden" name="copyId" value={c.id} />
            <input type="hidden" name="to" value={c.status === "available" ? "withdrawn" : "available"} />
            <SubmitButton variant="secondary" pendingText="Saving…" aria-label={`${c.status === "available" ? "Withdraw" : "Back on shelf"}: ${c.accessionNo}`}>
              {c.status === "available" ? "Withdraw" : "Back on shelf"}
            </SubmitButton>
          </ActionForm>
        ),
    },
  ];
  const historyColumns: Column<Loan>[] = [
    { key: "acc", header: "Copy", primary: true, cell: (h) => h.accessionNo },
    { key: "who", header: "Borrower", cell: (h) => h.borrower },
    { key: "issued", header: "Issued", secondary: true, cell: (h) => formatDateTime(h.issuedAt, s.timeZone) },
    { key: "due", header: "Due", cell: (h) => h.dueOn },
    { key: "status", header: "Status", cell: (h) => `${LOAN[h.status] ?? h.status}${h.closedOn ? ` · ${h.closedOn}` : ""}` },
  ];
  return (
    <>
      <PageHeader title={t.title} description={[t.author, t.isbn && `ISBN ${t.isbn}`].filter(Boolean).join(" · ") || undefined} action={<Link href="/school/library/catalogue" className="text-sm font-medium text-brand-700 hover:underline">Catalogue</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Copies" />
            <DataTable caption="Copies" columns={copyColumns} rows={t.copies} rowKey={(c) => c.id} empty={{ title: "No copies yet", body: "Add copies with their accession numbers." }} />
          </Card>
          <Card>
            <CardHeader title="Lending history" description="The last 50 loans of any copy." />
            <DataTable caption="Lending history" columns={historyColumns} rows={t.history} rowKey={(h) => `${h.accessionNo}-${h.issuedAt.toISOString()}`} empty={{ title: "Never lent" }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Add copies" />
            <ActionForm action={addCopiesAction} className="space-y-4 p-5">
              <input type="hidden" name="titleId" value={t.id} />
              <Field label="Accession numbers" htmlFor="accessionNos" hint="Separate with commas or new lines.">
                <Textarea id="accessionNos" name="accessionNos" rows={2} required />
              </Field>
              <Field label="Shelf (optional)" htmlFor="shelf">
                <Input id="shelf" name="shelf" />
              </Field>
              <SubmitButton pendingText="Adding…">Add copies</SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <ActionForm action={updateTitleAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="titleId" value={t.id} />
              <TitleFields t={t} />
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
