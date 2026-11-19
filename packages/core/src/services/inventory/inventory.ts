import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { inventoryAllocations, inventoryAssetEvents, inventoryAssets, inventoryItems, inventoryLocations, inventoryMovements, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { schoolToday } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";

/**
 * Inventory (Phase 13.3), run by school administrators.
 *
 * - Locations (store room, labs) and items. An item is an asset type, whose units are tracked
 *   one by one by a tag unique in the school, or a consumable, counted per location.
 * - Assets are in store, allocated to one staff member, under repair or disposed (final). One
 *   open allocation per asset is enforced in the database.
 * - Stock is received, issued, transferred and adjusted after a count (with a reason). A balance
 *   never goes below zero: the row is locked and checked here, and a check constraint backs it.
 * - Every stock change is an append-only movement with the balance after it; every asset
 *   change an append-only asset event.
 */

const CAP = "school.inventory.manage";
const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();
const tagField = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/, "Tag: up to 30 letters, digits, / _ or -.");
const quantityField = (label: string) => z.coerce.number({ message: `${label}: enter a whole number.` }).int(`${label}: enter a whole number.`).min(1, `${label}: at least 1.`).max(100_000, `${label}: at most 100,000.`);

/* ------------------------------------------------------------------ locations */

export interface LocationRow {
  id: string;
  name: string;
  archived: boolean;
}

export async function listLocations(db: Db, ctx: RequestContext, schoolId: string): Promise<LocationRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const rows = await tx
      .select({ id: inventoryLocations.id, name: inventoryLocations.name, archivedAt: inventoryLocations.archivedAt })
      .from(inventoryLocations)
      .where(eq(inventoryLocations.schoolId, schoolId))
      .orderBy(sql`${inventoryLocations.archivedAt} is not null`, sql`lower(${inventoryLocations.name})`);
    return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null }));
  });
}

export async function createLocation(db: Db, ctx: RequestContext, schoolId: string, name: string): Promise<{ id: string }> {
  const v = parse(trimmed("Location", 1, 80), name);
  try {
    return await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const [l] = await tx.insert(inventoryLocations).values({ schoolId, name: v }).returning({ id: inventoryLocations.id });
      await audit(tx, { action: "inventory.location_added", actorUserId: actor.userId, schoolId, entityType: "inventory_location", entityId: l!.id, data: { name: v } });
      return { id: l!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("inventory_locations_name")) throw new AppError("CONFLICT", "A location with this name already exists.", { name: "Already used." });
    throw e;
  }
}

async function activeLocation(tx: Tx, schoolId: string, locationId: string, field = "locationId") {
  parse(uuidField("Location"), locationId);
  const [l] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.schoolId, schoolId), eq(inventoryLocations.id, locationId), isNull(inventoryLocations.archivedAt)));
  if (!l) throw new AppError("NOT_FOUND", "Location not found.", { [field]: "Choose a location." });
  return l;
}

/* ------------------------------------------------------------------ items */

const itemSchema = z.object({
  name: trimmed("Name", 1, 120),
  category: optionalText("Category", 80),
  unit: optionalText("Unit", 30),
  reorderLevel: z.union([z.literal("").transform(() => null), z.coerce.number().int("Reorder level: a whole number.").min(0, "Reorder level: 0 or more.").max(100_000, "Reorder level: at most 100,000.")]).nullable().optional(),
});

export async function createItem(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof itemSchema> & { kind: string }): Promise<{ id: string }> {
  const kind = parse(z.enum(["asset", "consumable"], { message: "Choose asset or consumable." }), input.kind);
  const v = parse(itemSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const [i] = await tx
        .insert(inventoryItems)
        .values({
          schoolId,
          name: v.name,
          kind,
          category: v.category ?? null,
          unit: kind === "consumable" ? (v.unit ?? "pieces") : null,
          reorderLevel: kind === "consumable" ? (v.reorderLevel ?? null) : null,
          createdBy: actor.userId,
        })
        .returning({ id: inventoryItems.id });
      await audit(tx, { action: "inventory.item_added", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: i!.id, data: { name: v.name, kind } });
      return { id: i!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("inventory_items_name")) throw new AppError("CONFLICT", "An item with this name already exists.", { name: "Already used." });
    throw e;
  }
}

export async function updateItem(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: z.input<typeof itemSchema>): Promise<void> {
  parse(uuidField("Item"), itemId);
  const v = parse(itemSchema, input);
  try {
    await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const item = await lockItem(tx, schoolId, itemId);
      const consumable = item.kind === "consumable";
      await tx
        .update(inventoryItems)
        .set({ name: v.name, category: v.category ?? null, unit: consumable ? (v.unit ?? item.unit ?? "pieces") : null, reorderLevel: consumable ? (v.reorderLevel ?? null) : null })
        .where(eq(inventoryItems.id, itemId));
      await audit(tx, { action: "inventory.item_updated", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId });
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("inventory_items_name")) throw new AppError("CONFLICT", "An item with this name already exists.", { name: "Already used." });
    throw e;
  }
}

/** Archives an item with no stock and no asset other than disposed ones; or brings it back. */
export async function setItemArchived(db: Db, ctx: RequestContext, schoolId: string, itemId: string, archived: boolean): Promise<void> {
  parse(uuidField("Item"), itemId);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await lockItem(tx, schoolId, itemId, { allowArchived: true });
    if (archived) {
      const [c] = (await tx.execute(sql`
        select (select count(*)::int from inventory_assets where item_id = ${itemId}::uuid and status <> 'disposed') as assets,
               (select coalesce(sum(quantity), 0)::int from inventory_stock where item_id = ${itemId}::uuid) as stock`)) as unknown as { assets: number; stock: number }[];
      if ((c?.assets ?? 0) > 0 || (c?.stock ?? 0) > 0) throw new AppError("CONFLICT", "Only an item with no stock and no assets in use can be archived.");
    }
    await tx.update(inventoryItems).set({ archivedAt: archived ? sql`now()` : null }).where(eq(inventoryItems.id, itemId));
    await audit(tx, { action: archived ? "inventory.item_archived" : "inventory.item_restored", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId });
  });
}

async function lockItem(tx: Tx, schoolId: string, itemId: string, opts: { kind?: "asset" | "consumable"; allowArchived?: boolean } = {}) {
  parse(uuidField("Item"), itemId);
  const [i] = await tx.select().from(inventoryItems).where(and(eq(inventoryItems.schoolId, schoolId), eq(inventoryItems.id, itemId))).for("update");
  if (!i) throw new AppError("NOT_FOUND", "Item not found.");
  if (i.archivedAt && !opts.allowArchived) throw new AppError("CONFLICT", "This item is archived.");
  if (opts.kind && i.kind !== opts.kind) throw new AppError("VALIDATION", i.kind === "asset" ? "This item is tracked by tag, not counted." : "This item is counted, not tracked by tag.");
  return i;
}

export interface ItemRow {
  id: string;
  name: string;
  kind: "asset" | "consumable";
  category: string | null;
  unit: string | null;
  reorderLevel: number | null;
  archived: boolean;
  inStore: number;
  allocated: number;
  underRepair: number;
  stock: number;
  low: boolean;
}

export async function listItems(db: Db, ctx: RequestContext, schoolId: string, f: { search?: string; kind?: string; lowOnly?: boolean } = {}): Promise<ItemRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const q = f.search?.trim().slice(0, 100) ?? "";
    const kind = f.kind === "asset" || f.kind === "consumable" ? f.kind : null;
    return (await tx.execute(sql`
      select * from (
        select i.id, i.name, i.kind::text as kind, i.category, i.unit, i.reorder_level as "reorderLevel", i.archived_at is not null as archived,
               coalesce(a.in_store, 0)::int as "inStore", coalesce(a.allocated, 0)::int as allocated, coalesce(a.repair, 0)::int as "underRepair",
               coalesce(s.total, 0)::int as stock,
               (i.kind = 'consumable' and i.reorder_level is not null and i.archived_at is null and coalesce(s.total, 0) <= i.reorder_level) as low
        from inventory_items i
        left join (select item_id, count(*) filter (where status = 'in_store') as in_store, count(*) filter (where status = 'allocated') as allocated,
                          count(*) filter (where status = 'under_repair') as repair
                   from inventory_assets where school_id = ${schoolId}::uuid group by item_id) a on a.item_id = i.id
        left join (select item_id, sum(quantity) as total from inventory_stock where school_id = ${schoolId}::uuid group by item_id) s on s.item_id = i.id
        where i.school_id = ${schoolId}::uuid
          ${kind ? sql`and i.kind = ${kind}::inventory_item_kind` : sql``}
          ${q ? sql`and (i.name ilike ${likePattern(q)} or i.category ilike ${likePattern(q)}
                    or exists (select 1 from inventory_assets x where x.item_id = i.id and (x.tag ilike ${likePattern(q)} or x.serial_no ilike ${likePattern(q)})))` : sql``}
      ) r
      ${f.lowOnly ? sql`where r.low` : sql``}
      order by r.archived, lower(r.name) limit 500`)) as unknown as ItemRow[];
  });
}

export interface ItemDetail {
  id: string;
  name: string;
  kind: "asset" | "consumable";
  category: string | null;
  unit: string | null;
  reorderLevel: number | null;
  archived: boolean;
  assets: { id: string; tag: string; serialNo: string | null; location: string; locationId: string; status: "in_store" | "allocated" | "under_repair" | "disposed"; note: string | null; holder: string | null; dueOn: string | null }[];
  stock: { locationId: string; location: string; quantity: number }[];
  movements: { kind: string; quantity: number; balanceAfter: number; location: string; otherLocation: string | null; staff: string | null; note: string | null; actor: string; at: Date }[];
  events: { tag: string; kind: string; location: string | null; staff: string | null; note: string | null; actor: string; at: Date }[];
}

const staffName = (alias: string) => sql.raw(`${alias}.display_name || ' (' || ${alias}.employee_no || ')'`);

export async function getItem(db: Db, ctx: RequestContext, schoolId: string, itemId: string): Promise<ItemDetail> {
  parse(uuidField("Item"), itemId);
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const [i] = await tx.select().from(inventoryItems).where(and(eq(inventoryItems.schoolId, schoolId), eq(inventoryItems.id, itemId)));
    if (!i) throw new AppError("NOT_FOUND", "Item not found.");
    const assets = (await tx.execute(sql`
      select a.id, a.tag, a.serial_no as "serialNo", l.name as location, a.location_id as "locationId", a.status::text as status, a.note,
             ${staffName("st")} as holder, al.due_on::text as "dueOn"
      from inventory_assets a join inventory_locations l on l.id = a.location_id
      left join inventory_allocations al on al.asset_id = a.id and al.returned_at is null
      left join staff_profiles st on st.id = al.staff_id
      where a.item_id = ${itemId}::uuid order by a.status = 'disposed', lower(a.tag) limit 1000`)) as unknown as ItemDetail["assets"];
    const stock = (await tx.execute(sql`
      select s.location_id as "locationId", l.name as location, s.quantity from inventory_stock s join inventory_locations l on l.id = s.location_id
      where s.item_id = ${itemId}::uuid order by lower(l.name)`)) as unknown as ItemDetail["stock"];
    const movements = ((await tx.execute(sql`
      select m.kind::text as kind, m.quantity, m.balance_after as "balanceAfter", l.name as location, ol.name as "otherLocation", ${staffName("st")} as staff, m.note, u.full_name as actor, m.at
      from inventory_movements m join inventory_locations l on l.id = m.location_id left join inventory_locations ol on ol.id = m.other_location_id
      left join staff_profiles st on st.id = m.staff_id join users u on u.id = m.actor_user_id
      where m.item_id = ${itemId}::uuid order by m.at desc, m.id limit 100`)) as unknown as ItemDetail["movements"]).map((m) => ({ ...m, at: new Date(m.at) }));
    const events = ((await tx.execute(sql`
      select a.tag, e.kind::text as kind, l.name as location, ${staffName("st")} as staff, e.note, u.full_name as actor, e.at
      from inventory_asset_events e join inventory_assets a on a.id = e.asset_id left join inventory_locations l on l.id = e.location_id
      left join staff_profiles st on st.id = e.staff_id join users u on u.id = e.actor_user_id
      where a.item_id = ${itemId}::uuid order by e.at desc, e.id limit 100`)) as unknown as ItemDetail["events"]).map((e) => ({ ...e, at: new Date(e.at) }));
    return { id: i.id, name: i.name, kind: i.kind, category: i.category, unit: i.unit, reorderLevel: i.reorderLevel, archived: i.archivedAt !== null, assets, stock, movements, events };
  });
}

/* ------------------------------------------------------------------ assets */

/** Splits "LAP-01, LAP-02" or one per line into tags. */
export function parseTagList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

async function assetEvent(tx: Tx, schoolId: string, actorUserId: string, assetId: string, kind: (typeof inventoryAssetEvents.$inferInsert)["kind"], extra: { locationId?: string | null; staffId?: string | null; note?: string | null } = {}) {
  await tx.insert(inventoryAssetEvents).values({ schoolId, assetId, kind, locationId: extra.locationId ?? null, staffId: extra.staffId ?? null, note: extra.note ?? null, actorUserId });
}

export async function addAssets(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: { tags: string; serialNo?: string; locationId: string }): Promise<{ added: number }> {
  const tags = parseTagList(input.tags).map((t) => parse(tagField, t));
  if (tags.length === 0) throw new AppError("VALIDATION", "Enter at least one tag.", { tags: "Required." });
  if (tags.length > 200) throw new AppError("VALIDATION", "At most 200 assets at a time.", { tags: "Too many." });
  const serial = parse(optionalText("Serial number", 60), input.serialNo ?? "");
  if (serial && tags.length > 1) throw new AppError("VALIDATION", "A serial number can be given only when adding one asset.", { serialNo: "One asset only." });
  try {
    return await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      await lockItem(tx, schoolId, itemId, { kind: "asset" });
      const loc = await activeLocation(tx, schoolId, input.locationId);
      for (const tag of tags) {
        const [a] = await tx.insert(inventoryAssets).values({ schoolId, itemId, tag, serialNo: serial ?? null, locationId: loc.id }).returning({ id: inventoryAssets.id });
        await assetEvent(tx, schoolId, actor.userId, a!.id, "added", { locationId: loc.id });
      }
      await audit(tx, { action: "inventory.assets_added", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId, data: { added: tags.length } });
      return { added: tags.length };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("inventory_assets_tag")) throw new AppError("CONFLICT", "One of these tags is already used.", { tags: "Already used." });
    throw e;
  }
}

async function lockAsset(tx: Tx, schoolId: string, by: { tag: string } | { id: string }) {
  const where =
    "tag" in by
      ? sql`a.school_id = ${schoolId}::uuid and lower(a.tag) = lower(${by.tag.trim()})`
      : sql`a.school_id = ${schoolId}::uuid and a.id = ${parse(uuidField("Asset"), by.id)}::uuid`;
  const [a] = (await tx.execute(sql`
    select a.id, a.tag, a.status::text as status, a.location_id as "locationId", a.item_id as "itemId", i.name as "itemName"
    from inventory_assets a join inventory_items i on i.id = a.item_id where ${where} for update of a`)) as unknown as { id: string; tag: string; status: string; locationId: string; itemId: string; itemName: string }[];
  if (!a) throw new AppError("NOT_FOUND", "No asset has that tag.", { tag: "Not found." });
  if (a.status === "disposed") throw new AppError("CONFLICT", "This asset has been disposed of.");
  return a;
}

async function findStaff(tx: Tx, schoolId: string, employeeNo: string, field = "staff") {
  const key = employeeNo.trim();
  if (!key) throw new AppError("VALIDATION", "Enter the staff member's employee number.", { [field]: "Required." });
  const [s] = (await tx.execute(sql`select id, display_name as name, status::text as status from staff_profiles where school_id = ${schoolId}::uuid and lower(employee_no) = lower(${key})`)) as unknown as { id: string; name: string; status: string }[];
  if (!s) throw new AppError("NOT_FOUND", "No staff member has that employee number.", { [field]: "Not found." });
  if (s.status !== "active") throw new AppError("CONFLICT", `${s.name} has left the school.`, { [field]: "Not active." });
  return s;
}

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

/** Gives an asset in store to a staff member, optionally until a date. */
export async function allocateAsset(db: Db, ctx: RequestContext, schoolId: string, input: { tag: string; staff: string; dueOn?: string; note?: string }): Promise<{ itemName: string; staffName: string }> {
  const dueOn = input.dueOn?.trim() ? parse(isoDate("return date"), input.dueOn) : null;
  const note = parse(optionalText("Note", 300), input.note ?? "");
  try {
    return await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const a = await lockAsset(tx, schoolId, { tag: input.tag });
      if (a.status !== "in_store") throw new AppError("CONFLICT", a.status === "allocated" ? "This asset is already allocated." : "This asset is under repair.", { tag: "Not in store." });
      const s = await findStaff(tx, schoolId, input.staff);
      if (dueOn && dueOn < (await schoolDay(tx, schoolId))) throw new AppError("VALIDATION", "The return date cannot be in the past.", { dueOn: "In the past." });
      await tx.insert(inventoryAllocations).values({ schoolId, assetId: a.id, staffId: s.id, allocatedBy: actor.userId, dueOn });
      await tx.update(inventoryAssets).set({ status: "allocated", updatedAt: sql`now()` }).where(eq(inventoryAssets.id, a.id));
      await assetEvent(tx, schoolId, actor.userId, a.id, "allocated", { staffId: s.id, note });
      await audit(tx, { action: "inventory.asset_allocated", actorUserId: actor.userId, schoolId, entityType: "inventory_asset", entityId: a.id, data: { staffId: s.id, dueOn } });
      return { itemName: a.itemName, staffName: s.name };
    });
  } catch (e) {
    // Two allocations of the same asset at once: the second is refused by the database.
    if (uniqueViolation(e)?.includes("inventory_allocations_one_open_per_asset")) throw new AppError("CONFLICT", "This asset is already allocated.");
    throw e;
  }
}

/** Takes an allocated asset back into store at a location. */
export async function returnAsset(db: Db, ctx: RequestContext, schoolId: string, input: { tag: string; locationId: string; note?: string }): Promise<{ itemName: string }> {
  const note = parse(optionalText("Note", 300), input.note ?? "");
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const a = await lockAsset(tx, schoolId, { tag: input.tag });
    if (a.status !== "allocated") throw new AppError("CONFLICT", "This asset is not allocated.", { tag: "Not allocated." });
    const loc = await activeLocation(tx, schoolId, input.locationId);
    const r = await tx
      .update(inventoryAllocations)
      .set({ returnedAt: sql`now()`, returnedBy: actor.userId, returnNote: note ?? null })
      .where(and(eq(inventoryAllocations.assetId, a.id), isNull(inventoryAllocations.returnedAt)))
      .returning({ staffId: inventoryAllocations.staffId });
    await tx.update(inventoryAssets).set({ status: "in_store", locationId: loc.id, updatedAt: sql`now()` }).where(eq(inventoryAssets.id, a.id));
    await assetEvent(tx, schoolId, actor.userId, a.id, "returned", { locationId: loc.id, staffId: r[0]?.staffId ?? null, note });
    await audit(tx, { action: "inventory.asset_returned", actorUserId: actor.userId, schoolId, entityType: "inventory_asset", entityId: a.id, data: { locationId: loc.id } });
    return { itemName: a.itemName };
  });
}

/** Moves an asset that is in store or under repair to another location. */
export async function moveAsset(db: Db, ctx: RequestContext, schoolId: string, assetId: string, locationId: string, note?: string): Promise<void> {
  const why = parse(optionalText("Note", 300), note ?? "");
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const a = await lockAsset(tx, schoolId, { id: assetId });
    if (a.status === "allocated") throw new AppError("CONFLICT", "This asset is allocated. Take it back first.");
    const loc = await activeLocation(tx, schoolId, locationId);
    if (loc.id === a.locationId) return;
    await tx.update(inventoryAssets).set({ locationId: loc.id, updatedAt: sql`now()` }).where(eq(inventoryAssets.id, a.id));
    await assetEvent(tx, schoolId, actor.userId, a.id, "moved", { locationId: loc.id, note: why });
    await audit(tx, { action: "inventory.asset_moved", actorUserId: actor.userId, schoolId, entityType: "inventory_asset", entityId: a.id, data: { from: a.locationId, to: loc.id } });
  });
}

/** Sends an asset in store for repair, or brings a repaired one back into store. */
export async function setAssetRepair(db: Db, ctx: RequestContext, schoolId: string, assetId: string, toRepair: boolean, note?: string): Promise<void> {
  const why = parse(optionalText("Note", 300), note ?? "");
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const a = await lockAsset(tx, schoolId, { id: assetId });
    const from = toRepair ? "in_store" : "under_repair";
    if (a.status !== from) throw new AppError("CONFLICT", toRepair ? "Only an asset in store can be sent for repair." : "This asset is not under repair.");
    await tx.update(inventoryAssets).set({ status: toRepair ? "under_repair" : "in_store", updatedAt: sql`now()` }).where(eq(inventoryAssets.id, a.id));
    await assetEvent(tx, schoolId, actor.userId, a.id, toRepair ? "repair" : "repaired", { note: why });
    await audit(tx, { action: toRepair ? "inventory.asset_repair" : "inventory.asset_repaired", actorUserId: actor.userId, schoolId, entityType: "inventory_asset", entityId: a.id });
  });
}

/** Disposes of an asset that is not allocated. Final. */
export async function disposeAsset(db: Db, ctx: RequestContext, schoolId: string, assetId: string, reason: string): Promise<void> {
  const why = parse(trimmed("Reason", 3, 300), reason);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const a = await lockAsset(tx, schoolId, { id: assetId });
    if (a.status === "allocated") throw new AppError("CONFLICT", "This asset is allocated. Take it back first.");
    await tx.update(inventoryAssets).set({ status: "disposed", note: why, updatedAt: sql`now()` }).where(eq(inventoryAssets.id, a.id));
    await assetEvent(tx, schoolId, actor.userId, a.id, "disposed", { note: why });
    await audit(tx, { action: "inventory.asset_disposed", actorUserId: actor.userId, schoolId, entityType: "inventory_asset", entityId: a.id, data: { reason: why } });
  });
}

export interface AllocationRow {
  assetId: string;
  tag: string;
  itemId: string;
  itemName: string;
  staff: string;
  allocatedAt: Date;
  dueOn: string | null;
  overdue: boolean;
}

/** Assets currently with staff, overdue returns first. */
export async function listAllocations(db: Db, ctx: RequestContext, schoolId: string, f: { search?: string } = {}): Promise<AllocationRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const t = await schoolDay(tx, schoolId);
    const q = f.search?.trim().slice(0, 100) ?? "";
    const rows = (await tx.execute(sql`
      select a.id as "assetId", a.tag, i.id as "itemId", i.name as "itemName", ${staffName("st")} as staff, al.allocated_at as "allocatedAt", al.due_on::text as "dueOn",
             coalesce(al.due_on < ${t}::date, false) as overdue
      from inventory_allocations al join inventory_assets a on a.id = al.asset_id join inventory_items i on i.id = a.item_id join staff_profiles st on st.id = al.staff_id
      where al.school_id = ${schoolId}::uuid and al.returned_at is null
        ${q ? sql`and (a.tag ilike ${likePattern(q)} or i.name ilike ${likePattern(q)} or st.display_name ilike ${likePattern(q)} or st.employee_no ilike ${likePattern(q)})` : sql``}
      order by coalesce(al.due_on < ${t}::date, false) desc, al.due_on nulls last, lower(i.name) limit 500`)) as unknown as AllocationRow[];
    return rows.map((r) => ({ ...r, allocatedAt: new Date(r.allocatedAt) }));
  });
}

/* ------------------------------------------------------------------ stock */

type MovementKind = (typeof inventoryMovements.$inferInsert)["kind"];

/**
 * Changes one balance by `delta` under a row lock and records the movement. Refuses to go
 * below zero (the check constraint inventory_stock_not_negative backs this up).
 */
async function changeStock(
  tx: Tx,
  schoolId: string,
  actorUserId: string,
  itemId: string,
  locationId: string,
  delta: number,
  kind: MovementKind,
  extra: { staffId?: string | null; otherLocationId?: string | null; note?: string | null; locationName?: string } = {},
): Promise<number> {
  await tx.execute(sql`insert into inventory_stock (school_id, item_id, location_id, quantity) values (${schoolId}::uuid, ${itemId}::uuid, ${locationId}::uuid, 0) on conflict do nothing`);
  const [row] = (await tx.execute(sql`select quantity from inventory_stock where item_id = ${itemId}::uuid and location_id = ${locationId}::uuid for update`)) as unknown as { quantity: number }[];
  const current = row?.quantity ?? 0;
  const after = current + delta;
  if (after < 0) throw new AppError("CONFLICT", `Only ${current} in stock${extra.locationName ? ` at ${extra.locationName}` : ""}.`, { quantity: `At most ${current}.` });
  await tx.execute(sql`update inventory_stock set quantity = ${after}, updated_at = now() where item_id = ${itemId}::uuid and location_id = ${locationId}::uuid`);
  await tx.insert(inventoryMovements).values({ schoolId, itemId, locationId, kind, quantity: delta, balanceAfter: after, staffId: extra.staffId ?? null, otherLocationId: extra.otherLocationId ?? null, note: extra.note ?? null, actorUserId });
  return after;
}

/** A location that may already be archived (stock can still leave it). */
async function stockLocation(tx: Tx, schoolId: string, locationId: string, field = "locationId") {
  parse(uuidField("Location"), locationId);
  const [l] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.schoolId, schoolId), eq(inventoryLocations.id, locationId)));
  if (!l) throw new AppError("NOT_FOUND", "Location not found.", { [field]: "Choose a location." });
  return l;
}

export async function receiveStock(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: { locationId: string; quantity: string | number; note?: string }): Promise<{ balance: number }> {
  const qty = parse(quantityField("Quantity"), input.quantity);
  const note = parse(optionalText("Note", 300), input.note ?? "");
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await lockItem(tx, schoolId, itemId, { kind: "consumable" });
    const loc = await activeLocation(tx, schoolId, input.locationId);
    const balance = await changeStock(tx, schoolId, actor.userId, itemId, loc.id, qty, "received", { note });
    await audit(tx, { action: "inventory.stock_received", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId, data: { locationId: loc.id, quantity: qty } });
    return { balance };
  });
}

/** Issues stock to a staff member (employee number) or for a stated purpose. */
export async function issueStock(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: { locationId: string; quantity: string | number; staff?: string; note?: string }): Promise<{ balance: number }> {
  const qty = parse(quantityField("Quantity"), input.quantity);
  const note = parse(optionalText("Purpose", 300), input.note ?? "");
  if (!input.staff?.trim() && !note) throw new AppError("VALIDATION", "Enter who receives it (employee number) or the purpose.", { note: "Required without a staff member." });
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await lockItem(tx, schoolId, itemId, { kind: "consumable" });
    const loc = await stockLocation(tx, schoolId, input.locationId);
    const staff = input.staff?.trim() ? await findStaff(tx, schoolId, input.staff) : null;
    const balance = await changeStock(tx, schoolId, actor.userId, itemId, loc.id, -qty, "issued", { staffId: staff?.id, note, locationName: loc.name });
    await audit(tx, { action: "inventory.stock_issued", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId, data: { locationId: loc.id, quantity: qty, staffId: staff?.id ?? null } });
    return { balance };
  });
}

export async function transferStock(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: { fromLocationId: string; toLocationId: string; quantity: string | number; note?: string }): Promise<void> {
  const qty = parse(quantityField("Quantity"), input.quantity);
  const note = parse(optionalText("Note", 300), input.note ?? "");
  if (input.fromLocationId === input.toLocationId) throw new AppError("VALIDATION", "Choose two different locations.", { toLocationId: "Same as the source." });
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await lockItem(tx, schoolId, itemId, { kind: "consumable" });
    const from = await stockLocation(tx, schoolId, input.fromLocationId, "fromLocationId");
    const to = await activeLocation(tx, schoolId, input.toLocationId, "toLocationId");
    // Lock both balances in a fixed order so two opposite transfers cannot deadlock.
    for (const id of [from.id, to.id].sort()) await tx.execute(sql`insert into inventory_stock (school_id, item_id, location_id, quantity) values (${schoolId}::uuid, ${itemId}::uuid, ${id}::uuid, 0) on conflict do nothing`);
    for (const id of [from.id, to.id].sort()) await tx.execute(sql`select 1 from inventory_stock where item_id = ${itemId}::uuid and location_id = ${id}::uuid for update`);
    await changeStock(tx, schoolId, actor.userId, itemId, from.id, -qty, "transfer_out", { otherLocationId: to.id, note, locationName: from.name });
    await changeStock(tx, schoolId, actor.userId, itemId, to.id, qty, "transfer_in", { otherLocationId: from.id, note });
    await audit(tx, { action: "inventory.stock_transferred", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId, data: { from: from.id, to: to.id, quantity: qty } });
  });
}

/** Sets a balance to the physically counted quantity, recording the difference with a reason. */
export async function adjustStock(db: Db, ctx: RequestContext, schoolId: string, itemId: string, input: { locationId: string; counted: string | number; reason: string }): Promise<{ difference: number }> {
  const counted = parse(z.coerce.number({ message: "Counted quantity: enter a whole number." }).int("Counted quantity: enter a whole number.").min(0, "Counted quantity: 0 or more.").max(1_000_000, "Counted quantity: at most 1,000,000."), input.counted);
  const reason = parse(trimmed("Reason", 3, 300), input.reason);
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    await lockItem(tx, schoolId, itemId, { kind: "consumable" });
    const loc = await stockLocation(tx, schoolId, input.locationId);
    await tx.execute(sql`insert into inventory_stock (school_id, item_id, location_id, quantity) values (${schoolId}::uuid, ${itemId}::uuid, ${loc.id}::uuid, 0) on conflict do nothing`);
    const [row] = (await tx.execute(sql`select quantity from inventory_stock where item_id = ${itemId}::uuid and location_id = ${loc.id}::uuid for update`)) as unknown as { quantity: number }[];
    const difference = counted - (row?.quantity ?? 0);
    if (difference === 0) return { difference };
    await changeStock(tx, schoolId, actor.userId, itemId, loc.id, difference, "adjusted", { note: reason });
    await audit(tx, { action: "inventory.stock_adjusted", actorUserId: actor.userId, schoolId, entityType: "inventory_item", entityId: itemId, data: { locationId: loc.id, difference, reason } });
    return { difference };
  });
}
