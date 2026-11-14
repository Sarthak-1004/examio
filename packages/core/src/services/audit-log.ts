import { and, desc, eq, gte, ilike, isNull, lt, sql, type SQL } from "drizzle-orm";
import { auditEvents, users, withContext, type Db, type RequestContext } from "@examio/db";
import { requirePlatformAdmin } from "../authz";
import { withCapability } from "../capabilities";
import { likePattern, toPage, type Page, type PageRequest } from "../paging";

/**
 * Audit log viewer.
 * - School administrators: their school's events.
 * - Platform administrators: platform-level events of accounts they may see, plus everything
 *   platform administrators did anywhere (the database policy decides; a support grant also
 *   shows that school's events).
 * Read-only: the audit log cannot be changed or deleted through the application.
 */
export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  actorName: string | null;
  actorUserId: string | null;
  schoolId: string | null;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
}

export interface AuditFilter extends PageRequest {
  /** ISO dates (YYYY-MM-DD), interpreted in the school's timezone by the caller's display; here as UTC days. */
  from?: string;
  to?: string;
}

const columns = {
  id: auditEvents.id,
  createdAt: auditEvents.createdAt,
  action: auditEvents.action,
  actorName: users.fullName,
  actorUserId: auditEvents.actorUserId,
  schoolId: auditEvents.schoolId,
  entityType: auditEvents.entityType,
  entityId: auditEvents.entityId,
  data: auditEvents.data,
};

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

function filters(f: AuditFilter, scope: SQL | undefined): SQL | undefined {
  const parts: SQL[] = scope ? [scope] : [];
  if (f.search) parts.push(ilike(auditEvents.action, likePattern(f.search)));
  if (f.from && isoDay.test(f.from)) parts.push(gte(auditEvents.createdAt, new Date(`${f.from}T00:00:00Z`)));
  if (f.to && isoDay.test(f.to)) parts.push(lt(auditEvents.createdAt, new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)));
  return parts.length ? and(...parts) : undefined;
}

async function query(tx: Parameters<Parameters<typeof withContext>[2]>[0], where: SQL | undefined, f: AuditFilter): Promise<Page<AuditRow>> {
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where);
  const rows = await tx
    .select(columns)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return toPage(rows, count?.n ?? 0, f);
}

export async function listSchoolAuditEvents(db: Db, ctx: RequestContext, schoolId: string, f: AuditFilter): Promise<Page<AuditRow>> {
  return withCapability(db, ctx, schoolId, "school.audit.view", (tx) => query(tx, filters(f, eq(auditEvents.schoolId, schoolId)), f));
}

/** Platform-level events (no school), as far as the database lets this administrator see. */
export async function listPlatformAuditEvents(db: Db, ctx: RequestContext, f: AuditFilter): Promise<Page<AuditRow>> {
  requirePlatformAdmin(ctx);
  return withContext(db, ctx, (tx) => query(tx, filters(f, isNull(auditEvents.schoolId)), f));
}
