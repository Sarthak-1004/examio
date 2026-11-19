"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  addAssets,
  adjustStock,
  allocateAsset,
  createItem,
  createLocation,
  disposeAsset,
  issueStock,
  moveAsset,
  receiveStock,
  returnAsset,
  setAssetRepair,
  setItemArchived,
  transferStock,
  updateItem,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Inventory actions for school administrators; the services and the database check the rest. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/inventory", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const itemFields = (fd: FormData) => ({ name: str(fd, "name"), category: str(fd, "category"), unit: str(fd, "unit"), reorderLevel: str(fd, "reorderLevel") });

export async function createLocationAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createLocation(db, ctx, schoolId, str(fd, "name"));
    return "Location added.";
  });
}

export async function createItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  let id: string;
  try {
    id = (await createItem(db, s.ctx, s.ctx.schoolId, { ...itemFields(fd), kind: str(fd, "kind") })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/inventory", "layout");
  redirect(`/school/inventory/items/${id}`);
}

export async function updateItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateItem(db, ctx, schoolId, str(fd, "itemId"), itemFields(fd));
    return "Saved.";
  });
}

export async function archiveItemAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "1";
    await setItemArchived(db, ctx, schoolId, str(fd, "itemId"), archived);
    return archived ? "Item archived." : "Item restored.";
  });
}

export async function addAssetsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await addAssets(db, ctx, schoolId, str(fd, "itemId"), { tags: str(fd, "tags"), serialNo: str(fd, "serialNo"), locationId: str(fd, "locationId") });
    return `Added ${r.added} asset${r.added === 1 ? "" : "s"}.`;
  });
}

export async function allocateAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await allocateAsset(db, ctx, schoolId, { tag: str(fd, "tag"), staff: str(fd, "staff"), dueOn: str(fd, "dueOn"), note: str(fd, "note") });
    return `${r.itemName} ${str(fd, "tag").trim()} allocated to ${r.staffName}.`;
  });
}

export async function returnAssetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await returnAsset(db, ctx, schoolId, { tag: str(fd, "tag"), locationId: str(fd, "locationId"), note: str(fd, "note") });
    return `${str(fd, "tag").trim()} is back in store.`;
  });
}

export async function assetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const assetId = str(fd, "assetId");
    switch (str(fd, "op")) {
      case "move":
        await moveAsset(db, ctx, schoolId, assetId, str(fd, "locationId"), str(fd, "note"));
        return "Moved.";
      case "repair":
        await setAssetRepair(db, ctx, schoolId, assetId, true, str(fd, "note"));
        return "Sent for repair.";
      case "repaired":
        await setAssetRepair(db, ctx, schoolId, assetId, false, str(fd, "note"));
        return "Back in store.";
      case "dispose":
        await disposeAsset(db, ctx, schoolId, assetId, str(fd, "note"));
        return "Disposed of.";
      default:
        throw new AppError("VALIDATION", "Choose an action.");
    }
  });
}

export async function stockAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const itemId = str(fd, "itemId");
    switch (str(fd, "op")) {
      case "receive":
        return `Received. Balance there: ${(await receiveStock(db, ctx, schoolId, itemId, { locationId: str(fd, "locationId"), quantity: str(fd, "quantity"), note: str(fd, "note") })).balance}.`;
      case "issue":
        return `Issued. Balance there: ${(await issueStock(db, ctx, schoolId, itemId, { locationId: str(fd, "locationId"), quantity: str(fd, "quantity"), staff: str(fd, "staff"), note: str(fd, "note") })).balance}.`;
      case "transfer":
        await transferStock(db, ctx, schoolId, itemId, { fromLocationId: str(fd, "fromLocationId"), toLocationId: str(fd, "toLocationId"), quantity: str(fd, "quantity"), note: str(fd, "note") });
        return "Transferred.";
      case "adjust": {
        const { difference } = await adjustStock(db, ctx, schoolId, itemId, { locationId: str(fd, "locationId"), counted: str(fd, "counted"), reason: str(fd, "reason") });
        return difference === 0 ? "The count matches; nothing changed." : `Adjusted by ${difference > 0 ? "+" : ""}${difference}.`;
      }
      default:
        throw new AppError("VALIDATION", "Choose an action.");
    }
  });
}
