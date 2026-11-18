import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { feeHeads, feeStructureItems, feeStructures, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { isoDate, mapSetupError, parse, trimmed, uuidField } from "../setup/common";
import { MAX_PAISE, parsePercentBp, parseRupees, requireRupees } from "./money";

/**
 * Fee setup (Phase 8): fee heads (with a tax rate, default 0%) and fee structures per class and
 * academic year. A structure is drafted by finance or administrators and approved by a school
 * administrator; after approval its items never change (archive and make a new one instead).
 */

export interface FeeHead {
  id: string;
  name: string;
  taxBp: number;
  archived: boolean;
}

export async function listFeeHeads(db: Db, ctx: RequestContext, schoolId: string): Promise<FeeHead[]> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) =>
    (await tx.select().from(feeHeads).where(eq(feeHeads.schoolId, schoolId)).orderBy(asc(feeHeads.name))).map((h) => ({ id: h.id, name: h.name, taxBp: h.taxBp, archived: h.archivedAt !== null })),
  );
}

export async function createFeeHead(db: Db, ctx: RequestContext, schoolId: string, input: { name: string; taxPercent?: string }): Promise<{ id: string }> {
  const name = parse(trimmed("Name", 1, 80), input.name);
  const t = (input.taxPercent ?? "").trim();
  const taxBp = t === "" || t === "0" ? 0 : parsePercentBp(t);
  if (taxBp === null) throw new AppError("VALIDATION", "Tax: enter a percentage from 0 to 100, for example 18.", { taxPercent: "Not a valid percentage." });
  try {
    return await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
      const [h] = await tx.insert(feeHeads).values({ schoolId, name, taxBp }).returning({ id: feeHeads.id });
      await audit(tx, { action: "fees.head_created", actorUserId: actor.userId, schoolId, entityType: "fee_head", entityId: h!.id, data: { name, taxBp } });
      return { id: h!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: { fee_heads_school_name_unique: ["name", "A fee head with this name already exists."] } });
  }
}

export async function archiveFeeHead(db: Db, ctx: RequestContext, schoolId: string, headId: string, archived: boolean): Promise<void> {
  parse(uuidField("Fee head"), headId);
  await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const r = await tx.update(feeHeads).set({ archivedAt: archived ? sql`now()` : null }).where(and(eq(feeHeads.schoolId, schoolId), eq(feeHeads.id, headId))).returning({ id: feeHeads.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Fee head not found.");
    await audit(tx, { action: archived ? "fees.head_archived" : "fees.head_restored", actorUserId: actor.userId, schoolId, entityType: "fee_head", entityId: headId });
  });
}

export interface FeeStructureSummary {
  id: string;
  name: string;
  yearId: string;
  yearName: string;
  classId: string;
  className: string;
  status: "draft" | "approved" | "archived";
  totalPaise: number;
  instalments: number;
  lateFeePaise: number;
  lateGraceDays: number;
}

export async function listFeeStructures(db: Db, ctx: RequestContext, schoolId: string): Promise<FeeStructureSummary[]> {
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) =>
    (await tx.execute(sql`
      select s.id, s.name, y.id as "yearId", y.name as "yearName", c.id as "classId", c.name as "className", s.status::text as status,
             coalesce(sum(i.amount_paise), 0)::int as "totalPaise", count(distinct i.due_on)::int as instalments,
             s.late_fee_paise as "lateFeePaise", s.late_grace_days as "lateGraceDays"
      from fee_structures s join academic_years y on y.id = s.academic_year_id join classes c on c.id = s.class_id
      left join fee_structure_items i on i.structure_id = s.id
      where s.school_id = ${schoolId}::uuid
      group by s.id, y.id, y.name, y.starts_on, c.id, c.name, c.sort_order
      order by y.starts_on desc, c.sort_order, c.name, s.name`)) as unknown as FeeStructureSummary[],
  );
}

export interface FeeStructureDetail extends FeeStructureSummary {
  items: { id: string; feeHeadId: string; headName: string; label: string; amountPaise: number; dueOn: string; taxBp: number }[];
  approvedAt: Date | null;
}

export async function getFeeStructure(db: Db, ctx: RequestContext, schoolId: string, structureId: string): Promise<FeeStructureDetail> {
  parse(uuidField("Fee structure"), structureId);
  return withCapability(db, ctx, schoolId, "school.fees.view", async (tx) => {
    const all = (await tx.execute(sql`
      select s.id, s.name, y.id as "yearId", y.name as "yearName", c.id as "classId", c.name as "className", s.status::text as status,
             s.late_fee_paise as "lateFeePaise", s.late_grace_days as "lateGraceDays", s.approved_at as "approvedAt"
      from fee_structures s join academic_years y on y.id = s.academic_year_id join classes c on c.id = s.class_id
      where s.school_id = ${schoolId}::uuid and s.id = ${structureId}::uuid`)) as unknown as Omit<FeeStructureDetail, "items" | "totalPaise" | "instalments">[];
    const s = all[0];
    if (!s) throw new AppError("NOT_FOUND", "Fee structure not found.");
    const items = (await tx.execute(sql`
      select i.id, i.fee_head_id as "feeHeadId", h.name as "headName", i.label, i.amount_paise as "amountPaise", i.due_on::text as "dueOn", h.tax_bp as "taxBp"
      from fee_structure_items i join fee_heads h on h.id = i.fee_head_id
      where i.structure_id = ${structureId}::uuid order by i.due_on, h.name`)) as unknown as FeeStructureDetail["items"];
    return { ...s, items, totalPaise: items.reduce((a, i) => a + i.amountPaise, 0), instalments: new Set(items.map((i) => i.dueOn)).size };
  });
}

const structureSchema = z.object({
  yearId: z.uuid({ message: "Choose an academic year." }),
  classId: z.uuid({ message: "Choose a class." }),
  name: trimmed("Name", 1, 80),
  lateFee: z.string().optional(),
  lateGraceDays: z.coerce.number({ message: "Grace days must be a number." }).int().min(0).max(365).optional(),
});

export async function createFeeStructure(db: Db, ctx: RequestContext, schoolId: string, input: z.input<typeof structureSchema>): Promise<{ id: string }> {
  const d = parse(structureSchema, input);
  const lateFee = (d.lateFee ?? "").trim() === "" ? 0 : parseRupees(d.lateFee ?? "");
  if (lateFee === null || lateFee > MAX_PAISE) throw new AppError("VALIDATION", "Late fee: enter rupees, for example 100 (up to ₹10,00,000).", { lateFee: "Not a valid amount." });
  try {
    return await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
      const [y] = (await tx.execute(sql`select status::text as status from academic_years where school_id = ${schoolId}::uuid and id = ${d.yearId}::uuid`)) as unknown as { status: string }[];
      if (!y) throw new AppError("NOT_FOUND", "Academic year not found.");
      if (y.status === "closed") throw new AppError("CONFLICT", "That academic year is closed.");
      const [s] = await tx
        .insert(feeStructures)
        .values({ schoolId, academicYearId: d.yearId, classId: d.classId, name: d.name, lateFeePaise: lateFee, lateGraceDays: d.lateGraceDays ?? 0, createdBy: actor.userId })
        .returning({ id: feeStructures.id });
      await audit(tx, { action: "fees.structure_created", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: s!.id, data: { name: d.name } });
      return { id: s!.id };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate: { fee_structures_school_year_class_name_unique: ["name", "This class already has a fee structure with this name for the year."] } });
  }
}

export async function addFeeStructureItem(db: Db, ctx: RequestContext, schoolId: string, structureId: string, input: { feeHeadId: string; label: string; amount: string; dueOn: string }): Promise<void> {
  parse(uuidField("Fee structure"), structureId);
  parse(uuidField("Fee head"), input.feeHeadId);
  const label = parse(trimmed("Label", 1, 80), input.label);
  const amountPaise = requireRupees(input.amount, "amount");
  const dueOn = parse(isoDate("due date"), input.dueOn);
  await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const [s] = (await tx.execute(sql`
      select s.status::text as status, y.starts_on::text as "startsOn", y.ends_on::text as "endsOn" from fee_structures s join academic_years y on y.id = s.academic_year_id
      where s.school_id = ${schoolId}::uuid and s.id = ${structureId}::uuid`)) as unknown as { status: string; startsOn: string; endsOn: string }[];
    if (!s) throw new AppError("NOT_FOUND", "Fee structure not found.");
    if (s.status !== "draft") throw new AppError("CONFLICT", "An approved fee structure cannot be changed. Archive it and create a new one.");
    if (dueOn < s.startsOn || dueOn > s.endsOn) throw new AppError("VALIDATION", `The due date must be within the academic year (${s.startsOn} to ${s.endsOn}).`, { dueOn: "Outside the year." });
    const [h] = await tx.select({ archivedAt: feeHeads.archivedAt }).from(feeHeads).where(and(eq(feeHeads.schoolId, schoolId), eq(feeHeads.id, input.feeHeadId)));
    if (!h) throw new AppError("NOT_FOUND", "Fee head not found.");
    if (h.archivedAt) throw new AppError("CONFLICT", "That fee head is archived.");
    await tx.insert(feeStructureItems).values({ schoolId, structureId, feeHeadId: input.feeHeadId, label, amountPaise, dueOn });
    await audit(tx, { action: "fees.structure_item_added", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: structureId, data: { label, amountPaise, dueOn } });
  });
}

export async function removeFeeStructureItem(db: Db, ctx: RequestContext, schoolId: string, itemId: string): Promise<void> {
  parse(uuidField("Item"), itemId);
  await withCapability(db, ctx, schoolId, "school.fees.manage", async (tx, actor) => {
    const r = await tx.delete(feeStructureItems).where(and(eq(feeStructureItems.schoolId, schoolId), eq(feeStructureItems.id, itemId))).returning({ structureId: feeStructureItems.structureId });
    if (r.length === 0) throw new AppError("CONFLICT", "Only items of a draft fee structure can be removed.");
    await audit(tx, { action: "fees.structure_item_removed", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: r[0]!.structureId });
  });
}

/** Approval by a school administrator; the items are fixed from then on. */
export async function approveFeeStructure(db: Db, ctx: RequestContext, schoolId: string, structureId: string): Promise<void> {
  parse(uuidField("Fee structure"), structureId);
  await withCapability(db, ctx, schoolId, "school.fees.approve", async (tx, actor) => {
    const [n] = (await tx.execute(sql`select count(*)::int as n from fee_structure_items where structure_id = ${structureId}::uuid`)) as unknown as { n: number }[];
    if (!n?.n) throw new AppError("VALIDATION", "Add at least one item before approving.");
    const r = await tx
      .update(feeStructures)
      .set({ status: "approved", approvedBy: actor.userId, approvedAt: sql`now()` })
      .where(and(eq(feeStructures.schoolId, schoolId), eq(feeStructures.id, structureId), eq(feeStructures.status, "draft")))
      .returning({ id: feeStructures.id });
    if (r.length === 0) throw new AppError("CONFLICT", "Only a draft fee structure can be approved.");
    await audit(tx, { action: "fees.structure_approved", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: structureId });
  });
}

export async function archiveFeeStructure(db: Db, ctx: RequestContext, schoolId: string, structureId: string): Promise<void> {
  parse(uuidField("Fee structure"), structureId);
  await withCapability(db, ctx, schoolId, "school.fees.approve", async (tx, actor) => {
    const r = await tx
      .update(feeStructures)
      .set({ status: "archived" })
      .where(and(eq(feeStructures.schoolId, schoolId), eq(feeStructures.id, structureId), eq(feeStructures.status, "approved"), sql`${feeStructures.approvedBy} is not null`))
      .returning({ id: feeStructures.id });
    if (r.length === 0) throw new AppError("CONFLICT", "Only an approved fee structure can be archived.");
    await audit(tx, { action: "fees.structure_archived", actorUserId: actor.userId, schoolId, entityType: "fee_structure", entityId: structureId });
  });
}

