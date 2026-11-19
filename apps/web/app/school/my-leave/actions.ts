"use server";

import { revalidatePath } from "next/cache";
import { AppError, cancelLeave, requestLeave } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Leave self-service for any staff member; the services and the database check the rest. */
export async function myLeaveRequestAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  try {
    const r = await requestLeave(db, s.ctx, s.ctx.schoolId, {
      leaveTypeId: str(fd, "leaveTypeId"),
      fromOn: str(fd, "fromOn"),
      toOn: str(fd, "toOn"),
      halfDay: str(fd, "halfDay") === "on",
      reason: str(fd, "reason"),
    });
    revalidatePath("/school/my-leave");
    return { ok: true, message: `Requested ${r.days} working day(s). An administrator will decide it.` };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function myLeaveCancelAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  try {
    await cancelLeave(db, s.ctx, s.ctx.schoolId, str(fd, "requestId"));
    revalidatePath("/school/my-leave");
    return { ok: true, message: "Request cancelled." };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}
