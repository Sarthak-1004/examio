"use server";

import { revalidatePath } from "next/cache";
import {
  AppError,
  addStudentProfileForMember,
  admitStudent,
  attachStudentDocument,
  changeSection,
  commitPromotion,
  commitStudentImport,
  correctEnrollment,
  createGuardianAccount,
  createGuardianCode,
  enrollStudent,
  issueAccountCode,
  linkExistingGuardian,
  markStudentLeft,
  numberRollsAlphabetically,
  previewStudentImport,
  readmitStudent,
  removeStudentDocument,
  revokeGuardianLink,
  revokeUserSessions,
  setRollNo,
  updateStudentProfile,
  uploadFile,
  STUDENT_DOCUMENT_PURPOSE,
  type StudentImportPreview,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { getSession, requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";
import { fileStorage } from "@/lib/runtime";
import { formatDateTime } from "@/lib/format";

/**
 * Server actions for students, enrollments and guardians. Each checks that the caller is an
 * administrator of the selected school; the services and the database check again. One-time
 * codes are returned in the form state to be shown once and are never stored by the page.
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

/** An expiry time as the school sees it. */
const when = async (d: Date) => formatDateTime(d, (await getSession())?.timeZone);

export async function admitStudentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await admitStudent(db, ctx, schoolId, {
      fullName: str(fd, "fullName"),
      admissionNo: str(fd, "admissionNo"),
      admittedOn: str(fd, "admittedOn"),
      dateOfBirth: str(fd, "dateOfBirth"),
      sectionId: str(fd, "sectionId"),
      rollNo: str(fd, "rollNo"),
    });
    return {
      message: `${str(fd, "fullName")} admitted. Sign-in name: ${r.username}. Give the student (or parent) this activation code; they choose a password at /redeem.`,
      code: r.activationCode,
      codeExpires: await when(r.codeExpiresAt),
    };
  });
}

export async function addStudentProfileAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await addStudentProfileForMember(db, ctx, schoolId, str(fd, "userId"), { displayName: str(fd, "displayName"), admissionNo: str(fd, "admissionNo") });
    return "Student details added.";
  });
}

export async function updateStudentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateStudentProfile(db, ctx, schoolId, str(fd, "studentId"), { displayName: str(fd, "displayName"), admittedOn: str(fd, "admittedOn"), dateOfBirth: str(fd, "dateOfBirth") });
    return "Details saved.";
  });
}

export async function enrollAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await enrollStudent(db, ctx, schoolId, { studentId: str(fd, "studentId"), sectionId: str(fd, "sectionId"), rollNo: str(fd, "rollNo"), startsOn: str(fd, "startsOn") });
    return `Enrolled from ${r.startsOn}.`;
  });
}

export async function changeSectionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await changeSection(db, ctx, schoolId, { enrollmentId: str(fd, "enrollmentId"), sectionId: str(fd, "sectionId"), effectiveOn: str(fd, "effectiveOn"), rollNo: str(fd, "rollNo") });
    return `Moved from ${r.startsOn}.`;
  });
}

export async function correctEnrollmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await correctEnrollment(db, ctx, schoolId, str(fd, "enrollmentId"));
    return "Enrollment marked as a correction. Enroll the student in the right section.";
  });
}

export async function setRollAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await setRollNo(db, ctx, schoolId, str(fd, "enrollmentId"), str(fd, "rollNo"));
    return "Roll number saved.";
  });
}

export async function numberRollsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await numberRollsAlphabetically(db, ctx, schoolId, str(fd, "sectionId"));
    return `Numbered ${r.numbered} student(s) in alphabetical order.`;
  });
}

export async function markStudentLeftAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await markStudentLeft(db, ctx, schoolId, str(fd, "studentId"), { leftOn: str(fd, "leftOn"), reason: str(fd, "reason") });
    return `Marked as left. ${r.endedEnrollments} enrollment(s) ended.`;
  });
}

export async function readmitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await readmitStudent(db, ctx, schoolId, str(fd, "studentId"));
    return "Readmitted. Enroll the student in a section.";
  });
}

export async function issueStudentCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const purpose = str(fd, "purpose") === "activation" ? "activation" : "password_reset";
    const r = await issueAccountCode(db, { ...ctx, schoolId }, { userId: str(fd, "userId"), purpose, reason: str(fd, "reason") });
    return { message: "Give this one-time code to the person; they choose a new password at /redeem.", code: r.code, codeExpires: await when(r.expiresAt) };
  });
}

export async function signOutStudentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const n = await revokeUserSessions(db, { ...ctx, schoolId }, str(fd, "userId"));
    return `Signed out of ${n} session(s).`;
  });
}

export async function createGuardianAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await createGuardianAccount(db, ctx, schoolId, str(fd, "studentId"), {
      fullName: str(fd, "fullName"),
      email: str(fd, "email"),
      phone: str(fd, "phone"),
      relationship: str(fd, "relationship"),
    });
    return { message: `${str(fd, "fullName")} added as a parent. Give them this activation code; they choose a password at /redeem.`, code: r.activationCode, codeExpires: await when(r.codeExpiresAt) };
  });
}

export async function linkGuardianAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await linkExistingGuardian(db, ctx, schoolId, str(fd, "studentId"), { guardianUserId: str(fd, "guardianUserId"), relationship: str(fd, "relationship") });
    return "Parent linked.";
  });
}

export async function guardianCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await createGuardianCode(db, ctx, schoolId, str(fd, "studentId"), { relationship: str(fd, "relationship"), recipientLabel: str(fd, "recipientLabel") });
    return { message: "Give this code to the parent. They sign in to their own Examio account and enter it at /join; it links them to this child only.", code: r.code, codeExpires: await when(r.expiresAt) };
  });
}

export async function revokeGuardianAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await revokeGuardianLink(db, ctx, schoolId, str(fd, "linkId"));
    return r.membershipRevoked ? "Unlinked. They had no other child here, so their access to the school has ended." : "Unlinked.";
  });
}

export async function uploadDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose a file.", { file: "Choose a file." });
    const up = await uploadFile(db, ctx, fileStorage(), { schoolId, purpose: STUDENT_DOCUMENT_PURPOSE, fileName: file.name, data: Buffer.from(await file.arrayBuffer()) });
    await attachStudentDocument(db, ctx, schoolId, str(fd, "studentId"), { fileId: up.id, title: str(fd, "title") || file.name });
    return "Document added. It can be downloaded once the virus check has finished.";
  });
}

export async function removeDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await removeStudentDocument(db, ctx, schoolId, str(fd, "documentId"));
    return "Document removed.";
  });
}

export async function promoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const to = str(fd, "toSectionId");
    const r = await commitPromotion(db, ctx, schoolId, {
      fromSectionId: str(fd, "fromSectionId"),
      toSectionId: to === "" || to === "graduate" ? null : to,
      studentIds: fd.getAll("studentIds").filter((v): v is string => typeof v === "string"),
      keepRollNumbers: str(fd, "keepRollNumbers") === "on",
    });
    const parts = [r.promoted ? `${r.promoted} promoted` : "", r.graduated ? `${r.graduated} graduated` : "", r.skipped ? `${r.skipped} skipped (already enrolled in that year)` : ""].filter(Boolean);
    return parts.length ? `${parts.join(", ")}.` : "Nothing to do.";
  });
}

/* ------------------------------------------------------------------ import */

export interface StudentImportState {
  message?: string;
  preview?: StudentImportPreview;
  text?: string;
  key?: string;
  result?: { created: number; enrolled: number; replayed: boolean; codes: { admissionNo: string; name: string; username: string; code: string }[] | null };
}

async function readCsv(fd: FormData): Promise<string> {
  const file = fd.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > 256 * 1024) throw new AppError("VALIDATION", "The file is larger than 256 KB.");
    return (await file.text()).replace(/^﻿/, "");
  }
  return str(fd, "text");
}

export async function previewStudentImportAction(_prev: StudentImportState, fd: FormData): Promise<StudentImportState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const text = await readCsv(fd);
    if (!text.trim()) return { message: "Choose a CSV file or paste its contents." };
    const preview = await previewStudentImport(db, s.ctx, s.ctx.schoolId, { text, yearId: str(fd, "yearId") });
    return { preview, text, key: crypto.randomUUID() };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message };
    throw e;
  }
}

export async function commitStudentImportAction(prev: StudentImportState, fd: FormData): Promise<StudentImportState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const result = await commitStudentImport(db, s.ctx, s.ctx.schoolId, { text: str(fd, "text"), yearId: str(fd, "yearId"), fingerprint: str(fd, "fingerprint"), idempotencyKey: str(fd, "key") });
    revalidatePath("/school", "layout");
    return { result };
  } catch (e) {
    if (e instanceof AppError) return { ...prev, message: e.message };
    throw e;
  }
}
