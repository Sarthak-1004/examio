"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, addCopies, createTitle, formatPaise, issueCopy, markLoanLost, renewLoan, returnCopy, setCopyStatus, updateLibrarySettings, updateTitle } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Library actions for school administrators; the services and the database check the rest. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/library", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const charge = (paise: number) => (paise > 0 ? ` A charge of ${formatPaise(paise)} is waiting for another administrator's approval in Fees.` : "");

export async function issueAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await issueCopy(db, ctx, schoolId, { accessionNo: str(fd, "accessionNo"), borrower: str(fd, "borrower") });
    return `Issued “${r.title}” to ${r.borrowerName}, due ${r.dueOn}.`;
  });
}

export async function returnAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await returnCopy(db, ctx, schoolId, str(fd, "accessionNo"));
    return `Returned “${r.title}”${r.daysLate > 0 ? `, ${r.daysLate} day${r.daysLate === 1 ? "" : "s"} late` : ""}.${charge(r.chargePaise)}`;
  });
}

export async function renewAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => `Renewed, now due ${(await renewLoan(db, ctx, schoolId, str(fd, "loanId"))).dueOn}.`);
}

export async function lostAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => `Marked lost.${charge((await markLoanLost(db, ctx, schoolId, str(fd, "loanId"), str(fd, "charge"))).chargePaise)}`);
}

export async function settingsAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateLibrarySettings(db, ctx, schoolId, {
      loanDays: str(fd, "loanDays"),
      maxRenewals: str(fd, "maxRenewals"),
      maxLoansStudent: str(fd, "maxLoansStudent"),
      maxLoansStaff: str(fd, "maxLoansStaff"),
      finePerDay: str(fd, "finePerDay"),
    });
    return "Saved.";
  });
}

const titleFields = (fd: FormData) => ({ title: str(fd, "title"), author: str(fd, "author"), isbn: str(fd, "isbn"), publisher: str(fd, "publisher"), category: str(fd, "category") });

export async function createTitleAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  let id: string;
  try {
    id = (await createTitle(db, s.ctx, s.ctx.schoolId, { ...titleFields(fd), accessionNos: str(fd, "accessionNos"), shelf: str(fd, "shelf") })).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/library", "layout");
  redirect(`/school/library/catalogue/${id}`);
}

export async function updateTitleAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateTitle(db, ctx, schoolId, str(fd, "titleId"), titleFields(fd));
    return "Saved.";
  });
}

export async function addCopiesAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await addCopies(db, ctx, schoolId, str(fd, "titleId"), { accessionNos: str(fd, "accessionNos"), shelf: str(fd, "shelf") });
    return `Added ${r.added} cop${r.added === 1 ? "y" : "ies"}.`;
  });
}

export async function copyStatusAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const to = str(fd, "to") === "withdrawn" ? "withdrawn" : "available";
    await setCopyStatus(db, ctx, schoolId, str(fd, "copyId"), to, str(fd, "note"));
    return to === "withdrawn" ? "Copy withdrawn." : "Copy back on the shelf.";
  });
}
