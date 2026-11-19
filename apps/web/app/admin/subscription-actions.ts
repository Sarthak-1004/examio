"use server";

import { revalidatePath } from "next/cache";
import { AppError, cancelPlatformInvoice, createPlan, createPlatformInvoice, recordPlatformPayment, setOverrides, setSubscription, updatePlan } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Platform subscription actions; the services and the database allow platform administrators only. */
async function act(fn: (ctx: RequestContext) => Promise<string>): Promise<FormState> {
  const s = await requirePlatformAdmin();
  try {
    const message = await fn(s.ctx);
    revalidatePath("/admin", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const planFields = (fd: FormData) => ({
  name: str(fd, "name"),
  modules: fd.getAll("modules").map(String),
  maxStudents: str(fd, "maxStudents"),
  price: str(fd, "price"),
  periodMonths: str(fd, "periodMonths") || "12",
});

export async function createPlanAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    await createPlan(db, ctx, { code: str(fd, "code"), ...planFields(fd) });
    return "Plan created.";
  });
}

export async function updatePlanAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    const archived = str(fd, "archived");
    await updatePlan(db, ctx, str(fd, "planId"), { ...planFields(fd), archived: archived === "" ? undefined : archived === "1" });
    return "Plan saved.";
  });
}

export async function setSubscriptionAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    await setSubscription(db, ctx, str(fd, "schoolId"), { planId: str(fd, "planId"), startsOn: str(fd, "startsOn"), endsOn: str(fd, "endsOn"), reason: str(fd, "reason") });
    return "Subscription saved.";
  });
}

export async function setOverridesAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    await setOverrides(db, ctx, str(fd, "schoolId"), {
      modulesAdded: fd.getAll("added").map(String),
      modulesRemoved: fd.getAll("removed").map(String),
      maxStudentsOverride: str(fd, "maxStudentsOverride"),
      reason: str(fd, "reason"),
    });
    return "Overrides saved.";
  });
}

export async function createInvoiceAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    const r = await createPlatformInvoice(db, ctx, str(fd, "schoolId"), { periodFrom: str(fd, "periodFrom"), periodTo: str(fd, "periodTo"), amount: str(fd, "amount"), note: str(fd, "note") });
    return `Invoice ${r.number} issued.`;
  });
}

export async function recordInvoicePaymentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    const r = await recordPlatformPayment(db, ctx, str(fd, "invoiceId"), { paidOn: str(fd, "paidOn"), reference: str(fd, "reference") });
    if (r.alreadyRecorded) return "This payment was already recorded; nothing changed.";
    return r.extendedTo ? `Payment recorded. The subscription now runs until ${r.extendedTo}.` : "Payment recorded.";
  });
}

export async function cancelInvoiceAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx) => {
    await cancelPlatformInvoice(db, ctx, str(fd, "invoiceId"), str(fd, "reason"));
    return "Invoice cancelled.";
  });
}
