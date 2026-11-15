"use server";

import { revalidatePath } from "next/cache";
import { AppError, archiveAnnouncement, publishAnnouncement } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Notices: administrators any audience, teachers their own sections (checked in the service and the database). */
export async function publishNoticeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const r = await publishAnnouncement(db, s.ctx, s.ctx.schoolId, { title: str(fd, "title"), body: str(fd, "body"), audience: str(fd, "audience"), sectionId: str(fd, "sectionId") });
    revalidatePath("/school/announcements");
    return { ok: true, message: `Notice published (${r.notified} notification(s) queued).` };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function archiveNoticeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    await archiveAnnouncement(db, s.ctx, s.ctx.schoolId, str(fd, "announcementId"));
    revalidatePath("/school/announcements");
    return { ok: true, message: "Notice archived." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
