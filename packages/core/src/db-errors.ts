interface PgError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  cause?: unknown;
}

/** Finds the underlying Postgres error (drizzle wraps driver errors in `cause`). */
function pgError(e: unknown): PgError | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const c = cur as PgError;
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c;
    cur = c.cause;
  }
  return undefined;
}

export function uniqueViolation(e: unknown): string | null {
  const pg = pgError(e);
  if (pg?.code !== "23505") return null;
  return pg.constraint_name ?? pg.constraint ?? "";
}

/** Foreign-key violation: the row is still referenced (delete) or points at a missing row (insert). */
export function foreignKeyViolation(e: unknown): boolean {
  return pgError(e)?.code === "23503";
}

/** A CHECK constraint failed; returns its name. */
export function checkViolation(e: unknown): string | null {
  const pg = pgError(e);
  if (pg?.code !== "23514") return null;
  return pg.constraint_name ?? pg.constraint ?? "";
}

export function isRlsViolation(e: unknown): boolean {
  return pgError(e)?.code === "42501";
}
