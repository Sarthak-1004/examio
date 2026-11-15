import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { announcements, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { schoolToday } from "../../dates";
import { AppError } from "../../errors";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Notices (Phase 7). Administrators publish to everyone, staff, students, parents or one section;
 * teachers publish only to a section they teach today. A section notice reaches the section's
 * current students, their linked parents and its teachers. Recipients are notified in-app and by
 * email once per notice (dedupe key "announcement:<id>"). Notices are archived, never deleted;
 * administrators and the author see delivery and read counts.
 */

export const AUDIENCES = ["everyone", "staff", "students", "parents", "section"] as const;
export type Audience = (typeof AUDIENCES)[number];

const publishSchema = z
  .object({
    title: trimmed("Title", 1, 150),
    body: trimmed("Message", 1, 5000),
    audience: z.enum(AUDIENCES, { message: "Choose who should receive it." }),
    sectionId: z.union([z.literal("").transform(() => null), z.uuid({ message: "Section not found." })]).nullable().optional(),
  })
  .refine((v) => (v.audience === "section") === !!v.sectionId, { message: "Choose a section for a class notice.", path: ["sectionId"] });

export async function publishAnnouncement(db: Db, ctx: RequestContext, schoolId: string, input: { title: string; body: string; audience: string; sectionId?: string | null }): Promise<{ id: string; notified: number }> {
  const d = parse(publishSchema, input);
  return withCapability(db, ctx, schoolId, "school.announcements.publish", async (tx, actor) => {
    const [who] = (await tx.execute(sql`select app_can_manage_setup(${schoolId}::uuid) as admin, timezone from schools where id = ${schoolId}::uuid`)) as unknown as { admin: boolean; timezone: string }[];
    if (!who?.admin) {
      if (d.audience !== "section") throw new AppError("FORBIDDEN", "Teachers send notices to a section they teach.");
      const [t] = (await tx.execute(sql`select app_teaches_section(${d.sectionId}::uuid, ${schoolToday(who?.timezone ?? "Asia/Kolkata")}::date) as ok`)) as unknown as { ok: boolean }[];
      if (!t?.ok) throw new AppError("NOT_FOUND", "Section not found.");
    } else if (d.sectionId) {
      const [s] = (await tx.execute(sql`select 1 as ok from sections where school_id = ${schoolId}::uuid and id = ${d.sectionId}::uuid`)) as unknown as { ok: number }[];
      if (!s) throw new AppError("NOT_FOUND", "Section not found.");
    }
    const [row] = await tx
      .insert(announcements)
      .values({ schoolId, authorUserId: actor.userId, title: d.title, body: d.body, audience: d.audience, sectionId: d.sectionId ?? null })
      .returning({ id: announcements.id });
    const id = row!.id;
    const excerpt = d.body.length > 280 ? `${d.body.slice(0, 277)}…` : d.body;
    const [n] = (await tx.execute(sql`select app_notify_audience('announcement', ${id}::uuid, 'announcement.published', ${JSON.stringify({ title: d.title, excerpt })}::jsonb, ${`announcement:${id}`}) as n`)) as unknown as { n: number }[];
    await audit(tx, { action: "announcement.published", actorUserId: actor.userId, schoolId, entityType: "announcement", entityId: id, data: { audience: d.audience, sectionId: d.sectionId ?? null, notifications: n?.n ?? 0 } });
    return { id, notified: n?.n ?? 0 };
  });
}

export async function archiveAnnouncement(db: Db, ctx: RequestContext, schoolId: string, announcementId: string): Promise<void> {
  parse(uuidField("Notice"), announcementId);
  await withCapability(db, ctx, schoolId, "school.announcements.publish", async (tx, actor) => {
    const r = await tx
      .update(announcements)
      .set({ archivedAt: sql`now()` })
      .where(and(eq(announcements.schoolId, schoolId), eq(announcements.id, announcementId), isNull(announcements.archivedAt)))
      .returning({ id: announcements.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Notice not found or already archived.");
    await audit(tx, { action: "announcement.archived", actorUserId: actor.userId, schoolId, entityType: "announcement", entityId: announcementId });
  });
}

export interface Notice {
  id: string;
  title: string;
  body: string;
  audience: Audience;
  sectionLabel: string | null;
  authorName: string | null;
  publishedAt: Date;
  archivedAt: Date | null;
}

export interface StaffNotice extends Notice {
  mine: boolean;
  delivery: { recipients: number; delivered: number; pending: number; failed: number; read: number } | null;
}

const noticeSelect = sql`
  select a.id, a.title, a.body, a.audience::text as audience, case when s.id is null then null else c.name || ' ' || s.name end as "sectionLabel",
         u.full_name as "authorName", a.published_at as "publishedAt", a.archived_at as "archivedAt", a.author_user_id = app_user_id() as mine
  from announcements a left join sections s on s.id = a.section_id left join classes c on c.id = s.class_id left join users u on u.id = a.author_user_id`;

/** Notices for staff: administrators see all; teachers see their own and those addressed to them. */
export async function listAnnouncementsForStaff(db: Db, ctx: RequestContext, schoolId: string, opts: { archived?: boolean } = {}): Promise<StaffNotice[]> {
  return withCapability(db, ctx, schoolId, "school.announcements.publish", async (tx) => {
    const rows = (await tx.execute(sql`${noticeSelect}
      where a.school_id = ${schoolId}::uuid and ${opts.archived ? sql`a.archived_at is not null` : sql`a.archived_at is null`}
      order by a.published_at desc limit 100`)) as unknown as (Notice & { mine: boolean })[];
    const [admin] = (await tx.execute(sql`select app_can_manage_setup(${schoolId}::uuid) as ok`)) as unknown as { ok: boolean }[];
    const out: StaffNotice[] = [];
    for (const r of rows) {
      let delivery: StaffNotice["delivery"] = null;
      if (r.mine || admin?.ok) {
        const [d] = (await tx.execute(sql`select * from app_announcement_delivery(${r.id}::uuid)`)) as unknown as NonNullable<StaffNotice["delivery"]>[];
        delivery = d ?? null;
      }
      out.push({ ...r, delivery });
    }
    return out;
  });
}

/** Notices addressed to the signed-in user (students: school/students/own section; parents: also their children's sections). */
export async function listMyNotices(db: Db, ctx: RequestContext, schoolId: string, limit = 30): Promise<Notice[]> {
  return withCapability(db, ctx, schoolId, "school.announcements.view", async (tx) =>
    (await tx.execute(sql`${noticeSelect}
      where a.school_id = ${schoolId}::uuid and a.archived_at is null and app_announcement_for_me(a.school_id, a.audience, a.section_id)
      order by a.published_at desc limit ${Math.min(Math.max(Math.trunc(limit), 1), 100)}`)) as unknown as Notice[],
  );
}
