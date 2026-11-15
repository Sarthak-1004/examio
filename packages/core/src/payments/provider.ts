import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Payment providers (Phase 8). Only INR. The browser never marks anything paid: a payment is
 * captured when the provider's signed webhook event (or a reconciliation lookup) says so.
 *
 * - `razorpay`: Razorpay Orders API and webhooks (test or live keys; this project uses test mode).
 * - `sandbox`: no network; orders are local and a "payment" is simulated by producing a signed
 *   event that goes through exactly the same webhook processing. Refused in production.
 */

export interface ProviderOrder {
  orderId: string;
  amountPaise: number;
}

export interface ProviderEvent {
  eventId: string;
  type: string;
  orderId: string | null;
  paymentId: string | null;
  status: "captured" | "failed" | "other";
  amountPaise: number | null;
  failureReason: string | null;
}

export interface OrderPaymentStatus {
  paymentId: string;
  status: "captured" | "failed" | "pending";
  amountPaise: number;
}

export interface PaymentProvider {
  readonly name: "razorpay" | "sandbox";
  /** Public key for the browser checkout (Razorpay key id); null for the sandbox. */
  readonly publicKey: string | null;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder>;
  /** Verifies the webhook signature over the raw body and parses the event; null if invalid. */
  parseWebhook(rawBody: string, signature: string | null, eventIdHeader: string | null): ProviderEvent | null;
  /** Payments the provider knows for an order (reconciliation). */
  fetchOrderPayments(orderId: string): Promise<OrderPaymentStatus[]>;
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

interface RzpPaymentEntity {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  error_description?: unknown;
}

/** Parses a Razorpay-shaped event body (used by both providers). */
export function parseRazorpayEvent(rawBody: string, eventIdHeader: string | null): ProviderEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const b = body as { event?: unknown; id?: unknown; payload?: { payment?: { entity?: RzpPaymentEntity } } };
  const type = typeof b.event === "string" ? b.event : "";
  const p = b.payload?.payment?.entity;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null);
  const amount = typeof p?.amount === "number" && Number.isInteger(p.amount) ? p.amount : null;
  if (p?.currency !== undefined && p.currency !== "INR") return { eventId: "", type, orderId: null, paymentId: null, status: "other", amountPaise: null, failureReason: "Currency is not INR" };
  const eventId = str(eventIdHeader) ?? str(b.id) ?? (str(p?.id) ? `${type}:${str(p?.id)}` : null);
  if (!eventId) return null;
  const status = type === "payment.captured" || type === "order.paid" ? "captured" : type === "payment.failed" ? "failed" : "other";
  return { eventId, type, orderId: str(p?.order_id), paymentId: str(p?.id), status, amountPaise: amount, failureReason: typeof p?.error_description === "string" ? p.error_description.slice(0, 200) : null };
}

export function razorpayProvider(opts: { keyId: string; keySecret: string; webhookSecret: string; fetchImpl?: typeof fetch }): PaymentProvider {
  const f = opts.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await f(`https://api.razorpay.com/v1${path}`, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Razorpay ${path} failed with HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  return {
    name: "razorpay",
    publicKey: opts.keyId,
    async createOrder({ amountPaise, receipt, notes }) {
      const r = (await api("/orders", { method: "POST", body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: receipt.slice(0, 40), notes }) })) as { id?: unknown; amount?: unknown };
      if (typeof r.id !== "string" || r.amount !== amountPaise) throw new Error("Razorpay returned an unexpected order");
      return { orderId: r.id, amountPaise };
    },
    parseWebhook(rawBody, signature, eventIdHeader) {
      if (!signature || !safeEqualHex(hmacHex(opts.webhookSecret, rawBody), signature.trim())) return null;
      return parseRazorpayEvent(rawBody, eventIdHeader);
    },
    async fetchOrderPayments(orderId) {
      const r = (await api(`/orders/${encodeURIComponent(orderId)}/payments`)) as { items?: RzpPaymentEntity[] };
      return (r.items ?? []).flatMap((p) =>
        typeof p.id === "string" && typeof p.amount === "number"
          ? [{ paymentId: p.id, amountPaise: p.amount, status: p.status === "captured" ? ("captured" as const) : p.status === "failed" ? ("failed" as const) : ("pending" as const) }]
          : [],
      );
    },
  };
}

/** The sandbox signs its simulated events with this secret (development, tests and the demo only). */
export const SANDBOX_WEBHOOK_SECRET = "examio-sandbox-webhook-secret";

export interface SandboxProvider extends PaymentProvider {
  /** Builds a signed event as Razorpay would send it, for the simulated checkout and tests. */
  simulateEvent(input: { orderId: string; amountPaise: number; outcome: "captured" | "failed"; paymentId?: string }): { body: string; signature: string; eventId: string };
}

export function sandboxProvider(): SandboxProvider {
  return {
    name: "sandbox",
    publicKey: null,
    async createOrder({ amountPaise }) {
      return { orderId: `order_sbx_${randomUUID().replace(/-/g, "").slice(0, 20)}`, amountPaise };
    },
    parseWebhook(rawBody, signature, eventIdHeader) {
      if (!signature || !safeEqualHex(hmacHex(SANDBOX_WEBHOOK_SECRET, rawBody), signature.trim())) return null;
      return parseRazorpayEvent(rawBody, eventIdHeader);
    },
    async fetchOrderPayments() {
      return [];
    },
    simulateEvent({ orderId, amountPaise, outcome, paymentId }) {
      const pid = paymentId ?? `pay_sbx_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const eventId = `evt_sbx_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const body = JSON.stringify({
        id: eventId,
        event: outcome === "captured" ? "payment.captured" : "payment.failed",
        payload: { payment: { entity: { id: pid, order_id: orderId, amount: amountPaise, currency: "INR", status: outcome, ...(outcome === "failed" ? { error_description: "Payment declined in the sandbox" } : {}) } } },
      });
      return { body, signature: hmacHex(SANDBOX_WEBHOOK_SECRET, body), eventId };
    },
  };
}

export const PAYMENT_PROVIDERS = ["sandbox", "razorpay"] as const;

/** Builds the configured provider. Throws with a clear message when configuration is incomplete. */
export function paymentProviderFromEnv(env: NodeJS.ProcessEnv): PaymentProvider {
  const name = (env.PAYMENTS_PROVIDER ?? "sandbox").trim() || "sandbox";
  if (name === "sandbox") return sandboxProvider();
  if (name === "razorpay") {
    const keyId = env.RAZORPAY_KEY_ID?.trim() ?? "";
    const keySecret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? "";
    if (!keyId || !keySecret || !webhookSecret) throw new Error("PAYMENTS_PROVIDER=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.");
    return razorpayProvider({ keyId, keySecret, webhookSecret });
  }
  throw new Error(`Unknown PAYMENTS_PROVIDER "${name}". Use one of: ${PAYMENT_PROVIDERS.join(", ")}.`);
}
