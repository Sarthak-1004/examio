import type { Metadata } from "next";
import Link from "next/link";
import { listAllocations, listItems, listLocations, type AllocationRow, type ItemRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { createItemAction, createLocationAction } from "./actions";

export const metadata: Metadata = { title: "Inventory" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const sp = await searchParams;
  const search = one(sp.q).slice(0, 100);
  const kind = one(sp.kind) === "asset" || one(sp.kind) === "consumable" ? one(sp.kind) : "";
  const lowOnly = one(sp.show) === "low";
  const [items, locations, allocations] = await Promise.all([
    listItems(db, s.ctx, schoolId, { search, kind, lowOnly }),
    listLocations(db, s.ctx, schoolId),
    listAllocations(db, s.ctx, schoolId),
  ]);
  const lowCount = lowOnly ? items.length : items.filter((i) => i.low).length;

  const columns: Column<ItemRow>[] = [
    {
      key: "name",
      header: "Item",
      primary: true,
      cell: (r) => (
        <Link href={`/school/inventory/items/${r.id}`} className="text-brand-700 hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: "kind", header: "Kind", secondary: true, cell: (r) => (r.kind === "asset" ? "Asset (by tag)" : "Consumable") },
    { key: "category", header: "Category", secondary: true, cell: (r) => r.category ?? "—" },
    {
      key: "count",
      header: "On hand",
      cell: (r) =>
        r.kind === "asset" ? (
          `${r.inStore} in store · ${r.allocated} allocated${r.underRepair ? ` · ${r.underRepair} in repair` : ""}`
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            {`${r.stock} ${r.unit ?? ""}`.trim()}
            {r.low && <Badge tone="amber">Low stock</Badge>}
          </span>
        ),
    },
    { key: "state", header: "Status", secondary: true, cell: (r) => (r.archived ? <Badge>Archived</Badge> : "Active") },
  ];
  const allocColumns: Column<AllocationRow>[] = [
    { key: "asset", header: "Asset", primary: true, cell: (r) => <Link href={`/school/inventory/items/${r.itemId}`} className="text-brand-700 hover:underline">{`${r.itemName} · ${r.tag}`}</Link> },
    { key: "staff", header: "With", cell: (r) => r.staff },
    { key: "since", header: "Since", secondary: true, cell: (r) => formatDateTime(r.allocatedAt, s.timeZone) },
    { key: "due", header: "Return by", cell: (r) => (r.dueOn ? r.overdue ? <Badge tone="red">{`${r.dueOn} · overdue`}</Badge> : r.dueOn : "—") },
  ];

  return (
    <>
      <PageHeader title="Inventory" description="Assets tracked by tag and consumables counted by location. Every change is kept in the item's history." />
      {lowCount > 0 && !lowOnly && (
        <p className="mb-4 text-sm">
          <Link href="/school/inventory?show=low" className="font-medium text-amber-800 hover:underline">
            {lowCount} item{lowCount === 1 ? " is" : "s are"} at or below the reorder level
          </Link>
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Items" />
            <FilterBar
              basePath="/school/inventory"
              search={search}
              searchLabel="Search item, category, tag or serial number"
              selects={[
                { name: "kind", label: "Kind", value: kind, options: [{ value: "", label: "All" }, { value: "asset", label: "Assets" }, { value: "consumable", label: "Consumables" }] },
                { name: "show", label: "Show", value: lowOnly ? "low" : "", options: [{ value: "", label: "All items" }, { value: "low", label: "Low stock" }] },
              ]}
            />
            <DataTable caption="Items" columns={columns} rows={items} rowKey={(r) => r.id} empty={{ title: search || kind || lowOnly ? "No matching items" : "No items yet", body: search || kind || lowOnly ? "Try different filters." : "Add a location, then the first item." }} />
          </Card>
          <Card>
            <CardHeader title="Allocated to staff" description="Overdue returns first." />
            <DataTable caption="Allocated to staff" columns={allocColumns} rows={allocations} rowKey={(r) => r.assetId} empty={{ title: "Nothing allocated" }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Add an item" />
            {locations.length === 0 ? (
              <p className="p-5 text-sm text-slate-600">Add a location first.</p>
            ) : (
              <ActionForm action={createItemAction} className="space-y-4 p-5">
                <Field label="Name" htmlFor="item-name">
                  <Input id="item-name" name="name" required maxLength={120} />
                </Field>
                <Field label="Kind" htmlFor="item-kind" hint="Assets are tracked one by one by tag; consumables are counted.">
                  <Select id="item-kind" name="kind" defaultValue="asset">
                    <option value="asset">Asset (tracked by tag)</option>
                    <option value="consumable">Consumable (counted)</option>
                  </Select>
                </Field>
                <Field label="Category (optional)" htmlFor="item-category">
                  <Input id="item-category" name="category" maxLength={80} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Unit (consumables)" htmlFor="item-unit" hint="For example boxes or reams.">
                    <Input id="item-unit" name="unit" maxLength={30} />
                  </Field>
                  <Field label="Reorder level (consumables)" htmlFor="item-reorder">
                    <Input id="item-reorder" name="reorderLevel" type="number" min={0} max={100000} />
                  </Field>
                </div>
                <SubmitButton pendingText="Adding…">Add item</SubmitButton>
              </ActionForm>
            )}
          </Card>
          <Card>
            <CardHeader title="Locations" />
            {locations.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {locations.map((l) => (
                  <li key={l.id} className="px-5 py-2.5 text-slate-800">
                    {l.name}
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={createLocationAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 p-5">
              <Field label="New location" htmlFor="location-name" className="min-w-40 flex-1">
                <Input id="location-name" name="name" required maxLength={80} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Adding…">Add location</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
