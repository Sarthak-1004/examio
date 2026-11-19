/**
 * Payroll arithmetic (Phase 14.3): pure and deterministic, on integer paise.
 *
 * - Earned basic = basic × payable half days ÷ the month's working half days.
 * - Prorated fixed components scale the same way; unprorated ones are paid in full.
 * - Percentages (basis points) apply to earned basic, or (deductions) to gross earnings, then
 *   their cap applies.
 * - Every division rounds to the nearest paisa, halves up, in integer arithmetic.
 */

export interface SlipComponentInput {
  componentId: string;
  name: string;
  kind: "earning" | "deduction";
  calc: "fixed" | "percent_basic" | "percent_gross";
  prorate: boolean;
  capPaise: number | null;
  /** Paise for fixed components; basis points (1% = 100) for percentages. */
  value: number;
}

export interface SlipInputs {
  monthWorkingHalves: number;
  workingHalves: number;
  lopHalves: number;
  basicPaise: number;
  components: SlipComponentInput[];
  /** Approved corrections paid in this run (Phase 14.4): never prorated or capped. */
  adjustments?: { id: string; kind: "earning" | "deduction"; reason: string; amountPaise: number }[];
}

export interface SlipLine {
  componentId: string;
  name: string;
  kind: "earning" | "deduction";
  amountPaise: number;
}

export interface SlipResult {
  payableHalves: number;
  earnedBasicPaise: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  lines: SlipLine[];
}

/** round(a × b ÷ c), halves up, for non-negative integers; 0 when c is 0. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  return Math.floor((2 * a * b + c) / (2 * c));
}

export function calculateSlip(i: SlipInputs): SlipResult {
  const payableHalves = Math.max(0, i.workingHalves - i.lopHalves);
  const scale = (paise: number) => mulDivRound(paise, payableHalves, i.monthWorkingHalves);
  const earnedBasicPaise = scale(i.basicPaise);
  const capped = (amount: number, cap: number | null) => (cap === null ? amount : Math.min(amount, cap));
  const lines: SlipLine[] = [];

  let earnings = 0;
  for (const c of i.components.filter((x) => x.kind === "earning")) {
    const amount = c.calc === "fixed" ? (c.prorate ? scale(c.value) : c.value) : capped(mulDivRound(earnedBasicPaise, c.value, 10_000), c.capPaise);
    earnings += amount;
    lines.push({ componentId: c.componentId, name: c.name, kind: "earning", amountPaise: amount });
  }
  for (const a of (i.adjustments ?? []).filter((x) => x.kind === "earning")) {
    earnings += a.amountPaise;
    lines.push({ componentId: `adj:${a.id}`, name: a.reason, kind: "earning", amountPaise: a.amountPaise });
  }
  const grossPaise = earnedBasicPaise + earnings;

  let deductionsPaise = 0;
  for (const c of i.components.filter((x) => x.kind === "deduction")) {
    const base = c.calc === "percent_gross" ? grossPaise : earnedBasicPaise;
    const amount = c.calc === "fixed" ? (c.prorate ? scale(c.value) : c.value) : capped(mulDivRound(base, c.value, 10_000), c.capPaise);
    deductionsPaise += amount;
    lines.push({ componentId: c.componentId, name: c.name, kind: "deduction", amountPaise: amount });
  }
  for (const a of (i.adjustments ?? []).filter((x) => x.kind === "deduction")) {
    deductionsPaise += a.amountPaise;
    lines.push({ componentId: `adj:${a.id}`, name: a.reason, kind: "deduction", amountPaise: a.amountPaise });
  }
  return { payableHalves, earnedBasicPaise, grossPaise, deductionsPaise, netPaise: grossPaise - deductionsPaise, lines };
}
