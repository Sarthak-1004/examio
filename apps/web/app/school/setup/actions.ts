"use server";

import { revalidatePath } from "next/cache";
import {
  AppError,
  CBSE_STYLE_PRESET,
  addCalendarEntry,
  addStandardClasses,
  copyYearStructure,
  createAcademicYear,
  createAttendanceSession,
  createClass,
  createGradingScheme,
  createSection,
  createSubject,
  deleteAcademicYear,
  deleteCalendarEntry,
  deleteSetupItem,
  renameSubject,
  setAcademicYearStatus,
  setArchived,
  setAttendanceSessionArchived,
  setClassSubjects,
  setDefaultGradingScheme,
  setGradingSchemeArchived,
  updateAcademicYear,
  updateClass,
  updateSchoolProfile,
  type ArchivableKind,
  type YearStatus,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/**
 * Server actions for school setup. Each one checks that the caller is an administrator of the
 * selected school before doing anything (the services and the database check again), turns
 * expected refusals into a message for the form, and refreshes the school pages.
 */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const many = (fd: FormData, key: string) => fd.getAll(key).filter((v): v is string => typeof v === "string");

/* ------------------------------------------------------------------ profile */

export async function saveProfileAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateSchoolProfile(db, ctx, schoolId, {
      name: str(fd, "name"),
      shortName: str(fd, "shortName"),
      address: str(fd, "address"),
      contactEmail: str(fd, "contactEmail"),
      contactPhone: str(fd, "contactPhone"),
      timezone: str(fd, "timezone"),
      brandColor: str(fd, "brandColor"),
    });
    return "Profile saved.";
  });
}

/* ------------------------------------------------------------------ years */

export async function createYearAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await createAcademicYear(db, ctx, schoolId, { name: str(fd, "name"), startsOn: str(fd, "startsOn"), endsOn: str(fd, "endsOn") });
    return r.overlapsWith.length ? `Year created. Note: its dates overlap ${r.overlapsWith.join(", ")}.` : "Year created.";
  });
}

export async function updateYearAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await updateAcademicYear(db, ctx, schoolId, str(fd, "yearId"), { name: str(fd, "name"), startsOn: str(fd, "startsOn"), endsOn: str(fd, "endsOn") });
    return r.overlapsWith.length ? `Saved. Note: its dates overlap ${r.overlapsWith.join(", ")}.` : "Saved.";
  });
}

export async function setYearStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const status = str(fd, "status") as YearStatus;
    await setAcademicYearStatus(db, ctx, schoolId, str(fd, "yearId"), status);
    return status === "current" ? "This is now the current year." : status === "closed" ? "Year closed. It is now read-only." : "Year reopened.";
  });
}

export async function deleteYearAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await deleteAcademicYear(db, ctx, schoolId, str(fd, "yearId"));
    return "Year deleted.";
  });
}

export async function copyYearAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await copyYearStructure(db, ctx, schoolId, str(fd, "fromYearId"), str(fd, "toYearId"));
    return `Copied ${r.sections} section(s) and ${r.classSubjects} subject assignment(s).`;
  });
}

/* ------------------------------------------------------------------ classes and sections */

export async function createClassAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createClass(db, ctx, schoolId, { name: str(fd, "name"), sortOrder: str(fd, "sortOrder") || "0" });
    return "Class added.";
  });
}

export async function addStandardClassesAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await addStandardClasses(db, ctx, schoolId);
    return r.added ? `Added ${r.added} class(es).` : "Class 1 to Class 12 already exist.";
  });
}

export async function updateClassAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateClass(db, ctx, schoolId, str(fd, "classId"), { name: str(fd, "name"), sortOrder: str(fd, "sortOrder") || "0" });
    return "Class saved.";
  });
}

export async function createSectionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createSection(db, ctx, schoolId, { yearId: str(fd, "yearId"), classId: str(fd, "classId"), name: str(fd, "name"), capacity: str(fd, "capacity") });
    return "Section added.";
  });
}

const KINDS: readonly ArchivableKind[] = ["class", "section", "subject"];
const kindOf = (fd: FormData): ArchivableKind => {
  const k = str(fd, "kind");
  if (!(KINDS as readonly string[]).includes(k)) throw new AppError("VALIDATION", "Unknown item.");
  return k as ArchivableKind;
};

export async function archiveItemAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "true";
    await setArchived(db, ctx, schoolId, kindOf(fd), str(fd, "id"), archived);
    return archived ? "Archived." : "Restored.";
  });
}

export async function deleteItemAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await deleteSetupItem(db, ctx, schoolId, kindOf(fd), str(fd, "id"));
    return "Deleted.";
  });
}

/* ------------------------------------------------------------------ subjects */

export async function createSubjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createSubject(db, ctx, schoolId, { name: str(fd, "name"), code: str(fd, "code") });
    return "Subject added.";
  });
}

export async function renameSubjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await renameSubject(db, ctx, schoolId, str(fd, "subjectId"), str(fd, "name"));
    return "Subject renamed.";
  });
}

export async function setClassSubjectsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await setClassSubjects(db, ctx, schoolId, { yearId: str(fd, "yearId"), classId: str(fd, "classId"), subjectIds: many(fd, "subjectIds") });
    return r.added || r.removed ? `Saved (${r.added} added, ${r.removed} removed).` : "No changes.";
  });
}

/* ------------------------------------------------------------------ grading */

export async function createGradingSchemeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const labels = many(fd, "bandLabel");
    const mins = many(fd, "bandMin");
    const bands = labels.map((label, i) => ({ label, minPercent: mins[i] ?? "" })).filter((b) => b.label.trim() !== "" || b.minPercent.trim() !== "");
    await createGradingScheme(db, ctx, schoolId, { name: str(fd, "name"), passPercent: str(fd, "passPercent"), bands });
    return "Grading scheme created.";
  });
}

export async function createPresetSchemeAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createGradingScheme(db, ctx, schoolId, CBSE_STYLE_PRESET);
    return "CBSE-style scheme created. You can change it at any time.";
  });
}

export async function setDefaultSchemeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await setDefaultGradingScheme(db, ctx, schoolId, str(fd, "schemeId"));
    return "Default scheme changed.";
  });
}

export async function archiveSchemeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "true";
    await setGradingSchemeArchived(db, ctx, schoolId, str(fd, "schemeId"), archived);
    return archived ? "Scheme archived." : "Scheme restored.";
  });
}

/* ------------------------------------------------------------------ calendar and sessions */

export async function addCalendarEntryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await addCalendarEntry(db, ctx, schoolId, str(fd, "yearId"), {
      title: str(fd, "title"),
      kind: str(fd, "kind") as "holiday" | "event" | "exam",
      startsOn: str(fd, "startsOn"),
      endsOn: str(fd, "endsOn") || str(fd, "startsOn"),
    });
    return "Added to the calendar.";
  });
}

export async function deleteCalendarEntryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await deleteCalendarEntry(db, ctx, schoolId, str(fd, "entryId"));
    return "Removed.";
  });
}

export async function createSessionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createAttendanceSession(db, ctx, schoolId, { name: str(fd, "name"), sortOrder: str(fd, "sortOrder") || "0" });
    return "Session added.";
  });
}

export async function archiveSessionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "true";
    await setAttendanceSessionArchived(db, ctx, schoolId, str(fd, "sessionId"), archived);
    return archived ? "Session archived." : "Session restored.";
  });
}
