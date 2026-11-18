import type { Metadata } from "next";
import Link from "next/link";
import { searchCatalogue, type TitleRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { createTitleAction } from "../actions";
import { TitleFields } from "./title-fields";

export const metadata: Metadata = { title: "Library catalogue" };

export default async function CataloguePage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const s = await requireSchoolRole("school_admin");
  const { q } = await searchParams;
  const search = (typeof q === "string" ? q : "").slice(0, 100);
  const rows = await searchCatalogue(db, s.ctx, s.ctx.schoolId, search);
  const columns: Column<TitleRow>[] = [
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (r) => (
        <Link href={`/school/library/catalogue/${r.id}`} className="text-brand-700 hover:underline">
          {r.title}
        </Link>
      ),
    },
    { key: "author", header: "Author", cell: (r) => r.author ?? "—" },
    { key: "category", header: "Category", secondary: true, cell: (r) => r.category ?? "—" },
    { key: "copies", header: "Available", align: "right", cell: (r) => `${r.available} of ${r.copies}` },
  ];
  return (
    <>
      <PageHeader title="Catalogue" description="Titles and their copies. Each copy has its own accession number." action={<Link href="/school/library" className="text-sm font-medium text-brand-700 hover:underline">Back to the desk</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <FilterBar basePath="/school/library/catalogue" search={search} searchLabel="Search title, author, ISBN or accession number" />
          <DataTable caption="Titles" columns={columns} rows={rows} rowKey={(r) => r.id} empty={{ title: search ? "No matching titles" : "No titles yet", body: search ? "Try a different search." : "Add the first title." }} />
        </Card>
        <Card>
          <CardHeader title="Add a title" />
          <ActionForm action={createTitleAction} className="space-y-4 p-5">
            <TitleFields />
            <Field label="Accession numbers of the copies" htmlFor="accessionNos" hint="Separate with commas or new lines, for example B-001, B-002.">
              <Textarea id="accessionNos" name="accessionNos" rows={2} />
            </Field>
            <Field label="Shelf (optional)" htmlFor="shelf">
              <Input id="shelf" name="shelf" />
            </Field>
            <SubmitButton pendingText="Adding…">Add title</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
