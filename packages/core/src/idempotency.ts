import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { idempotencyRecords, type RequestContext, type Tx } from "@examio/db";
import { requireSignedIn } from "./authz";
import { AppError } from "./errors";
import type { JsonValue } from "./jobs/queue";

/**
 * Makes a retriable operation safe to repeat. The client sends a key (for example a UUID
 * generated when the form was shown) with the request:
 * - first time: the operation runs and its result is stored with the key, in the same transaction;
 * - same key, same request: the stored result is returned and nothing runs again;
 * - same key, different request: CONFLICT.
 * A concurrent duplicate waits for the first to commit, then replays its result.
 *
 * The stored result must not contain secrets (one-time codes, passwords); return a reference
 * instead. Records expire after `ttlSeconds` (default 24 hours) and are purged by the worker.
 */
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export function requestFingerprint(request: unknown): string {
  return createHash("sha256").update(stable(request)).digest("hex");
}

export async function withIdempotency<T extends JsonValue>(
  tx: Tx,
  ctx: RequestContext,
  opts: { operation: string; key: string; request: unknown; schoolId?: string | null; ttlSeconds?: number },
  run: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  requireSignedIn(ctx);
  if (!KEY_FORMAT.test(opts.key)) throw new AppError("VALIDATION", "The request key is missing or malformed. Reload the page and try again.");
  const requestHash = requestFingerprint(opts.request);
  const ttl = Math.min(Math.max(opts.ttlSeconds ?? 86_400, 60), 7 * 86_400);

  const inserted = await tx
    .insert(idempotencyRecords)
    .values({
      actorUserId: ctx.userId,
      schoolId: opts.schoolId ?? null,
      operation: opts.operation,
      key: opts.key,
      requestHash,
      expiresAt: sql`now() + make_interval(secs => ${ttl}::integer)`,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id });

  if (inserted.length === 0) {
    const [existing] = await tx
      .select({ requestHash: idempotencyRecords.requestHash, response: idempotencyRecords.response, completedAt: idempotencyRecords.completedAt })
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.actorUserId, ctx.userId), eq(idempotencyRecords.operation, opts.operation), eq(idempotencyRecords.key, opts.key)));
    if (!existing || existing.requestHash !== requestHash) {
      throw new AppError("CONFLICT", "This request key was already used for a different request.");
    }
    if (!existing.completedAt) throw new AppError("CONFLICT", "The same request is still being processed. Try again in a moment.");
    return { result: existing.response as T, replayed: true };
  }

  const result = await run();
  await tx
    .update(idempotencyRecords)
    .set({ response: result, completedAt: sql`now()` })
    .where(eq(idempotencyRecords.id, inserted[0]!.id));
  return { result, replayed: false };
}
