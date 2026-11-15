"use server";

import { revalidatePath } from "next/cache";
import { AppError, addTimetableSlot, removeTimetableSlot } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Timetable changes: school administrators only (checked again in the service and the database). */
export async function addSlotAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    await addTimetableSlot(db, s.ctx, s.ctx.schoolId, {
      sectionId: str(fd, "sectionId"),
      subjectId: str(fd, "subjectId"),
      staffId: str(fd, "staffId"),
      weekday: str(fd, "weekday"),
      start: str(fd, "start"),
      end: str(fd, "end"),
      room: str(fd, "room"),
    });
    revalidatePath("/school/timetable");
    return { ok: true, message: "Period added." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function removeSlotAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    await removeTimetableSlot(db, s.ctx, s.ctx.schoolId, str(fd, "slotId"));
    revalidatePath("/school/timetable");
    return { ok: true, message: "Period removed." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
