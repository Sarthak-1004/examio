import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { inventoryAssets, inventoryMovements, inventoryStock, withContext, type RequestContext } from "@examio/db";
import { AppError } from "../src/errors";
import {
  addAssets,
  adjustStock,
  allocateAsset,
  createItem,
  createLocation,
  disposeAsset,
  getItem,
  issueStock,
  listAllocations,
  listItems,
  listLocations,
  moveAsset,
  receiveStock,
  returnAsset,
  setAssetRepair,
  setItemArchived,
  transferStock,
  updateItem,
} from "../src/services/inventory/inventory";
import { createStaffMember } from "../src/services/staff/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 13.3: inventory. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("inventory", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let teacher: RequestContext;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("iva");
    B = await makeSchool("ivb");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@inv.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const t = await createStaffMember(app.db, admin, A.id, { fullName: "Teacher Inv", email: `t-${randomUUID().slice(0, 6)}@inv.test`, employeeNo: "T-1", role: "teacher" });
    teacher = A.ctx(t.userId);
    await createStaffMember(app.db, admin, A.id, { fullName: "Lab Assistant", email: `l-${randomUUID().slice(0, 6)}@inv.test`, employeeNo: "T-2", role: "teacher" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("locations and items: unique names, administrators only", async () => {
    expect(await outcome(createLocation(app.db, teacher, A.id, "Store"))).toBe("FORBIDDEN");
    id.store = (await createLocation(app.db, admin, A.id, "Store room")).id;
    id.lab = (await createLocation(app.db, admin, A.id, "Science lab")).id;
    expect(await outcome(createLocation(app.db, admin, A.id, "store ROOM"))).toBe("CONFLICT");
    expect((await listLocations(app.db, admin, A.id)).map((l) => l.name)).toEqual(["Science lab", "Store room"]);
    id.laptop = (await createItem(app.db, admin, A.id, { name: "Laptop", kind: "asset", category: "IT" })).id;
    id.chalk = (await createItem(app.db, admin, A.id, { name: "Chalk box", kind: "consumable", unit: "boxes", reorderLevel: "5" })).id;
    expect(await outcome(createItem(app.db, admin, A.id, { name: "laptop", kind: "asset" }))).toBe("CONFLICT");
    expect(await outcome(createItem(app.db, admin, A.id, { name: "X", kind: "furniture" }))).toBe("VALIDATION");
    await updateItem(app.db, admin, A.id, id.laptop, { name: "Laptop", category: "Computers", unit: "ignored", reorderLevel: "3" });
    const items = await listItems(app.db, admin, A.id);
    expect(items.find((i) => i.name === "Laptop")).toMatchObject({ category: "Computers", unit: null, reorderLevel: null });
    expect(items.find((i) => i.name === "Chalk box")).toMatchObject({ unit: "boxes", reorderLevel: 5, stock: 0, low: true });
  });

  it("assets: added by unique tag, allocated once even when two requests race, returned, moved, repaired, disposed for good", async () => {
    expect(await addAssets(app.db, admin, A.id, id.laptop!, { tags: "LAP-01, LAP-02\nLAP-03", locationId: id.store! })).toEqual({ added: 3 });
    expect(await outcome(addAssets(app.db, admin, A.id, id.laptop!, { tags: "lap-01", locationId: id.store! }))).toBe("CONFLICT");
    expect(await message(addAssets(app.db, admin, A.id, id.chalk!, { tags: "C-1", locationId: id.store! }))).toMatch(/counted/);

    const both = await Promise.allSettled([
      allocateAsset(app.db, admin, A.id, { tag: "LAP-01", staff: "T-1" }),
      allocateAsset(app.db, admin2, A.id, { tag: "lap-01", staff: "T-2" }),
    ]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await message(allocateAsset(app.db, admin, A.id, { tag: "LAP-01", staff: "T-2" }))).toMatch(/already allocated/);
    expect(await outcome(allocateAsset(app.db, admin, A.id, { tag: "LAP-02", staff: "X-9" }))).toBe("NOT_FOUND");
    expect(await outcome(allocateAsset(app.db, admin, A.id, { tag: "LAP-02", staff: "T-1", dueOn: "2020-01-01" }))).toBe("VALIDATION");
    await allocateAsset(app.db, admin, A.id, { tag: "LAP-02", staff: "T-1", dueOn: "2099-12-31" });
    // An overdue allocation is listed first.
    await owner.db.execute(sql`update inventory_allocations set due_on = '2020-01-01' where asset_id = (select id from inventory_assets where tag = 'LAP-02')`);
    const allocs = await listAllocations(app.db, admin, A.id);
    expect(allocs.map((a) => [a.tag, a.overdue])).toEqual([["LAP-02", true], ["LAP-01", false]]);

    const lap1 = (await getItem(app.db, admin, A.id, id.laptop!)).assets.find((a) => a.tag === "LAP-01")!;
    expect(await message(moveAsset(app.db, admin, A.id, lap1.id, id.lab!))).toMatch(/allocated/);
    expect(await message(disposeAsset(app.db, admin, A.id, lap1.id, "Broken screen"))).toMatch(/allocated/);
    await returnAsset(app.db, admin, A.id, { tag: "LAP-01", locationId: id.lab!, note: "Keyboard worn" });
    expect(await message(returnAsset(app.db, admin, A.id, { tag: "LAP-01", locationId: id.lab! }))).toMatch(/not allocated/);

    const lap3 = (await getItem(app.db, admin, A.id, id.laptop!)).assets.find((a) => a.tag === "LAP-03")!;
    await moveAsset(app.db, admin, A.id, lap3.id, id.lab!);
    await setAssetRepair(app.db, admin, A.id, lap3.id, true, "Battery");
    expect(await message(allocateAsset(app.db, admin, A.id, { tag: "LAP-03", staff: "T-1" }))).toMatch(/under repair/);
    await setAssetRepair(app.db, admin, A.id, lap3.id, false);
    expect(await outcome(disposeAsset(app.db, admin, A.id, lap3.id, ""))).toBe("VALIDATION");
    await disposeAsset(app.db, admin, A.id, lap3.id, "Beyond repair");
    expect(await message(moveAsset(app.db, admin, A.id, lap3.id, id.store!))).toMatch(/disposed/);
    // The database keeps a disposed asset final, even for a direct write.
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(inventoryAssets).set({ status: "in_store" }).where(eq(inventoryAssets.id, lap3.id))))).toMatch(/disposed asset/);

    const d = await getItem(app.db, admin, A.id, id.laptop!);
    expect(d.assets.map((a) => [a.tag, a.status, a.location])).toEqual([["LAP-01", "in_store", "Science lab"], ["LAP-02", "allocated", "Store room"], ["LAP-03", "disposed", "Science lab"]]);
    expect(d.events.filter((e) => e.tag === "LAP-03").map((e) => e.kind)).toEqual(["disposed", "repaired", "repair", "moved", "added"]);
    expect((await listItems(app.db, admin, A.id, { kind: "asset" }))[0]).toMatchObject({ inStore: 1, allocated: 1, underRepair: 0 });
  });

  it("stock never goes below zero, also when two issues race; every change is in the ledger", async () => {
    expect(await outcome(receiveStock(app.db, admin, A.id, id.chalk!, { locationId: id.store!, quantity: "0" }))).toBe("VALIDATION");
    expect(await receiveStock(app.db, admin, A.id, id.chalk!, { locationId: id.store!, quantity: "10", note: "Supplier invoice 44" })).toEqual({ balance: 10 });
    expect(await message(issueStock(app.db, admin, A.id, id.chalk!, { locationId: id.store!, quantity: "11", note: "Class 3" }))).toBe("Only 10 in stock at Store room.");
    expect(await outcome(issueStock(app.db, admin, A.id, id.chalk!, { locationId: id.store!, quantity: "1" }))).toBe("VALIDATION"); // who or what for
    const race = await Promise.allSettled([
      issueStock(app.db, admin, A.id, id.chalk!, { locationId: id.store!, quantity: "6", staff: "T-1" }),
      issueStock(app.db, admin2, A.id, id.chalk!, { locationId: id.store!, quantity: "6", note: "Exams" }),
    ]);
    expect(race.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await message(transferStock(app.db, admin, A.id, id.chalk!, { fromLocationId: id.store!, toLocationId: id.store!, quantity: "1" }))).toMatch(/different/);
    await transferStock(app.db, admin, A.id, id.chalk!, { fromLocationId: id.store!, toLocationId: id.lab!, quantity: "3" });
    expect(await message(transferStock(app.db, admin, A.id, id.chalk!, { fromLocationId: id.store!, toLocationId: id.lab!, quantity: "2" }))).toBe("Only 1 in stock at Store room.");
    expect(await outcome(adjustStock(app.db, admin, A.id, id.chalk!, { locationId: id.lab!, counted: "2", reason: "" }))).toBe("VALIDATION");
    expect(await adjustStock(app.db, admin, A.id, id.chalk!, { locationId: id.lab!, counted: "2", reason: "Count on 19 Nov" })).toEqual({ difference: -1 });
    expect(await adjustStock(app.db, admin, A.id, id.chalk!, { locationId: id.lab!, counted: "2", reason: "Recount" })).toEqual({ difference: 0 });

    const d = await getItem(app.db, admin, A.id, id.chalk!);
    expect(d.stock.map((s) => [s.location, s.quantity])).toEqual([["Science lab", 2], ["Store room", 1]]);
    expect(d.movements.map((m) => [m.kind, m.quantity, m.balanceAfter]).reverse()).toEqual([
      ["received", 10, 10],
      ["issued", -6, 4],
      ["transfer_out", -3, 1],
      ["transfer_in", 3, 3],
      ["adjusted", -1, 2],
    ]);
    expect((await listItems(app.db, admin, A.id, { lowOnly: true })).map((i) => [i.name, i.stock])).toEqual([["Chalk box", 3]]);

    // The database refuses a negative balance and changes to the ledger.
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(inventoryStock).set({ quantity: -1 }).where(eq(inventoryStock.itemId, id.chalk!))))).toMatch(/inventory_stock_not_negative/);
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(inventoryMovements).set({ quantity: 99 })))).toMatch(/permission denied/);
    expect(await dbError(withContext(app.db, admin, (tx) => tx.delete(inventoryMovements)))).toMatch(/permission denied/);
  });

  it("archiving needs an empty item; teachers and other schools see nothing", async () => {
    expect(await message(setItemArchived(app.db, admin, A.id, id.chalk!, true))).toMatch(/no stock/);
    const proj = (await createItem(app.db, admin, A.id, { name: "Projector", kind: "asset" })).id;
    await setItemArchived(app.db, admin, A.id, proj, true);
    expect(await message(addAssets(app.db, admin, A.id, proj, { tags: "PRJ-1", locationId: id.store! }))).toMatch(/archived/);
    await setItemArchived(app.db, admin, A.id, proj, false);

    expect(await outcome(listItems(app.db, teacher, A.id))).toBe("FORBIDDEN");
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(inventoryAssets))).toHaveLength(0);
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(inventoryMovements))).toHaveLength(0);
    const other = B.ctx(B.adminId);
    expect(await withContext(app.db, other, (tx) => tx.select().from(inventoryStock))).toHaveLength(0);
    expect(await outcome(getItem(app.db, other, B.id, id.laptop!))).toBe("NOT_FOUND");
    expect(await outcome(listItems(app.db, other, A.id))).toBe("NOT_FOUND");
    // School B cannot place stock at school A's location.
    const pens = (await createItem(app.db, other, B.id, { name: "Pens", kind: "consumable" })).id;
    expect(await outcome(receiveStock(app.db, other, B.id, pens, { locationId: id.store!, quantity: "5" }))).toBe("NOT_FOUND");
  });
});
