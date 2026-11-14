import { auditEvents, type Tx } from "@examio/db";

export interface AuditInput {
  action: string;
  actorUserId: string | null;
  schoolId?: string | null;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
}

/** Append an audit event inside the caller's transaction (so it commits or rolls back with the change). */
export async function audit(tx: Tx, e: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    action: e.action,
    actorUserId: e.actorUserId,
    schoolId: e.schoolId ?? null,
    entityType: e.entityType,
    entityId: e.entityId,
    data: e.data,
  });
}
