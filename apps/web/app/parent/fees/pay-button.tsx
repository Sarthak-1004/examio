"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";
import { completeSandboxAction, startPaymentAction, type PayState } from "./actions";

interface RazorpayCheckout {
  open(): void;
}
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayCheckout;

function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Checkout did not load")));
    s.onerror = () => reject(new Error("Checkout did not load"));
    document.body.appendChild(s);
  });
}

/**
 * Pay one invoice online. The server opens a provider order for the outstanding amount. With
 * Razorpay the checkout opens; with the sandbox, test buttons complete or decline it through the
 * same signed-webhook processing. The page never marks anything paid by itself: it only says
 * "processing" until the verified event has been applied.
 */
export function PayButton({ invoiceId, label, schoolName }: { invoiceId: string; label: string; schoolName: string }) {
  const router = useRouter();
  const [state, start] = useActionState<PayState, FormData>(startPaymentAction, {});
  const [done, complete] = useActionState<PayState, FormData>(completeSandboxAction, {});
  const opened = useRef<string | null>(null);

  useEffect(() => {
    const o = state.order;
    if (!o || o.provider !== "razorpay" || !o.publicKey || opened.current === o.orderId) return;
    opened.current = o.orderId;
    loadCheckout()
      .then((Razorpay) => {
        new Razorpay({
          key: o.publicKey,
          amount: o.amountPaise,
          currency: "INR",
          order_id: o.orderId,
          name: schoolName,
          description: `Invoice ${o.invoiceNumber} (${o.studentName})`,
          handler: () => router.replace("/parent/fees?payment=processing"),
          modal: { ondismiss: () => router.refresh() },
        }).open();
      })
      .catch(() => router.replace("/parent/fees?payment=unavailable"));
  }, [state.order, router, schoolName]);

  if (done.done === "captured") return <Alert tone="green">Payment received (test mode). The receipt is listed below.</Alert>;
  if (done.done === "failed") return <Alert>The test payment was declined. Nothing was charged.</Alert>;
  if (done.done === "processing") return <Alert tone="amber">Payment processing: it appears here once confirmed.</Alert>;

  return (
    <div className="space-y-2">
      {(state.message || done.message) && <Alert>{state.message ?? done.message}</Alert>}
      {state.order?.provider === "sandbox" ? (
        <div className="rounded-md bg-amber-50 p-3 text-sm">
          <p className="mb-2 font-medium text-amber-900">Test mode: no real money moves.</p>
          <div className="flex flex-wrap gap-2">
            {(["captured", "failed"] as const).map((o) => (
              <form key={o} action={complete}>
                <input type="hidden" name="paymentId" value={state.order!.paymentId} />
                <input type="hidden" name="outcome" value={o} />
                <SubmitButton variant={o === "captured" ? "primary" : "ghost"} pendingText="Processing…">
                  {o === "captured" ? "Complete test payment" : "Decline"}
                </SubmitButton>
              </form>
            ))}
          </div>
        </div>
      ) : (
        <form action={start}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <SubmitButton pendingText="Opening…">{label}</SubmitButton>
        </form>
      )}
    </div>
  );
}
