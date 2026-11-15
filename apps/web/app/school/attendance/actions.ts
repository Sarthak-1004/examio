"use server";

import { revalidatePath } from "next/cache";
import { AppError, submitRegister, updateAttendanceSettings } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Attendance actions. The register is open to administrators and teachers; the service and the
 * database decide which sections, dates and changes each may make.
 */

export async function submitRegisterAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher");
  try {
    const entries = fd
      .getAll("enrollment")
      .filter((v): v is string => typeof v === "string")
      .map((id) => {
        return { enrollmentId: id, status: str(fd, `status-${id}`), note: str(fd, `note-${id}`) };
      });
    const r = await submitRegister(db, s.ctx, s.ctx.schoolId, {
      sectionId: str(fd, "sectionId"),
      sessionId: str(fd, "sessionId"),
      date: str(fd, "date"),
      version: str(fd, "version"),
      entries,
      reason: str(fd, "reason"),
    });
    revalidatePath("/school", "layout");
    const parts = [r.created ? `${r.created} marked` : "", r.changed ? `${r.changed} changed` : "", !r.created && !r.changed ? "No changes" : ""].filter(Boolean);
    return { ok: true, message: `Register saved: ${parts.join(", ")}.` };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function attendanceSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    await updateAttendanceSettings(db, s.ctx, s.ctx.schoolId, {
      editDays: str(fd, "editDays"),
      weeklyOffDays: fd.getAll("weeklyOff").filter((v): v is string => typeof v === "string"),
      lockedThrough: str(fd, "lockedThrough"),
    });
    revalidatePath("/school", "layout");
    return { ok: true, message: "Attendance settings saved." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
