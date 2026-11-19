"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, addSalaryVersion, calculateRun, createComponent, createRun, setComponentArchived } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Payroll actions for administrators and finance; the services and the database check who may do what. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "finance");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/payroll", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

export async function componentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createComponent(db, ctx, schoolId, {
      name: str(fd, "name"),
      kind: str(fd, "kind") as never,
      calc: str(fd, "calc") as never,
      prorate: str(fd, "prorate") !== "no",
      cap: str(fd, "cap"),
      sortOrder: str(fd, "sortOrder"),
    });
    return "Component added.";
  });
}

export async function componentArchiveAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "1";
    await setComponentArchived(db, ctx, schoolId, str(fd, "componentId"), archived);
    return archived ? "Archived." : "Restored.";
  });
}

export async function salaryAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const lines = [...fd.entries()].filter(([k]) => k.startsWith("c:")).map(([k, v]) => ({ componentId: k.slice(2), value: String(v) }));
    await addSalaryVersion(db, ctx, schoolId, str(fd, "staffId"), { effectiveFrom: str(fd, "effectiveFrom"), basic: str(fd, "basic"), note: str(fd, "note"), lines });
    return "Salary saved as a new version.";
  });
}

export async function createRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin", "finance");
  let id: string;
  try {
    id = (await createRun(db, s.ctx, s.ctx.schoolId, str(fd, "month"))).id;
    await calculateRun(db, s.ctx, s.ctx.schoolId, id);
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/payroll", "layout");
  redirect(`/school/payroll/runs/${id}`);
}

export async function calculateRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await calculateRun(db, ctx, schoolId, str(fd, "runId"));
    return `Calculated ${r.included} payslip${r.included === 1 ? "" : "s"}${r.excluded ? `; ${r.excluded} staff without a salary` : ""}.`;
  });
}
