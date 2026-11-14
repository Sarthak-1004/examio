import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@examio/db";
import { AppError } from "./errors";

/**
 * Rate limiting backed by PostgreSQL, so every server instance shares the same counters.
 * Counters are fixed windows keyed by SHA-256(scope, subject): identifiers and addresses
 * are never stored. Always call these outside a business transaction, otherwise a rolled-back
 * failure would not be counted.
 */
export interface RateLimitRule {
  /** Names the kind of limit, e.g. "login:identifier". */
  scope: string;
  /** Who or what is being limited within the scope. */
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

function bucketKey(scope: string, subject: string): string {
  return createHash("sha256").update(scope).update("\0").update(subject).digest("hex");
}

interface HitRow extends Record<string, unknown> {
  allowed: boolean;
  retry_after_seconds: number;
}

export async function hitRateLimit(db: Db, rule: RateLimitRule): Promise<RateLimitResult> {
  const rows = (await db.execute<HitRow>(
    sql`select allowed, retry_after_seconds from rate_limit_hit(${bucketKey(rule.scope, rule.subject)}, ${rule.limit}::integer, ${rule.windowSeconds}::integer)`,
  )) as unknown as HitRow[];
  const row = rows[0];
  if (!row) throw new Error("rate_limit_hit returned no row");
  return { allowed: row.allowed === true, retryAfterSec: Number(row.retry_after_seconds) };
}

/**
 * Gives back the attempt counted for each rule after the operation succeeded, so that only
 * failures consume a limit. Earlier failures stay counted: a success never clears a bucket.
 */
export async function refundRateLimits(db: Db, rules: readonly RateLimitRule[]): Promise<void> {
  for (const rule of rules) {
    await db.execute(sql`select rate_limit_refund(${bucketKey(rule.scope, rule.subject)})`);
  }
}

/**
 * Counts one attempt against every rule and throws RATE_LIMITED if any is exhausted.
 * All rules are counted even when an earlier one already failed, so limits cannot be
 * probed one at a time.
 */
export async function enforceRateLimits(db: Db, rules: readonly RateLimitRule[]): Promise<void> {
  let retryAfterSec = 0;
  let blocked = false;
  for (const rule of rules) {
    const r = await hitRateLimit(db, rule);
    if (!r.allowed) {
      blocked = true;
      retryAfterSec = Math.max(retryAfterSec, r.retryAfterSec);
    }
  }
  if (blocked) {
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    throw new AppError("RATE_LIMITED", `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}
