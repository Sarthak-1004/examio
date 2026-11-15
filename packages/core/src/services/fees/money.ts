import { AppError } from "../../errors";

/**
 * Money helpers (Phase 8). Amounts are integer paise (INR); nothing is ever a floating-point
 * rupee value. Percentages are basis points (1% = 100 bp). Rounding is half-up to the paisa.
 */

export const MAX_PAISE = 100_000_000; // ₹10,00,000 per amount

/** Parses "1,250", "1250.5" or "₹ 1,250.50" into paise. Returns null for anything else. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, "");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return paise;
}

export function requireRupees(input: string, field: string, label = "Amount"): number {
  const p = parseRupees(input);
  if (p === null || p < 1 || p > MAX_PAISE) throw new AppError("VALIDATION", `${label}: enter rupees, for example 1250 or 1250.50 (up to ₹10,00,000).`, { [field]: "Not a valid amount." });
  return p;
}

/** "₹1,23,456.50" in the Indian numbering format. */
export function formatPaise(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, "0");
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "−" : ""}₹${rest ? `${rest},${last3}` : last3}.${p}`;
}

/** amount × bp / 10000, rounded half-up, in integer arithmetic (amount ≤ 10^8, bp ≤ 10^4). */
export function applyBp(amountPaise: number, bp: number): number {
  return Math.floor((amountPaise * bp + 5000) / 10000);
}

/** Percent text ("12.5") to basis points; null if not 0.01..100. */
export function parsePercentBp(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp >= 1 && bp <= 10000 ? bp : null;
}

export interface LineInput {
  amountPaise: number;
  taxBp: number;
  /** Approved concessions that apply to this line. */
  concessions: { kind: "percent" | "amount"; value: number }[];
}

/** Discount (capped at the amount), tax on the discounted amount, and the line total. */
export function computeLine(l: LineInput): { discountPaise: number; taxPaise: number; totalPaise: number } {
  let discount = 0;
  for (const c of l.concessions) discount += c.kind === "percent" ? applyBp(l.amountPaise, c.value) : c.value;
  discount = Math.min(discount, l.amountPaise);
  const tax = applyBp(l.amountPaise - discount, l.taxBp);
  return { discountPaise: discount, taxPaise: tax, totalPaise: l.amountPaise - discount + tax };
}
