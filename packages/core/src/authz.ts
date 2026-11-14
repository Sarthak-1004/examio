import { z } from "zod";
import type { RequestContext } from "@examio/db";
import { AppError } from "./errors";

/**
 * Service-level authorization guards. These run before any query and are the first of two
 * layers: PostgreSQL policies re-check the same boundaries against the database.
 */

export type PlatformContext = RequestContext & { userId: string; isPlatformAdmin: true };

export function requireSignedIn(ctx: RequestContext): asserts ctx is RequestContext & { userId: string } {
  if (!ctx.userId) throw new AppError("FORBIDDEN", "Not signed in.");
}

export function requirePlatformAdmin(ctx: RequestContext): asserts ctx is PlatformContext {
  if (!ctx.userId || !ctx.isPlatformAdmin) {
    throw new AppError("FORBIDDEN", "Only platform administrators can do this.");
  }
}

/**
 * The caller may act on `schoolId` only if it is their selected school or they are a platform
 * administrator. Another school's identifier is reported as not found, so its existence is
 * not disclosed.
 */
export function requireSchoolScope(ctx: RequestContext, schoolId: string): void {
  requireSignedIn(ctx);
  if (!ctx.isPlatformAdmin && ctx.schoolId !== schoolId) {
    throw new AppError("NOT_FOUND", "School not found.");
  }
}

const uuidSchema = z.uuid();

/** Rejects malformed identifiers before they reach SQL. */
export function requireUuid(value: string, what: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new AppError("NOT_FOUND", `${what} not found.`);
  return parsed.data;
}
