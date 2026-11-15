"use server";

import { revalidatePath } from "next/cache";
import { AppError, completeSandboxPayment, createCheckoutOrder, sandboxProvider, type CheckoutOrder } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str } from "@/lib/forms";
import { paymentProvider } from "@/lib/runtime";

export interface PayState {
  message?: string;
  order?: CheckoutOrder;
  done?: "captured" | "failed" | "processing";
}

/** Opens (or reuses) a provider order for the outstanding amount of a linked child's invoice. */
export async function startPaymentAction(_prev: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSchoolRole("parent");
  try {
    return { order: await createCheckoutOrder(db, s.ctx, s.ctx.schoolId, paymentProvider(), str(fd, "invoiceId")) };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
}

/** Sandbox only: completes or declines the simulated payment through the signed-webhook path. */
export async function completeSandboxAction(_prev: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSchoolRole("parent");
  const provider = paymentProvider();
  if (provider.name !== "sandbox") return { message: "Test payments are not available." };
  try {
    const outcome = await completeSandboxPayment(db, s.ctx, s.ctx.schoolId, sandboxProvider(), str(fd, "paymentId"), str(fd, "outcome") === "failed" ? "failed" : "captured");
    revalidatePath("/parent", "layout");
    return { done: outcome === "captured" || outcome === "already_captured" ? "captured" : outcome === "failed" ? "failed" : "processing" };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
}
