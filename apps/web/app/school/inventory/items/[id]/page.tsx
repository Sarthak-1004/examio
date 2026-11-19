import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getItem, listLocations, type ItemDetail, type LocationRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { addAssetsAction, allocateAction, archiveItemAction, assetAction, returnAssetAction, stockAction, updateItemAction } from "../../actions";

export const metadata: Metadata = { title: "Inventory item" };

type Asset = ItemDetail["assets"][number];
type Movement = ItemDetail["movements"][number];
type AssetEvent = ItemDetail["events"][number];

const STATUS: Record<Asset["status"], { label: string; tone: "green" | "blue" | "amber" | "slate" }> = {
  in_store: { label: "In store", tone: "green" },
  allocated: { label: "Allocated", tone: "blue" },
  under_repair: { label: "Under repair", tone: "amber" },
  disposed: { label: "Disposed", tone: "slate" },
};
const MOVEMENT: Record<string, string> = { received: "Received", issued: "Issued", transfer_out: "Transferred out", transfer_in: "Transferred in", adjusted: "Count adjustment" };
const EVENT: Record<string, string> = { added: "Added", moved: "Moved", allocated: "Allocated", returned: "Returned", repair: "Sent for repair", repaired: "Back from repair", disposed: "Disposed" };

function LocationSelect({ id, name, locations, label = "Location" }: { id: string; name: string; locations: LocationRow[]; label?: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} name={name} required defaultValue="">
        <option value="" disabled>
          Choose…
        </option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const { id } = await params;
  const [item, allLocations] = await Promise.all([
    getItem(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
      if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
      throw e;
    }),
    listLocations(db, s.ctx, s.ctx.schoolId),
  ]);
  const locations = allLocations.filter((l) => !l.archived);
  const isAsset = item.kind === "asset";
  const unit = item.unit ?? "";
  const active = !item.archived;

  const assetColumns: Column<Asset>[] = [
    { key: "tag", header: "Tag", primary: true, cell: (a) => a.tag },
    { key: "serial", header: "Serial no.", secondary: true, cell: (a) => a.serialNo ?? "—" },
    { key: "status", header: "Status", cell: (a) => <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge> },
    { key: "where", header: "Where", cell: (a) => (a.holder ? `${a.holder}${a.dueOn ? `, until ${a.dueOn}` : ""}` : a.status === "disposed" ? (a.note ?? "—") : a.location) },
    {
      key: "act",
      header: "Actions",
      cell: (a) =>
        a.status === "disposed" || a.status === "allocated" ? (
          "—"
        ) : (
          <details className="text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Change ${a.tag}`}</summary>
            <ActionForm action={assetAction} className="mt-2 w-64 space-y-3">
              <input type="hidden" name="assetId" value={a.id} />
              <Field label="Action" htmlFor={`op-${a.id}`}>
                <Select id={`op-${a.id}`} name="op" defaultValue="move">
                  <option value="move">Move to another location</option>
                  {a.status === "in_store" ? <option value="repair">Send for repair</option> : <option value="repaired">Back from repair</option>}
                  <option value="dispose">Dispose of (final)</option>
                </Select>
              </Field>
              <Field label="New location (for a move)" htmlFor={`loc-${a.id}`}>
                <Select id={`loc-${a.id}`} name="locationId" defaultValue={a.locationId}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note (reason required to dispose)" htmlFor={`note-${a.id}`}>
                <Input id={`note-${a.id}`} name="note" maxLength={300} />
              </Field>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Apply
              </SubmitButton>
            </ActionForm>
          </details>
        ),
    },
  ];
  const stockColumns: Column<ItemDetail["stock"][number]>[] = [
    { key: "loc", header: "Location", primary: true, cell: (r) => r.location },
    { key: "qty", header: "Quantity", align: "right", cell: (r) => `${r.quantity} ${unit}`.trim() },
  ];
  const movementColumns: Column<Movement>[] = [
    { key: "at", header: "When", primary: true, cell: (m) => formatDateTime(m.at, s.timeZone) },
    { key: "kind", header: "Change", cell: (m) => `${MOVEMENT[m.kind] ?? m.kind} ${m.quantity > 0 ? "+" : ""}${m.quantity}` },
    { key: "loc", header: "Location", cell: (m) => (m.otherLocation ? `${m.location} (${m.kind === "transfer_out" ? "to" : "from"} ${m.otherLocation})` : m.location) },
    { key: "bal", header: "Balance", align: "right", cell: (m) => m.balanceAfter },
    { key: "detail", header: "Details", secondary: true, cell: (m) => [m.staff, m.note].filter(Boolean).join(" · ") || "—" },
    { key: "by", header: "By", secondary: true, cell: (m) => m.actor },
  ];
  const eventColumns: Column<AssetEvent>[] = [
    { key: "at", header: "When", primary: true, cell: (e) => formatDateTime(e.at, s.timeZone) },
    { key: "tag", header: "Tag", cell: (e) => e.tag },
    { key: "kind", header: "Change", cell: (e) => EVENT[e.kind] ?? e.kind },
    { key: "detail", header: "Details", cell: (e) => [e.staff, e.location, e.note].filter(Boolean).join(" · ") || "—" },
    { key: "by", header: "By", secondary: true, cell: (e) => e.actor },
  ];

  return (
    <>
      <PageHeader
        title={item.name}
        description={[isAsset ? "Asset, tracked by tag" : `Consumable, counted in ${unit}`, item.category, item.reorderLevel !== null ? `reorder at ${item.reorderLevel}` : null, item.archived ? "archived" : null].filter(Boolean).join(" · ")}
        action={<Link href="/school/inventory" className="text-sm font-medium text-brand-700 hover:underline">Inventory</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {isAsset ? (
            <>
              <Card>
                <CardHeader title="Assets" />
                <DataTable caption="Assets" columns={assetColumns} rows={item.assets} rowKey={(a) => a.id} empty={{ title: "No assets yet", body: "Add assets with their tags." }} />
              </Card>
              <Card>
                <CardHeader title="History" description="The last 100 changes." />
                <DataTable caption="Asset history" columns={eventColumns} rows={item.events} rowKey={(e) => `${e.tag}-${e.at.toISOString()}-${e.kind}`} empty={{ title: "No changes yet" }} />
              </Card>
            </>
          ) : (
            <>
              <Card>
                <CardHeader title="Stock by location" description={`${item.stock.reduce((a, r) => a + r.quantity, 0)} ${unit} in all.`} />
                <DataTable caption="Stock by location" columns={stockColumns} rows={item.stock} rowKey={(r) => r.locationId} empty={{ title: "No stock yet", body: "Receive the first delivery." }} />
              </Card>
              <Card>
                <CardHeader title="Movements" description="The last 100 changes; nothing is ever edited or deleted." />
                <DataTable caption="Stock movements" columns={movementColumns} rows={item.movements} rowKey={(m) => `${m.at.toISOString()}-${m.kind}-${m.location}`} empty={{ title: "No movements yet" }} />
              </Card>
            </>
          )}
        </div>
        <div className="min-w-0 space-y-6">
          {active && isAsset && (
            <>
              <Card>
                <CardHeader title="Allocate to staff" />
                <ActionForm action={allocateAction} className="space-y-4 p-5">
                  <Field label="Tag" htmlFor="alloc-tag">
                    <Input id="alloc-tag" name="tag" required autoComplete="off" />
                  </Field>
                  <Field label="Employee number" htmlFor="alloc-staff">
                    <Input id="alloc-staff" name="staff" required autoComplete="off" />
                  </Field>
                  <Field label="Return by (optional)" htmlFor="alloc-due">
                    <Input id="alloc-due" name="dueOn" type="date" />
                  </Field>
                  <Field label="Note (optional)" htmlFor="alloc-note">
                    <Input id="alloc-note" name="note" maxLength={300} />
                  </Field>
                  <SubmitButton pendingText="Allocating…">Allocate</SubmitButton>
                </ActionForm>
              </Card>
              <Card>
                <CardHeader title="Take back" />
                <ActionForm action={returnAssetAction} className="space-y-4 p-5">
                  <Field label="Tag" htmlFor="ret-tag">
                    <Input id="ret-tag" name="tag" required autoComplete="off" />
                  </Field>
                  <LocationSelect id="ret-loc" name="locationId" locations={locations} label="Back to location" />
                  <Field label="Condition note (optional)" htmlFor="ret-note">
                    <Input id="ret-note" name="note" maxLength={300} />
                  </Field>
                  <SubmitButton pendingText="Saving…">Take back</SubmitButton>
                </ActionForm>
              </Card>
              <Card>
                <CardHeader title="Add assets" />
                <ActionForm action={addAssetsAction} className="space-y-4 p-5">
                  <input type="hidden" name="itemId" value={item.id} />
                  <Field label="Tags" htmlFor="add-tags" hint="Separate with commas or new lines, for example LAP-01, LAP-02.">
                    <Textarea id="add-tags" name="tags" rows={2} required />
                  </Field>
                  <Field label="Serial number (one asset only, optional)" htmlFor="add-serial">
                    <Input id="add-serial" name="serialNo" maxLength={60} />
                  </Field>
                  <LocationSelect id="add-loc" name="locationId" locations={locations} />
                  <SubmitButton pendingText="Adding…">Add assets</SubmitButton>
                </ActionForm>
              </Card>
            </>
          )}
          {active && !isAsset && (
            <>
              <Card>
                <CardHeader title="Receive" />
                <ActionForm action={stockAction} className="space-y-4 p-5">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="op" value="receive" />
                  <LocationSelect id="rcv-loc" name="locationId" locations={locations} />
                  <Field label={`Quantity (${unit})`} htmlFor="rcv-qty">
                    <Input id="rcv-qty" name="quantity" type="number" min={1} max={100000} required />
                  </Field>
                  <Field label="Note, for example the supplier's invoice (optional)" htmlFor="rcv-note">
                    <Input id="rcv-note" name="note" maxLength={300} />
                  </Field>
                  <SubmitButton pendingText="Saving…">Receive</SubmitButton>
                </ActionForm>
              </Card>
              <Card>
                <CardHeader title="Issue" />
                <ActionForm action={stockAction} className="space-y-4 p-5">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="op" value="issue" />
                  <LocationSelect id="iss-loc" name="locationId" locations={allLocations} label="From location" />
                  <Field label={`Quantity (${unit})`} htmlFor="iss-qty">
                    <Input id="iss-qty" name="quantity" type="number" min={1} max={100000} required />
                  </Field>
                  <Field label="To staff member (employee number, optional)" htmlFor="iss-staff">
                    <Input id="iss-staff" name="staff" autoComplete="off" />
                  </Field>
                  <Field label="Purpose (needed without a staff member)" htmlFor="iss-note">
                    <Input id="iss-note" name="note" maxLength={300} />
                  </Field>
                  <SubmitButton pendingText="Saving…">Issue</SubmitButton>
                </ActionForm>
              </Card>
              <Card>
                <CardHeader title="Transfer" />
                <ActionForm action={stockAction} className="space-y-4 p-5">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="op" value="transfer" />
                  <LocationSelect id="tr-from" name="fromLocationId" locations={allLocations} label="From" />
                  <LocationSelect id="tr-to" name="toLocationId" locations={locations} label="To" />
                  <Field label={`Quantity (${unit})`} htmlFor="tr-qty">
                    <Input id="tr-qty" name="quantity" type="number" min={1} max={100000} required />
                  </Field>
                  <SubmitButton pendingText="Saving…">Transfer</SubmitButton>
                </ActionForm>
              </Card>
              <Card>
                <CardHeader title="Correct after a count" />
                <ActionForm action={stockAction} className="space-y-4 p-5">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="op" value="adjust" />
                  <LocationSelect id="adj-loc" name="locationId" locations={allLocations} />
                  <Field label={`Counted quantity (${unit})`} htmlFor="adj-count">
                    <Input id="adj-count" name="counted" type="number" min={0} required />
                  </Field>
                  <Field label="Reason" htmlFor="adj-reason">
                    <Input id="adj-reason" name="reason" required minLength={3} maxLength={300} />
                  </Field>
                  <SubmitButton pendingText="Saving…">Record count</SubmitButton>
                </ActionForm>
              </Card>
            </>
          )}
          <Card>
            <CardHeader title="Details" />
            <ActionForm action={updateItemAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="itemId" value={item.id} />
              <Field label="Name" htmlFor="ed-name">
                <Input id="ed-name" name="name" required maxLength={120} defaultValue={item.name} />
              </Field>
              <Field label="Category (optional)" htmlFor="ed-category">
                <Input id="ed-category" name="category" maxLength={80} defaultValue={item.category ?? ""} />
              </Field>
              {!isAsset && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Unit" htmlFor="ed-unit">
                    <Input id="ed-unit" name="unit" maxLength={30} defaultValue={unit} />
                  </Field>
                  <Field label="Reorder level" htmlFor="ed-reorder">
                    <Input id="ed-reorder" name="reorderLevel" type="number" min={0} max={100000} defaultValue={item.reorderLevel ?? ""} />
                  </Field>
                </div>
              )}
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </ActionForm>
            <ActionForm action={archiveItemAction} className="border-t border-slate-100 p-5">
              <input type="hidden" name="itemId" value={item.id} />
              <input type="hidden" name="archived" value={item.archived ? "0" : "1"} />
              <SubmitButton variant="secondary" pendingText="Saving…">
                {item.archived ? "Restore item" : "Archive item"}
              </SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
