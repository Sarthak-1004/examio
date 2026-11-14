import { z } from "zod";
import { checkViolation, foreignKeyViolation, isRlsViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";

/** Shared validation and error mapping for school setup services. */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, `Enter a valid ${label}.`);

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const uuidField = (what: string) => z.uuid({ message: `${what} not found.` });

export const trimmed = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be at most ${max} characters.`);

export function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): AppError {
  const fields: Record<string, string> = {};
  for (const i of issues) fields[i.path.map(String).join(".")] ??= i.message;
  return new AppError("VALIDATION", issues[0]?.message ?? "Invalid input.", fields);
}

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const notFound = r.error.issues.find((i) => i.message.endsWith("not found."));
    if (notFound) throw new AppError("NOT_FOUND", notFound.message);
    throw validationError(r.error.issues);
  }
  return r.data;
}

/**
 * Turns database refusals into messages for people:
 * - duplicate names/codes → CONFLICT naming the field;
 * - still referenced on delete → CONFLICT suggesting archive;
 * - a row from another school or a closed year → NOT_FOUND / CONFLICT.
 */
export function mapSetupError(e: unknown, labels: { duplicate?: Record<string, [field: string, message: string]>; inUse?: string } = {}): never {
  const unique = uniqueViolation(e);
  if (unique !== null) {
    for (const [fragment, [field, message]] of Object.entries(labels.duplicate ?? {})) {
      if (unique.includes(fragment)) throw new AppError("CONFLICT", message, { [field]: message });
    }
    throw new AppError("CONFLICT", "Something with these details already exists.");
  }
  if (foreignKeyViolation(e)) {
    throw new AppError("CONFLICT", labels.inUse ?? "This is in use and cannot be deleted. Archive it instead.");
  }
  if (checkViolation(e) !== null) throw new AppError("VALIDATION", "Some values are outside the allowed range.");
  if (isRlsViolation(e)) throw new AppError("CONFLICT", "This cannot be changed: the academic year is closed, or you do not have permission.");
  throw e;
}

/** Percent text such as "33", "33.5" or "33.33" → basis points (3333). Exact, no floating point. */
export function percentToBp(value: string): number | null {
  const m = value.trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

/** 3333 → "33.33", 3300 → "33". */
export function bpToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
