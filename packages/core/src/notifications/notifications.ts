import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { notifications, withContext, withWorkerContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { requireSignedIn, requireUuid } from "../authz";
import { AppError } from "../errors";
import { PermanentJobError, type ClaimedJob, type JsonValue } from "../jobs/queue";
import type { EmailAdapter } from "./email";
import { isTemplateName, renderTemplate, type TemplateName } from "./templates";

/**
 * Notifications: queued in the caller's transaction (with a delivery job), delivered by the
 * worker. In-app notifications are delivered by being stored; email goes through the
 * configured adapter (sandbox only, for now).
 */
export type NotificationChannel = "in_app" | "email";

interface CountRow extends Record<string, unknown> {
  n: number;
}

const channelArray = (channels: readonly NotificationChannel[]) =>
  sql`array[${sql.join(channels.map((c) => sql`${c}`), sql`, `)}]::notification_channel[]`;

/** Queue for one recipient. Returns how many notifications were created (0 if already queued). */
export async function queueNotification(
  tx: Tx,
  opts: { recipientUserId: string; schoolId: string | null; channels: readonly NotificationChannel[]; template: TemplateName; params: { [k: string]: JsonValue }; dedupeKey: string },
): Promise<number> {
  const rows = (await tx.execute<CountRow>(sql`select notification_queue(
    ${opts.recipientUserId}::uuid, ${opts.schoolId}::uuid, ${channelArray(opts.channels)}, ${opts.template}, ${JSON.stringify(opts.params)}::jsonb, ${opts.dedupeKey}
  ) as n`)) as unknown as CountRow[];
  return Number(rows[0]?.n ?? 0);
}

/** Queue for every active administrator of a school. */
export async function queueSchoolAdminNotification(
  tx: Tx,
  opts: { schoolId: string; channels: readonly NotificationChannel[]; template: TemplateName; params: { [k: string]: JsonValue }; dedupeKey: string },
): Promise<number> {
  const rows = (await tx.execute<CountRow>(sql`select notification_queue_school_admins(
    ${opts.schoolId}::uuid, ${channelArray(opts.channels)}, ${opts.template}, ${JSON.stringify(opts.params)}::jsonb, ${opts.dedupeKey}
  ) as n`)) as unknown as CountRow[];
  return Number(rows[0]?.n ?? 0);
}

interface DeliveryRow extends Record<string, unknown> {
  id: string;
  channel: NotificationChannel;
  template: string;
  params: unknown;
  status: "pending" | "delivered" | "sandboxed" | "failed";
  recipient_name: string;
  recipient_email: string | null;
}

/**
 * Job handler for `notification.deliver`. Idempotent: an already delivered notification is
 * left alone, so a retried or duplicated job never sends twice.
 */
export function notificationDeliveryHandler(db: Db, email: EmailAdapter) {
  return async (job: ClaimedJob): Promise<void> => {
    const id = job.payload.notificationId;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentJobError("payload has no valid notificationId");

    const rows = (await withWorkerContext(db, job.schoolId, (tx) =>
      tx.execute<DeliveryRow>(sql`select * from notification_for_delivery(${id}::uuid)`),
    )) as unknown as DeliveryRow[];
    const n = rows[0];
    if (!n) throw new PermanentJobError("notification no longer exists");
    if (n.status === "delivered" || n.status === "sandboxed") return;

    const mark = (status: "delivered" | "sandboxed" | "failed", provider: string, ref: string | null, error: string | null) =>
      withWorkerContext(db, job.schoolId, (tx) =>
        tx.execute(sql`select notification_mark(${id}::uuid, ${status}::notification_status, ${provider}, ${ref}, ${error})`),
      );

    const message = renderTemplate(n.template, n.params);
    if (!message) {
      await mark("failed", "none", null, "unknown template or invalid parameters");
      throw new PermanentJobError(`cannot render template ${n.template}`);
    }

    if (n.channel === "in_app") {
      await mark("delivered", "in_app", null, null);
      return;
    }

    if (!n.recipient_email) {
      await mark("failed", email.name, null, "recipient has no email address");
      throw new PermanentJobError("recipient has no email address");
    }
    const { providerRef } = await email.send({ to: n.recipient_email, subject: message.subject, text: message.text });
    await mark(email.sandbox ? "sandboxed" : "delivered", email.name, providerRef, null);
  };
}

export interface InAppNotification {
  id: string;
  subject: string;
  text: string;
  createdAt: Date;
  readAt: Date | null;
}

/** The signed-in user's own in-app notifications, newest first. */
export async function listMyNotifications(db: Db, ctx: RequestContext, limit = 10): Promise<InAppNotification[]> {
  requireSignedIn(ctx);
  const rows = await withContext(db, ctx, (tx) =>
    tx
      .select({ id: notifications.id, template: notifications.template, params: notifications.params, createdAt: notifications.createdAt, readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.recipientUserId, ctx.userId), eq(notifications.channel, "in_app"), eq(notifications.status, "delivered")))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(Math.max(Math.trunc(limit), 1), 50)),
  );
  return rows.flatMap((r) => {
    const m = isTemplateName(r.template) ? renderTemplate(r.template, r.params) : null;
    return m ? [{ id: r.id, subject: m.subject, text: m.text, createdAt: r.createdAt, readAt: r.readAt }] : [];
  });
}

export async function markNotificationRead(db: Db, ctx: RequestContext, notificationId: string): Promise<void> {
  requireSignedIn(ctx);
  requireUuid(notificationId, "Notification");
  const updated = await withContext(db, ctx, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, ctx.userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id }),
  );
  if (updated.length === 0) throw new AppError("NOT_FOUND", "Notification not found.");
}
