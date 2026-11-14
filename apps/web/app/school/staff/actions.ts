"use server";

import { revalidatePath } from "next/cache";
import {
  AppError,
  addStaffProfileForMember,
  assignTeacher,
  commitStaffImport,
  createMembershipInvitation,
  createStaffMember,
  endAssignment,
  issueAccountCode,
  markStaffLeft,
  previewStaffImport,
  reactivateStaff,
  revokeMembershipInvitation,
  revokeUserSessions,
  setClassTeacher,
  updateStaffProfile,
  type ImportPreview,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Server actions for staff management. Each checks that the caller is an administrator of the
 * selected school; the services and the database check again. One-time codes are returned in the
 * form state to be shown once, and are never stored by the page.
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string | FormState>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const r = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school", "layout");
    return typeof r === "string" ? { ok: true, message: r } : { ok: true, ...r };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export async function createStaffAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await createStaffMember(db, ctx, schoolId, {
      fullName: str(fd, "fullName"),
      email: str(fd, "email"),
      phone: str(fd, "phone"),
      employeeNo: str(fd, "employeeNo"),
      jobTitle: str(fd, "jobTitle"),
      role: str(fd, "role") as "teacher" | "finance",
      joinedOn: str(fd, "joinedOn"),
    });
    return {
      message: `${str(fd, "fullName")} added. Give them this activation code; they choose their password at /redeem.`,
      code: r.activationCode,
      codeExpires: when(r.codeExpiresAt),
    };
  });
}

export async function addProfileForMemberAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await addStaffProfileForMember(db, ctx, schoolId, str(fd, "userId"), { employeeNo: str(fd, "employeeNo"), displayName: str(fd, "displayName"), jobTitle: str(fd, "jobTitle") });
    return "Staff details added.";
  });
}

export async function updateStaffAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateStaffProfile(db, ctx, schoolId, str(fd, "staffId"), { employeeNo: str(fd, "employeeNo"), displayName: str(fd, "displayName"), jobTitle: str(fd, "jobTitle"), joinedOn: str(fd, "joinedOn") });
    return "Saved.";
  });
}

export async function markLeftAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await markStaffLeft(db, ctx, schoolId, str(fd, "staffId"), { leftOn: str(fd, "leftOn") || undefined, reason: str(fd, "reason") });
    return `Marked as left. School access ended${r.endedAssignments ? `; ${r.endedAssignments} assignment(s) ended` : ""}.`;
  });
}

export async function reactivateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await reactivateStaff(db, ctx, schoolId, str(fd, "staffId"));
    return "Welcome back: access restored.";
  });
}

export async function issueStaffCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const purpose = str(fd, "purpose") === "activation" ? "activation" : "password_reset";
    const r = await issueAccountCode(db, { ...ctx, schoolId }, { userId: str(fd, "userId"), purpose, reason: str(fd, "reason") });
    return { message: "Give them this one-time code; they enter it at /redeem.", code: r.code, codeExpires: when(r.expiresAt) };
  });
}

export async function signOutEverywhereAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const n = await revokeUserSessions(db, { ...ctx, schoolId }, str(fd, "userId"));
    return n ? `Signed out of ${n} device(s).` : "They were not signed in anywhere.";
  });
}

export async function assignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await assignTeacher(db, ctx, schoolId, { staffId: str(fd, "staffId"), sectionId: str(fd, "sectionId"), subjectId: str(fd, "subjectId"), startsOn: str(fd, "startsOn") || undefined });
    return `Assigned from ${r.startsOn}.`;
  });
}

export async function classTeacherAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await setClassTeacher(db, ctx, schoolId, { staffId: str(fd, "staffId"), sectionId: str(fd, "sectionId"), startsOn: str(fd, "startsOn") || undefined });
    return r.replaced ? `Class teacher from ${r.startsOn}; the previous class teacher's role ends the day before.` : `Class teacher from ${r.startsOn}.`;
  });
}

export async function endAssignmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await endAssignment(db, ctx, schoolId, { kind: str(fd, "kind") === "class_teacher" ? "class_teacher" : "subject", id: str(fd, "id"), endsOn: str(fd, "endsOn") || undefined });
    return `Ends on ${r.endsOn}.`;
  });
}

export async function inviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    // Staff invitations only; student and parent invitations belong to Phase 5.
    const role = str(fd, "role");
    if (role !== "teacher" && role !== "finance") throw new AppError("VALIDATION", "Choose teacher or finance.", { role: "Choose teacher or finance." });
    const r = await createMembershipInvitation(db, ctx, schoolId, { role, recipientLabel: str(fd, "recipientLabel") });
    return { message: "Invitation created. Give the code to the person; they sign in to their own account and enter it at /join.", code: r.code, codeExpires: when(r.expiresAt) };
  });
}

export async function revokeInvitationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await revokeMembershipInvitation(db, ctx, schoolId, str(fd, "invitationId"));
    return "Invitation cancelled.";
  });
}

/* ------------------------------------------------------------------ import */

export interface ImportState {
  preview?: ImportPreview;
  /** The text that was previewed, sent back with the commit so the server can check it is unchanged. */
  text?: string;
  key?: string;
  result?: { created: number; codes: { employeeNo: string; name: string; code: string }[] | null; replayed: boolean };
  message?: string;
}

async function readImportText(fd: FormData): Promise<string> {
  const file = fd.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > 256 * 1024) throw new AppError("VALIDATION", "The file is larger than 256 KB.");
    return file.text();
  }
  return str(fd, "text");
}

export async function previewImportAction(_prev: ImportState, fd: FormData): Promise<ImportState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const text = await readImportText(fd);
    const preview = await previewStaffImport(db, s.ctx, s.ctx.schoolId, text);
    return { preview, text, key: `staff-import-${crypto.randomUUID()}` };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
}

export async function commitImportAction(prev: ImportState, fd: FormData): Promise<ImportState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const result = await commitStaffImport(db, s.ctx, s.ctx.schoolId, { text: str(fd, "text"), fingerprint: str(fd, "fingerprint"), idempotencyKey: str(fd, "key") });
    revalidatePath("/school", "layout");
    return { ...prev, result };
  } catch (e) {
    if (e instanceof AppError) return { ...prev, message: e.message };
    throw e;
  }
}
