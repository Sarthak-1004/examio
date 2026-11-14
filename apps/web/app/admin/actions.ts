"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  addLookup,
  createSchoolWithAdmin,
  endSupportAccess,
  issueAccountCode,
  retryDeadJob,
  setLookupActive,
  setSchoolStatus,
  startSupportAccess,
} from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, toFormState, type FormState } from "@/lib/forms";

export async function createSchoolAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requirePlatformAdmin();
  let schoolId: string;
  try {
    ({ schoolId } = await createSchoolWithAdmin(db, s.ctx, {
      name: str(fd, "name"),
      code: str(fd, "code"),
      boardId: str(fd, "boardId"),
      mediumId: str(fd, "mediumId"),
      timezone: str(fd, "timezone") || "Asia/Kolkata",
      address: str(fd, "address"),
      contactEmail: str(fd, "contactEmail"),
      contactPhone: str(fd, "contactPhone"),
      admin: {
        fullName: str(fd, "adminName"),
        email: str(fd, "adminEmail"),
        phone: str(fd, "adminPhone"),
        password: str(fd, "adminPassword"),
      },
    }));
  } catch (e) {
    const st = toFormState(e, fd);
    // Map nested service field names to form input names.
    const map: Record<string, string> = {
      "admin.fullName": "adminName",
      "admin.email": "adminEmail",
      "admin.phone": "adminPhone",
      "admin.password": "adminPassword",
    };
    if (st.fields) st.fields = Object.fromEntries(Object.entries(st.fields).map(([k, v]) => [map[k] ?? k, v]));
    return st;
  }
  revalidatePath("/admin");
  redirect(`/admin/schools/${schoolId}?created=1`);
}

export async function setSchoolStatusAction(fd: FormData): Promise<void> {
  const s = await requirePlatformAdmin();
  const id = str(fd, "schoolId");
  const status = str(fd, "status");
  if (status !== "active" && status !== "suspended" && status !== "onboarding") throw new Error("Bad status");
  await setSchoolStatus(db, s.ctx, id, status);
  revalidatePath(`/admin/schools/${id}`);
  revalidatePath("/admin");
}

export async function addLookupAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requirePlatformAdmin();
  const kind = str(fd, "kind") === "medium" ? "medium" : "board";
  try {
    await addLookup(db, s.ctx, kind, str(fd, "name"));
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath("/admin/settings");
  return { ok: true, message: `${kind === "board" ? "Board" : "Medium"} added.` };
}

export async function toggleLookupAction(fd: FormData): Promise<void> {
  const s = await requirePlatformAdmin();
  const kind = str(fd, "kind") === "medium" ? "medium" : "board";
  await setLookupActive(db, s.ctx, kind, str(fd, "id"), str(fd, "active") === "true");
  revalidatePath("/admin/settings");
}

/**
 * Platform admin issues a one-time password reset code for a school administrator.
 * The code is returned once, to be handed to that person; it is not stored in readable form.
 */
export async function issueResetCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requirePlatformAdmin();
  try {
    const { code, expiresAt } = await issueAccountCode(db, s.ctx, {
      userId: str(fd, "userId"),
      purpose: "password_reset",
      reason: str(fd, "reason"),
    });
    return {
      ok: true,
      code,
      codeExpires: expiresAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }),
    };
  } catch (e) {
    return toFormState(e, fd);
  }
}

/**
 * Platform admin opens a time-limited support access grant for one school. The reason is
 * recorded in that school's audit log and shown to its administrators.
 */
export async function startSupportAccessAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const s = await requirePlatformAdmin();
  const schoolId = str(fd, "schoolId");
  try {
    await startSupportAccess(db, s.ctx, { schoolId, reason: str(fd, "reason") });
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  return { ok: true };
}

export async function endSupportAccessAction(fd: FormData): Promise<void> {
  const s = await requirePlatformAdmin();
  try {
    await endSupportAccess(db, s.ctx, str(fd, "grantId"));
  } catch (e) {
    // Already ended or expired: the outcome the caller wanted.
    if (!(e instanceof AppError && e.code === "NOT_FOUND")) throw e;
  }
  revalidatePath(`/admin/schools/${str(fd, "schoolId")}`);
}

/** Put a dead-lettered job back in the queue. */
export async function retryJobAction(fd: FormData): Promise<void> {
  const s = await requirePlatformAdmin();
  try {
    await retryDeadJob(db, s.ctx, str(fd, "jobId"));
  } catch (e) {
    // Already retried by someone else: the outcome the caller wanted.
    if (!(e instanceof AppError && e.code === "NOT_FOUND")) throw e;
  }
  revalidatePath("/admin/system");
}
