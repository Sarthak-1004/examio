import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { payments, withWorkerContext, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import type { PaymentProvider, ProviderEvent, SandboxProvider } from "../../payments/provider";
import { parse, uuidField } from "../setup/common";

/**
 * Online fee payments (Phase 8).
 *
 * 1. A parent asks to pay an invoice: the server creates a provider order for exactly the
 *    outstanding amount and records a pending payment (an unexpired pending one is reused).
 * 2. The browser opens the provider's checkout. Whatever the browser reports afterwards changes
 *    nothing: the page only says "processing".
 * 3. The provider's signed webhook event is verified and applied by
 *    payment_record_provider_event() in the worker context: captured once, never for a
 *    different amount, failures after a capture ignored, repeated events ignored.
 * 4. Finance staff can reconcile pending payments by asking the provider for the order's state;
 *    the answer goes through the same function.
 */

const PENDING_REUSE_MS = 30 * 60_000;

export interface CheckoutOrder {
  paymentId: string;
  provider: "razorpay" | "sandbox";
  orderId: string;
  amountPaise: number;
  /** Razorpay key id for the checkout script; null for the sandbox. */
  publicKey: string | null;
  invoiceNumber: string;
  studentName: string;
}

export async function createCheckoutOrder(db: Db, ctx: RequestContext, schoolId: string, provider: PaymentProvider, invoiceId: string): Promise<CheckoutOrder> {
  parse(uuidField("Invoice"), invoiceId);
  // Read and check first; the provider call happens outside any transaction.
  const info = await withCapability(db, ctx, schoolId, "school.fees.pay", async (tx, actor) => {
    const [inv] = (await tx.execute(sql`
      select i.id, i.number, i.status::text as status, i.student_id as "studentId", p.display_name as "studentName",
             (select coalesce(sum(amount_paise), 0)::int from ledger_entries l where l.invoice_id = i.id) as balance
      from invoices i join student_profiles p on p.id = i.student_id
      where i.school_id = ${schoolId}::uuid and i.id = ${invoiceId}::uuid`)) as unknown as { id: string; number: string; status: string; studentId: string; studentName: string; balance: number }[];
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
    if (inv.status !== "open") throw new AppError("CONFLICT", "This invoice is cancelled.");
    if (inv.balance <= 0) throw new AppError("CONFLICT", "This invoice is already paid.");
    const [pending] = await tx
      .select({ id: payments.id, orderId: payments.providerOrderId, amount: payments.amountPaise, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "pending"), eq(payments.provider, provider.name), eq(payments.createdBy, actor.userId)));
    return { inv, pending: pending && pending.amount === inv.balance && Date.now() - pending.createdAt.getTime() < PENDING_REUSE_MS ? pending : null };
  });
  if (info.pending?.orderId) {
    return { paymentId: info.pending.id, provider: provider.name, orderId: info.pending.orderId, amountPaise: info.pending.amount, publicKey: provider.publicKey, invoiceNumber: info.inv.number, studentName: info.inv.studentName };
  }
  const paymentId = randomUUID();
  const order = await provider.createOrder({ amountPaise: info.inv.balance, receipt: paymentId, notes: { invoice: info.inv.number, paymentId } });
  await withCapability(db, ctx, schoolId, "school.fees.pay", async (tx, actor) => {
    await tx.insert(payments).values({
      id: paymentId,
      schoolId,
      studentId: info.inv.studentId,
      invoiceId,
      method: "online",
      amountPaise: order.amountPaise,
      status: "pending",
      provider: provider.name,
      providerOrderId: order.orderId,
      createdBy: actor.userId,
    });
    await audit(tx, { action: "fees.online_payment_started", actorUserId: actor.userId, schoolId, entityType: "payment", entityId: paymentId, data: { invoiceId, amountPaise: order.amountPaise, provider: provider.name } });
  });
  return { paymentId, provider: provider.name, orderId: order.orderId, amountPaise: order.amountPaise, publicKey: provider.publicKey, invoiceNumber: info.inv.number, studentName: info.inv.studentName };
}

export type WebhookOutcome =
  | "invalid_signature"
  | "ignored_event"
  | "duplicate_event"
  | "unknown_order"
  | "captured"
  | "already_captured"
  | "second_capture_for_order"
  | "amount_mismatch"
  | "failed"
  | string;

async function applyEvent(db: Db, provider: string, ev: ProviderEvent): Promise<WebhookOutcome> {
  if (!ev.orderId || ev.status === "other") {
    // Recorded so a repeat is recognised, but nothing changes.
    return withWorkerContext(db, null, async (tx) => {
      const [r] = (await tx.execute(sql`select payment_record_provider_event(${provider}, ${ev.eventId}, ${ev.type}, ${ev.orderId ?? ""}, ${ev.paymentId}, 'other', ${ev.amountPaise}, null) as outcome`)) as unknown as { outcome: string }[];
      return r?.outcome === "duplicate_event" ? "duplicate_event" : "ignored_event";
    });
  }
  return withWorkerContext(db, null, async (tx) => {
    const [r] = (await tx.execute(sql`select payment_record_provider_event(${provider}, ${ev.eventId}, ${ev.type}, ${ev.orderId}, ${ev.paymentId}, ${ev.status}, ${ev.amountPaise}, ${ev.failureReason}) as outcome`)) as unknown as { outcome: string }[];
    return r?.outcome ?? "ignored_event";
  });
}

/** Verifies and applies one webhook delivery. Never throws for business outcomes. */
export async function processPaymentWebhook(db: Db, provider: PaymentProvider, input: { rawBody: string; signature: string | null; eventId: string | null }): Promise<WebhookOutcome> {
  if (input.rawBody.length > 64 * 1024) return "invalid_signature";
  const ev = provider.parseWebhook(input.rawBody, input.signature, input.eventId);
  if (!ev || !ev.eventId) return "invalid_signature";
  return applyEvent(db, provider.name, ev);
}

/** Sandbox only: the parent completes (or declines) a simulated payment through the webhook path. */
export async function completeSandboxPayment(db: Db, ctx: RequestContext, schoolId: string, provider: SandboxProvider, paymentId: string, outcome: "captured" | "failed"): Promise<WebhookOutcome> {
  parse(uuidField("Payment"), paymentId);
  const p = await withCapability(db, ctx, schoolId, "school.fees.pay", async (tx) => {
    const [row] = await tx.select().from(payments).where(and(eq(payments.schoolId, schoolId), eq(payments.id, paymentId), eq(payments.provider, "sandbox")));
    if (!row || !row.providerOrderId) throw new AppError("NOT_FOUND", "Payment not found.");
    return row;
  });
  const signed = provider.simulateEvent({ orderId: p.providerOrderId!, amountPaise: p.amountPaise, outcome });
  return processPaymentWebhook(db, provider, { rawBody: signed.body, signature: signed.signature, eventId: signed.eventId });
}

/** Asks the provider about pending online payments older than five minutes (finance staff). */
export async function reconcilePendingPayments(db: Db, ctx: RequestContext, schoolId: string, provider: PaymentProvider): Promise<{ checked: number; captured: number; failed: number }> {
  const pending = await withCapability(db, ctx, schoolId, "school.fees.manage", (tx) =>
    tx
      .select({ id: payments.id, orderId: payments.providerOrderId })
      .from(payments)
      .where(and(eq(payments.schoolId, schoolId), eq(payments.status, "pending"), eq(payments.provider, provider.name), sql`${payments.createdAt} < now() - interval '5 minutes'`)),
  );
  let captured = 0;
  let failed = 0;
  for (const p of pending) {
    if (!p.orderId) continue;
    const known = await provider.fetchOrderPayments(p.orderId);
    const hit = known.find((k) => k.status === "captured") ?? known.find((k) => k.status === "failed");
    if (!hit) continue;
    const outcome = await applyEvent(db, provider.name, {
      eventId: `reconcile:${p.orderId}:${hit.paymentId}:${hit.status}`,
      type: "reconcile",
      orderId: p.orderId,
      paymentId: hit.paymentId,
      status: hit.status === "captured" ? "captured" : "failed",
      amountPaise: hit.amountPaise,
      failureReason: hit.status === "failed" ? "Reported failed by the provider" : null,
    });
    if (outcome === "captured") captured++;
    if (outcome === "failed") failed++;
  }
  await withCapability(db, ctx, schoolId, "school.fees.manage", (tx, actor) =>
    audit(tx, { action: "fees.payments_reconciled", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { checked: pending.length, captured, failed } }),
  );
  return { checked: pending.length, captured, failed };
}

