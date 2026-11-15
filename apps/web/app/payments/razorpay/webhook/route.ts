import { processPaymentWebhook, raiseAlert } from "@examio/core";
import { db } from "@/lib/db";
import { paymentProvider, serverLog } from "@/lib/runtime";

/**
 * Razorpay webhook (Phase 8). The only way an online payment becomes "captured": the raw body's
 * HMAC signature is verified with RAZORPAY_WEBHOOK_SECRET before anything is read, and each
 * event is applied once in the database. Configure in the Razorpay dashboard (test mode):
 * URL https://<site>/payments/razorpay/webhook, events payment.captured and payment.failed.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const provider = paymentProvider();
  if (provider.name !== "razorpay") return new Response("Not found.", { status: 404 });
  const rawBody = await request.text();
  const outcome = await processPaymentWebhook(db, provider, {
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventId: request.headers.get("x-razorpay-event-id"),
  });
  if (outcome === "invalid_signature") {
    serverLog().warn("payment webhook with an invalid signature");
    return new Response("Invalid signature.", { status: 400 });
  }
  if (outcome === "amount_mismatch" || outcome === "second_capture_for_order" || outcome === "unknown_order") {
    await raiseAlert(db, { key: `payments.${outcome}`, severity: "warning", summary: `Payment webhook: ${outcome.replace(/_/g, " ")}` }).catch(() => undefined);
  }
  // 200 for every verified event (including duplicates) so the provider stops retrying.
  return Response.json({ ok: true, outcome });
}
